import type { AppType, BoxRegions, CaptureStrategy } from '../core/rpa/types'
import { ARK_MODEL, LEGACY_ARK_MODEL } from '../core/ai-config'
import type { InstalledProviderInfo } from './provider-bundle'

interface PerAppCapture {
  strategy: CaptureStrategy
  regions: BoxRegions | null
}

export interface AppSettings {
  locale: 'zh' | 'en'
  appType: AppType
  vision: {
    apiKey: string
    model: string
  }
  siliconFlow: {
    apiKey: string
    model: string
  }
  chatProvider: {
    manifestUrl: string
    installed: InstalledProviderInfo | null
    config: Record<string, any>
  }
  // 默认抓取策略（仅当 appType 没有 per-app 覆盖时生效）
  defaultCaptureStrategy: CaptureStrategy
  // 每个 appType 独立保存的策略 + 框选区域
  capture: Partial<Record<AppType, PerAppCapture>>
}

const VALID_APP_TYPES: AppType[] = [
  'wechat',
  'wework',
  'dingtalk',
  'lark',
  'slack',
  'telegram',
  'generic'
]
const VALID_CAPTURE_STRATEGIES: CaptureStrategy[] = ['auto', 'vlm', 'box-select']

export function coerceAppType(raw: unknown): AppType {
  return typeof raw === 'string' && (VALID_APP_TYPES as string[]).includes(raw)
    ? (raw as AppType)
    : 'wechat'
}

function coerceStrategy(raw: unknown, fallback: CaptureStrategy = 'auto'): CaptureStrategy {
  return typeof raw === 'string' && (VALID_CAPTURE_STRATEGIES as string[]).includes(raw)
    ? (raw as CaptureStrategy)
    : fallback
}

function coerceRect(raw: unknown): BoxRegions['contactList'] | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const x = Number(r.x),
    y = Number(r.y),
    w = Number(r.width),
    h = Number(r.height)
  if (![x, y, w, h].every((n) => Number.isFinite(n)) || w <= 0 || h <= 0) return null
  return { x, y, width: w, height: h }
}

function coerceRegions(raw: unknown): BoxRegions | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const contactList = coerceRect(r.contactList)
  const chatMain = coerceRect(r.chatMain)
  const inputBox = coerceRect(r.inputBox)
  if (!contactList || !chatMain || !inputBox) return null
  return {
    contactList,
    chatMain,
    inputBox,
    unreadIndicator: coerceRect(r.unreadIndicator),
    displayId: typeof r.displayId === 'number' ? r.displayId : undefined,
    scaleFactor: typeof r.scaleFactor === 'number' ? r.scaleFactor : undefined,
    capturedAt: typeof r.capturedAt === 'number' ? r.capturedAt : Date.now()
  }
}

function normalizeCapture(raw: unknown): Partial<Record<AppType, PerAppCapture>> {
  const out: Partial<Record<AppType, PerAppCapture>> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const key of VALID_APP_TYPES) {
    const value = (raw as Record<string, unknown>)[key]
    if (!value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    out[key] = {
      strategy: coerceStrategy(v.strategy),
      regions: coerceRegions(v.regions)
    }
  }
  return out
}

