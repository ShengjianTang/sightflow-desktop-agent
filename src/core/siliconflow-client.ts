import { fetchWithTimeout } from './http-request'

export const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1'
export const SILICONFLOW_DEFAULT_MODEL = 'Qwen/Qwen3-VL-30B-A3B-Instruct'
export const SILICONFLOW_PROVIDER_ID = 'siliconflow-vision'
const REQUEST_TIMEOUT_MS = 90_000
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export function validateImageDataUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('请选择有效的图片')
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match || match[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
    throw new Error('图片格式无效或超过 8 MB（支持 PNG/JPEG/WebP）')
  }
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== match[2]) {
    throw new Error('图片数据无效或超过 8 MB')
  }
  return value
}

export class SiliconFlowClient {
  constructor(
    private readonly apiKey: string,
    readonly model: string = SILICONFLOW_DEFAULT_MODEL
  ) {}

  async detectVision(prompt: string, image: string): Promise<string> {
    return this.analyzeImage(image, prompt, '你是桌面界面视觉分析助手。严格按照用户要求输出。')
  }

  async analyzeImage(
    image: string,
    prompt: string,
    systemPrompt?: string,
    signal?: AbortSignal
  ): Promise<string> {
    if (!this.apiKey.trim())
      throw new Error('请在智能体配置中填写硅基流动 API Key，或设置 SILICONFLOW_API_KEY')
    if (!this.model.trim()) throw new Error('请配置硅基流动视觉模型')
    const imageUrl = validateImageDataUrl(image)
    const messages = [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: prompt.trim() || '描述图片内容。' }
        ]
      }
    ]
    let data: any
    try {
      data = await fetchWithTimeout(
        `${SILICONFLOW_BASE_URL}/chat/completions`,
        {
          method: 'POST',
          signal,
          headers: {
            Authorization: `Bearer ${this.apiKey.trim()}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ model: this.model.trim(), messages, stream: false })
        },
        (response) => response.json(),
        REQUEST_TIMEOUT_MS,
        '硅基流动图片请求超时 (90s)'
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/^HTTP (401|403)$/.test(message))
        throw new Error(`${message}：检查硅基流动密钥及模型权限`)
      if (message === 'HTTP 404')
        throw new Error('HTTP 404：硅基流动模型 ID 不存在或当前账号不可用')
      if (message === 'HTTP 429') throw new Error('HTTP 429：硅基流动请求过多或额度不足')
      if (message === 'HTTP 400') throw new Error('HTTP 400：图片或模型参数不被硅基流动接受')
      if (message === 'HTTP 413') throw new Error('HTTP 413：图片请求体过大，请选择较小的图片')
      throw error
    }
    const content = data?.choices?.[0]?.message?.content
    if (typeof content === 'string' && content.trim()) return content.trim()
    if (Array.isArray(content)) {
      const text = content
        .filter((part) => part?.type === 'text')
        .map((part) => part.text)
        .join('')
      if (text.trim()) return text.trim()
    }
    throw new Error('硅基流动返回格式无效：缺少回复文本')
  }
}
