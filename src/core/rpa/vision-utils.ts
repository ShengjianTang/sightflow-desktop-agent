// src/core/rpa/vision-utils.ts
// VLM 视觉检测工具
//
// 用 AIClient.detectVision() 调豆包 VLM，解析返回的 bbox/point 坐标
// 检测微信/企微布局（聊天入口、联系人列表、输入框等）

import type { VisionClient } from '../vision-client'
import { AppType, ScreenRect } from './types'
import { captureWechatWindow } from './screenshot-utils'
import { getWindowInfo, getWindowInfoSync } from './window-utils'

// ── 类型定义 ──

export type BBox = [number, number, number, number] // [x1, y1, x2, y2] 归一化 0-1000

export interface LayoutAreaItem {
  bbox?: BBox
  rect?: ScreenRect
  coordinates: [number, number] // 屏幕绝对坐标
  source?: 'vlm' | 'box-select' | 'derived'
}

export interface LayoutCache {
  // ── 未读检测区域（detectUnreadArea） ──
  chatEntranceArea: LayoutAreaItem | null // 聊天入口按钮（粗检测红点）
  firstContact: LayoutAreaItem | null // 联系人列表第一行（细检测红点）
  contactListArea?: LayoutAreaItem | null // 完整可见联系人列表，不依赖首个头像的位置
  unreadMeasuredAt?: number

  // ── 主布局区域（detectWechatLayout） ──
  searchInputBox: LayoutAreaItem | null // 搜索输入框
  headerArea: LayoutAreaItem | null // 对话窗口 header
  chatMainArea: LayoutAreaItem | null // 聊天记录区（diff 检测用）

  // ── 输入框区域（从 chatMainArea 反推） ──
  messageInputArea: LayoutAreaItem | null // 文字输入框（chatMainArea 底边 → 窗口底边）

  timestamp: number
  appType: AppType
}

// ── 布局缓存（内存） ──

const layoutCacheMemory = new Map<AppType, LayoutCache>()
const unreadAreaRetryAfter = new Map<AppType, number>()
// 定位失败只短暂退避，避免一次临时截图/API失败后 60 秒都不再更新坐标。
const UNREAD_AREA_RETRY_DELAY_MS = 5_000

async function matchingWindowInfo(appType: AppType, snapshot: { bounds?: ScreenRect }) {
  const info = await getWindowInfo(appType, false, true)
  if (!info?.bounds) throw new Error('获取窗口信息失败')
  if (
    snapshot.bounds &&
    (Math.abs(snapshot.bounds.width - info.bounds.width) > 1 ||
      Math.abs(snapshot.bounds.height - info.bounds.height) > 1)
  )
    throw new Error('布局识别期间窗口尺寸已改变，请保持窗口尺寸稳定并重新识别')
  return info
}

export function getLayoutCache(appType: AppType): LayoutCache | null {
  return layoutCacheMemory.get(appType) || null
}

export function setLayoutCache(appType: AppType, cache: LayoutCache): void {
  layoutCacheMemory.set(appType, cache)
}

export function clearLayoutCache(appType: AppType): void {
  layoutCacheMemory.delete(appType)
  unreadAreaRetryAfter.delete(appType)
}

export function clearUnreadAreaRetry(appType: AppType): void {
  unreadAreaRetryAfter.delete(appType)
}

/** Use the independently measured search/chat divider, not a guessed first-row avatar. */
export function deriveContactListArea(
  cache: LayoutCache,
  bounds: ScreenRect
): LayoutAreaItem | null {
  const search = cache.searchInputBox?.bbox
  const chat = cache.chatMainArea?.bbox || cache.headerArea?.bbox
  if (!search || !chat || search[2] >= chat[0] || search[3] >= 700) return null
  const bbox: BBox = [
    Math.max(0, Math.floor(search[0] - (12 / bounds.width) * 1000)),
    search[3],
    chat[0],
    Math.floor(1000 - (8 / bounds.height) * 1000)
  ]
  const rect = bboxToCropBounds(bbox, bounds)
  if (rect.width < 80 || rect.width > bounds.width * 0.6 || rect.height < 80) return null
  return { bbox, coordinates: bboxToScreenCoords(bbox, bounds, 1), source: 'derived' }
}

