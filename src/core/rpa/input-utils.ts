import { clipboard, screen } from 'electron'
import { AppType } from './types'
import { getWindowInfo } from './window-utils'
import { getInputAreaFromCache } from './vision-utils'
import { clearScreenshotCache } from './screenshot-utils'
import { DesktopStateError } from '../desktop-errors'
const IS_WINDOWS = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

import { delay, randomDelayIn, getRobot } from './util'

// 原版 whatsapp-agent-demo 的贝塞尔曲线仿人滑动
async function humanLikeMove(
  targetX: number,
  targetY: number,
  options: {
    minSteps?: number
    maxSteps?: number
    baseDelay?: number
  } = {}
): Promise<void> {
  const robot = getRobot()
  if (!robot) return

  // Layout and box-selection coordinates are DIP. Convert only at the mouse boundary.
  const physical = IS_WINDOWS
    ? screen.dipToScreenPoint({ x: targetX, y: targetY })
    : { x: targetX, y: targetY }
  targetX = physical.x
  targetY = physical.y
  const { minSteps = 5, maxSteps = 15, baseDelay = 2 } = options

  const startPos = robot.getMousePos()
  const dx = targetX - startPos.x
  const dy = targetY - startPos.y
  const distance = Math.sqrt(dx * dx + dy * dy)

  if (distance < 1) {
    robot.moveMouse(Math.round(targetX), Math.round(targetY))
    return
  }

  // 根据距离决定步数
  const steps = Math.min(
    maxSteps,
    Math.max(minSteps, Math.floor(distance / 40) + Math.floor(Math.random() * 3))
  )

  // 生成贝塞尔曲线控制点 (Cubic Bezier)
  const ctrl1X = startPos.x + dx * Math.random() * 0.5 + (Math.random() - 0.5) * distance * 0.2
  const ctrl1Y = startPos.y + dy * Math.random() * 0.5 + (Math.random() - 0.5) * distance * 0.2
  const ctrl2X =
    startPos.x + dx * (0.5 + Math.random() * 0.5) + (Math.random() - 0.5) * distance * 0.2
  const ctrl2Y =
    startPos.y + dy * (0.5 + Math.random() * 0.5) + (Math.random() - 0.5) * distance * 0.2

  for (let i = 1; i <= steps; i++) {
    const t = i / steps

    // 匀速转非线性 (Ease Out)
    const easeT = t * (2 - t)

    const mt = 1 - easeT
    const mt2 = mt * mt
    const mt3 = mt2 * mt
    const easeT2 = easeT * easeT
    const easeT3 = easeT2 * easeT

    // 贝塞尔曲线公式计算
    const x =
      mt3 * startPos.x + 3 * mt2 * easeT * ctrl1X + 3 * mt * easeT2 * ctrl2X + easeT3 * targetX
    const y =
      mt3 * startPos.y + 3 * mt2 * easeT * ctrl1Y + 3 * mt * easeT2 * ctrl2Y + easeT3 * targetY

    // 加入随机细微抖动 (±1像素)
    const jitterX = i === steps ? 0 : (Math.random() - 0.5) * 2
    const jitterY = i === steps ? 0 : (Math.random() - 0.5) * 2

    robot.moveMouse(Math.round(x + jitterX), Math.round(y + jitterY))

    // 变频延迟，模拟人类微停顿
    let stepDelay = baseDelay + Math.random() * 2
    if (i > steps * 0.8) stepDelay += 2

    await delay(stepDelay)
  }
}

/**
 * 仿人化的鼠标点击函数
 * 将点击分解为按下和抬起，并加入随机物理按压延迟
 * @param button 鼠标按键，默认 'left'
 */
export async function humanLikeClick(button: 'left' | 'right' = 'left'): Promise<void> {
  const robot = getRobot()
  if (!robot) return

  try {
    // 模拟按下
    robot.mouseToggle('down', button)

    // 模拟物理按压耗时 (50ms - 150ms)
    const pressDuration = 120 + Math.random() * 100
    await delay(Math.round(pressDuration))

    // 模拟抬起
    robot.mouseToggle('up', button)

    // 点击后的随机微小停顿，模拟人类反应
    const afterClickDelay = 50 + Math.random() * 100
    await delay(Math.round(afterClickDelay))
  } catch (error) {
    console.error('【拟人化点击】执行失败:', error)
    // 降级处理：如果异常，确保至少尝试点击
    robot.mouseClick(button)
  }
}

