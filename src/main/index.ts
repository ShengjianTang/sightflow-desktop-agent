import { app, shell, BrowserWindow, ipcMain, desktopCapturer, dialog, nativeImage } from 'electron'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { checkAndRequestPermissions } from './permission'
import Store from 'electron-store'
import { AIClient } from '../core/ai-client'
import { DesktopDevice } from '../core/device'
import { RPADevice } from '../core/rpa-device'
import { BoxSelectDevice } from '../core/box-select-device'
import { RuntimeHost } from '../core/runtime-host'
import {
  createInitialGenericChannelState,
  GenericChannelSession
} from '../core/generic-channel-session'
import { AppType, BoxRegions, CaptureStrategy, isWechatLike } from '../core/rpa/types'
import { runBoxSelectWizard, type WizardStepKey } from './overlay-window'
import {
  BUILTIN_DOUBAO_PROVIDER_ID,
  getBuiltinDoubaoInstalledInfo,
  getBuiltinDoubaoManifestForUi,
  getInstalledProviderManifest,
  installProviderFromUrl,
  loadBuiltinDoubaoProvider,
  loadInstalledProvider
} from './provider-bundle'
import {
  SkillEngineController,
  SkillPauseResult,
  SkillStartResult,
  startSkillServer,
  stopSkillServer
} from './skill-server'
import {
  listTraceSessions,
  readTraceScreenshot,
  readTraceSession,
  TraceRecorder
} from '../core/trace/trace-recorder'
import { TraceStepInput } from '../core/trace/trace-types'
import { ExperienceStore, NewExperienceCard } from '../core/memory/experience-store'
import { induceCardsFromSession } from '../core/memory/learn-from-session'
import { ARK_BASE_URL, ARK_MODEL } from '../core/ai-config'
import { fetchWithTimeout } from '../core/http-request'
import { validateImageDataUrl, SILICONFLOW_PROVIDER_ID } from '../core/siliconflow-client'
import {
  SILICONFLOW_INSTALLED,
  SILICONFLOW_MANIFEST,
  type SiliconFlowConfig,
  siliconFlowStatus,
  createSiliconFlowClient,
  createSiliconFlowProvider
} from './siliconflow-provider'
import { sendImageAction } from '../core/rpa/input-utils'
import {
  type AppSettings,
  coerceAppType,
  normalizeSettings,
  mergeSettings,
  withSchemaDefaults
} from './settings'
const StoreClass = typeof Store === 'function' ? Store : ((Store as any).default as typeof Store)

const FIXED_ARK_MODEL = ARK_MODEL
const FIXED_ARK_BASE_URL = ARK_BASE_URL

type ProviderConfigFieldType = 'text' | 'password' | 'url' | 'select' | 'textarea' | 'boolean'

type ProviderConfigField = {
  key: string
  label: string
  type: ProviderConfigFieldType
  required?: boolean
  readonly?: boolean
  placeholder?: string
  hint?: string
  defaultValue?: string | boolean
  options?: Array<{ label: string; value: string }>
}

type ProviderCatalogItem = {
  id: string
  name: string
  description?: string
  version: string
  manifestUrl: string
  capabilities?: string[]
  configSchema: {
    fields: ProviderConfigField[]
  }
}

type ProviderHubCache = {
  sourceUrl: string
  fetchedAt: string
  providers: ProviderCatalogItem[]
}

type ProviderHubEntry = {
  id?: unknown
  enabled?: unknown
  manifestUrl?: unknown
}

type ProviderHubManifest = {
  id?: unknown
  name?: unknown
  description?: unknown
  version?: unknown
  capabilities?: unknown
  configSchema?: unknown
}

const DEFAULT_PROVIDER_HUB_URL =
  process.env.SIGHTFLOW_PROVIDER_HUB_URL || 'https://sightflow.dev/provider-hub.json'
const PROVIDER_HUB_CACHE_KEY = 'providerHubCache'

const settingsStore = new StoreClass({
  name: 'settings',
  defaults: {
    locale: 'zh',
    appType: 'wechat',
    vision: { apiKey: '', model: ARK_MODEL },
    siliconFlow: { apiKey: '', model: '' },
    chatProvider: {
      manifestUrl: '',
      installed: null,
      config: {}
    },
    defaultCaptureStrategy: 'auto',
    capture: {}
  }
})

