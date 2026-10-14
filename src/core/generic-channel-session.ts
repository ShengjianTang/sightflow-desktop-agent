// src/core/generic-channel-session.ts
// 通用 ChannelSession — 驱动 DesktopDevice，具体位置来源由设备测量后写入 LayoutCache。
//
// 设计原则：本文件只依赖 DesktopDevice 接口。所有微信特定的行为（如 layoutCache 清理、
// VLM bbox 状态同步）都封装到具体设备的 onSessionStart / onSessionStop / clearUnreadCache
// 里，使 channel session 在不同设备之间真正可复用。

import { DesktopDevice } from './device'
import { isDesktopStateError } from './desktop-errors'
import { ReplyGuard } from './reply-guard'
import {
  ChannelContext,
  ChannelSession,
  ChatObservation,
  ProviderEvent,
  SessionEvent
} from './session-types'

export interface GenericChannelState {
  measuredAt: number | null
  latestChatBaseline: number | null
}

export function createInitialGenericChannelState(): GenericChannelState {
  return {
    measuredAt: null,
    latestChatBaseline: null
  }
}

export class GenericChannelSession implements ChannelSession<GenericChannelState> {
  private readonly retryDelayMs = 5000
  private readonly pollDelayMs = 1200
  private bootstrapRetryCount = 0
  private consecutiveUnreadFailures = 0
  private skipDiffRetryUsed = false
  private observingNonChat = false
  private readonly replyGuard = new ReplyGuard()
  private observation: ChatObservation | undefined
  private observationVersion = 0
  private completedObservationVersion = -1
  private providerInFlight = false

  constructor(private readonly device: DesktopDevice) {}

  async onStart(ctx: ChannelContext<GenericChannelState>): Promise<void> {
    this.device.setAppType(ctx.appType)
    this.device.clearChatBaseline()
    this.bootstrapRetryCount = 0
    this.consecutiveUnreadFailures = 0
    this.skipDiffRetryUsed = false
    this.observingNonChat = false
    this.replyGuard.clear()
    this.observation = undefined
    this.observationVersion++
    this.providerInFlight = false
    this.resetState(ctx.state)
    await this.device.onSessionStart?.()
    ctx.host.enqueue({ type: 'bootstrap' })
  }

  async onStop(ctx: ChannelContext<GenericChannelState>): Promise<void> {
    this.device.clearChatBaseline()
    this.bootstrapRetryCount = 0
    this.consecutiveUnreadFailures = 0
    this.skipDiffRetryUsed = false
    this.observingNonChat = false
    this.replyGuard.clear()
    this.observation = undefined
    this.observationVersion++
    this.providerInFlight = false
    await this.device.onSessionStop?.()
    this.resetState(ctx.state)
  }