/** A verified unread row is also a better avatar-column anchor for later local scans. */
export function rememberUnreadAvatar(
  appType: AppType,
  area: { bbox: BBox; coordinates: [number, number] }
): void {
  const cache = getLayoutCache(appType)
  if (cache) setLayoutCache(appType, { ...cache, firstContact: { ...area, source: 'vlm' } })
}

// ── BBox / Point 解析 ──

/**
 * 从 VLM 返回文本中解析所有 <bbox> 标签
 * 支持格式:
 *   - <bbox>x1,y1,x2,y2</bbox>  (逗号分隔)
 *   - <bbox>x1 y1 x2 y2</bbox>  (空格分隔)
 * 坐标为归一化 0-1000
 */
export function parseBBoxes(text: string): BBox[] {
  if (!text) return []
  const bboxes: BBox[] = []

  // 1. 先尝试逗号分隔格式（标准格式）
  let regex = /<bbox>\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*<\/bbox>/gi
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    const x1 = Number(match[1])
    const y1 = Number(match[2])
    const x2 = Number(match[3])
    const y2 = Number(match[4])
    if ([x1, y1, x2, y2].every((v) => Number.isFinite(v))) {
      bboxes.push([Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)])
    }
  }

  // 2. 如果没有找到逗号分隔的格式，尝试空格分隔
  if (bboxes.length === 0) {
    regex = /<bbox>\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*<\/bbox>/gi

    while ((match = regex.exec(text)) !== null) {
      const x1 = Number(match[1])
      const y1 = Number(match[2])
      const x2 = Number(match[3])
      const y2 = Number(match[4])
      if ([x1, y1, x2, y2].every((v) => Number.isFinite(v))) {
        bboxes.push([Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)])
      }
    }
  }

  // Reject the whole response rather than shifting positional targets after a bad bbox.
  return bboxes.every(
    ([x1, y1, x2, y2]) => x1 >= 0 && y1 >= 0 && x2 <= 1000 && y2 <= 1000 && x2 > x1 && y2 > y1
  )
    ? bboxes
    : []
}

/**
 * 从 VLM 返回文本中解析 <point> 标签
 * 格式: <point>x y</point> 或 <point>x,y</point>  (归一化 0-1000)
 */
export function parsePoint(text: string): [number, number] | null {
  const regex = /<point>\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*<\/point>/i
  const match = regex.exec(text)
  if (!match) return null

  return [Math.round(parseFloat(match[1])), Math.round(parseFloat(match[2]))]
}

// ── 坐标转换 ──

/**
 * 归一化 bbox (0-1000) → 屏幕绝对坐标（中心点）
 *
 * 布局坐标统一使用 Electron DIP；在鼠标动作边界转换为物理像素。
 */
export function bboxToScreenCoords(
  bbox: BBox,
  bounds: { x: number; y: number; width: number; height: number },
  _scaleFactor: number
): [number, number] {
  void _scaleFactor // Keep the public signature; scaling happens at the mouse boundary.
  const [x1, y1, x2, y2] = bbox

  // 归一化 → 相对于窗口的逻辑像素
  const logicalX = ((x1 + x2) / 2 / 1000) * bounds.width
  const logicalY = ((y1 + y2) / 2 / 1000) * bounds.height

  return [Math.round(bounds.x + logicalX), Math.round(bounds.y + logicalY)]
}

/**
 * 归一化 point (0-1000) → 屏幕绝对坐标
 */
export function pointToScreenCoords(
  point: [number, number],
  bounds: { x: number; y: number; width: number; height: number },
  _scaleFactor: number
): [number, number] {
  void _scaleFactor
  const [px, py] = point

  const logicalX = (px / 1000) * bounds.width
  const logicalY = (py / 1000) * bounds.height

  return [Math.round(bounds.x + logicalX), Math.round(bounds.y + logicalY)]
}