/**
 * 业务原子 2 — 核心实现：按给定坐标发送消息（不依赖 VLM 缓存）。
 * `sendReplyAction`（VLM 路线）与 `BoxSelectDevice.sendMessage`（框选路线）共用此函数。
 *
 * 1. humanLikeMove → 输入框焦点坐标 (x, y)
 * 2. 隐式鼠标左键点击聚焦
 * 3. 剪贴板 + Cmd/Ctrl+V 粘贴
 * 4. Enter 发送
 */
export async function sendReplyByCoordsAction(
  x: number,
  y: number,
  text: string,
  assertFocused?: () => void,
  signal?: AbortSignal
): Promise<boolean> {
  const robot = getRobot()
  if (!robot) {
    console.error('[sendReplyByCoordsAction] RobotJS 缺失')
    return false
  }

  let sendPhase: 'before_paste' | 'pasted' | 'submitted' = 'before_paste'
  const focused = assertFocused
  assertFocused = () => {
    if (signal?.aborted)
      throw new DesktopStateError('send_failed', '引擎已停止，取消发送', sendPhase)
    focused?.()
  }
  try {
    assertFocused?.()
    await humanLikeMove(x, y)
    await randomDelayIn(100, 200)

    assertFocused?.()
    robot.mouseClick('left')
    await randomDelayIn(200, 300)

    assertFocused?.()
    clipboard.writeText(text)
    await randomDelayIn(50, 100)

    assertFocused?.()
    sendPhase = 'pasted'
    if (IS_MAC) {
      robot.keyTap('v', ['command'])
    } else {
      robot.keyTap('v', ['control'])
    }

    await randomDelayIn(300, 500)

    assertFocused?.()
    sendPhase = 'submitted'
    robot.keyTap('enter')

    assertFocused?.()
    if (IS_WINDOWS) {
      robot.keyTap('enter', ['control'])
      await randomDelayIn(40, 60)
      robot.keyTap('backspace')
    } else {
      robot.keyTap('enter', ['command'])
      await randomDelayIn(20, 40)
      robot.keyToggle('command', 'up')
      await randomDelayIn(20, 40)
      robot.keyTap('backspace')
    }

    clearScreenshotCache()
    return true
  } catch (err: any) {
    console.error('[sendReplyByCoordsAction] Failed:', err)
    throw new DesktopStateError(
      err instanceof DesktopStateError ? err.code : 'send_failed',
      err instanceof Error ? err.message : '桌面消息发送暂时失败',
      sendPhase
    )
  }
}

/**
 * 业务原子 2：极简防检测回复模式（VLM 路线适配器）。
 * 从 layout cache 中找输入框坐标并检查窗口范围，最终调用 `sendReplyByCoordsAction`。
 */
export async function sendReplyAction(
  appType: AppType,
  text: string,
  signal?: AbortSignal
): Promise<boolean> {
  const windowInfo = await getWindowInfo(appType, false, true)
  if (!windowInfo || !windowInfo.bounds) {
    console.error('[sendReplyAction] 无法获取窗口信息')
    throw new DesktopStateError('target_unavailable', '未找到目标聊天窗口，请返回微信或企业微信')
  }

  let assertFocused: (() => void) | undefined
  if (IS_WINDOWS) {
    const { windowManager } = require('node-window-manager')
    assertFocused = () => {
      if (windowManager.getActiveWindow()?.id !== windowInfo.wechatWindow.id) {
        throw new DesktopStateError(
          'focus_changed',
          '目标聊天窗口失去焦点，已取消本次发送，请返回普通聊天'
        )
      }
    }
    // User opened a browser: wait rather than forcing focus away from it.
    assertFocused()
  }

  let inputX: number | undefined
  let inputY: number | undefined

  // 优先从缓存获取输入框坐标（chatMainArea 反推）
  const inputArea = getInputAreaFromCache(appType)
  if (inputArea && isInputPointInsideWindow(inputArea.coordinates, windowInfo.bounds)) {
    inputX = inputArea.coordinates[0] + (Math.random() - 0.5) * 10
    inputY = inputArea.coordinates[1] + (Math.random() - 0.5) * 4
    console.log(`[sendReplyAction] 使用缓存输入框坐标: (${inputX}, ${inputY})`)
  }

  // Fallback 处理
  if (inputX === undefined || inputY === undefined) {
    throw new DesktopStateError(
      'layout_invalid',
      '输入框坐标不可用或超出目标窗口，请重新测量布局或手动框选'
    )
  }

  return sendReplyByCoordsAction(inputX, inputY, text, assertFocused, signal)
}

function isInputPointInsideWindow(
  [x, y]: [number, number],
  bounds: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x > bounds.x + bounds.width * 0.35 &&
    x < bounds.x + bounds.width - 20 &&
    y > bounds.y + bounds.height * 0.55 &&
    y < bounds.y + bounds.height - 15
  )
}

