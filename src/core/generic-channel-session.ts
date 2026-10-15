// src/core/generic-channel-session.ts
// 通用 ChannelSession — 驱动 DesktopDevice，具体位置来源由设备测量后写入 LayoutCache。
//
// 设计原则：本文件只依赖 DesktopDevice 接口。所有微信特定的行为（如 layoutCache 清理、
// VLM bbox 状态同步）都封装到具体设备的 onSessionStart / onSessionStop / clearUnreadCache
// 里，使 channel session 在不同设备之间真正可复用。

import { DesktopDevice } from './device'
import { isDesktopStateError } from './desktop-errors'
import { ReplyGuard } from './reply-guard'
import { incomingTail, messageSequenceError, sameMessage } from './chat-messages'
import {
  ChannelContext,
  ChannelSession,
  ChatObservation,
  ProviderEvent,
  ReplyBatch,
  VisibleChatMessage,
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
  private request: AbortController | undefined
  private batchId: string | undefined
  private batchSequence = 0
  private batchStartedAt = 0
  private replyModel: string | undefined
  private readonly pendingBatches = new Map<string, ReplyBatch>()
  private pendingInput: ReplyBatch | undefined
  private readyReply:
    | {
        event: Extract<SessionEvent, { type: 'provider.reply_text' }>
        observation: ChatObservation
        transcript: VisibleChatMessage[]
        appended: VisibleChatMessage[]
        currentTranscript: VisibleChatMessage[]
        attempts: number
      }
    | undefined

  constructor(private readonly device: DesktopDevice) {}

  async onStart(ctx: ChannelContext<GenericChannelState>): Promise<void> {
    this.request?.abort()
    this.pendingBatches.clear()
    this.readyReply = undefined
    this.batchId = undefined
    this.pendingInput = undefined
    this.device.setReplyPanelCapture?.(
      Boolean(ctx.host.reviewPendingReply && this.device.inspectPendingReply)
    )
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
    this.request?.abort()
    this.request = undefined
    this.batchId = undefined
    this.pendingBatches.clear()
    this.pendingInput = undefined
    this.readyReply = undefined
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
    if (event.batchId && event.batchId !== this.batchId) return
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
        if (this.providerInFlight || this.readyReply) break
        this.request?.abort()
        this.request = new AbortController()
        this.batchId = 'batch-' + ++this.batchSequence
        const captureStart = Date.now()
        this.batchStartedAt = captureStart
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
        this.pendingInput = this.observation
          ? this.pendingBatches.get(this.observation.conversationId)
          : undefined
        ctx.host.trace({
          phase: 'observe',
          summary: '截图合并完成 ' + this.batchId,
          performance: { batchId: this.batchId, stage: 'capture', code: 'OK' },
          outcome: { status: 'ok', latencyMs: Date.now() - captureStart }
        })
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

      case 'provider.metric':
        this.replyModel = event.model
        ctx.host.log(
          'thinking',
          event.stage +
            ' ' +
            event.latencyMs +
            'ms [' +
            event.code +
            '] 模型=' +
            event.model +
            ' 批次=' +
            event.batchId
        )
        ctx.host.trace({
          phase: 'think',
          summary: event.stage + ' ' + event.batchId + ' ' + event.model,
          performance: {
            batchId: event.batchId,
            stage: event.stage === 'reply_review' ? 'reply_review' : 'reply_request',
            model: event.model,
            code: event.code
          },
          outcome: {
            status: event.code === 'OK' ? 'ok' : 'skip',
            latencyMs: event.latencyMs,
            detail: event.code
          }
        })
        break

      case 'retry_batch_send': {
        if (this.readyReply && ctx.host.isRunning()) await this.sendReadyBatch(ctx)
        break
      }

      case 'provider.reply_text': {
        if (
          event.batchId &&
          this.device.getCaptureContext?.() === 'conversation_panel' &&
          this.device.inspectPendingReply &&
          ctx.host.reviewPendingReply &&
          this.observation
        ) {
          await this.acceptBatchReply(event, ctx)
          break
        }
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
          await this.device.sendMessage(event.content, this.request?.signal)
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
        if (event.category === 'empty_chat') {
          ctx.host.log('skip', '尚未打开聊天，转回未读联系人定位，不再复核回复')
          if (await this.openUnreadFromEmptyChat(ctx)) break
          ctx.host.schedule({ type: 'bootstrap' }, this.retryDelayMs)
          break
        }
        if (event.category === 'self') {
          if (this.observation && this.pendingInput)
            this.pendingBatches.delete(this.observation.conversationId)
        }
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
        const detectionStart = Date.now()
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
              performance: { stage: 'detect', code: 'CHAT_CHANGED' },
              outcome: { status: 'ok', latencyMs: Date.now() - detectionStart }
            })
            ctx.host.enqueue({ type: 'observe_chat' })
            break
          }

          if (!diffResult.hasBaseline) {
            ctx.host.enqueue({ type: 'observe_chat' })
            break
          }
          if (this.observingNonChat) {
            if (this.pendingInput && this.device.inspectPendingReply) {
              try {
                const changed = await this.device.inspectPendingReply()
                if (changed.changed && ctx.host.isRunning()) {
                  ctx.host.enqueue({ type: 'observe_chat' })
                  break
                }
              } catch (error) {
                // An editor/header change needs a new model observation, never a send.
                if (
                  isDesktopStateError(error) &&
                  error.code === 'conversation_changed' &&
                  ctx.host.isRunning()
                ) {
                  ctx.host.enqueue({ type: 'observe_chat' })
                  break
                }
              }
            }
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

  private async acceptBatchReply(
    event: Extract<SessionEvent, { type: 'provider.reply_text' }>,
    ctx: ChannelContext<GenericChannelState>
  ): Promise<void> {
    this.observingNonChat = false
    this.skipDiffRetryUsed = false
    const observation = this.observation!
    const pending = this.pendingInput
    const trusted = Boolean(
      pending &&
      pending.conversationId === observation.conversationId &&
      event.messages &&
      pending.messages.every((m, i) => event.messages?.[i] && sameMessage(m, event.messages[i]))
    )
    const blocked = trusted
      ? messageSequenceError(event, observation.chatAreaBbox)
      : this.replyGuard.rejection(event, observation)
    if (blocked || !event.messages?.length) {
      ctx.host.log('skip', '本批未发送：' + (blocked || '缺少消息列表'))
      await this.updateBaseline(ctx)
      ctx.host.enqueue({ type: 'check_unread' })
      return
    }
    this.readyReply = {
      event,
      observation,
      transcript: event.observedMessages || event.messages,
      currentTranscript: event.observedMessages || event.messages,
      appended: [],
      attempts: 0
    }
    await this.sendReadyBatch(ctx)
  }

  private async sendReadyBatch(ctx: ChannelContext<GenericChannelState>): Promise<void> {
    const ready = this.readyReply
    if (!ready) return
    const signal = this.request?.signal
    const active = () => ctx.host.isRunning() && !signal?.aborted && this.readyReply === ready
    const verifyStart = Date.now()
    let sendStart = 0
    try {
      const inspected = await this.device.inspectPendingReply!()
      if (!active()) return
      if (inspected.changed) {
        const review = await ctx.host.reviewPendingReply!({
          screenshot: inspected.screenshot!,
          appType: ctx.appType,
          captureContext: 'conversation_panel',
          observation: inspected.observation,
          previousMessages: ready.transcript,
          batchId: ready.event.batchId,
          signal
        })
        if (!active()) return
        ctx.host.trace({
          phase: 'verify',
          summary: '发送前状态复核 ' + ready.event.batchId,
          performance: {
            batchId: ready.event.batchId,
            stage: 'presend',
            model: this.replyModel,
            code: review.code
          },
          outcome: {
            status: review.safe ? 'ok' : 'skip',
            latencyMs: Date.now() - verifyStart,
            detail: review.code
          }
        })
        if (!review.safe || !review.messages) {
          this.readyReply = undefined
          ctx.host.log('skip', '本批取消发送：' + review.code)
          if (review.code === 'MANUAL_REPLY_DETECTED')
            this.pendingBatches.delete(ready.observation.conversationId)
          await this.updateBaseline(ctx)
          ctx.host.enqueue({ type: 'check_unread' })
          return
        }
        ready.appended = review.appended || []
        ready.currentTranscript = review.messages
      }
      if (!inspected.changed)
        ctx.host.trace({
          phase: 'verify',
          summary: '发送前状态未变 ' + ready.event.batchId,
          performance: { batchId: ready.event.batchId, stage: 'presend', code: 'UNCHANGED' },
          outcome: { status: 'ok', latencyMs: Date.now() - verifyStart }
        })
      if (!active()) return
      sendStart = Date.now()
      await this.device.sendMessage(ready.event.content, signal)
      if (!active()) return
      // Acknowledge only the frozen batch, never arrivals observed during generation.
      this.replyGuard.record(
        ready.event.content,
        ready.observation,
        ready.event,
        incomingTail(ready.event.messages!)
      )
      if (ready.appended.length)
        this.pendingBatches.set(ready.observation.conversationId, {
          id: ready.event.batchId + '-next',
          conversationId: ready.observation.conversationId,
          messages: ready.appended,
          afterReply: ready.event.content,
          beforeReply: ready.currentTranscript
        })
      else this.pendingBatches.delete(ready.observation.conversationId)
      ctx.host.log('reply', ready.event.content)
      ctx.host.trace({
        phase: 'act',
        summary: '发送回复 ' + ready.event.batchId,
        performance: {
          batchId: ready.event.batchId,
          stage: 'send',
          model: this.replyModel,
          code: 'OK'
        },
        action: { kind: 'send' },
        outcome: { status: 'ok', latencyMs: Date.now() - sendStart }
      })
      this.readyReply = undefined
      ctx.host.trace({
        phase: 'act',
        summary: '批次处理完成 ' + ready.event.batchId,
        performance: {
          batchId: ready.event.batchId,
          stage: 'batch_total',
          model: this.replyModel,
          code: 'OK'
        },
        outcome: { status: 'ok', latencyMs: Date.now() - this.batchStartedAt }
      })
      await this.updateBaseline(ctx)
      ctx.host.enqueue({ type: ready.appended.length ? 'observe_chat' : 'check_unread' })
    } catch (error) {
      if (!active()) return
      const detail = error instanceof Error ? error.message : String(error)
      ctx.host.trace({
        phase: 'verify',
        summary: '本批发送未完成 ' + ready.event.batchId,
        performance: {
          batchId: ready.event.batchId,
          stage: 'presend',
          model: this.replyModel,
          code: isDesktopStateError(error) ? error.code : 'REVIEW_FAILED'
        },
        outcome: {
          status: 'fail',
          detail: isDesktopStateError(error) ? error.code : 'REVIEW_FAILED',
          latencyMs: Date.now() - verifyStart
        }
      })
      if (isDesktopStateError(error) && error.sendPhase !== 'before_paste') {
        this.replyGuard.record(
          ready.event.content,
          ready.observation,
          ready.event,
          incomingTail(ready.event.messages!)
        )
        this.pendingBatches.delete(ready.observation.conversationId)
        this.readyReply = undefined
        ctx.host.log('error', '可能已经粘贴或发送，本批不会自动重发')
        await this.updateBaseline(ctx)
        ctx.host.enqueue({ type: 'check_unread' })
      } else if (
        isDesktopStateError(error) &&
        error.code === 'history_changed' &&
        ready.attempts++ < 1
      ) {
        ctx.host.log('thinking', '发送前又收到消息，保留本批答案并复核新增消息')
        ctx.host.schedule(
          { type: 'retry_batch_send', batchId: ready.event.batchId! },
          this.pollDelayMs
        )
      } else {
        this.readyReply = undefined
        this.waitForDesktop(ctx, detail)
      }
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
        ...(this.device.getCaptureContext?.() === 'conversation_panel'
          ? { batchId: this.batchId, pendingBatch: this.pendingInput }
          : {}),
        signal: this.request?.signal,
        recentSentMessages: this.replyGuard.recent(observation?.conversationId || 'unknown'),
        ...this.replyGuard.context(observation?.conversationId || 'unknown')
      })) {
        if (!ctx.host.isRunning() || observationId !== this.observationVersion) break

        const sessionEvent = this.mapProviderEvent(event)
        if (sessionEvent) {
          ctx.host.enqueue({
            ...sessionEvent,
            ...(event.batchId ? { batchId: event.batchId } : {}),
            observationId
          } as SessionEvent)
        }
        // A Provider may emit only one terminal decision per observation.
        if (event.type !== 'thinking' && event.type !== 'metric') return
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
      if (
        !ctx.host.isRunning() ||
        observationId !== this.observationVersion ||
        this.request?.signal.aborted
      )
        return
      ctx.host.enqueue({ type: 'provider.error', error: message, observationId })
    }
  }

  private mapProviderEvent(event: ProviderEvent): SessionEvent | null {
    switch (event.type) {
      case 'metric':
        return {
          type: 'provider.metric',
          stage: event.stage,
          latencyMs: event.latencyMs,
          model: event.model,
          code: event.code,
          batchId: event.batchId
        }
      case 'thinking':
        return { type: 'provider.thinking', content: event.content }
      case 'reply_text':
        return {
          type: 'provider.reply_text',
          content: event.content,
          latestMessage: event.latestMessage,
          sender: event.sender,
          senderBbox: event.senderBbox,
          messages: event.messages,
          observedMessages: event.observedMessages
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