/**
 * 归一化 bbox (0-1000) → 相对于窗口的逻辑像素 crop 区域
 * （用于 captureWechatWindow 的 crop 参数）
 */
export function bboxToCropBounds(
  bbox: BBox,
  windowBounds: { width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const [bx1, by1, bx2, by2] = bbox

  const x1 = (bx1 / 1000) * windowBounds.width
  const y1 = (by1 / 1000) * windowBounds.height
  const x2 = (bx2 / 1000) * windowBounds.width
  const y2 = (by2 / 1000) * windowBounds.height

  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1)
  }
}

// ── VLM 布局检测 Prompt ──

const UNREAD_AREA_PROMPTS: Record<'wechat' | 'wework', { prompt: string; targets: string[] }> = {
  wechat: {
    prompt: `你是一个微信布局解析专家。

## 微信桌面端布局
- 最左侧一列是导航栏，从上到下前三个按钮：头像、聊天入口💬、联系人
- 聊天入口按钮区域：包含💬图标和可能的红色圆形数字角标
- 左侧第二列是聊天联系人列表，第一行是最新消息的联系人，头像右上角可能有红色未读气泡

## 你的职责
帮我框选以下区域，每个区域用 <bbox>x1,y1,x2,y2</bbox> 格式，坐标范围 0-1000：
1. 【聊天入口按钮区域】— 导航栏中的聊天按钮，包含图标和红色角标
2. 【头像参考】— 一个完整可见的联系人头像外框，不要框整行、昵称或头像内部的小图案。首行被裁切时选下一个完整头像；折叠置顶聊天标题不是头像
3. 【完整联系人列表】— 搜索框下方到窗口底部的全部可见会话行，包含置顶/折叠分隔区，排除最左导航栏及右侧聊天内容
分别用 <chatEntrance><bbox>...</bbox></chatEntrance>、<firstContact><bbox>...</bbox></firstContact>、<contactList><bbox>...</bbox></contactList> 包裹。导航栏隐藏时省略chatEntrance。右侧为空白微信占位图时仍定位contactList。不要将红色文字预览框成头像。`,
    targets: ['【聊天入口按钮区域】', '【聊天联系人列表第一行】']
  },
  wework: {
    prompt: `你是一个企业微信布局解析专家。

## 企业微信桌面端布局（三栏式）
- 左侧导航栏：顶部用户头像、功能菜单（消息/通讯录/邮件/日程/工作台），系统分组
- 中间消息列表：顶部搜索框，下方是联系人消息列表，有未读红点
- 右侧聊天区

## 你的职责
帮我框选以下区域，每个区域用 <bbox>x1,y1,x2,y2</bbox> 格式，坐标范围 0-1000：
1. 【消息按钮区域】— 左侧导航栏中的消息按钮区域，包含按钮和红色角标
2. 【头像参考】— 一个完整可见的联系人头像外框，不要框整行或头像内部小图案，首行被裁切时选其他完整头像
3. 【完整消息列表】— 搜索框下方到窗口底部的全部可见会话行，排除导航栏及右侧聊天内容
分别用 <chatEntrance><bbox>...</bbox></chatEntrance>、<firstContact><bbox>...</bbox></firstContact>、<contactList><bbox>...</bbox></contactList> 包裹。导航栏隐藏时省略chatEntrance。右侧为空白占位图时仍定位contactList。`,
    targets: ['【消息按钮区域】', '【消息列表第一行】']
  }
}

// ── 核心检测函数 ──

/**
 * 检测聊天入口区域和第一个联系人（用于红点检测的"两步走"）
 *
 * 返回: chatEntranceArea (Step 1 粗检测区域) + firstContact (Step 2 细检测区域)
 * 结果写入 LayoutCache
 */
