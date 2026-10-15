import type { ChatObservation, ConversationMessage, ReplyEvidence } from './session-types'
import {
  incomingTail,
  messageSequenceError,
  mergeMessageSequence,
  normalizeMessage,
  sameMessage
} from './chat-messages'

interface SentReply {
  historyId?: string
  text: string
  incoming: ConversationMessage[]
  observed?: ConversationMessage[]
}
interface ConversationState {
  sent: SentReply[]
  history: ConversationMessage[]
  pending: ConversationMessage[]
}

/** Session-local message boundaries. A changed screenshot or a left avatar alone is not a new message. */
export class ReplyGuard {
  private conversations = new Map<string, ConversationState>()

  clear(): void {
    this.conversations.clear()
  }

  recent(conversationId: string): string[] {
    return this.conversations.get(conversationId)?.sent.map((item) => item.text) || []
  }

  context(conversationId: string): {
    conversationHistory: ConversationMessage[]
    pendingIncomingMessages: ConversationMessage[]
  } {
    const state = this.conversations.get(conversationId)
    return {
      conversationHistory: state?.history.map((message) => ({ ...message })) || [],
      pendingIncomingMessages: state?.pending.map((message) => ({ ...message })) || []
    }
  }

  rejection(evidence: ReplyEvidence, observation?: ChatObservation): string | undefined {
    const state = this.conversations.get(observation?.conversationId || 'unknown')
    const recent = state?.sent || []
    if (observation && recent.some((item) => item.historyId === observation.historyId))
      return '同一聊天画面已处理，避免重复回复'
    if (evidence.sender === 'self') return '最新消息是自己发送的，已拦截自我回复'
    const avatar = evidence.senderBbox
    const chat = observation?.chatAreaBbox
    if (avatar && chat) {
      const [x1, y1, x2, y2] = avatar
      const position = ((x1 + x2) / 2 - chat[0]) / (chat[2] - chat[0])
      if (
        x1 < chat[0] ||
        x2 > chat[2] ||
        y1 < chat[1] ||
        y2 > chat[3] ||
        x2 <= x1 ||
        y2 <= y1 ||
        x2 - x1 > (chat[2] - chat[0]) * 0.2
      )
        return '最新消息头像不在聊天记录区内，等待重新确认发送方'
      if (position >= 0.78) return '最新消息头像位于右侧，已拦截自我回复'
      if (position > 0.22) return '最新消息头像方向不明确，等待重新识别'
      if (
        observation?.outgoingBubbleBottom !== undefined &&
        observation.outgoingBubbleBottom > y2 + (y2 - y1) * 0.3
      )
        return '画面下方仍有自己的发送气泡，模型选中了更早的消息，已拦截自我回复'
    }
    const sequenceError = messageSequenceError(evidence, chat)
    if (sequenceError) return sequenceError
    if (!recent.length) return undefined

    const lastSent = recent[recent.length - 1]
    const messages = evidence.messages
    if (
      messages &&
      recent.some(
        (item) =>
          item.observed?.length === messages.length &&
          item.observed.every((message, i) => sameMessage(message, messages[i]))
      )
    )
      return '这批对方消息已经回复，画面位置变化不代表收到新消息'
    const lastSelf = messages?.findLast((message) => message.sender === 'self')
    // Repeated words are legitimate only when they visibly occur after the newest sent reply.
    const afterLastReply = Boolean(
      lastSelf && normalizeMessage(lastSelf.text) === normalizeMessage(lastSent.text)
    )
    const echoed =
      evidence.latestMessage &&
      recent.some(
        (item) => normalizeMessage(item.text) === normalizeMessage(evidence.latestMessage!)
      )
    if (echoed && !afterLastReply)
      return '识别内容与本会话已发送回复相同，尚无新收到消息的证据，已拦截自我回复'
    if (!messages || evidence.sender !== 'incoming' || !avatar || !chat)
      return '本会话已发送回复，尚未确认新的左侧消息及完整消息顺序，等待重新识别'
    if (
      lastSelf &&
      !afterLastReply &&
      recent.some((item) => normalizeMessage(item.text) === normalizeMessage(lastSelf.text))
    )
      return '消息列表停留在更早的回复，尚未确认新的对方消息'
    const batch = this.batch(evidence, observation)
    if (!batch.length) return '这批对方消息已经回复，等待新的对方消息'
    if (
      !afterLastReply &&
      batch.some((message) =>
        recent.some((item) => normalizeMessage(item.text) === normalizeMessage(message.text))
      )
    )
      return '待回复消息混入了本会话已发送内容，已拦截自我回复'
    return undefined
  }

  /** Retain a batch before attempting input; cancellation must not lose earlier incoming messages. */
  remember(evidence: ReplyEvidence, observation?: ChatObservation): void {
    const state = this.state(observation?.conversationId || 'unknown')
    const batch = this.batch(evidence, observation)
    if (!state.history.length && evidence.messages) {
      const tail = incomingTail(evidence.messages)
      state.history = mergeMessageSequence(
        [],
        evidence.messages.slice(0, evidence.messages.length - tail.length)
      )
    }
    state.pending = mergeMessageSequence(state.pending, batch)
  }

  acknowledgeSelf(text: string | undefined, observation?: ChatObservation): void {
    const state = this.conversations.get(observation?.conversationId || 'unknown')
    // A manual reply also closes a pending batch; otherwise it would be re-injected on the next turn.
    if (text && state?.pending.length) this.record(text, observation)
  }

  record(
    text: string,
    observation?: ChatObservation,
    evidence: ReplyEvidence = {},
    answeredBatch?: ConversationMessage[]
  ): void {
    this.remember(evidence, observation)
    const state = this.state(observation?.conversationId || 'unknown')
    const incoming = answeredBatch || state.pending
    state.history = mergeMessageSequence(state.history, incoming)
    state.history = [
      ...state.history,
      { sender: 'self' as const, kind: 'text' as const, text: text.slice(0, 2000) }
    ].slice(-48)
    state.pending = []
    state.sent = [
      ...state.sent,
      {
        historyId: observation?.historyId,
        text,
        incoming,
        observed: evidence.messages?.map(({ sender, kind, text }) => ({ sender, kind, text }))
      }
    ].slice(-8)
  }

  private batch(evidence: ReplyEvidence, observation?: ChatObservation): ConversationMessage[] {
    if (!evidence.messages)
      return evidence.latestMessage
        ? [{ sender: 'incoming', kind: 'text', text: evidence.latestMessage }]
        : []
    const tail = incomingTail(evidence.messages)
    const recent = this.conversations.get(observation?.conversationId || 'unknown')?.sent || []
    if (!recent.length) return tail
    const lastSelf = evidence.messages.findLast((message) => message.sender === 'self')
    if (
      lastSelf &&
      normalizeMessage(lastSelf.text) === normalizeMessage(recent[recent.length - 1].text)
    )
      return tail
    // Without the outgoing boundary, a previously answered prefix remains history, not pending input.
    const answered = recent.flatMap((reply) => reply.incoming)
    const lastAnswered = tail.findLastIndex((message) =>
      answered.some((known) => sameMessage(known, message))
    )
    return tail.slice(lastAnswered + 1)
  }

  private state(id: string): ConversationState {
    const state = this.conversations.get(id) || { sent: [], history: [], pending: [] }
    this.conversations.delete(id)
    this.conversations.set(id, state)
    if (this.conversations.size > 50)
      this.conversations.delete(this.conversations.keys().next().value!)
    return state
  }
}
