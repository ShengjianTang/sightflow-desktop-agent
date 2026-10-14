const assert = require('node:assert/strict')
const { test } = require('node:test')
const { normalizeSettings, mergeSettings } = require('../src/main/settings.ts')
const { loadSource } = require('./helpers.cjs')

function settings(id = 'first') {
  return normalizeSettings({
    vision: { apiKey: 'vision-test-only' },
    chatProvider: {
      installed: { id },
      manifestUrl: 'https://example.invalid/' + id + '/manifest.json',
      config: { apiKey: 'provider-test-only', privateEndpoint: 'https://example.invalid/private' }
    }
  })
}

test('missing settings normalize to usable defaults', () => {
  const empty = normalizeSettings(null)
  assert.equal(empty.vision.apiKey, '')
  assert.equal(empty.appType, 'wechat')
  assert.deepEqual(empty.capture, {})
})

test('explicitly cleared vision keys cannot be revived by legacy settings', () => {
  const normalized = normalizeSettings({
    apiKey: 'legacy-test-only',
    vision: { apiKey: '' },
    chatProvider: { config: { apiKey: 'legacy-test-only' } }
  })
  assert.equal(normalized.vision.apiKey, '')
  assert.equal(normalized.chatProvider.config.apiKey, undefined)
  assert.equal(normalizeSettings({ apiKey: 'legacy-test-only' }).vision.apiKey, 'legacy-test-only')
})

test('provider switches and URL changes never inherit previous credentials', () => {
  const current = settings()
  const switched = mergeSettings(current, {
    chatProvider: {
      installed: { id: 'second' },
      manifestUrl: 'https://example.invalid/second/manifest.json',
      config: { model: 'new-model' }
    }
  })
  assert.deepEqual(switched.chatProvider.config, { model: 'new-model' })
  assert.equal(switched.vision.apiKey, 'vision-test-only')
  const moved = mergeSettings(current, {
    chatProvider: { manifestUrl: 'https://other.invalid/manifest.json' }
  })
  assert.deepEqual(moved.chatProvider.config, {})
})

test('same-provider edits preserve unrelated fields and allow clearing credentials', () => {
  const next = mergeSettings(settings(), {
    chatProvider: { config: { apiKey: '', enabled: false } }
  })
  assert.equal(next.chatProvider.config.apiKey, '')
  assert.equal(next.chatProvider.config.enabled, false)
  assert.equal(next.chatProvider.config.privateEndpoint, 'https://example.invalid/private')
})

test('invalid capture geometry is discarded so setup can run again', () => {
  const rect = { x: 0, y: 0, width: 20, height: 30 }
  const result = normalizeSettings({
    capture: {
      generic: { regions: { contactList: rect, chatMain: { ...rect, width: -1 }, inputBox: rect } }
    }
  })
  assert.equal(result.capture.generic.regions, null)
})

test('provider required validation accepts false but rejects blank passwords', () => {
  const { validateProviderConfig } = loadSource('src/main/provider-bundle.ts', {
    electron: { app: {} }
  })
  const manifest = {
    configSchema: {
      properties: { enabled: { type: 'boolean' }, apiKey: { type: 'password' } },
      required: ['enabled', 'apiKey']
    }
  }
  assert.equal(
    validateProviderConfig(manifest, { enabled: false, apiKey: 'test-only-key' }).valid,
    true
  )
  assert.equal(validateProviderConfig(manifest, { enabled: false, apiKey: ' ' }).valid, false)
})

test('visual model persists independently of provider config and defaults for old settings', () => {
  assert.equal(normalizeSettings(null).vision.model, 'doubao-seed-evolving')
  const saved = mergeSettings(normalizeSettings(null), {
    vision: { apiKey: '  test-only  ', model: '  ep-test-only  ' }
  })
  assert.deepEqual(saved.vision, { apiKey: 'test-only', model: 'ep-test-only' })
  assert.equal(normalizeSettings({ model: 'legacy-model' }).vision.model, 'legacy-model')
})

test('previous bundled default migrates without replacing manually selected models', () => {
  const previousDefault = 'doubao-seed-2-0-lite-260215'
  const migrated = normalizeSettings({
    vision: { apiKey: 'test-only-key', model: previousDefault },
    chatProvider: { config: { model: previousDefault } }
  })
  assert.equal(migrated.vision.apiKey, 'test-only-key')
  assert.equal(migrated.vision.model, 'doubao-seed-evolving')
  assert.equal(migrated.chatProvider.config.model, 'doubao-seed-evolving')
  assert.equal(normalizeSettings({ vision: { model: 'ep-manual' } }).vision.model, 'ep-manual')
  assert.equal(
    normalizeSettings({
      chatProvider: { installed: { id: 'custom' }, config: { model: previousDefault } }
    }).chatProvider.config.model,
    previousDefault
  )
})

test('SiliconFlow credentials and model survive provider switches without entering other provider config', () => {
  const saved = mergeSettings(normalizeSettings(null), {
    siliconFlow: { apiKey: '  saved-test-only  ', model: '  Qwen/test-vision  ' },
    chatProvider: {
      installed: { id: 'siliconflow-vision' },
      manifestUrl: 'builtin://siliconflow',
      config: {}
    }
  })
  assert.deepEqual(saved.siliconFlow, {
    apiKey: 'saved-test-only',
    model: 'Qwen/test-vision'
  })
  const switched = mergeSettings(saved, {
    chatProvider: {
      installed: { id: 'custom' },
      manifestUrl: 'https://example.invalid/custom',
      config: {}
    }
  })
  assert.deepEqual(switched.siliconFlow, saved.siliconFlow)
  assert.deepEqual(switched.chatProvider.config, {})
  const cleared = mergeSettings(switched, { siliconFlow: { apiKey: '' } })
  assert.equal(cleared.siliconFlow.apiKey, '')
  assert.equal(cleared.siliconFlow.model, 'Qwen/test-vision')
})

test('older SiliconFlow provider config migrates once to the dedicated settings namespace', () => {
  const settings = normalizeSettings({
    chatProvider: {
      installed: { id: 'siliconflow-vision' },
      config: { apiKey: 'legacy-test-only', model: 'Qwen/legacy' }
    }
  })
  assert.deepEqual(settings.siliconFlow, { apiKey: 'legacy-test-only', model: 'Qwen/legacy' })
  assert.deepEqual(settings.chatProvider.config, {})
  assert.equal(mergeSettings(settings, { siliconFlow: { apiKey: '' } }).siliconFlow.apiKey, '')
})
