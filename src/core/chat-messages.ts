import type { BBox } from './rpa/vision-utils'
import type { ConversationMessage, ReplyEvidence, VisibleChatMessage } from './session-types'

export function normalizeMessage(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\s\p{P}]/gu, '')
    .toLowerCase()
}

export function isMessageBox(box: unknown): box is BBox {
  return (
    Array.isArray(box) &&
    box.length === 4 &&
    box.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1000) &&
    box[2] > box[0] &&
    box[3] > box[1]
  )
}

/** Reject the entire transcript on malformed entries; dropping an entry can hide an own reply. */
export function readVisibleMessages(value: unknown): VisibleChatMessage[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 80) return undefined
  const messages: VisibleChatMessage[] = []
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !['incoming', 'self'].includes(entry.sender) ||
      !['text', 'image', 'emoji'].includes(entry.kind) ||
      typeof entry.text !== 'string' ||
      !entry.text.trim() ||
      entry.text.length > 6000 ||
      !isMessageBox(entry.senderBbox)
    )
      return undefined
    messages.push({
      sender: entry.sender,
      kind: entry.kind,
      text: entry.text.trim(),
      senderBbox: entry.senderBbox
    })
  }
  return messages
}

export function messageSequenceError(evidence: ReplyEvidence, chat?: BBox): string | undefined {
  if (!evidence.messages) return undefined
  const messages = readVisibleMessages(evidence.messages)
  if (!messages) return '消息列表格式不完整，等待重新识别'
  let previousTop = -1
  for (const message of messages) {
    const box = message.senderBbox
    if (box[1] <= previousTop) return '消息顺序或头像位置矛盾，等待重新识别'
    previousTop = box[1]
    if (chat) {
      const width = chat[2] - chat[0]
      const position = ((box[0] + box[2]) / 2 - chat[0]) / width
      if (
        box[0] < chat[0] ||
        box[2] > chat[2] ||
        box[1] < chat[1] ||
        box[3] > chat[3] ||
        box[2] - box[0] > width * 0.2 ||
        (message.sender === 'incoming' ? position > 0.22 : position < 0.78)
      )
        return '消息发送方与头像方向不一致，等待重新识别'
    }
  }
  const last = messages[messages.length - 1]
  if (last.sender === 'self') return '消息列表最后一条是自己发送的，已拦截自我回复'
  if (
    last.sender !== evidence.sender ||
    !evidence.latestMessage ||
    normalizeMessage(last.text) !== normalizeMessage(evidence.latestMessage) ||
    !evidence.senderBbox ||
    last.senderBbox.some((n, i) => Math.abs(n - evidence.senderBbox![i]) > 5)
  )
    return '最新消息与消息列表不一致，等待重新识别'
  return undefined
}

export function incomingTail(messages: VisibleChatMessage[]): VisibleChatMessage[] {
  const lastSelf = messages.findLastIndex((message) => message.sender === 'self')
  return messages.slice(lastSelf + 1)
}

export function sameMessage(a: ConversationMessage, b: ConversationMessage): boolean {
  return (
    a.sender === b.sender &&
    a.kind === b.kind &&
    normalizeMessage(a.text) === normalizeMessage(b.text)
  )
}

/** Merge an overlapping observed suffix without collapsing distinct equal consecutive messages. */
export function mergeMessageSequence(
  previous: ConversationMessage[],
  next: ConversationMessage[]
): ConversationMessage[] {
  // An older/partially visible subset must not be appended as new input on re-observation.
  if (
    next.length <= previous.length &&
    previous.some(
      (_, start) =>
        start + next.length <= previous.length &&
        next.every((message, i) => sameMessage(previous[start + i], message))
    )
  )
    return previous.map(({ sender, kind, text }) => ({ sender, kind, text }))
  let overlap = Math.min(previous.length, next.length)
  while (
    overlap > 0 &&
    !previous.slice(-overlap).every((message, i) => sameMessage(message, next[i]))
  )
    overlap--
  return [...previous, ...next.slice(overlap)]
    .slice(-48)
    .map(({ sender, kind, text }) => ({ sender, kind, text: text.slice(0, 2000) }))
}