export async function detectUnreadArea(
  aiClient: VisionClient,
  appType: AppType
): Promise<{
  success: boolean
  chatEntranceArea?: { bbox: BBox; coordinates: [number, number] }
  firstContact?: { bbox: BBox; coordinates: [number, number] }
  contactListArea?: { bbox: BBox; coordinates: [number, number] }
  error?: string
}> {
  try {
    // 1. 截图
    const screenshotResult = await captureWechatWindow(appType)
    if (!screenshotResult.success || !screenshotResult.screenshotBase64) {
      return { success: false, error: screenshotResult.error || '截图失败' }
    }

    // 2. 获取窗口信息（用于坐标转换）
    const windowInfo = await getWindowInfo(appType, false)
    if (!windowInfo?.bounds || !windowInfo?.scaleFactor) {
      return { success: false, error: '获取窗口信息失败' }
    }

    // 3. 选择 prompt
    const promptKey = appType === 'wework' ? 'wework' : 'wechat'
    const config = UNREAD_AREA_PROMPTS[promptKey]

    // 4. 调 VLM
    console.log('[VisionUtils] 调用 VLM 检测未读区域...')
    const vlmResult = await aiClient.detectVision(config.prompt, screenshotResult.screenshotBase64)
    console.log('[VisionUtils] VLM 返回:', vlmResult.slice(0, 300))

    // 5. 解析 bbox
    const bboxes = parseBBoxes(vlmResult)
    const tagged = /<(?:chatEntrance|firstContact|contactList)>/i.test(vlmResult)
    const taggedBox = (name: string) => {
      const text = vlmResult.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'))?.[1]
      return text ? parseBBoxes(text)[0] : undefined
    }
    const entranceBox = tagged ? taggedBox('chatEntrance') : bboxes[0]
    const contactBox = tagged ? taggedBox('firstContact') : bboxes[1]
    const listBox = tagged ? taggedBox('contactList') : bboxes[2]
    if ((!tagged && bboxes.length < 2) || (!entranceBox && !contactBox && !listBox)) {
      return { success: false, error: '未读布局缺少联系人头像或聊天入口区域，请重新识别' }
    }

    // Models can take seconds: resolve clicks against the window after inference,
    // and reject bbox if its source image no longer has the same dimensions.
    const { bounds, scaleFactor } = await matchingWindowInfo(appType, screenshotResult)
    const contactListArea = listBox
      ? { bbox: listBox, coordinates: bboxToScreenCoords(listBox, bounds, scaleFactor) }
      : null

    // 6. chatEntranceArea — 第一个 bbox
    const chatEntranceArea = entranceBox
      ? { bbox: entranceBox, coordinates: bboxToScreenCoords(entranceBox, bounds, scaleFactor) }
      : null

    // 7. firstContact — 第二个 bbox（如果有）
    let firstContact: { bbox: BBox; coordinates: [number, number] } | null = null
    if (contactBox) {
      const firstContactCoords = bboxToScreenCoords(contactBox, bounds, scaleFactor)
      firstContact = { bbox: contactBox, coordinates: firstContactCoords }
    }

    // 8. 更新缓存
    const existingCache = getLayoutCache(appType)
    setLayoutCache(appType, {
      ...(existingCache || {
        searchInputBox: null,
        headerArea: null,
        chatMainArea: null,
        messageInputArea: null
      }),
      chatEntranceArea,
      firstContact,
      contactListArea,
      unreadMeasuredAt: Date.now(),
      timestamp: Date.now(),
      appType
    } as LayoutCache)

    console.log('[VisionUtils] 未读区域检测完成', {
      chatEntranceArea: chatEntranceArea?.coordinates,
      firstContact: firstContact?.coordinates
    })

    return {
      success: true,
      chatEntranceArea: chatEntranceArea || undefined,
      firstContact: firstContact || undefined,
      contactListArea: contactListArea || undefined
    }
  } catch (error: any) {
    console.error('[VisionUtils] 检测失败:', error)
    return { success: false, error: error?.message || String(error) }
  }
}

/**
 * 获取未读区域（优先用缓存，没有则调 VLM 检测）
 */
