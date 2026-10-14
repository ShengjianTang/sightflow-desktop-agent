import type { ProviderAdapter } from '../core/session-types'
import {
  CHAT_REPLY_RULES,
  parseChatDecision,
  SKIP_REASON_TEXT,
  buildChatObservationContext,
  needsSenderReview
} from '../core/chat-reply-policy'
import {
  SiliconFlowClient,
  SILICONFLOW_DEFAULT_MODEL,
  SILICONFLOW_PROVIDER_ID
} from '../core/siliconflow-client'

export const SILICONFLOW_INSTALLED = {
  id: SILICONFLOW_PROVIDER_ID,
  name: '硅基流动多模态',
  version: '1.0.0',
  entryFile: 'builtin://siliconflow',
  installedAt: '0'
}

export const SILICONFLOW_MANIFEST = {
  apiVersion: 1 as const,
  id: SILICONFLOW_PROVIDER_ID,
  name: '硅基流动多模态',
  version: '1.0.0',
  entry: 'builtin://siliconflow',
  capabilities: ['chat'] as ['chat'],
  configSchema: {
    type: 'object' as const,
    properties: {
      apiKey: { type: 'password' as const, title: 'API Key' },
      model: { type: 'string' as const, title: '视觉模型', default: SILICONFLOW_DEFAULT_MODEL }
    },
    required: [] as string[]
  }
}

export interface SiliconFlowConfig {
  apiKey?: string
  model?: string
}

export function siliconFlowStatus(config: SiliconFlowConfig = {}): {
  configured: boolean
  environmentConfigured: boolean
  model: string
} {
  const environmentConfigured = Boolean(process.env.SILICONFLOW_API_KEY?.trim())
  return {
    configured: Boolean(config.apiKey?.trim()) || environmentConfigured,
    environmentConfigured,
    model:
      config.model?.trim() ||
      process.env.SILICONFLOW_VISION_MODEL?.trim() ||
      SILICONFLOW_DEFAULT_MODEL
  }
}

export function createSiliconFlowClient(config: SiliconFlowConfig = {}): SiliconFlowClient {
  const key = config.apiKey?.trim() || process.env.SILICONFLOW_API_KEY?.trim()
  if (!key) throw new Error('请在智能体配置中填写硅基流动 API Key，或设置 SILICONFLOW_API_KEY')
  return new SiliconFlowClient(key, siliconFlowStatus(config).model)
}

export function createSiliconFlowProvider(client: SiliconFlowClient): ProviderAdapter {
  return {
    async *run(input) {
      if (!input.screenshot) {
        yield { type: 'skip' }
        return
      }
      yield { type: 'thinking', content: '正在识别聊天内容及图片消息...' }
      try {
        const memory = input.memoryCards?.length
          ? `\n团队经验：${input.memoryCards.map((item) => item.guidance).join('；')}`
          : ''
        const prompt = `逐条识别可见聊天消息，合并尚未回复的连续文字、图片、截图缩略图和表情，结合上下文给出一次回复。${CHAT_REPLY_RULES}\n截图范围：${input.captureContext === 'full_window' ? '完整应用窗口，需检查是否为普通聊天页面' : '可能仅包含聊天记录区'}。${buildChatObservationContext(input)}`
        let decision = parseChatDecision(
          await client.analyzeImage(input.screenshot, prompt, CHAT_REPLY_RULES + memory)
        )
        if (needsSenderReview(decision, input)) {
          yield {
            type: 'thinking',
            content: '首次判断未确认是否回复，正在复核消息顺序、发送方和待回复批次...'
          }
          decision = parseChatDecision(
            await client.analyzeImage(
              input.screenshot,
              prompt +
                '\n请重新逐条列出messages（sender、kind、text、senderBbox），复核底部最后一条消息的头像方向并提供匹配的latestMessage、sender和senderBbox；合并完整待回复批次，不只回答最后一句。禁止从自己的最新消息跳回更早的对方消息。左侧普通消息、群聊问句和图片均需要回复；仍看不清则uncertain。',
              CHAT_REPLY_RULES + memory
            )
          )
        }
        if (needsSenderReview(decision, input))
          decision = {
            reason: 'uncertain',
            latestMessage: decision.latestMessage,
            needsReview: false
          }
        if (decision.reply)
          yield {
            type: 'reply_text',
            content: decision.reply,
            ...(decision.latestMessage ? { latestMessage: decision.latestMessage } : {}),
            ...(decision.sender ? { sender: decision.sender } : {}),
            ...(decision.senderBbox ? { senderBbox: decision.senderBbox } : {}),
            ...(decision.messages ? { messages: decision.messages } : {})
          }
        else
          yield {
            type: 'skip',
            reason: SKIP_REASON_TEXT[decision.reason || 'uncertain'],
            latestMessage: decision.latestMessage,
            category: decision.reason || 'uncertain'
          }
      } catch (error) {
        yield { type: 'error', error: error instanceof Error ? error.message : '图片识别失败' }
      }
    }
  }
}
