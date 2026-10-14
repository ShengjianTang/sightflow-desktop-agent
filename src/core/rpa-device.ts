// src/core/rpa-device.ts
// RPADevice — DesktopDevice 的真实 RPA 实现
//
// 串联 screenshot-utils、input-utils、has-unread、vision-utils
// 所有感知和动作能力在这里汇聚

import { DesktopDevice } from './device'
import { captureStableChat, outgoingBubbleBottom } from './chat-observation'
import type { ChatObservation } from './session-types'
import { createHash } from 'node:crypto'
import { DesktopStateError, isDesktopStateError } from './desktop-errors'
import { AIClient } from './ai-client'
import type { VisionClient } from './vision-client'
import { AppType } from './rpa/types'
import { BBox } from './rpa/vision-utils'
import { captureWechatWindow, clearScreenshotCache } from './rpa/screenshot-utils'
import {
  sendReplyAction,
  activeUnreadByClickAction,
  clickUnreadContactAction
} from './rpa/input-utils'
import {
  hasUnreadMessage as hasUnreadMessageDetect,
  isChatContactUnread as isChatContactUnreadDetect,
  clearUnreadDetectionCache
} from './rpa/has-unread'
import {
  setChatBaseline as setChatBaselineFn,
  checkChatAreaDiff,
  clearChatBaseline as clearChatBaselineFn,
  setChatBaselineImage,
  comparePngBuffers
} from './rpa/image-compare'
import {
  clearLayoutCache,
  clearUnreadAreaRetry,
  detectWechatLayout,
  getInputAreaFromCache,
  getLayoutCache,
  setLayoutCache
} from './rpa/vision-utils'
import { getWechatWindowInfo, getWindowInfoSync } from './rpa/window-utils'

export class RPADevice implements DesktopDevice {
  private appType: AppType = 'wechat'
  private aiClient: VisionClient | null = null
  private lastReplyHeader: Buffer | null = null
  private observedHistory: Electron.NativeImage | null = null
  private observation: ChatObservation | undefined
  private layoutWait: {
    hash: string
    retryAfter: number
    error: string
    canOpenUnread?: boolean
  } | null = null

  setAppType(appType: AppType): void {
    this.appType = appType
  }

  setApiKey(apiKey: string): void {
    this.aiClient = apiKey ? new AIClient({ apiKey }) : null
  }

  setModel(model: string): void {
    if (this.aiClient instanceof AIClient) this.aiClient.updateConfig({ model })
  }

  setVisionClient(client: VisionClient): void {
    this.aiClient = client
  }