export async function getUnreadArea(
  aiClient: VisionClient,
  appType: AppType
): Promise<{
  chatEntranceArea: { bbox: BBox; coordinates: [number, number] } | null
  firstContact: { bbox: BBox; coordinates: [number, number] } | null
  contactListArea: { bbox: BBox; coordinates: [number, number] } | null
}> {
  const windowInfo = await getWindowInfo(appType, false)
  const cache = getLayoutCache(appType)
  const toCurrentCoords = (item: LayoutAreaItem | null | undefined) =>
    item?.bbox && windowInfo?.bounds
      ? {
          bbox: item.bbox,
          coordinates: bboxToScreenCoords(item.bbox, windowInfo.bounds, windowInfo.scaleFactor)
        }
      : null
  const cachedAreas = {
    chatEntranceArea: cache?.chatEntranceArea?.bbox
      ? toCurrentCoords(cache.chatEntranceArea)
      : null,
    firstContact: cache?.firstContact?.bbox ? toCurrentCoords(cache.firstContact) : null,
    contactListArea: toCurrentCoords(
      cache && windowInfo?.bounds
        ? deriveContactListArea(cache, windowInfo.bounds) || cache.contactListArea
        : null
    )
  }

  // A full list remains useful even when its first row changes. Legacy avatar-only layouts
  // must be remeasured periodically rather than caching a false "no unread" indefinitely.
  if (
    cachedAreas.contactListArea ||
    (cachedAreas.firstContact && Date.now() - (cache?.unreadMeasuredAt || 0) < 30_000)
  )
    return cachedAreas

  if (Date.now() < (unreadAreaRetryAfter.get(appType) || 0)) {
    return cachedAreas
  }

  // 没有缓存，调 VLM 检测
  console.log('[VisionUtils] 缓存不存在，开始 VLM 检测')
  const result = await detectUnreadArea(aiClient, appType)

  if (!result.success) {
    unreadAreaRetryAfter.set(appType, Date.now() + UNREAD_AREA_RETRY_DELAY_MS)
    console.error('[VisionUtils] 检测失败:', result.error)
    return cachedAreas
  }

  unreadAreaRetryAfter.delete(appType)

  return {
    chatEntranceArea: result.chatEntranceArea || null,
    firstContact: result.firstContact || null,
    contactListArea: result.contactListArea || null
  }
}

/**
 * 从 chatMainArea 反推输入框区域（纯计算，无外部调用）
 *
 * 原理：
 * - 窗口右侧 = chatMainArea（聊天记录区）+ InputArea（文字输入区）上下排列
 * - InputArea.x1 = chatMainArea.x1（同宽左边）
 * - InputArea.x2 = chatMainArea.x2（同宽右边）
 * - InputArea.y1 = chatMainArea.y2（chatMainArea 底边 = InputArea 顶边）
 * - InputArea.y2 = 1000（窗口底边）
 */
export function getInputAreaFromCache(appType: AppType): LayoutAreaItem | null {
  const cache = getLayoutCache(appType)

  // VLM 派生坐标随窗口位置/缩放变化，使用当前 bounds 重新换算。
  // box-select 的 rect-only 区域没有 bbox，保留其绝对坐标。
  if (cache?.messageInputArea) {
    if (!cache.messageInputArea.bbox) return cache.messageInputArea
    const info = getWindowInfoSync(appType)
    if (!info) return null
    return {
      ...cache.messageInputArea,
      coordinates: bboxToScreenCoords(cache.messageInputArea.bbox, info.bounds, info.scaleFactor)
    }
  }

  // 从 chatMainArea 反推
  if (!cache?.chatMainArea) {
    console.warn('[VisionUtils] chatMainArea 不存在，无法反推 inputArea')
    return null
  }

  if (!cache.chatMainArea.bbox) {
    console.warn('[VisionUtils] chatMainArea 没有 bbox，无法反推 inputArea')
    return null
  }

  const [x1, , x2, y2] = cache.chatMainArea.bbox
  if (y2 < 450 || y2 > 930 || x2 - x1 < 200) return null
  const inputBbox: BBox = [x1, y2, x2, 1000] // chatMainArea 底边 → 窗口底边

  // 需要窗口信息来转换坐标
  // 这里用 chatMainArea 的坐标来估算：inputArea 中心 = (x1+x2)/2, (y2+1000)/2
  // 但更精确的方式是拿窗口 bounds 转换
  const windowInfo = getWindowInfoSync(appType)
  if (!windowInfo?.bounds) {
    console.warn('[VisionUtils] 窗口信息不可用，使用粗略坐标估算')
    return null
  }

  const { bounds, scaleFactor } = windowInfo
  const coordinates = bboxToScreenCoords(inputBbox, bounds, scaleFactor)
  const messageInputArea: LayoutAreaItem = { bbox: inputBbox, coordinates }

  // 写入缓存
  setLayoutCache(appType, {
    ...cache,
    messageInputArea,
    timestamp: Date.now()
  })

  console.log('[VisionUtils] 从 chatMainArea 反推 inputArea:', {
    chatMainArea: cache.chatMainArea.bbox,
    inputArea: inputBbox,
    coordinates
  })

  return messageInputArea
}

