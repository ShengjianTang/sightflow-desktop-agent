const assert = require('node:assert/strict')
const { test } = require('node:test')
const { loadSource } = require('./helpers.cjs')
const path = require('node:path')
const manifest = {
  apiVersion: 1,
  id: 'test-provider',
  name: 'Test',
  version: '1.0.0',
  entry: 'bundle.js',
  moduleType: 'module',
  capabilities: ['chat'],
  configSchema: { type: 'object', properties: {} }
}

function installer() {
  const writes = []
  return {
    writes,
    ...loadSource('src/main/provider-bundle.ts', {
      electron: { app: { getPath: () => path.resolve('.local/test-user-data') } },
      'node:fs/promises': {
        mkdir: async (...args) => writes.push(args),
        writeFile: async (...args) => writes.push(args)
      }
    })
  }
}

test('failed provider bundle download makes no filesystem changes', async (t) => {
  const install = installer()
  t.mock.method(globalThis, 'fetch', async (url) =>
    String(url).endsWith('manifest.json')
      ? Response.json(manifest)
      : new Response('unavailable', { status: 503 })
  )
  await assert.rejects(
    install.installProviderFromUrl('https://example.invalid/manifest.json'),
    /HTTP 503/
  )
  assert.equal(install.writes.length, 0)
})

test('invalid JSON and path traversal in provider manifests are rejected before writes', async (t) => {
  const install = installer()
  t.mock.method(globalThis, 'fetch', async () => new Response('{'))
  await assert.rejects(
    install.installProviderFromUrl('https://example.invalid/manifest.json'),
    SyntaxError
  )
  for (const field of ['id', 'version']) {
    globalThis.fetch = async () => Response.json({ ...manifest, [field]: '../outside' })
    await assert.rejects(
      install.installProviderFromUrl('https://example.invalid/manifest.json'),
      /单级目录名/
    )
  }
  assert.equal(install.writes.length, 0)
})

test('manifest downloads abort even when headers arrive but body stalls', async (t) => {
  const install = installer()
  const realSetTimeout = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) =>
    realSetTimeout(fn, ms === 15000 ? 20 : ms, ...args)
  )
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => ({
    ok: true,
    text: () =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true
        })
      })
  }))
  await assert.rejects(
    install.installProviderFromUrl('https://example.invalid/manifest.json'),
    /下载超时/
  )
  assert.equal(install.writes.length, 0)
})