/** User-confirmed image send; never invoked from model output. */
export async function sendImageAction(
  appType: AppType,
  image: Electron.NativeImage,
  prepareLayout?: () => Promise<void>
): Promise<void> {
  const info = await getWindowInfo(appType, false, true)
  const robot = getRobot()
  if (!info?.bounds || !robot) throw new Error('目标聊天窗口或桌面输入设备不可用')
  if (!info.wechatWindow?.bringToTop) throw new Error('无法激活目标聊天窗口')
  info.wechatWindow.bringToTop()
  await delay(350)
  const { windowManager } = require('node-window-manager')
  const assertTargetFocused = (afterPaste = false): void => {
    const active = windowManager.getActiveWindow()
    if (!active || active.id !== info.wechatWindow.id) {
      throw new Error(
        afterPaste
          ? '目标聊天窗口失去焦点，图片可能已粘贴但未发送，请检查会话后再重试'
          : '目标聊天窗口未获得焦点，图片未发送'
      )
    }
  }
  assertTargetFocused()
  const inputArea = getInputAreaFromCache(appType)
  if (!inputArea && prepareLayout) {
    await prepareLayout()
    // Resolve fresh window information after the model request; focus may have changed.
    return sendImageAction(appType, image)
  }
  // Manual image sending also requires a measured input box; do not guess a click.
  if (!inputArea || !isInputPointInsideWindow(inputArea.coordinates, info.bounds)) {
    throw new Error('输入框坐标不可用，请先重新识别窗口布局或完成手动框选')
  }
  const pos = { inputX: inputArea.coordinates[0], inputY: inputArea.coordinates[1] }
  await humanLikeMove(pos.inputX, pos.inputY)
  assertTargetFocused()
  robot.mouseClick('left')
  assertTargetFocused()
  clipboard.writeImage(image)
  await delay(150)
  assertTargetFocused()
  robot.keyTap('v', [IS_MAC ? 'command' : 'control'])
  await delay(500)
  assertTargetFocused(true)
  robot.keyTap('enter')
  clearScreenshotCache()
}

export type ClickPolicy = 'single' | 'double'

/**
 * 默认点击策略：仅微信桌面端需要双击红点切换会话；
 * 企业微信、钉钉、飞书、Slack、Telegram 以及任何 generic 应用都用单击。
 */
export function defaultClickPolicy(appType: AppType): ClickPolicy {
  return appType === 'wechat' ? 'double' : 'single'
}

/**
 * 业务原子 3：点击红点区域激活未读消息（纯视觉路线）
 *
 * 参考 whatsapp-agent-demo 的 activeUnreadByClick：
 * - 微信场景：双击红点区域（单击只是展开，双击才会切换）
 * - 企业微信、通用 IM 场景：单击即可
 *
 * 旧签名 (coords, appType) 仍然支持；想显式指定策略时传第三个参数。
 */
export async function activeUnreadByClickAction(
  coordinates: [number, number],
  appType: AppType,
  clickPolicy?: ClickPolicy
): Promise<void> {
  const robot = getRobot()
  if (!robot) return

  const [centerX, centerY] = coordinates
  const policy: ClickPolicy = clickPolicy ?? defaultClickPolicy(appType)
  const isSingleClick = policy === 'single'

  console.log(`[activeUnreadByClick] ${isSingleClick ? '单击' : '双击'}红点`, {
    centerX,
    centerY,
    appType,
    policy
  })

  // 移动鼠标到红点中心
  await humanLikeMove(centerX, centerY)

  // 移动后的随机延迟（150-250ms）
  await randomDelayIn(150, 250)

  // 根据 policy 执行单击或双击
  robot.mouseClick('left')
  if (!isSingleClick) {
    // 双击：第二次点击
    await randomDelayIn(40, 60)
    robot.mouseClick('left')
  }
  clearScreenshotCache()
}

/**
 * 业务原子 4：点击联系人列表第一个未读联系人
 *
 * 参考 whatsapp-agent-demo 的 clickUnreadContact
 */
export async function clickUnreadContactAction(coordinates: [number, number]): Promise<void> {
  const robot = getRobot()
  if (!robot) return

  const [firstContactX, firstContactY] = coordinates
  console.log('[clickUnreadContact] 点击联系人', {
    firstContactX,
    firstContactY
  })

  // 移动鼠标到联系人位置
  await humanLikeMove(firstContactX, firstContactY)
  await randomDelayIn(150, 250)

  // 点击左键
  robot.mouseClick('left')
  clearScreenshotCache()
  console.log('[clickUnreadContact] 点击完成')
  await randomDelayIn(150, 250)
}