let runtime: RuntimeHost<ReturnType<typeof createInitialGenericChannelState>> | null = null
let runtimeDevice: DesktopDevice | null = null
let engineStarting = false
let settingsWindow: BrowserWindow | null = null
let memoryWindow: BrowserWindow | null = null
let selectedImage: { token: string; dataUrl: string } | null = null
let imageSending = false

function siliconFlowConfig(settings: AppSettings): SiliconFlowConfig {
  return settings.siliconFlow
}

// ── 工作记忆（work-trace + 经验卡片）单例，首次使用时初始化 ──
let traceRecorderInstance: TraceRecorder | null = null
let experienceStoreInstance: ExperienceStore | null = null

function worktraceBaseDir(): string {
  return join(app.getPath('userData'), 'worktrace')
}

function getTraceRecorder(): TraceRecorder {
  if (!traceRecorderInstance) {
    traceRecorderInstance = new TraceRecorder(worktraceBaseDir())
  }
  return traceRecorderInstance
}

function getExperienceStore(): ExperienceStore {
  if (!experienceStoreInstance) {
    experienceStoreInstance = new ExperienceStore(join(worktraceBaseDir(), 'memory', 'cards.json'))
  }
  return experienceStoreInstance
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 420,
    height: 700,
    minWidth: 360,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#0a0b10',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return
  }

  settingsWindow = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 860,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#0a0b10',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  settingsWindow.on('ready-to-show', () => {
    settingsWindow?.show()
  })

  settingsWindow.on('closed', () => {
    settingsWindow = null
  })

  settingsWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    settingsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=settings`)
  } else {
    settingsWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'settings' }
    })
  }
}

function createMemoryWindow(): void {
  if (memoryWindow && !memoryWindow.isDestroyed()) {
    memoryWindow.show()
    memoryWindow.focus()
    return
  }

  memoryWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#0a0b10',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  memoryWindow.on('ready-to-show', () => {
    memoryWindow?.show()
  })

  memoryWindow.on('closed', () => {
    memoryWindow = null
  })

  memoryWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    memoryWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=memory`)
  } else {
    memoryWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'memory' }
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeFieldType(value: unknown, format?: unknown): ProviderConfigFieldType {
  if (
    value === 'password' ||
    value === 'url' ||
    value === 'select' ||
    value === 'textarea' ||
    value === 'boolean'
  ) {
    return value
  }
  if (format === 'password') return 'password'
  if (format === 'uri' || format === 'url') return 'url'
  return 'text'
}

function normalizeOptions(value: unknown): Array<{ label: string; value: string }> | undefined {
  if (!Array.isArray(value)) return undefined
  const options = value
    .map((item) => {
      if (typeof item === 'string') return { label: item, value: item }
      if (!isRecord(item)) return null
      const label = typeof item.label === 'string' ? item.label : String(item.value || '')
      const optionValue = typeof item.value === 'string' ? item.value : ''
      return optionValue ? { label, value: optionValue } : null
    })
    .filter(Boolean) as Array<{ label: string; value: string }>
  return options.length ? options : undefined
}

function normalizeManifestConfigFields(configSchema: unknown): ProviderConfigField[] {
  if (!isRecord(configSchema)) return []

  const required = Array.isArray(configSchema.required)
    ? configSchema.required.filter((key): key is string => typeof key === 'string')
    : []

  if (Array.isArray(configSchema.fields)) {
    return configSchema.fields
      .map((field) => {
        if (!isRecord(field) || typeof field.key !== 'string') return null
        return {
          key: field.key,
          label: typeof field.label === 'string' ? field.label : field.key,
          type: normalizeFieldType(field.type),
          required: field.required === true || required.includes(field.key),
          readonly: field.readonly === true,
          placeholder: typeof field.placeholder === 'string' ? field.placeholder : undefined,
          hint: typeof field.hint === 'string' ? field.hint : undefined,
          defaultValue:
            typeof field.defaultValue === 'string' || typeof field.defaultValue === 'boolean'
              ? field.defaultValue
              : undefined,
          options: normalizeOptions(field.options)
        }
      })
      .filter(Boolean) as ProviderConfigField[]
  }

  if (!isRecord(configSchema.properties)) return []

  return Object.entries(configSchema.properties).map(([key, property]) => {
    const schema = isRecord(property) ? property : {}
    const title = typeof schema.title === 'string' ? schema.title : key
    return {
      key,
      label: title,
      type: normalizeFieldType(schema.type, schema.format),
      required: required.includes(key),
      readonly: schema.readonly === true || schema.readOnly === true,
      placeholder: typeof schema.placeholder === 'string' ? schema.placeholder : undefined,
      hint: typeof schema.description === 'string' ? schema.description : undefined,
      defaultValue:
        typeof schema.default === 'string' || typeof schema.default === 'boolean'
          ? schema.default
          : undefined,
      options: normalizeOptions(schema.enum)
    }
  })
}