  async onEvent(event: SessionEvent, ctx: ChannelContext<GenericChannelState>): Promise<void> {
    this.device.setAppType(ctx.appType)
    if (
      'observationId' in event &&
      event.observationId !== undefined &&
      event.observationId !== this.observationVersion
    )
      return

    if (
      (event.type === 'provider.reply_text' ||
        event.type === 'provider.skip' ||
        event.type === 'provider.error') &&
      event.observationId !== undefined
    ) {
      if (this.completedObservationVersion === event.observationId) return
      this.completedObservationVersion = event.observationId
      this.providerInFlight = false
    }

    switch (event.type) {
      case 'bootstrap': {
        ctx.host.log('thinking', '正在识别聊天窗口布局...')
        const measureStart = Date.now()
        const result = await this.device.measureLayout()
        if (!ctx.host.isRunning()) return

        if (!result.success) {
          const detail = result.error || '界面识别失败'
          ctx.host.trace({
            phase: 'observe',
            summary: '识别聊天窗口布局',
            action: { kind: 'measure' },
            outcome: {
              status: 'fail',
              detail,
              latencyMs: Date.now() - measureStart
            }
          })
          if (result.recoverable) {
            // Only the recognized empty conversation placeholder permits this bootstrap click.
            // Articles, browsers, lost focus and uncertain layouts keep waiting.
            if (result.canOpenUnread && (await this.openUnreadFromEmptyChat(ctx))) break
            ctx.host.log('skip', `${detail}，引擎保持运行，5 秒后自动重新检查`)
            ctx.host.schedule({ type: 'bootstrap' }, this.retryDelayMs)
            return
          }
          if (this.bootstrapRetryCount === 0 && this.isTransientVisionFailure(detail)) {
            this.bootstrapRetryCount = 1
            ctx.host.log('thinking', `布局识别暂时失败（${detail}），5 秒后重试一次`)
            ctx.host.schedule({ type: 'bootstrap' }, this.retryDelayMs)
            return
          }
          ctx.host.log('error', `${detail}，引擎无法启动`)
          await ctx.host.stopSession('bootstrap_failed')
          return
        }

        this.bootstrapRetryCount = 0
        ctx.state.measuredAt = Date.now()
        ctx.host.log('thinking', '聊天窗口识别完成')
        ctx.host.trace({
          phase: 'observe',
          summary: '识别聊天窗口布局',
          action: { kind: 'measure' },
          outcome: { status: 'ok', latencyMs: Date.now() - measureStart }
        })
        ctx.host.enqueue({ type: 'observe_chat' })
        break
      }

      case 'observe_chat': {
        if (this.providerInFlight) break
        const observationId = ++this.observationVersion
        this.providerInFlight = true
        let screenshot: string
        try {
          screenshot = this.device.captureStableScreenshot
            ? await this.device.captureStableScreenshot(
                () => ctx.host.isRunning() && observationId === this.observationVersion
              )
            : await this.device.screenshot()
        } catch (error: unknown) {
          if (observationId !== this.observationVersion || !ctx.host.isRunning()) break
          this.providerInFlight = false
          if (!isDesktopStateError(error)) throw error
          this.waitForDesktop(ctx, error.message)
          break
        }
        if (observationId !== this.observationVersion || !ctx.host.isRunning()) break
        ctx.host.trace({
          phase: 'observe',
          summary: '截取当前聊天窗口',
          screenshotBase64: screenshot
        })
        this.observation = this.device.getObservationContext?.()
        void this.forwardProviderEvents(screenshot, ctx, observationId, this.observation)
        break
      }

      case 'provider.thinking':
        ctx.host.log('thinking', event.content)
        ctx.host.trace({
          phase: 'think',
          summary: event.content,
          reasoning: { content: event.content }
        })
        break

      case 'provider.reply_text': {
        this.skipDiffRetryUsed = false
        this.observingNonChat = false
        const blocked = this.replyGuard.rejection(event, this.observation)
        if (blocked) {
          ctx.host.log('skip', `本轮未发送：${blocked}`)
          await this.updateBaseline(ctx)
          ctx.host.enqueue({ type: 'check_unread' })
          break
        }
        this.replyGuard.remember(event, this.observation)
        const pending = this.replyGuard.context(
          this.observation?.conversationId || 'unknown'
        ).pendingIncomingMessages
        if (pending.length > 1)
          ctx.host.log(
            'thinking',
            `已合并本会话 ${pending.length} 条待回复消息，结合上下文发送一次回复`
          )
        const sendStart = Date.now()
        try {
          await this.device.sendMessage(event.content)
        } catch (error: unknown) {
          if (!isDesktopStateError(error)) throw error
          ctx.host.trace({
            phase: 'act',
            summary: '当前桌面状态不适合发送，等待恢复',
            outcome: { status: 'fail', detail: error.message }
          })
          if (error.sendPhase !== 'before_paste') {
            this.replyGuard.record(event.content, this.observation, event)
            ctx.host.log('error', '内容可能已粘贴或发送，请检查输入框；不会自动重发原回复')
            await this.updateBaseline(ctx)
          }
          if (error.code === 'conversation_changed' && error.sendPhase === 'before_paste') {
            ctx.host.log('thinking', `${error.message}；保留待回复内容，合并后重新分析`)
            ctx.host.schedule({ type: 'observe_chat' }, this.pollDelayMs)
          } else this.waitForDesktop(ctx, error.message)
          break
        }
        this.replyGuard.record(event.content, this.observation, event)
        ctx.host.log('reply', event.content)
        ctx.host.trace({
          phase: 'act',
          summary: '发送回复',
          action: { kind: 'send', payload: event.content },
          outcome: { status: 'ok', latencyMs: Date.now() - sendStart }
        })
        await this.updateBaseline(ctx)
        ctx.host.enqueue({ type: 'check_unread' })
        break
      }

      case 'provider.skip':
        if (event.category === 'self')
          this.replyGuard.acknowledgeSelf(event.latestMessage, this.observation)
        this.observingNonChat = event.category === 'non_chat' || event.category === 'draft'
        // A multimodal model can occasionally return [SKIP] for an image-only
        // message even though the chat area changed. Check the old baseline
        // once before accepting the skip, then re-analyze the same screenshot.
        if (!event.reason && !this.skipDiffRetryUsed) {
          const diffResult = await this.device.hasChatAreaChanged()
          if (diffResult.hasDiff) {
            this.skipDiffRetryUsed = true
            ctx.host.log('thinking', '检测到聊天区有新内容，正在重新分析图片消息...')
            await this.updateBaseline(ctx)
            ctx.host.enqueue({ type: 'observe_chat' })
            break
          }
        }
        this.skipDiffRetryUsed = false
        ctx.host.log(
          'skip',
          event.reason
            ? `本轮未发送：${event.reason}${event.latestMessage ? `；最新内容：${event.latestMessage.slice(0, 120)}` : ''}`
            : '本轮无需回复'
        )
        ctx.host.trace({
          phase: 'think',
          summary: event.reason || '判断本轮无需回复',
          outcome: { status: 'skip' }
        })
        await this.updateBaseline(ctx)
        ctx.host.enqueue({ type: 'check_unread' })
        break

      case 'provider.error':
        ctx.host.log('error', `回复服务异常：${event.error}`)
        ctx.host.trace({
          phase: 'think',
          summary: '回复服务异常',
          outcome: { status: 'fail', detail: event.error }
        })
        ctx.host.enqueue({
          type: 'wait_retry',
          reason: 'provider_error',
          delayMs: this.retryDelayMs
        })
        break

      case 'check_unread': {
        try {
          const diffResult = await this.device.hasChatAreaChanged()
          if (diffResult.error) {
            ctx.host.log('error', `聊天检测失败：${diffResult.error}`)
            if (diffResult.needsLayout) {
              ctx.host.schedule({ type: 'bootstrap' }, this.retryDelayMs)
              break
            }
            ctx.host.enqueue({
              type: 'wait_retry',
              reason: 'detection_error',
              delayMs: this.retryDelayMs
            })
            break
          }
          if (diffResult.hasDiff) {
            ctx.host.log('thinking', '检测到当前对话有新消息')
            ctx.host.trace({
              phase: 'verify',
              summary: '检测到当前对话有新消息',
              outcome: { status: 'ok' }
            })
            ctx.host.enqueue({ type: 'observe_chat' })
            break
          }

          if (!diffResult.hasBaseline) {
            ctx.host.enqueue({ type: 'observe_chat' })
            break
          }
          if (this.observingNonChat) {
            ctx.host.enqueue({
              type: 'wait_retry',
              reason: 'non_chat_page',
              delayMs: this.pollDelayMs
            })
            break
          }

          const unreadResult = await this.device.hasUnreadMessage((detail) =>
            ctx.host.log('thinking', detail)
          )
          if (!ctx.host.isRunning()) return
          if (unreadResult.error) {
            ctx.host.log('error', `未读检测失败：${unreadResult.error}`)
            if (++this.consecutiveUnreadFailures >= 2) {
              this.device.clearUnreadCache()
              this.consecutiveUnreadFailures = 0
              ctx.host.log('thinking', '未读定位连续失败，已清除旧坐标，下一轮重新识别列表')
            }
            ctx.host.enqueue({
              type: 'wait_retry',
              reason: 'detection_error',
              delayMs: this.retryDelayMs
            })
            break
          }
          if (!unreadResult.hasUnread) {
            ctx.host.enqueue({
              type: 'wait_retry',
              reason: 'no_unread',
              detail: unreadResult.detail,
              delayMs: this.pollDelayMs
            })
            break
          }

          // The local badge scan already knows the actual visible row. Avoid double-clicking
          // navigation and then guessing the first contact (which can be a pinned conversation).
          if (unreadResult.unreadContactCoords) {
            await this.device.clickUnreadContact(unreadResult.unreadContactCoords)
            await this.sleep(250)
            const switched = await this.device.hasChatAreaChanged()
            if (switched.error || (switched.hasBaseline && !switched.hasDiff)) {
              ctx.host.log('skip', switched.error || '点击后聊天区未变化，等待下一轮核实联系人')
              if (++this.consecutiveUnreadFailures >= 2) {
                this.device.clearUnreadCache()
                this.consecutiveUnreadFailures = 0
                ctx.host.log('thinking', '会话切换未生效，已清除旧联系人位置，下一轮重新定位')
              }
              ctx.host.enqueue({
                type: 'wait_retry',
                reason: 'contact_not_ready',
                delayMs: this.pollDelayMs
              })
              break
            }
            this.consecutiveUnreadFailures = 0
            this.device.clearChatBaseline()
            ctx.state.latestChatBaseline = null
            ctx.host.log('thinking', '已打开检测到的未读联系人')
            ctx.host.enqueue({ type: 'observe_chat' })
            break
          }

          const chatEntranceCoords = unreadResult.chatEntranceArea?.coordinates
          if (!chatEntranceCoords) {
            ctx.host.log('error', '检测到未读消息，但未找到聊天入口位置')
            ctx.host.enqueue({
              type: 'wait_retry',
              reason: 'missing_chat_entrance',
              delayMs: this.retryDelayMs
            })
            break
          }

          ctx.host.log('thinking', '检测到未读消息，正在尝试打开会话')
          ctx.host.trace({
            phase: 'act',
            summary: '点击未读会话入口',
            action: { kind: 'click', target: chatEntranceCoords },
            outcome: { status: 'ok' }
          })
          await this.device.activeUnreadByClick(chatEntranceCoords)
          await this.sleep(150 + Math.random() * 100)

          // WeChat's navigation double-click can open the conversation immediately,
          // clearing its badge before the subsequent contact scan.
          const openedDiff = await this.device.hasChatAreaChanged()
          if (openedDiff.hasDiff) {
            this.device.clearChatBaseline()
            ctx.state.latestChatBaseline = null
            ctx.host.enqueue({ type: 'observe_chat' })
            break
          }

          const openResult = await this.tryOpenUnreadConversation(ctx)
          if (openResult === 'opened') {
            ctx.host.enqueue({ type: 'observe_chat' })
            break
          }

          ctx.host.enqueue({
            type: 'wait_retry',
            reason: openResult,
            delayMs: this.retryDelayMs
          })
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : String(error)
          ctx.host.log('error', `未读检测或会话切换失败：${detail}`)
          ctx.host.enqueue({
            type: 'wait_retry',
            reason: 'detection_error',
            delayMs: this.retryDelayMs
          })
        }
        break
      }

      case 'wait_retry':
        ctx.host.log(
          'skip',
          event.detail
            ? `${event.detail}；等待下一轮检测`
            : event.reason === 'no_unread'
              ? '当前聊天无新增消息，未发现可切换的未读联系人；等待下一轮检测'
              : '等待下一轮未读检测'
        )
        ctx.host.schedule(
          event.reason === 'provider_error' ? { type: 'observe_chat' } : { type: 'check_unread' },
          event.delayMs ?? this.retryDelayMs
        )
        break
    }
  }

