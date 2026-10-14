import { AppType } from './rpa/types'
import { MemoryCardBrief, TraceStepInput } from './trace/trace-types'
import type { BBox } from './rpa/vision-utils'

export interface ChatObservation {
  conversationId: string
  historyId: string
  chatAreaBbox?: BBox
  /** Local pixel evidence, when a standard right-aligned outgoing bubble is visible. */
  outgoingBubbleBottom?: number
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
  captureContext?: 'full_window' | 'chat_area'
  observation?: ChatObservation
  recentSentMessages?: string[]
  conversationHistory?: ConversationMessage[]
  pendingIncomingMessages?: ConversationMessage[]
  /** 运行时注入的经验卡片（工作记忆）。Provider 可拼入 system prompt。 */
  memoryCards?: MemoryCardBrief[]
}

export type ProviderEvent =
  | { type: 'thinking'; content: string }
  | ({ type: 'reply_text'; content: string } & ReplyEvidence)
  | {
      type: 'skip'
      reason?: string
      latestMessage?: string
      category?: 'self' | 'system' | 'non_chat' | 'uncertain' | 'draft' | 'empty_chat'
    }
  | { type: 'error'; error: string }

export type SessionEvent =
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
  | { type: 'check_unread' }
  | { type: 'wait_retry'; reason?: string; delayMs?: number; detail?: string }

export interface ProviderAdapter {
  run(input: ProviderInput): AsyncIterable<ProviderEvent>
}

export interface RuntimeHostControls {
  enqueue(event: SessionEvent): void
  schedule(event: SessionEvent, delayMs: number): void
  runProvider(input: ProviderInput): AsyncIterable<ProviderEvent>
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
