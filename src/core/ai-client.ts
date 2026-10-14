// src/core/ai-client.ts
// AI 客户端 — 统一封装所有大模型调用
//
// 使用火山引擎 Ark OpenAI 兼容 /responses 端点
// 两种用途：
//   1. 聊天回复：截图 → AI 分析 → 回复文字
//   2. VLM 视觉检测：截图 → AI 分析 → bbox/point 坐标

import { MemoryCardBrief } from './trace/trace-types'
import {
  AI_REQUEST_TIMEOUT_MS,
  AI_VISION_REQUEST_TIMEOUT_MS,
  ARK_BASE_URL,
  ARK_MODEL
} from './ai-config'
import { fetchWithTimeout, formatArkHttpError } from './http-request'

export interface AIClientConfig {
  apiKey: string
  model: string
  baseURL: string
  systemPrompt: string
}

/** 把经验卡片拼成 system prompt 附加段（与内置 provider bundle 的格式保持一致） */
export function buildMemorySection(memoryCards?: MemoryCardBrief[]): string {
  if (!memoryCards || memoryCards.length === 0) return ''
  const lines = memoryCards.map((card, index) => {
    const rationale = card.rationale ? `（原因：${card.rationale}）` : ''
    return `${index + 1}. 【${card.scenario}】${card.guidance}${rationale}`
  })
  return `\n\n## 团队经验（来自工作记忆，优先遵循）\n${lines.join('\n')}`
}

const REPLY_SYSTEM_PROMPT = `你是一个微信自动回复助手。你会收到一张微信/企业微信的聊天窗口截图。

## 你的任务
分析截图中的聊天内容，生成合适的回复。

## 规则
1. 只输出回复文字，不要解释、不要添加多余内容
2. **防自我循环**：仔细观察截图。聊天窗口中，右侧的气泡是"我"发送的。如果最后一条消息是右侧气泡（即"我"自己发送的），必须输出 [SKIP]
3. 如果最新消息是系统消息、群公告、红包、转账等非对话消息，输出 [SKIP]
4. 如果无法判断是否需要回复，输出 [SKIP]
5. 回复要自然、口语化，像真人对话`

export class AIClient {
  private config: AIClientConfig

  constructor(config: Partial<AIClientConfig> & { apiKey: string }) {
    this.config = {
      apiKey: config.apiKey,
      model: config.model || ARK_MODEL,
      baseURL: config.baseURL || ARK_BASE_URL,
      systemPrompt: config.systemPrompt || REPLY_SYSTEM_PROMPT
    }
  }

  /**
   * 发送截图给 AI，获取聊天回复
   * memoryCards: 运行时注入的经验卡片（工作记忆），拼入 system prompt
   */
  async getReply(
    screenshotBase64: string,
    memoryCards?: MemoryCardBrief[]
  ): Promise<string | null> {
    const startTime = Date.now()
    try {
      console.log('[AIClient] getReply 开始...')
      const replyText = await this.callVision(
        this.config.systemPrompt + buildMemorySection(memoryCards),
        '请根据截图中微信聊天窗口的最新消息进行回复。',
        screenshotBase64
      )

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(`[AIClient] getReply 完成 (${elapsed}s):`, replyText?.slice(0, 100))

      if (!replyText || replyText.trim() === '[SKIP]') {
        return null
      }

      return replyText.trim()
    } catch (error: any) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      console.error(`[AIClient] 聊天回复失败 (${elapsed}s):`, error?.message || error)
      throw error
    }
  }

  /**
   * VLM 视觉检测 — 发送截图 + prompt，获取 bbox/point 文本
   * 供 vision-utils.ts 调用
   */
  async detectVision(prompt: string, screenshotBase64: string): Promise<string> {
    return await this.callVision(
      '你是一个视觉分析专家。请严格按照用户要求的格式输出检测结果。',
      prompt,
      screenshotBase64
    )
  }

  /**
   * 纯文本调用（不带图片）— 用于 testConnection 等
   */
  async callText(userMessage: string): Promise<string> {
    const data = await this.callAPI([{ role: 'user', content: userMessage }])
    return this.extractText(data)
  }

  /**
   * 测试 API 连接
   */
  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.callText('你好，请回复"连接成功"。')
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  }

  updateConfig(config: Partial<AIClientConfig>): void {
    Object.assign(this.config, config)
  }

  getApiKey(): string {
    return this.config.apiKey
  }

  // ── 内部方法 ──

  /**
   * 视觉调用：system prompt + 用户文本 + 图片
   */
  private async callVision(
    systemPrompt: string,
    userText: string,
    imageBase64: string
  ): Promise<string> {
    const rawBase64 = this.stripBase64Prefix(imageBase64)
    const imageUrl = rawBase64.startsWith('http') ? rawBase64 : `data:image/png;base64,${rawBase64}`

    const data = await this.callAPI(
      [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'input_image', image_url: imageUrl },
            { type: 'input_text', text: userText }
          ]
        }
      ],
      AI_VISION_REQUEST_TIMEOUT_MS
    )

    return this.extractText(data)
  }

  /**
   * 底层 HTTP 调用 — 火山方舟 OpenAI 兼容 /responses 端点
   */
  private async callAPI(messages: any[], timeoutMs = AI_REQUEST_TIMEOUT_MS): Promise<any> {
    if (typeof this.config.apiKey !== 'string' || !this.config.apiKey.trim()) {
      throw new Error('请先填写视觉接口密钥')
    }
    const url = `${this.config.baseURL.replace(/\/+$/, '')}/responses`
    return fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey.trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.config.model,
          input: messages,
          thinking: { type: 'disabled' },
          stream: false
        })
      },
      (response) => response.json(),
      timeoutMs,
      `AI API 请求超时 (${timeoutMs / 1000}s)`
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      const status = /^HTTP (\d{3})$/.exec(message)
      if (status) throw new Error(formatArkHttpError(Number(status[1])))
      throw error
    })
  }

  /**
   * 从 Responses output 的 message.content 中提取 output_text
   */
  private extractText(responseData: any): string {
    const output = responseData?.output
    const content = Array.isArray(output)
      ? output
          .filter((item) => item?.type === 'message' && Array.isArray(item.content))
          .flatMap((item) => item.content)
          .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('')
      : ''
    if (content) return content
    throw new Error('AI API 返回格式无效：缺少回复文本')
  }

  private stripBase64Prefix(base64: string): string {
    const idx = base64.indexOf('base64,')
    return idx !== -1 ? base64.slice(idx + 'base64,'.length) : base64
  }
}