  // ── 生命周期 ──
  async onSessionStart(): Promise<void> {
    this.layoutWait = null
    this.lastReplyHeader = null
    this.observedHistory = null
    this.observation = undefined
    const info = await getWechatWindowInfo(this.appType, true)
    // Activation is only intentional on engine start; never steal a browser's focus in polling.
    if (process.platform === 'win32' && info?.wechatWindow?.bringToTop) {
      info.wechatWindow.bringToTop()
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
  // 旧实现里 clearLayoutCache 由 WeChatChannelSession.onStop 调用。改用 GenericChannelSession 之后，
  // 把这个微信特定的清理动作下沉到设备的 onSessionStop hook 里，让 channel session 不必感知 appType。
  onSessionStop(): void {
    clearLayoutCache(this.appType)
    clearUnreadDetectionCache(this.appType)
    this.lastReplyHeader = null
    this.observedHistory = null
    this.observation = undefined
    this.layoutWait = null
  }

  // ── 感知层 ──

  /** 启动只测量必需的主布局；未读区域在首次轮询时按需检测。 */
  async measureLayout(): Promise<{
    success: boolean
    error?: string
    recoverable?: boolean
    canOpenUnread?: boolean
  }> {
    if (!this.aiClient) {
      console.error('[RPADevice] aiClient 未初始化，无法测量布局')
      return { success: false, error: 'AI Client 未初始化' }
    }

    try {
      // 提前校验应用窗口，避免大模型成本和迷惑性报错
      const windowInfo = await getWechatWindowInfo(this.appType, true)
      if (!windowInfo) {
        const appName =
          this.appType === 'wechat' ? '微信' : this.appType === 'wework' ? '企业微信' : 'WhatsApp'
        return {
          success: false,
          recoverable: true,
          error: `未找到${appName}窗口，请确保已打开且未被完全遮挡/最小化`
        }
      }
      if (windowInfo.foreground === false)
        return { success: false, recoverable: true, error: '聊天窗口暂不在前台，请返回聊天窗口' }
      const frame = await captureWechatWindow(this.appType)
      if (!frame.success || !frame.screenshotBase64)
        return { success: false, recoverable: true, error: frame.error || '窗口截图暂时失败' }
      const hash = createHash('sha256').update(frame.screenshotBase64).digest('hex')
      if (
        this.layoutWait &&
        this.layoutWait.hash === hash &&
        Date.now() < this.layoutWait.retryAfter
      ) {
        return {
          success: false,
          recoverable: true,
          error: this.layoutWait.error,
          canOpenUnread: this.layoutWait.canOpenUnread
        }
      }

      console.log('[RPADevice] 开始主布局测量...')
      const layoutResult = await detectWechatLayout(this.aiClient, this.appType)

      if (layoutResult.success) {
        console.log('[RPADevice] 主布局:', {
          searchInputBox: layoutResult.searchInputBox?.coordinates,
          headerArea: layoutResult.headerArea?.coordinates,
          chatMainArea: layoutResult.chatMainArea?.coordinates
        })

        // 从 chatMainArea 反推 inputArea（纯计算）
        const inputArea = getInputAreaFromCache(this.appType)
        if (inputArea) {
          console.log('[RPADevice] 输入框（反推）:', inputArea.coordinates)
        } else {
          console.warn('[RPADevice] 输入框反推失败')
        }
      } else {
        console.warn('[RPADevice] 主布局检测失败:', layoutResult.error)
      }

      if (!layoutResult.success) {
        const error = `布局测量失败: ${layoutResult.error || '主布局检测失败'}`
        if (layoutResult.recoverable)
          this.layoutWait = {
            hash,
            retryAfter: Date.now() + 20_000,
            error,
            canOpenUnread: layoutResult.canOpenUnread
          }
        return {
          success: false,
          error,
          recoverable: layoutResult.recoverable,
          canOpenUnread: layoutResult.canOpenUnread
        }
      }

      const inputArea = getInputAreaFromCache(this.appType)
      if (!layoutResult.chatMainArea || !inputArea) {
        return { success: false, recoverable: true, error: '布局测量失败: 缺少聊天区或输入框位置' }
      }

      this.layoutWait = null
      console.log('[RPADevice] 布局测量完成 ✓')
      return { success: true }
    } catch (error: any) {
      console.error('[RPADevice] 布局测量异常:', error)
      return { success: false, error: String(error) }
    }
  }

  captureStableScreenshot(isRunning: () => boolean): Promise<string> {
    return captureStableChat(this, isRunning)
  }

  async screenshot(): Promise<string> {
    await this.ensureLayout()
    clearScreenshotCache()
    const frame = await captureWechatWindow(this.appType)
    if (!frame.success || !frame.nativeImage)
      throw new DesktopStateError('target_unavailable', frame.error || '聊天窗口截图暂时失败')
    // Include header, bubble alignment and the editor. A crop alone loses page/author context.
    this.lastReplyHeader = this.captureReplyHeader(frame.nativeImage)
    this.observedHistory = this.cropHistory(
      frame.nativeImage,
      frame.bounds,
      frame.display?.scaleFactor
    )
    this.observation = {
      conversationId: this.lastReplyHeader
        ? createHash('sha256').update(this.lastReplyHeader).digest('hex')
        : `${this.appType}:unknown`,
      historyId: createHash('sha256')
        .update(this.observedHistory?.toPNG() || frame.screenshotBase64)
        .digest('hex'),
      outgoingBubbleBottom:
        this.appType === 'wechat'
          ? outgoingBubbleBottom(
              frame.screenshotBase64,
              getLayoutCache(this.appType)?.chatMainArea?.bbox
            )
          : undefined,
      chatAreaBbox: getLayoutCache(this.appType)?.chatMainArea?.bbox
    }
    return frame.screenshotBase64
  }

  getObservationContext(): ChatObservation | undefined {
    return this.observation
  }

  commitObservationBaseline(): boolean {
    if (!this.observedHistory) return false
    setChatBaselineImage(this.observedHistory)
    return true
  }

  private cropHistory(
    image: Electron.NativeImage,
    bounds?: { width: number; height: number },
    scaleFactor = 1
  ): Electron.NativeImage | null {
    const bbox = getLayoutCache(this.appType)?.chatMainArea?.bbox
    if (!bbox) return null
    const size = image.getSize()
    const logicalWidth = bounds?.width ?? size.width / scaleFactor
    const logicalHeight = bounds?.height ?? size.height / scaleFactor
    const left = (bbox[0] / 1000) * logicalWidth
    const top = (bbox[1] / 1000) * logicalHeight
    const cropWidth = (bbox[2] / 1000) * logicalWidth - left
    const cropHeight = (bbox[3] / 1000) * logicalHeight - top
    // Match captureWechatWindow's floor/ceil crop exactly, including fractional DIP sizes.
    const x = Math.max(0, Math.floor(left * scaleFactor))
    const y = Math.max(0, Math.floor(top * scaleFactor))
    const width = Math.min(size.width, Math.ceil((left + cropWidth) * scaleFactor)) - x
    const height = Math.min(size.height, Math.ceil((top + cropHeight) * scaleFactor)) - y
    return width > 0 && height > 0 ? image.crop({ x, y, width, height }) : null
  }

  getCaptureContext(): 'full_window' {
    return 'full_window'
  }

  private captureReplyHeader(image: Electron.NativeImage): Buffer | null {
    const bbox = getLayoutCache(this.appType)?.headerArea?.bbox
    if (!bbox) return null
    const size = image.getSize()
    const x = Math.round((bbox[0] / 1000) * size.width)
    const y = Math.round((bbox[1] / 1000) * size.height)
    const width = Math.min(
      size.width - x,
      Math.round(((bbox[2] - bbox[0]) / 1000) * size.width * 0.75)
    )
    const height = Math.min(size.height - y, Math.round(((bbox[3] - bbox[1]) / 1000) * size.height))
    return width > 0 && height > 0 ? image.crop({ x, y, width, height }).toPNG() : null
  }

  async hasUnreadMessage(onProgress?: (message: string) => void): Promise<{
    hasUnread: boolean
    chatEntranceArea?: { bbox: BBox; coordinates: [number, number] }
    unreadContactCoords?: [number, number]
    detail?: string
    error?: string
  }> {
    if (!this.aiClient) {
      console.warn('[RPADevice] aiClient 未初始化，无法进行视觉检测')
      return { hasUnread: false, error: '视觉客户端未初始化' }
    }

    const result = await hasUnreadMessageDetect(this.aiClient, this.appType, onProgress)

    if (!result.success) {
      console.error('[RPADevice] hasUnreadMessage 失败:', result.error)
      return { hasUnread: false, error: result.error || '未读检测失败' }
    }

    return {
      hasUnread: result.hasUnread || false,
      chatEntranceArea: result.chatEntranceArea,
      unreadContactCoords: result.unreadContactCoords,
      detail: result.detail
    }
  }

  async isChatContactUnread(): Promise<{
    isUnread: boolean
    firstContactCoords?: [number, number]
  }> {
    if (!this.aiClient) {
      console.warn('[RPADevice] aiClient 未初始化')
      return { isUnread: false }
    }

    const result = await isChatContactUnreadDetect(this.aiClient, this.appType)

    if (!result.success) {
      console.error('[RPADevice] isChatContactUnread 失败:', result.error)
      return { isUnread: false }
    }

    return {
      isUnread: result.isUnread || false,
      firstContactCoords: result.firstContact?.coordinates
    }
  }

  /**
   * 清除未读区域的 VLM 坐标缓存（chatEntranceArea + firstContact）
   * 连续检测失败时调用：强制下次 isChatContactUnread / hasUnreadMessage 重新 VLM 定位
   */
  clearUnreadCache(): void {
    clearUnreadAreaRetry(this.appType)
    clearUnreadDetectionCache(this.appType)
    const cache = getLayoutCache(this.appType)
    if (cache) {
      cache.chatEntranceArea = null
      cache.firstContact = null
      cache.contactListArea = null
      cache.unreadMeasuredAt = undefined
      setLayoutCache(this.appType, cache)
      console.log('[RPADevice] 已清除未读区域缓存')
    }
  }

  // ── chatMainArea Diff 检测 ──

  async setChatBaseline(): Promise<boolean> {
    await this.ensureLayout()
    return setChatBaselineFn(this.appType)
  }

  async hasChatAreaChanged(): Promise<{
    hasDiff: boolean
    hasBaseline: boolean
    error?: string
    needsLayout?: boolean
  }> {
    try {
      clearScreenshotCache()
      const remeasured = await this.ensureLayout()
      if (remeasured) return { hasDiff: true, hasBaseline: false }
      return await checkChatAreaDiff(this.appType)
    } catch (error: unknown) {
      return {
        hasDiff: false,
        hasBaseline: false,
        error: error instanceof Error ? error.message : String(error),
        needsLayout: isDesktopStateError(error) && error.code === 'layout_invalid'
      }
    }
  }

  /** Moving preserves normalized bbox; resize/DPI changes invalidate and remeasure once. */
  private async ensureLayout(): Promise<boolean> {
    const info = await getWechatWindowInfo(this.appType, true)
    if (!info)
      throw new DesktopStateError(
        'target_unavailable',
        '未找到目标聊天窗口，请打开窗口并取消最小化'
      )
    if (info.foreground === false)
      throw new DesktopStateError('focus_changed', '聊天窗口暂不在前台，请关闭或切回网页后返回聊天')
    if (getLayoutCache(this.appType)?.chatMainArea) return false
    console.log('[RPADevice] 窗口布局已失效，重新测量')
    const result = await this.measureLayout()
    if (!result.success) {
      if (result.recoverable)
        throw new DesktopStateError('layout_invalid', result.error || '重新识别窗口布局失败')
      throw new Error(result.error || '重新识别窗口布局失败')
    }
    return true
  }

  clearChatBaseline(): void {
    clearChatBaselineFn()
    this.observedHistory = null
    this.observation = undefined
  }

  // ── 动作层 ──

  async sendMessage(text: string): Promise<void> {
    await this.ensureLayout()
    if (this.lastReplyHeader) {
      clearScreenshotCache()
      const frame = await captureWechatWindow(this.appType)
      if (!frame.success || !frame.nativeImage)
        throw new DesktopStateError('target_unavailable', '发送前无法确认目标聊天窗口')
      const currentHeader = this.captureReplyHeader(frame.nativeImage)
      if (
        !currentHeader ||
        comparePngBuffers(this.lastReplyHeader, currentHeader, {
          threshold: 0.1,
          changeThreshold: 0.5
        }).hasChanged
      ) {
        this.lastReplyHeader = null
        clearChatBaselineFn()
        throw new DesktopStateError(
          'conversation_changed',
          '识别期间聊天对象或页面已改变，已取消旧回复并等待重新识别'
        )
      }
      const currentHistory = this.cropHistory(
        frame.nativeImage,
        frame.bounds,
        frame.display?.scaleFactor
      )
      if (
        this.observedHistory &&
        currentHistory &&
        comparePngBuffers(this.observedHistory.toPNG(), currentHistory.toPNG()).hasChanged
      ) {
        clearChatBaselineFn()
        throw new DesktopStateError(
          'conversation_changed',
          '模型分析期间聊天内容已改变，已取消旧回复并重新识别最新消息'
        )
      }
    }
    let success: boolean
    try {
      success = await sendReplyAction(this.appType, text)
    } catch (error: unknown) {
      if (isDesktopStateError(error) && error.code === 'layout_invalid') {
        clearLayoutCache(this.appType)
        this.layoutWait = null
        this.lastReplyHeader = null
      }
      throw error
    }
    if (!success) {
      throw new DesktopStateError('send_failed', '桌面输入设备暂不可用，发送未完成')
    }
  }

  /**
   * 点击红点区域激活未读消息（视觉路线）
   * 微信场景双击，企业微信场景单击
   */
  async activeUnreadByClick(coordinates: [number, number]): Promise<void> {
    await this.prepareClick(coordinates)
    await activeUnreadByClickAction(coordinates, this.appType)
  }

  /**
   * 点击联系人列表中的第一个联系人
   */
  async clickUnreadContact(coordinates: [number, number]): Promise<void> {
    await this.prepareClick(coordinates)
    await clickUnreadContactAction(coordinates)
  }

  private async prepareClick([x, y]: [number, number]): Promise<void> {
    const previous = getWindowInfoSync(this.appType)
    const info = await getWechatWindowInfo(this.appType, true)
    if (info?.foreground === false)
      throw new DesktopStateError('focus_changed', '聊天窗口暂不在前台，已取消会话切换')
    if (
      previous &&
      info &&
      (['x', 'y', 'width', 'height'] as const).some(
        (key) => previous.bounds[key] !== info.bounds[key]
      )
    ) {
      throw new Error('检测后窗口位置或尺寸改变，已取消旧坐标点击，将在下一轮重新检测')
    }
    if (
      !info ||
      x < info.bounds.x ||
      x >= info.bounds.x + info.bounds.width ||
      y < info.bounds.y ||
      y >= info.bounds.y + info.bounds.height
    ) {
      throw new Error('点击坐标已失效，请保持聊天窗口位置稳定并重新识别')
    }
    if (process.platform === 'win32') {
      if (!info.wechatWindow.bringToTop) throw new Error('无法激活目标聊天窗口')
      info.wechatWindow.bringToTop()
      await new Promise((resolve) => setTimeout(resolve, 120))
      const { windowManager } = require('node-window-manager')
      if (windowManager.getActiveWindow()?.id !== info.wechatWindow.id) {
        throw new Error('目标聊天窗口未获得焦点，已取消会话切换')
      }
    }
  }

  async clickAt(x: number, y: number): Promise<void> {
    await clickUnreadContactAction([x, y])
  }
}