export function normalizeSettings(raw: any): AppSettings {
  const oldApiKey = typeof raw?.apiKey === 'string' ? raw.apiKey : ''
  const oldModel = normalizeArkModel(raw?.model)
  const oldSystemPrompt = typeof raw?.systemPrompt === 'string' ? raw.systemPrompt : ''
  const rawProviderConfig =
    raw?.chatProvider?.config && typeof raw.chatProvider.config === 'object'
      ? { ...raw.chatProvider.config }
      : {}
  const oldSiliconFlowConfig =
    raw?.chatProvider?.installed?.id === 'siliconflow-vision' ? { ...rawProviderConfig } : {}
  if (raw?.chatProvider?.installed?.id === 'siliconflow-vision') {
    delete rawProviderConfig.apiKey
    delete rawProviderConfig.model
  }

  // Keep arbitrary provider config keys, and only backfill legacy volcengine fields for old persisted settings.
  // Built-in credentials come only from vision.apiKey. Never revive a cleared key.
  if (!raw?.chatProvider?.installed) delete rawProviderConfig.apiKey
  if (
    (!raw?.chatProvider?.installed || raw.chatProvider.installed.id === 'volcengine-ark') &&
    typeof rawProviderConfig.model === 'string'
  ) {
    rawProviderConfig.model = normalizeArkModel(rawProviderConfig.model)
  }
  if (!raw?.chatProvider?.installed && rawProviderConfig.model === undefined && oldModel) {
    rawProviderConfig.model = oldModel
  }
  if (
    !raw?.chatProvider?.installed &&
    rawProviderConfig.systemPrompt === undefined &&
    oldSystemPrompt
  ) {
    rawProviderConfig.systemPrompt = oldSystemPrompt
  }

  const builtInModel =
    !raw?.chatProvider?.installed || raw.chatProvider.installed.id === 'volcengine-ark'
      ? rawProviderConfig.model
      : undefined

  return {
    locale: raw?.locale === 'en' ? 'en' : 'zh',
    appType: coerceAppType(raw?.appType),
    vision: {
      apiKey:
        raw?.vision?.apiKey === undefined
          ? oldApiKey.trim()
          : typeof raw.vision.apiKey === 'string'
            ? raw.vision.apiKey.trim()
            : '',
      model:
        typeof raw?.vision?.model === 'string' && raw.vision.model.trim()
          ? normalizeArkModel(raw.vision.model)
          : typeof builtInModel === 'string' && builtInModel.trim()
            ? normalizeArkModel(builtInModel)
            : oldModel
    },
    siliconFlow: {
      apiKey:
        typeof raw?.siliconFlow?.apiKey === 'string'
          ? raw.siliconFlow.apiKey.trim()
          : typeof oldSiliconFlowConfig.apiKey === 'string'
            ? oldSiliconFlowConfig.apiKey.trim()
            : '',
      model:
        typeof raw?.siliconFlow?.model === 'string'
          ? raw.siliconFlow.model.trim()
          : typeof oldSiliconFlowConfig.model === 'string'
            ? oldSiliconFlowConfig.model.trim()
            : ''
    },
    chatProvider: {
      manifestUrl: raw?.chatProvider?.manifestUrl || raw?.providerManifestUrl || '',
      installed: raw?.chatProvider?.installed || null,
      config: rawProviderConfig
    },
    defaultCaptureStrategy: coerceStrategy(raw?.defaultCaptureStrategy, 'auto'),
    capture: normalizeCapture(raw?.capture)
  }
}

function normalizeArkModel(value: unknown): string {
  const model = typeof value === 'string' ? value.trim() : ''
  return !model || model === LEGACY_ARK_MODEL ? ARK_MODEL : model
}

export function withSchemaDefaults(
  schema: { properties: Record<string, { default?: unknown }> },
  current: Record<string, any>
): Record<string, any> {
  const next = { ...current }
  for (const [key, field] of Object.entries(schema.properties || {})) {
    if (next[key] === undefined && field.default !== undefined) {
      next[key] = field.default
    }
  }
  return next
}

/** Merge partial settings without sharing credentials across provider identities. */
export function mergeSettings(current: AppSettings, data: Record<string, any>): AppSettings {
  const chatProvider = { ...current.chatProvider, ...(data.chatProvider || {}) }
  const sameProvider =
    current.chatProvider.installed?.id === chatProvider.installed?.id &&
    current.chatProvider.manifestUrl === chatProvider.manifestUrl
  return normalizeSettings({
    ...current,
    ...data,
    vision: { ...current.vision, ...(data.vision || {}) },
    siliconFlow: { ...current.siliconFlow, ...(data.siliconFlow || {}) },
    chatProvider: {
      ...chatProvider,
      config: {
        ...(sameProvider ? current.chatProvider.config : {}),
        ...(data.chatProvider?.config || {})
      }
    },
    capture: { ...current.capture, ...(data.capture || {}) }
  })
}
