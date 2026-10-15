const assert = require('node:assert/strict')
const { test } = require('node:test')
const { setImmediate: nextTurn } = require('node:timers/promises')
const { loadSource } = require('./helpers.cjs')

async function mainProcess(t, options = {}) {
  const handlers = new Map()
  let store
  class MemoryStore {
    constructor(options) {
      this.store = structuredClone(options.defaults)
      store = { set: this.set.bind(this) }
    }
    get(key) {
      return this.store[key]
    }
    set(key, value) {
      if (typeof key === 'string') this.store[key] = value
      else Object.assign(this.store, key)
    }
    delete(key) {
      delete this.store[key]
    }
  }
  class Window {
    static windows = []
    static getAllWindows() {
      return this.windows
    }
    static getFocusedWindow() {
      return { minimize: () => undefined }
    }
    constructor() {
      Window.windows.push(this)
      this.webContents = { send: () => undefined, setWindowOpenHandler: () => undefined }
    }
    on() {
      return this
    }
    isDestroyed() {
      return false
    }
    loadFile() {
      return Promise.resolve()
    }
  }
  class FakeDevice {
    setVisionClient() {
      return undefined
    }
    setApiKey() {
      return undefined
    }
    setModel() {
      return undefined
    }
    setAppType() {
      return undefined
    }
    clearChatBaseline() {
      return undefined
    }
    // Keep layout pending; these tests must never capture or send to a desktop.
    measureLayout() {
      return new Promise(() => {})
    }
  }
  let loadedConfig
  const manifest = {
    configSchema: {
      properties: { apiKey: { type: 'password', title: 'Key' } },
      required: ['apiKey']
    }
  }
  loadSource('src/main/index.ts', {
    electron: {
      app: {
        whenReady: () => Promise.resolve(),
        on: () => undefined,
        getVersion: () => 'test',
        getPath: () => '.local/test-user-data'
      },
      BrowserWindow: Window,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['mock.png'] }) },
      nativeImage: {
        createFromBuffer: () => ({
          isEmpty: () => false,
          getSize: () => ({ width: 200, height: 100 }),
          toDataURL: () => 'data:image/png;base64,cGl4ZWw='
        }),
        createFromDataURL: () => ({ isEmpty: () => false })
      },
      ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: () => undefined }
    },
    'node:fs/promises': { readFile: async () => Buffer.from('pixel') },
    '../core/rpa/input-utils': {
      sendImageAction: options.sendImageAction || (async () => undefined)
    },
    'electron-store': MemoryStore,
    '@electron-toolkit/utils': {
      electronApp: { setAppUserModelId: () => undefined },
      optimizer: {},
      is: { dev: false }
    },
    '../../resources/icon.png?asset': 'test-icon',
    './permission': { checkAndRequestPermissions: async () => undefined },
    '../core/rpa-device': { RPADevice: FakeDevice },
    '../core/box-select-device': { BoxSelectDevice: FakeDevice },
    './overlay-window': { runBoxSelectWizard: async () => ({ ok: false, reason: 'cancelled' }) },
    './skill-server': { startSkillServer: async () => null, stopSkillServer: () => undefined },
    './provider-bundle': {
      BUILTIN_DOUBAO_PROVIDER_ID: 'volcengine-ark',
      getInstalledProviderManifest: async () => manifest,
      loadBuiltinDoubaoProvider: async (config) => {
        loadedConfig = config
        return { provider: {} }
      },
      loadInstalledProvider: async (_installed, config) => {
        loadedConfig = config
        return { provider: {} }
      }
    },
    '../core/trace/trace-recorder': {
      TraceRecorder: class {
        startSession() {
          return undefined
        }
        endSession() {
          return undefined
        }
      }
    },
    '../core/memory/experience-store': { ExperienceStore: class {} }
  })
  await nextTurn()
  const invoke = (name, ...payload) => handlers.get(name)({}, ...payload)
  t.after(() => invoke('engine:stop'))
  return { invoke, getConfig: () => loadedConfig, store }
}