async function fetchJson(url: string): Promise<unknown> {
  return fetchWithTimeout(url, {}, (response) => response.json(), 10_000, 'Provider Hub 请求超时')
}

function getCachedProviderHub(): ProviderHubCache | null {
  const cached = settingsStore.get(PROVIDER_HUB_CACHE_KEY)
  if (!isRecord(cached) || !Array.isArray(cached.providers)) return null
  return cached as ProviderHubCache
}

async function fetchProviderHub(url = DEFAULT_PROVIDER_HUB_URL): Promise<ProviderHubCache> {
  const hub = await fetchJson(url)
  if (!isRecord(hub) || !Array.isArray(hub.providers)) {
    throw new Error('Provider hub JSON must contain a providers array')
  }

  const results = await Promise.allSettled(
    (hub.providers as ProviderHubEntry[])
      .filter((entry) => entry?.enabled !== false && typeof entry?.manifestUrl === 'string')
      .map(async (entry) => {
        const manifestUrl = entry.manifestUrl as string
        const manifest = (await fetchJson(manifestUrl)) as ProviderHubManifest
        if (!isRecord(manifest)) throw new Error('Provider manifest 格式无效')
        const id =
          typeof manifest.id === 'string'
            ? manifest.id
            : typeof entry.id === 'string'
              ? entry.id
              : manifestUrl
        const name = typeof manifest.name === 'string' ? manifest.name : id
        const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0'
        const capabilities = Array.isArray(manifest.capabilities)
          ? manifest.capabilities.filter((item): item is string => typeof item === 'string')
          : undefined
        const description =
          typeof manifest.description === 'string' ? manifest.description : undefined

        return {
          id,
          name,
          description,
          version,
          manifestUrl,
          capabilities,
          configSchema: {
            fields: normalizeManifestConfigFields(manifest.configSchema)
          }
        }
      })
  )

  const providers = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : []
  )
  if (results.length > 0 && providers.length === 0) {
    throw new Error('Provider 列表中的配置清单均不可用')
  }
  const cache = {
    sourceUrl: url,
    fetchedAt: new Date().toISOString(),
    providers
  }
  settingsStore.set(PROVIDER_HUB_CACHE_KEY, cache)
  return cache
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // 检查和请求 macOS 需要的权限
  await checkAndRequestPermissions()

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  // ── Settings 持久化 ──
  ipcMain.handle('settings:getAll', async () => {
    return normalizeSettings(settingsStore.store)
  })

  ipcMain.handle('settings:get', async (_event, key: string) => {
    const settings = normalizeSettings(settingsStore.store)
    return (settings as Record<string, any>)[key]
  })

  ipcMain.handle('settings:set', async (_event, data: Record<string, any>) => {
    const current = normalizeSettings(settingsStore.store)
    const next = mergeSettings(current, data)
    if (runtime?.isRunning()) await runtime.stopSession('settings_changed')
    settingsStore.set(next as any)
    settingsStore.delete('apiKey' as any)
    return { success: true }
  })

  ipcMain.handle('provider:installFromUrl', async (_event, manifestUrl: string) => {
    try {
      const result = await installProviderFromUrl(manifestUrl)
      if (runtime?.isRunning()) await runtime.stopSession('provider_changed')
      const current = normalizeSettings(settingsStore.store)
      settingsStore.set({
        ...current,
        chatProvider: {
          ...current.chatProvider,
          manifestUrl,
          installed: result.installed,
          config: withSchemaDefaults(
            result.manifest.configSchema,
            current.chatProvider.installed?.id === result.installed.id &&
              current.chatProvider.manifestUrl === manifestUrl
              ? current.chatProvider.config
              : {}
          )
        }
      } as any)

      return {
        success: true,
        installed: result.installed,
        manifest: result.manifest
      }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('provider:getInstalled', async () => {
    const settings = normalizeSettings(settingsStore.store)
    if (settings.chatProvider.installed?.id === SILICONFLOW_PROVIDER_ID) {
      return {
        installed: SILICONFLOW_INSTALLED,
        manifest: SILICONFLOW_MANIFEST,
        isBuiltinDefault: false
      }
    }

    // 用户安装过自定义 provider：原样返回
    if (settings.chatProvider.installed) {
      const manifest = await getInstalledProviderManifest(settings.chatProvider.installed)
      return {
        installed: settings.chatProvider.installed,
        manifest,
        isBuiltinDefault: false
      }
    }

    // 没装过 → 回退到内置 doubao（apiKey 字段已剥离，使用视觉密钥）
    const installed = await getBuiltinDoubaoInstalledInfo()
    const manifest = await getBuiltinDoubaoManifestForUi()
    return {
      installed,
      manifest,
      isBuiltinDefault: true
    }
  })

  ipcMain.handle('siliconflow:status', () =>
    siliconFlowStatus(siliconFlowConfig(normalizeSettings(settingsStore.store)))
  )

  ipcMain.handle('image:pick', async () => {
    if (imageSending) return { success: false, error: '图片正在发送，请稍后再选择' }
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg'] }]
    })
    if (result.canceled || !result.filePaths[0]) return { success: false, cancelled: true }
    try {
      const bytes = await readFile(result.filePaths[0])
      if (bytes.length > 12 * 1024 * 1024) throw new Error('图片文件超过 12 MB')
      const image = nativeImage.createFromBuffer(bytes)
      if (image.isEmpty()) throw new Error('无法解析图片')
      const size = image.getSize()
      const scale = Math.min(1, 1600 / Math.max(size.width, size.height))
      const resized =
        scale < 1 ? image.resize({ width: Math.max(1, Math.round(size.width * scale)) }) : image
      const dataUrl = resized.toDataURL()
      validateImageDataUrl(dataUrl)
      if (imageSending) return { success: false, error: '图片正在发送，请稍后再选择' }
      selectedImage = { token: randomUUID(), dataUrl }
      return { success: true, token: selectedImage.token, preview: dataUrl }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '图片读取失败' }
    }
  })

  ipcMain.handle('image:analyze', async (_event, token: unknown, prompt: unknown) => {
    if (!selectedImage || token !== selectedImage.token)
      return { success: false, error: '请重新选择图片' }
    if (typeof prompt !== 'string' || prompt.length > 2000)
      return { success: false, error: '提示词过长' }
    try {
      const config = siliconFlowConfig(normalizeSettings(settingsStore.store))
      const text = await createSiliconFlowClient(config).analyzeImage(selectedImage.dataUrl, prompt)
      return { success: true, text }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '图片识别失败' }
    }
  })

  ipcMain.handle('image:send', async (_event, token: unknown) => {
    if (!selectedImage || token !== selectedImage.token)
      return { success: false, error: '请重新选择图片' }
    if (imageSending) return { success: false, error: '图片正在发送，请勿重复操作' }
    if (runtime?.isRunning() || engineStarting)
      return { success: false, error: '请先暂停引擎再手动发送图片' }
    const appType = normalizeSettings(settingsStore.store).appType
    if (process.platform !== 'win32')
      return { success: false, error: '手动发送图片目前仅支持 Windows' }
    if (appType !== 'wechat' && appType !== 'wework') {
      return { success: false, error: '手动发送图片目前仅支持微信和企业微信' }
    }
    imageSending = true
    const imageToSend = selectedImage
    try {
      const image = nativeImage.createFromDataURL(imageToSend.dataUrl)
      if (image.isEmpty()) throw new Error('图片已失效，请重新选择')
      BrowserWindow.getFocusedWindow()?.minimize()
      await new Promise((resolve) => setTimeout(resolve, 400))
      await sendImageAction(appType, image, async () => {
        // Stopping the engine clears layout memory. Manual send measures it again
        // using the selected provider or saved boxes, without starting auto replies.
        const settings = normalizeSettings(settingsStore.store)
        const { device } = await buildDevice(
          appType,
          settings,
          settings.vision.apiKey,
          (type, content) => console.log(`[ImageSend:${type}] ${content}`)
        )
        device.setAppType(appType)
        const measured = await device.measureLayout()
        if (!measured.success) throw new Error(measured.error || '手动图片发送前的布局测量失败')
      })
      if (selectedImage?.token === imageToSend.token) selectedImage = null
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '发送图片失败' }
    } finally {
      imageSending = false
    }
  })

  ipcMain.handle('providerHub:getCatalog', async () => {
    const cached = getCachedProviderHub()
    if (cached) return { success: true, catalog: cached }

    try {
      const catalog = await fetchProviderHub()
      return { success: true, catalog }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message, catalog: null }
    }
  })

  ipcMain.handle('providerHub:update', async () => {
    try {
      const catalog = await fetchProviderHub()
      return { success: true, catalog }
    } catch (error: unknown) {
      const cached = getCachedProviderHub()
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message, catalog: cached }
    }
  })

  ipcMain.handle('settings:open', async () => {
    createSettingsWindow()
    return { success: true }
  })

  // ── 工作记忆：轨迹查询 / 回放 ──
  ipcMain.handle('memory:open', async () => {
    createMemoryWindow()
    return { success: true }
  })

  ipcMain.handle('trace:listSessions', async () => {
    return listTraceSessions(worktraceBaseDir())
  })

  ipcMain.handle('trace:getSession', async (_event, sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId) return null
    return readTraceSession(worktraceBaseDir(), sessionId)
  })

  ipcMain.handle(
    'trace:getScreenshot',
    async (_event, sessionId: string, screenshotPath: string) => {
      if (typeof sessionId !== 'string' || typeof screenshotPath !== 'string') return null
      return readTraceScreenshot(worktraceBaseDir(), sessionId, screenshotPath)
    }
  )

  // ── 工作记忆：经验卡片 ──
  ipcMain.handle('memory:listCards', async () => {
    return getExperienceStore().listCards()
  })

  ipcMain.handle('memory:learnFromSession', async (_event, sessionId: string) => {
    try {
      const apiKey = normalizeSettings(settingsStore.store).vision.apiKey
      if (!apiKey) {
        return { success: false, error: '请先在设置中填写视觉接口密钥' }
      }
      const data = await readTraceSession(worktraceBaseDir(), sessionId)
      if (!data || data.steps.length === 0) {
        return { success: false, error: '该轨迹暂无可学习的步骤' }
      }

      const client = new AIClient({
        apiKey,
        model: FIXED_ARK_MODEL,
        baseURL: FIXED_ARK_BASE_URL
      })
      const induced = await induceCardsFromSession(client, data.session, data.steps)
      if (induced.length === 0) {
        return { success: true, cards: [] }
      }

      const cards = getExperienceStore().addCards(
        induced.map((item) => ({
          scenario: item.scenario,
          guidance: item.guidance,
          rationale: item.rationale,
          source: 'agent_summary' as const,
          evidence: { sessionId, stepIds: item.stepIds }
        }))
      )
      return { success: true, cards }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('memory:addCard', async (_event, input: NewExperienceCard) => {
    if (!input?.scenario?.trim() || !input?.guidance?.trim()) {
      return { success: false, error: '场景和做法不能为空' }
    }
    const source: NewExperienceCard['source'] =
      input.source === 'human_takeover' || input.source === 'manual' ? input.source : 'manual'
    const cards = getExperienceStore().addCards([
      {
        scenario: input.scenario,
        guidance: input.guidance,
        rationale: input.rationale,
        source,
        evidence: input.evidence
      }
    ])
    return { success: true, cards }
  })

  ipcMain.handle('memory:deleteCard', async (_event, cardId: string) => {
    return { success: getExperienceStore().deleteCard(cardId) }
  })

  ipcMain.handle('memory:setCardEnabled', async (_event, cardId: string, enabled: boolean) => {
    return { success: getExperienceStore().setEnabled(cardId, enabled === true) }
  })

  // ── Runtime / Session IPC（沿用 legacy engine:* 通道名） ──
  ipcMain.handle('engine:start', async (_event, config) => {
    const result = await startEngineCore(config)
    if (result.ok) return { success: true }
    return { success: false, error: result.message || result.reason }
  })

  ipcMain.handle('engine:stop', async (_event, reason?: string) => {
    const result = await stopEngineCore(reason || 'ipc_stop')
    if (result.ok) return { success: true }
    return { success: false, error: result.message || result.reason }
  })

  ipcMain.handle('engine:status', async () => {
    return { running: runtime?.isRunning() ?? false }
  })

  ipcMain.handle('engine:updateConfig', async (_event, config) => {
    // Provider instances capture their original credentials; rebuild on the next start.
    if (runtime?.isRunning()) await runtime.stopSession('settings_changed')
    const settings = normalizeSettings(config || settingsStore.store)
    if (runtimeDevice) {
      // setApiKey 在 BoxSelectDevice 上是 no-op，对 RPADevice 才生效。
      runtimeDevice.setApiKey(settings.vision.apiKey)
      if (runtimeDevice instanceof RPADevice && typeof runtimeDevice.setModel === 'function') {
        if (settings.chatProvider.installed?.id === SILICONFLOW_PROVIDER_ID) {
          runtimeDevice.setVisionClient(createSiliconFlowClient(siliconFlowConfig(settings)))
        } else {
          runtimeDevice.setModel(settings.vision.model)
        }
      }
      runtimeDevice.setAppType(settings.appType)
    }
    if (runtime) {
      runtime.updateAppType(settings.appType)
    }
    return { success: true }
  })

  ipcMain.handle('engine:testConnection', async (_event, config) => {
    const savedVision = normalizeSettings(settingsStore.store).vision
    const apiKey = config?.apiKey ?? savedVision.apiKey
    const client = new AIClient({
      apiKey,
      model: config?.model ?? savedVision.model,
      baseURL: FIXED_ARK_BASE_URL
    })
    return client.testConnection()
  })

  // ── Capture / 框选向导 IPC ──

  ipcMain.handle(
    'capture:openSetupWizard',
    async (_event, args: { appType: AppType; steps?: WizardStepKey[] }) => {
      const settings = normalizeSettings(settingsStore.store)
      const appType = coerceAppType(args?.appType)
      const prefill = settings.capture[appType]?.regions ?? null

      const result = await runBoxSelectWizard({ appType, steps: args?.steps, prefill })
      if (!result.ok || !result.regions) {
        return { success: false, reason: result.reason || 'cancelled' }
      }

      // 持久化区域到 settings.capture[appType]，但保留已有 strategy（默认 'auto'）
      const current = normalizeSettings(settingsStore.store)
      const next: AppSettings = {
        ...current,
        capture: {
          ...current.capture,
          [appType]: {
            strategy: current.capture[appType]?.strategy ?? 'auto',
            regions: result.regions
          }
        }
      }
      settingsStore.set(next as any)
      notifyCaptureRegionsUpdated(appType, result.regions)
      return { success: true, regions: result.regions }
    }
  )

  ipcMain.handle('capture:getRegions', async (_event, appType: AppType) => {
    const settings = normalizeSettings(settingsStore.store)
    return settings.capture[coerceAppType(appType)]?.regions ?? null
  })

  ipcMain.handle('capture:resetRegions', async (_event, appType: AppType) => {
    const current = normalizeSettings(settingsStore.store)
    const key = coerceAppType(appType)
    const next: AppSettings = {
      ...current,
      capture: {
        ...current.capture,
        [key]: { strategy: current.capture[key]?.strategy ?? 'auto', regions: null }
      }
    }
    settingsStore.set(next as any)
    notifyCaptureRegionsUpdated(key, null)
    return { success: true }
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.handle('capture-screen', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      })
      if (sources && sources.length > 0) {
        return sources[0].thumbnail.toDataURL()
      }
      return null
    } catch (error) {
      console.error('Screen capture failed:', error)
      return null
    }
  })

  // ── 测试入口：VLM 并行 vs 串行 ──
  ipcMain.handle('test:vlm-parallel', async () => {
    const apiKey = normalizeSettings(settingsStore.store).vision.apiKey
    if (!apiKey) return { error: '请先在设置中填写视觉接口密钥' }
    const { runVlmParallelTest } = await import('../core/rpa/tests/test-vlm-parallel')
    return await runVlmParallelTest(apiKey, 'wechat')
  })

  // ── Skill HTTP Server（OpenClaw 远程启动 / 暂停接入点） ──
  void startSkillServer(skillEngineController)

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopSkillServer()
})

