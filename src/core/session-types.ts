import { AppType } from './rpa/types'
import { MemoryCardBrief, TraceStepInput } from './trace/trace-types'
import type { BBox } from './rpa/vision-utils'

export interface ChatObservation {
  conversationId: string
  historyId: string
  chatAreaBbox?: BBox
  /** Local pixel evidence, when a standard right-aligned outgoing bubble is visible. */
  outgoingBubbleBottom?: number
  /** Crop in full-window normalized coordinates; model evidence is mapped back. */
  panelBbox?: BBox
  headerId?: string
  editorId?: string
}

export interface ReplyBatch {
  id: string
  conversationId: string
  messages: ConversationMessage[]
  afterReply: string
  beforeReply: ConversationMessage[]
}

export interface ConversationMessage {
  sender: 'incoming' | 'self'
  kind: 'text' | 'image' | 'emoji'
  text: string
}

export interface VisibleChatMessage extends ConversationMessage {
  senderBbox: BBox
}

export interface ReplyEvidence {
  /** Full transcript behind a host-approved pending batch (internal provider only). */
  observedMessages?: VisibleChatMessage[]
  latestMessage?: string
  sender?: 'incoming' | 'self' | 'unknown'
  /** Latest message sender's avatar, normalized to this screenshot (0-1000). */
  senderBbox?: BBox
  /** All visible conversation messages in chronological order, including our own. */
  messages?: VisibleChatMessage[]
}

export interface ProviderInput {
  screenshot: string
  appType: AppType
  currentContact?: string
  ocrText?: string
  captureContext?: 'full_window' | 'chat_area' | 'conversation_panel'
  batchId?: string
  pendingBatch?: ReplyBatch
  signal?: AbortSignal
  observation?: ChatObservation
  recentSentMessages?: string[]
  conversationHistory?: ConversationMessage[]
  pendingIncomingMessages?: ConversationMessage[]
  /** 运行时注入的经验卡片（工作记忆）。Provider 可拼入 system prompt。 */
  memoryCards?: MemoryCardBrief[]
}

export type ProviderEvent = (
  | { type: 'thinking'; content: string }
  | ({ type: 'reply_text'; content: string } & ReplyEvidence)
  | {
      type: 'skip'
      reason?: string
      latestMessage?: string
      category?: 'self' | 'system' | 'non_chat' | 'uncertain' | 'draft' | 'empty_chat'
    }
  | { type: 'error'; error: string }
  | { type: 'metric'; stage: string; latencyMs: number; model: string; code: string }
) & { batchId?: string }

export type SessionEvent = (
  | { type: 'bootstrap' }
  | { type: 'observe_chat' }
  | { type: 'provider.thinking'; content: string; observationId?: number }
  | ({ type: 'provider.reply_text'; content: string; observationId?: number } & ReplyEvidence)
  | {
      type: 'provider.skip'
      reason?: string
      latestMessage?: string
      category?: 'self' | 'system' | 'non_chat' | 'uncertain' | 'draft' | 'empty_chat'
      observationId?: number
    }
  | { type: 'provider.error'; error: string; observationId?: number }
  | {
      type: 'provider.metric'
      stage: string
      latencyMs: number
      model: string
      code: string
      observationId?: number
    }
  | { type: 'retry_batch_send'; batchId: string }
  | { type: 'check_unread' }
  | { type: 'wait_retry'; reason?: string; delayMs?: number; detail?: string }
) & { batchId?: string }

export interface PendingReplyReview extends ProviderInput {
  previousMessages: VisibleChatMessage[]
}
export interface PendingReplyReviewResult {
  safe: boolean
  code: string
  messages?: VisibleChatMessage[]
  appended?: VisibleChatMessage[]
}

export interface ProviderAdapter {
  run(input: ProviderInput): AsyncIterable<ProviderEvent>
  reviewPendingReply?(input: PendingReplyReview): Promise<PendingReplyReviewResult>
}

export interface RuntimeHostControls {
  enqueue(event: SessionEvent): void
  schedule(event: SessionEvent, delayMs: number): void
  runProvider(input: ProviderInput): AsyncIterable<ProviderEvent>
  reviewPendingReply?(input: PendingReplyReview): Promise<PendingReplyReviewResult>
  log(type: 'thinking' | 'reply' | 'skip' | 'error', content: string): void
  /** 记录一条结构化工作轨迹（work-trace）。无 recorder 时为 no-op。 */
  trace(step: TraceStepInput): void
  isRunning(): boolean
  stopSession(reason?: string): Promise<void>
}

export interface ChannelContext<TState> {
  appType: AppType
  state: TState
  host: RuntimeHostControls
}

export interface ChannelSession<TState> {
  onStart(ctx: ChannelContext<TState>): Promise<void>
  onStop(ctx: ChannelContext<TState>): Promise<void>
  onEvent(event: SessionEvent, ctx: ChannelContext<TState>): Promise<void>
}