// ── 布局主检测 Prompt ──

const LAYOUT_DETECT_PROMPTS: Record<'wechat' | 'wework', { prompt: string; targets: string[] }> = {
  wechat: {
    prompt: `你是一个微信布局解析专家。你熟知微信桌面端的布局。

## 微信桌面端布局
- 最左侧一列是导航栏
- 左侧第二列是聊天联系人列表，顶部是搜索输入框
- 第三列是对话区域，由上中下三部分组成：顶部是 header（显示对话人名称），中间是聊天记录区，底部是文字输入区域

## 你的职责
帮我按顺序框选以下四个区域，每个区域用 <bbox>x1,y1,x2,y2</bbox> 格式，坐标范围 0-1000：
1. 【搜索输入框】— 聊天联系人列表顶部的搜索栏
2. 【对话窗口header区域】— 对话区域最顶上一条，显示当前对话人的名称
3. 【聊天记录区】— 右侧完整聊天面板的历史区域，从左侧会话列表的分隔线一直到右侧面板边缘，不要只框住现有气泡、图片或头像；不包含输入框和工具栏
4. 【消息文字输入框】— 底部可编辑文字的空白区域，不包含表情/文件工具栏、发送按钮和窗口边框；若无法确认请不输出第4个框
若左侧是聊天列表，右侧只有空白微信占位标志、尚未选择聊天，只输出 [EMPTY_CHAT]。公众号文章、网页、订阅号列表或其他没有可编辑聊天输入框的页面只输出 [NO_CHAT_INPUT]，不要猜测输入框。`,
    targets: ['【搜索输入框】', '【对话窗口header区域】', '【聊天记录区】', '【消息文字输入框】']
  },
  wework: {
    prompt: `你是一个企业微信布局解析专家。企业微信Mac客户端界面是三栏式布局：

- 左侧导航栏：顶部用户头像，功能菜单（消息/通讯录/邮件/日程/工作台）
- 中间消息列表：顶部搜索框+加号，下面是消息项
- 右侧聊天区：顶部header、中间聊天记录区、底部输入框

## 你的职责
帮我按顺序框选以下四个区域，每个区域用 <bbox>x1,y1,x2,y2</bbox> 格式，坐标范围 0-1000：
1. 【搜索输入框】— 中间消息列表顶部的搜索栏
2. 【右侧聊天区顶部】— 右侧聊天区最顶上一条，显示当前聊天人/群名
3. 【聊天记录区】— 右侧完整聊天面板的历史区域，从会话列表分隔线一直到右侧面板边缘，不要只框住气泡、图片或头像；不包含输入框和工具栏
4. 【消息文字输入框】— 底部可编辑文字的空白区域，不包含表情/文件工具栏、发送按钮和窗口边框；若无法确认请不输出第4个框
若左侧是消息列表，右侧为空白占位标志、尚未选择聊天，只输出 [EMPTY_CHAT]。公众号文章、网页、订阅号列表或其他没有可编辑聊天输入框的页面只输出 [NO_CHAT_INPUT]，不要猜测输入框。`,
    targets: ['【搜索输入框】', '【右侧聊天区顶部】', '【聊天记录区】', '【消息文字输入框】']
  }
}