// ── 引擎启动 / 暂停核心逻辑（IPC 与 Skill HTTP Server 共用） ──

async function startEngineCore(rawConfig?: any): Promise<SkillStartResult> {
  if (imageSending)
    return { ok: false, reason: 'operation_in_progress', message: '图片正在发送，请稍后启动引擎' }
  if (engineStarting) return { ok: false, reason: 'operation_in_progress', message: '引擎正在启动' }
  if (runtime?.isRunning()) {
    return { ok: false, reason: 'already_running', message: '引擎已在运行中' }
  }

  engineStarting = true
  try {
    const settings = normalizeSettings(rawConfig || settingsStore.store)
    const appType: AppType = settings.appType || 'wechat'
    const startupStrategy = resolveSettingsStrategy(appType, settings)
    const providerNeedsVisionKey =
      !settings.chatProvider.installed ||
      settings.chatProvider.installed.id === BUILTIN_DOUBAO_PROVIDER_ID
    const isSiliconFlow = settings.chatProvider.installed?.id === SILICONFLOW_PROVIDER_ID
    const needsVisionKey = (startupStrategy === 'vlm' && !isSiliconFlow) || providerNeedsVisionKey

    if (needsVisionKey && !settings.vision.apiKey) {
      return { ok: false, reason: 'no_vision_key', message: '请先填写视觉接口密钥' }
    }

    // 没有自定义 provider → 走内置 doubao，使用视觉密钥
    let provider
    if (!settings.chatProvider.installed) {
      const loaded = await loadBuiltinDoubaoProvider({
        ...settings.chatProvider.config,
        apiKey: settings.vision.apiKey,
        model: settings.vision.model
      })
      provider = loaded.provider
    } else if (isSiliconFlow) {
      provider = createSiliconFlowProvider(
        createSiliconFlowClient(siliconFlowConfig(settings), 'reply')
      )
    } else {
      const installedManifest = await getInstalledProviderManifest(settings.chatProvider.installed)
      // doubao（无论是用户主动装的还是内置的）apiKey 由视觉密钥共享提供，不强校验
      const isDoubao = settings.chatProvider.installed.id === BUILTIN_DOUBAO_PROVIDER_ID
      const required = (installedManifest?.configSchema?.required || []).filter(
        (key) => !(isDoubao && key === 'apiKey')
      )
      const missing = required.find((key) => {
        const value = settings.chatProvider.config?.[key]
        return value === undefined || value === null || value === ''
      })
      if (missing) {
        return {
          ok: false,
          reason: 'missing_required_field',
          message: `缺少必填配置: ${missing}`
        }
      }

      const effectiveConfig = isDoubao
        ? {
            ...settings.chatProvider.config,
            apiKey: settings.vision.apiKey,
            model: settings.vision.model
          }
        : settings.chatProvider.config

      const loaded = await loadInstalledProvider(settings.chatProvider.installed, effectiveConfig)
      provider = loaded.provider
    }

    const mainWindow = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
    const log = (type: 'thinking' | 'reply' | 'skip' | 'error', content: string): void => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('engine:log', { type, content })
      }
    }

    let device: DesktopDevice
    let strategy: CaptureStrategy
    try {
      const built = await buildDevice(appType, settings, settings.vision.apiKey, log)
      device = built.device
      strategy = built.strategy
    } catch (err: any) {
      const message = err?.message || String(err)
      if (message === 'user_cancelled_box_select_wizard') {
        return { ok: false, reason: 'wizard_cancelled', message: '已取消框选，引擎未启动' }
      }
      throw err
    }
    log('thinking', `已选用抓取策略：${strategy}`)
    runtimeDevice = device

    // ── 工作记忆：本次执行的所有步骤落成 work-trace 会话 ──
    const recorder = getTraceRecorder()
    recorder.startSession({
      appType,
      engineVersion: app.getVersion(),
      providerId: settings.chatProvider.installed?.id ?? BUILTIN_DOUBAO_PROVIDER_ID,
      model: isSiliconFlow
        ? siliconFlowStatus(siliconFlowConfig(settings)).replyModel
        : providerNeedsVisionKey
          ? settings.vision.model
          : settings.chatProvider.config?.model || FIXED_ARK_MODEL
    })

    const onTrace = (input: TraceStepInput): void => {
      const step = recorder.record(input)
      if (!step) return

      // 继承闭环：带经验引用的回复成功发送 → 卡片 used/success 计数
      const refs = step.reasoning?.memoryRefs
      if (step.phase === 'act' && step.action?.kind === 'send' && refs?.length) {
        getExperienceStore().recordUsage(refs, step.outcome?.status === 'ok')
      }

      // 实时推给工作记忆窗口
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('trace:step', { sessionId: step.sessionId, step })
        }
      }
    }

    const channel = new GenericChannelSession(device)
    runtime = new RuntimeHost({
      appType,
      channel,
      provider,
      initialState: createInitialGenericChannelState(),
      onLog: log,
      onTrace,
      getMemoryCards: () => getExperienceStore().getActiveCardBriefs(),
      onSessionEnd: () => {
        recorder.endSession()
        notifyEngineStateChanged('idle')
      }
    })

    await runtime.startSession()
    if (!runtime.isRunning()) {
      return { ok: false, reason: 'engine_failed', message: '引擎初始化失败，请检查运行日志' }
    }

    notifyEngineStateChanged('running')

    return { ok: true }
  } catch (error: any) {
    return {
      ok: false,
      reason: 'engine_failed',
      message: error?.message || String(error)
    }
  } finally {
    engineStarting = false
  }
}