test('main IPC starts without keys, rejects incomplete config, and allows custom box selection', async (t) => {
  const { invoke, getConfig } = await mainProcess(t)
  assert.equal((await invoke('settings:getAll')).vision.apiKey, '')
  const missing = await invoke('engine:start')
  assert.equal(missing.success, false)
  assert.match(missing.error, /视觉接口密钥/)
  const rect = { x: 0, y: 0, width: 20, height: 30 }
  await invoke('settings:set', {
    appType: 'generic',
    chatProvider: {
      installed: { id: 'custom' },
      manifestUrl: 'https://example.invalid/manifest.json',
      config: {}
    },
    capture: {
      generic: {
        strategy: 'box-select',
        regions: { contactList: rect, chatMain: rect, inputBox: rect }
      }
    }
  })
  assert.match((await invoke('engine:start')).error, /apiKey/)
  await invoke('settings:set', { chatProvider: { config: { apiKey: 'custom-test-only' } } })
  assert.deepEqual(await invoke('engine:start'), { success: true })
  assert.deepEqual(getConfig(), { apiKey: 'custom-test-only' })
  assert.deepEqual(await invoke('engine:stop'), { success: true })
  await invoke('settings:set', { capture: { generic: { strategy: 'box-select', regions: null } } })
  assert.match((await invoke('engine:start')).error, /已取消框选/)
})

test('SiliconFlow settings save drives startup and image analysis without an Ark key', async (t) => {
  const previous = process.env.SILICONFLOW_API_KEY
  delete process.env.SILICONFLOW_API_KEY
  t.after(() => {
    if (previous === undefined) delete process.env.SILICONFLOW_API_KEY
    else process.env.SILICONFLOW_API_KEY = previous
  })
  const { invoke } = await mainProcess(t)
  await invoke('settings:set', {
    chatProvider: {
      installed: { id: 'siliconflow-vision', name: '硅基流动多模态' },
      manifestUrl: 'builtin://siliconflow',
      config: {}
    }
  })
  assert.equal((await invoke('provider:getInstalled')).installed.id, 'siliconflow-vision')
  assert.deepEqual(await invoke('siliconflow:status'), {
    configured: false,
    environmentConfigured: false,
    model: 'Qwen/Qwen3-VL-30B-A3B-Instruct',
    replyModel: 'Qwen/Qwen3-VL-30B-A3B-Instruct'
  })
  assert.match((await invoke('engine:start')).error, /API Key/)

  await invoke('settings:set', {
    siliconFlow: { apiKey: 'saved-test-only', model: 'Qwen/saved-vision' }
  })
  assert.deepEqual((await invoke('settings:getAll')).siliconFlow, {
    apiKey: 'saved-test-only',
    model: 'Qwen/saved-vision',
    replyModel: ''
  })
  assert.equal((await invoke('siliconflow:status')).configured, true)
  assert.equal((await invoke('siliconflow:status')).model, 'Qwen/saved-vision')
  assert.doesNotMatch(JSON.stringify(await invoke('siliconflow:status')), /saved-test-only/)
  assert.doesNotMatch(JSON.stringify(await invoke('provider:getInstalled')), /saved-test-only/)

  const seen = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    seen.push({ authorization: init.headers.Authorization, model: JSON.parse(init.body).model })
    return Response.json({ choices: [{ message: { content: '识别成功' } }] })
  })
  const selected = await invoke('image:pick')
  assert.equal((await invoke('image:analyze', selected.token, '识别')).text, '识别成功')
  assert.deepEqual(seen, [{ authorization: 'Bearer saved-test-only', model: 'Qwen/saved-vision' }])
  assert.deepEqual(await invoke('engine:start'), { success: true })
  assert.deepEqual(await invoke('engine:stop'), { success: true })

  await invoke('settings:set', { chatProvider: { installed: null, manifestUrl: '', config: {} } })
  assert.equal((await invoke('settings:getAll')).siliconFlow.apiKey, 'saved-test-only')
  await invoke('settings:set', {
    chatProvider: {
      installed: { id: 'siliconflow-vision' },
      manifestUrl: 'builtin://siliconflow',
      config: {}
    }
  })
  assert.deepEqual(await invoke('engine:start'), { success: true })
  assert.deepEqual(await invoke('engine:stop'), { success: true })

  await invoke('settings:set', { siliconFlow: { apiKey: '' } })
  assert.match((await invoke('engine:start')).error, /API Key/)
  process.env.SILICONFLOW_API_KEY = 'environment-test-only'
  assert.deepEqual(await invoke('engine:start'), { success: true })
  assert.deepEqual(await invoke('engine:stop'), { success: true })
})