  private async forwardProviderEvents(
    screenshot: string,
    ctx: ChannelContext<GenericChannelState>,
    observationId: number,
    observation?: ChatObservation
  ): Promise<void> {
    try {
      for await (const event of ctx.host.runProvider({
        screenshot,
        appType: ctx.appType,
        captureContext: this.device.getCaptureContext?.(),
        observation,
        recentSentMessages: this.replyGuard.recent(observation?.conversationId || 'unknown'),
        ...this.replyGuard.context(observation?.conversationId || 'unknown')
      })) {
        if (!ctx.host.isRunning() || observationId !== this.observationVersion) break

        const sessionEvent = this.mapProviderEvent(event)
        if (sessionEvent) {
          ctx.host.enqueue({ ...sessionEvent, observationId } as SessionEvent)
        }
        // A Provider may emit only one terminal decision per observation.
        if (event.type !== 'thinking') return
      }
      if (ctx.host.isRunning() && observationId === this.observationVersion)
        ctx.host.enqueue({
          type: 'provider.skip',
          category: 'uncertain',
          reason: '回复服务未给出有效判断',
          observationId
        })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.host.enqueue({ type: 'provider.error', error: message, observationId })
    }
  }

  private mapProviderEvent(event: ProviderEvent): SessionEvent | null {
    switch (event.type) {
      case 'thinking':
        return { type: 'provider.thinking', content: event.content }
      case 'reply_text':
        return {
          type: 'provider.reply_text',
          content: event.content,
          latestMessage: event.latestMessage,
          sender: event.sender,
          senderBbox: event.senderBbox,
          messages: event.messages
        }
      case 'skip':
        return {
          type: 'provider.skip',
          ...(event.reason ? { reason: event.reason } : {}),
          ...(event.latestMessage ? { latestMessage: event.latestMessage } : {}),
          ...(event.category ? { category: event.category } : {})
        }
      case 'error':
        return { type: 'provider.error', error: event.error }
      default:
        return null
    }
  }