async function stopEngineCore(stopReason: string): Promise<SkillPauseResult> {
  if (!runtime?.isRunning()) {
    return { ok: false, reason: 'not_running', message: '引擎未运行' }
  }
  try {
    await runtime.stopSession(stopReason)
    notifyEngineStateChanged('idle')
    return { ok: true }
  } catch (error: any) {
    return {
      ok: false,
      reason: 'pause_failed',
      message: error?.message || String(error)
    }
  }
}

/** 通知 Renderer 引擎状态变化（让 UI 在远程启停时同步切换） */
function notifyEngineStateChanged(status: 'running' | 'idle'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('engine:state', { status })
    }
  }
}

/** 通知 Renderer：某个 appType 的框选区域被向导/重置更新了，UI 上的 chip 立即重渲染。 */
function notifyCaptureRegionsUpdated(appType: AppType, regions: BoxRegions | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('capture:regions-updated', { appType, regions })
    }
  }
}

/**
 * 选取实际生效的 capture strategy。
 * 用户在 settings 里给 appType 显式设置过策略，就用它；否则用全局默认；
 * 全局默认是 'auto' 时，wechat/wework 优先 VLM，其它直接 box-select。
 */
function resolveEffectiveStrategy(
  appType: AppType,
  perAppStrategy: CaptureStrategy,
  defaultStrategy: CaptureStrategy
): CaptureStrategy {
  const effective = perAppStrategy === 'auto' ? defaultStrategy : perAppStrategy
  if (effective === 'auto') {
    return isWechatLike(appType) ? 'vlm' : 'box-select'
  }
  return effective
}