test(
  'image IPC protects tokens, blocks concurrent desktop actions, and consumes a sent image',
  {
    skip: process.platform !== 'win32'
  },
  async (t) => {
    let releaseSend
    let sendCount = 0
    const { invoke } = await mainProcess(t, {
      sendImageAction: async () => {
        sendCount++
        await new Promise((resolve) => {
          releaseSend = resolve
        })
      }
    })
    const selected = await invoke('image:pick')
    assert.equal(selected.success, true)
    assert.equal((await invoke('image:analyze', 'wrong-token', 'prompt')).success, false)
    assert.equal((await invoke('image:send', 'wrong-token')).success, false)
    const sending = invoke('image:send', selected.token)
    assert.match((await invoke('image:pick')).error, /正在发送/)
    assert.match((await invoke('image:send', selected.token)).error, /正在发送/)
    assert.match((await invoke('engine:start')).error, /正在发送/)
    while (!releaseSend) await new Promise((resolve) => setTimeout(resolve, 10))
    releaseSend()
    assert.deepEqual(await sending, { success: true })
    assert.equal(sendCount, 1)
    assert.match((await invoke('image:send', selected.token)).error, /重新选择/)
  }
)

test('main IPC returns cached provider catalog when the Hub is offline', async (t) => {
  const { invoke, store } = await mainProcess(t)
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('offline')
  })
  assert.equal((await invoke('providerHub:getCatalog')).success, false)
  const cache = { sourceUrl: 'https://example.invalid/hub', fetchedAt: 'test', providers: [] }
  store.set('providerHubCache', cache)
  assert.deepEqual((await invoke('providerHub:getCatalog')).catalog, cache)
  const refreshed = await invoke('providerHub:update')
  assert.equal(refreshed.success, false)
  assert.deepEqual(refreshed.catalog, cache)
})

test('main IPC keeps successful Hub entries when another manifest fails', async (t) => {
  const { invoke } = await mainProcess(t)
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).endsWith('/good.json'))
      return Response.json({
        id: 'good',
        name: 'Good',
        version: '1',
        configSchema: {
          properties: { enabled: { type: 'boolean', title: 'Enabled', default: false } },
          required: ['enabled']
        }
      })
    if (String(url).endsWith('/bad.json')) return new Response('', { status: 503 })
    return Response.json({
      providers: [
        { manifestUrl: 'https://example.invalid/good.json' },
        { manifestUrl: 'https://example.invalid/bad.json' }
      ]
    })
  })
  const result = await invoke('providerHub:update')
  assert.equal(result.success, true)
  assert.deepEqual(
    result.catalog.providers.map((provider) => provider.id),
    ['good']
  )
  assert.equal(result.catalog.providers[0].configSchema.fields[0].defaultValue, false)
})

test('editing active settings stops the session before stale credentials can be reused', async (t) => {
  const { invoke } = await mainProcess(t)
  const rect = { x: 0, y: 0, width: 20, height: 30 }
  await invoke('settings:set', {
    appType: 'generic',
    chatProvider: {
      installed: { id: 'custom' },
      manifestUrl: 'https://example.invalid/manifest.json',
      config: { apiKey: 'custom-test-only' }
    },
    capture: {
      generic: {
        strategy: 'box-select',
        regions: { contactList: rect, chatMain: rect, inputBox: rect }
      }
    }
  })
  assert.equal((await invoke('engine:start')).success, true)
  await invoke('settings:set', { chatProvider: { config: { apiKey: '' } } })
  await invoke('engine:updateConfig', await invoke('settings:getAll'))
  assert.deepEqual(await invoke('engine:status'), { running: false })
})

test('main IPC testConnection uses the supplied draft key and model', async (t) => {
  const { invoke } = await mainProcess(t)
  let request
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    request = {
      url: String(url),
      authorization: init.headers.Authorization,
      body: JSON.parse(init.body)
    }
    return Response.json({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }]
    })
  })
  assert.deepEqual(
    await invoke('engine:testConnection', { apiKey: '  test-only-key  ', model: 'ep-test-only' }),
    { success: true }
  )
  assert.equal(request.url, 'https://ark.cn-beijing.volces.com/api/v3/responses')
  assert.equal(request.authorization, 'Bearer test-only-key')
  assert.equal(request.body.model, 'ep-test-only')
})

test('saved legacy default reaches the built-in provider as the enabled model', async (t) => {
  const { invoke, getConfig, store } = await mainProcess(t)
  store.set('vision', { apiKey: 'test-only-key', model: 'doubao-seed-2-0-lite-260215' })
  const rect = { x: 0, y: 0, width: 20, height: 30 }
  await invoke('settings:set', {
    appType: 'generic',
    capture: {
      generic: {
        strategy: 'box-select',
        regions: { contactList: rect, chatMain: rect, inputBox: rect }
      }
    }
  })
  assert.equal((await invoke('settings:getAll')).vision.model, 'doubao-seed-evolving')
  assert.deepEqual(await invoke('engine:start'), { success: true })
  assert.equal(getConfig().apiKey, 'test-only-key')
  assert.equal(getConfig().model, 'doubao-seed-evolving')
})