  private resetState(state: GenericChannelState): void {
    state.measuredAt = null
    state.latestChatBaseline = null
  }

  private waitForDesktop(ctx: ChannelContext<GenericChannelState>, detail: string): void {
    ctx.host.log('skip', `${detail}；引擎保持运行，等待聊天窗口恢复`)
    ctx.host.enqueue({
      type: 'wait_retry',
      reason: 'desktop_not_ready',
      delayMs: this.retryDelayMs
    })
  }

  private async updateBaseline(ctx: ChannelContext<GenericChannelState>): Promise<void> {
    try {
      const saved =
        this.device.commitObservationBaseline?.() || (await this.device.setChatBaseline())
      ctx.state.latestChatBaseline = saved ? Date.now() : null
    } catch (error: unknown) {
      if (!isDesktopStateError(error)) throw error
      ctx.host.log('skip', `聊天基线暂未更新：${error.message}`)
      ctx.state.latestChatBaseline = null
    }
  }

  private isTransientVisionFailure(message: string): boolean {
    return /请求超时|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message)
  }

  private async openUnreadFromEmptyChat(
    ctx: ChannelContext<GenericChannelState>
  ): Promise<boolean> {
    try {
      const unread = await this.device.hasUnreadMessage()
      if (unread.error) ctx.host.log('error', `未读检测失败：${unread.error}`)
      if (!ctx.host.isRunning() || !unread.hasUnread || !unread.unreadContactCoords) return false
      await this.device.clickUnreadContact(unread.unreadContactCoords)
      await this.sleep(250)
      this.device.clearChatBaseline()
      this.observation = undefined
      ctx.state.latestChatBaseline = null
      ctx.host.log('thinking', '已从左侧列表打开未读联系人，正在重新识别聊天布局')
      ctx.host.enqueue({ type: 'bootstrap' })
      return true
    } catch (error: unknown) {
      ctx.host.log(
        'error',
        `打开未读会话暂时失败：${error instanceof Error ? error.message : String(error)}`
      )
      return false
    }
  }

  private async tryOpenUnreadConversation(
    ctx: ChannelContext<GenericChannelState>
  ): Promise<'opened' | 'contact_not_ready'> {
    let contactResult = await this.device.isChatContactUnread()

    if (!contactResult.isUnread) {
      ctx.host.log('thinking', '当前会话没有新消息，正在重新检测...')
      await this.sleep(1000)

      const recheckResult = await this.device.hasUnreadMessage()
      const recheckCoords = recheckResult.chatEntranceArea?.coordinates

      if (!recheckResult.hasUnread || !recheckCoords) {
        ctx.host.log('skip', '重新检测后无未读消息，等待下一轮')
        return 'contact_not_ready'
      }

      ctx.host.log('thinking', '仍检测到未读消息，正在再次尝试打开会话')
      await this.device.activeUnreadByClick(recheckCoords)
      await this.sleep(500)
      contactResult = await this.device.isChatContactUnread()
    }

    if (!contactResult.isUnread) {
      this.consecutiveUnreadFailures += 1

      if (this.consecutiveUnreadFailures >= 3) {
        ctx.host.log(
          'thinking',
          `连续 ${this.consecutiveUnreadFailures} 次检测失败，正在重置未读识别状态`
        )
        this.device.clearUnreadCache()
        this.consecutiveUnreadFailures = 0
        await this.sleep(500)

        contactResult = await this.device.isChatContactUnread()
        if (!contactResult.isUnread) {
          ctx.host.log('thinking', '重置后仍未成功，正在再次尝试打开会话')
          const retryUnread = await this.device.hasUnreadMessage()
          const retryCoords = retryUnread.chatEntranceArea?.coordinates

          if (!retryUnread.hasUnread || !retryCoords) {
            ctx.host.log('skip', '重置后仍未找到可用会话入口，等待下一轮')
            return 'contact_not_ready'
          }

          await this.device.activeUnreadByClick(retryCoords)
          await this.sleep(500)
          contactResult = await this.device.isChatContactUnread()

          if (!contactResult.isUnread) {
            ctx.host.log('skip', '最终检测仍失败，放弃当前轮未读切换')
            return 'contact_not_ready'
          }
        }
      } else {
        ctx.host.log(
          'skip',
          `会话切换检测失败（第 ${this.consecutiveUnreadFailures} 次），等待下一轮`
        )
        return 'contact_not_ready'
      }
    }

    this.consecutiveUnreadFailures = 0

    if (!contactResult.firstContactCoords) {
      ctx.host.log('skip', '未找到联系人位置，等待下一轮')
      return 'contact_not_ready'
    }

    ctx.host.log('thinking', '正在打开未读会话')
    ctx.host.trace({
      phase: 'act',
      summary: '打开未读会话',
      action: { kind: 'click', target: contactResult.firstContactCoords },
      outcome: { status: 'ok' }
    })
    await this.device.clickUnreadContact(contactResult.firstContactCoords)
    await this.sleep(500 + Math.random() * 300)
    this.device.clearChatBaseline()
    ctx.state.latestChatBaseline = null
    return 'opened'
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