function resolveSettingsStrategy(appType: AppType, settings: AppSettings): CaptureStrategy {
  const perApp = settings.capture[appType] ?? { strategy: 'auto' as CaptureStrategy, regions: null }
  return resolveEffectiveStrategy(appType, perApp.strategy, settings.defaultCaptureStrategy)
}

/**
 * 把 capture 配置 + strategy 解析成具体设备实例。
 * VLM 和 box-select 只决定"如何测量 LayoutCache"，后续运行统一消费 LayoutCache。
 * 本轮不做 VLM 失败自动 fallback；VLM 测量失败由 session bootstrap 报错停止。
 */
async function buildDevice(
  appType: AppType,
  settings: AppSettings,
  apiKey: string,
  log: (type: 'thinking' | 'reply' | 'skip' | 'error', content: string) => void
): Promise<{ device: DesktopDevice; strategy: CaptureStrategy }> {
  const perApp = settings.capture[appType] ?? { strategy: 'auto' as CaptureStrategy, regions: null }
  const effective = resolveSettingsStrategy(appType, settings)

  if (effective === 'vlm') {
    const rpa = new RPADevice()
    rpa.setAppType(appType)
    if (settings.chatProvider.installed?.id === SILICONFLOW_PROVIDER_ID) {
      rpa.setVisionClient(createSiliconFlowClient(siliconFlowConfig(settings)))
    } else {
      rpa.setApiKey(apiKey)
      rpa.setModel(settings.vision.model)
    }
    return { device: rpa, strategy: 'vlm' }
  }

  // box-select 路线：缺区域则拉向导
  let regions = perApp.regions
  if (!regions) {
    log('thinking', `首次配置 ${appType}：请框选 3 个关键区域`)
    const wizardResult = await runBoxSelectWizard({ appType, prefill: null })
    if (!wizardResult.ok || !wizardResult.regions) {
      throw new Error('user_cancelled_box_select_wizard')
    }
    regions = wizardResult.regions
    persistRegionsAndStickyStrategy(appType, regions, perApp.strategy)
  }
  return { device: new BoxSelectDevice(regions), strategy: 'box-select' }
}

/** 把向导产出的 regions 写回 settings，并保留当前策略配置。 */
function persistRegionsAndStickyStrategy(
  appType: AppType,
  regions: BoxRegions,
  strategy: CaptureStrategy
): void {
  const current = normalizeSettings(settingsStore.store)
  const next: AppSettings = {
    ...current,
    capture: {
      ...current.capture,
      [appType]: { strategy, regions }
    }
  }
  settingsStore.set(next as any)
  notifyCaptureRegionsUpdated(appType, regions)
}

const skillEngineController: SkillEngineController = {
  start: () => startEngineCore(),
  pause: () => stopEngineCore('skill_pause'),
  isRunning: () => runtime?.isRunning() ?? false
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