export function isUsableMessageInput(input: BBox, chat: BBox, windowHeight: number): boolean {
  const centerX = (input[0] + input[2]) / 2
  const centerY = (input[1] + input[3]) / 2
  // Models sometimes crop the history box around visible bubbles while the
  // editor extends farther right. Require a shared panel and a center inside
  // the history box, but do not mistake that cropped right edge for a wall.
  const overlap = Math.min(input[2], chat[2]) - Math.max(input[0], chat[0])
  return (
    input[2] - input[0] >= 60 &&
    ((input[3] - input[1]) / 1000) * windowHeight >= 12 &&
    input[1] >= 450 &&
    centerY >= 600 &&
    centerY <= 970 &&
    centerX >= chat[0] &&
    centerX <= chat[2] &&
    input[0] >= chat[0] - 100 &&
    overlap >= 0.6 * Math.min(input[2] - input[0], chat[2] - chat[0])
  )
}

/**
 * 检测微信/企微主布局：搜索输入框 + header区域 + 聊天记录区
 * 结果写入 LayoutCache
 */
export async function detectWechatLayout(
  aiClient: VisionClient,
  appType: AppType
): Promise<{
  success: boolean
  searchInputBox?: LayoutAreaItem
  headerArea?: LayoutAreaItem
  chatMainArea?: LayoutAreaItem
  error?: string
  recoverable?: boolean
  canOpenUnread?: boolean
}> {
  try {
    console.log('[VisionUtils] 开始微信布局检测...')

    // 1. 截图
    const screenshotResult = await captureWechatWindow(appType)
    if (!screenshotResult.success || !screenshotResult.screenshotBase64) {
      return { success: false, error: screenshotResult.error || '截图失败' }
    }

    // 2. 获取窗口信息
    const windowInfo = await getWindowInfo(appType, false)
    if (!windowInfo?.bounds || !windowInfo?.scaleFactor) {
      return { success: false, error: '获取窗口信息失败' }
    }

    // 3. 选择 prompt
    const promptKey = appType === 'wework' ? 'wework' : 'wechat'
    const config = LAYOUT_DETECT_PROMPTS[promptKey]

    // 4. 调 VLM
    console.log('[VisionUtils] 调用 VLM 检测布局...')
    const vlmResult = await aiClient.detectVision(config.prompt, screenshotResult.screenshotBase64)
    console.log('[VisionUtils] VLM 布局检测返回:', vlmResult.slice(0, 300))
    if (/\[EMPTY_CHAT\]/i.test(vlmResult)) {
      const cache = getLayoutCache(appType)
      if (cache)
        setLayoutCache(appType, {
          ...cache,
          headerArea: null,
          chatMainArea: null,
          messageInputArea: null
        })
      return {
        success: false,
        recoverable: true,
        canOpenUnread: true,
        error: '尚未打开聊天，正在检查左侧未读联系人'
      }
    }
    if (/\[NO_CHAT_INPUT\]/i.test(vlmResult)) {
      clearLayoutCache(appType)
      return {
        success: false,
        recoverable: true,
        error: '当前页面没有聊天输入框，请返回普通聊天，引擎会自动恢复'
      }
    }

    // 5. 解析 bbox
    const bboxes = parseBBoxes(vlmResult)
    if (bboxes.length < 3) {
      return {
        success: false,
        recoverable: true,
        error: '布局区域暂未识别完整，等待普通聊天页面后重新测量'
      }
    }

    let inputBbox = bboxes[3]
    if (inputBbox && !isUsableMessageInput(inputBbox, bboxes[2], windowInfo.bounds.height)) {
      console.log('[VisionUtils] 输入框区域不可靠，单独复核可编辑区域')
      const verified = await aiClient.detectVision(
        '只定位当前窗口右侧底部可以输入聊天文字的可编辑空白区域，排除工具栏、发送按钮、历史气泡和网页。输出一个归一化0-1000的 <bbox>x1,y1,x2,y2</bbox>。公众号文章、网页或任何没有聊天编辑框的页面，只输出 [NO_CHAT_INPUT]，不得猜测。',
        screenshotResult.screenshotBase64
      )
      const verifiedBoxes = parseBBoxes(verified)
      if (/\[NO_CHAT_INPUT\]/i.test(verified)) {
        clearLayoutCache(appType)
        return {
          success: false,
          recoverable: true,
          error: '当前页面没有聊天输入框，请返回普通聊天，引擎会自动恢复'
        }
      }
      if (
        verifiedBoxes.length !== 1 ||
        !isUsableMessageInput(verifiedBoxes[0], bboxes[2], windowInfo.bounds.height)
      ) {
        return {
          success: false,
          recoverable: true,
          error: '输入框暂未可靠识别，稍后重试或使用手动框选'
        }
      }
      inputBbox = verifiedBoxes[0]
    }
    // The same accepted editor provides independent evidence that the right
    // panel continues past a bubble-cropped history box. Include that visible
    // portion in history/diff/self-bubble checks; never extrapolate to the
    // full window width or use the editor as a click target without validation.
    if (inputBbox && bboxes[2][2] < inputBbox[2]) {
      bboxes[2] = [bboxes[2][0], bboxes[2][1], inputBbox[2], bboxes[2][3]]
    }
    // A VLM often includes the toolbar/input top in chatMain. Trust a valid editor
    // separately and trim the history ROI instead of rejecting the entire startup.
    if (inputBbox && bboxes[2][3] > inputBbox[1] - 12) {
      const bottom = inputBbox[1] - 12
      if (bottom <= bboxes[2][1] + 120) {
        return {
          success: false,
          recoverable: true,
          error: '聊天记录区暂未可靠识别，请保持窗口可见后重试'
        }
      }
      bboxes[2] = [bboxes[2][0], bboxes[2][1], bboxes[2][2], bottom]
    }

    const { bounds, scaleFactor } = await matchingWindowInfo(appType, screenshotResult)

    // 6. 转换坐标
    const searchInputBox: LayoutAreaItem | undefined = bboxes[0]
      ? { bbox: bboxes[0], coordinates: bboxToScreenCoords(bboxes[0], bounds, scaleFactor) }
      : undefined

    const headerArea: LayoutAreaItem | undefined = bboxes[1]
      ? { bbox: bboxes[1], coordinates: bboxToScreenCoords(bboxes[1], bounds, scaleFactor) }
      : undefined

    const chatMainArea: LayoutAreaItem | undefined = bboxes[2]
      ? { bbox: bboxes[2], coordinates: bboxToScreenCoords(bboxes[2], bounds, scaleFactor) }
      : undefined

    const messageInputArea: LayoutAreaItem | null = inputBbox
      ? {
          bbox: inputBbox,
          coordinates: bboxToScreenCoords(inputBbox, bounds, scaleFactor),
          source: 'vlm'
        }
      : null

    // 7. 更新缓存
    const existingCache = getLayoutCache(appType)
    setLayoutCache(appType, {
      ...(existingCache || {
        chatEntranceArea: null,
        firstContact: null,
        messageInputArea: null
      }),
      searchInputBox: searchInputBox || null,
      headerArea: headerArea || null,
      chatMainArea: chatMainArea || null,
      messageInputArea,
      timestamp: Date.now(),
      appType
    } as LayoutCache)

    console.log('[VisionUtils] 布局检测完成', {
      searchInputBox: searchInputBox?.coordinates,
      headerArea: headerArea?.coordinates,
      chatMainArea: chatMainArea?.coordinates
    })

    return { success: true, searchInputBox, headerArea, chatMainArea }
  } catch (error: any) {
    console.error('[VisionUtils] 布局检测失败:', error)
    return { success: false, error: error?.message || String(error) }
  }
}
