const assert = require('node:assert/strict')
const http = require('node:http')
const { test } = require('node:test')
const { once } = require('node:events')
const { fetchWithTimeout } = require('../src/core/http-request.ts')
const { AIClient } = require('../src/core/ai-client.ts')
const { loadSource } = require('./helpers.cjs')

async function localService(t) {
  const server = http.createServer((req, res) => {
    if (req.url === '/stall') {
      res.writeHead(200)
      res.write('{')
      return
    }
    if (req.url === '/error') {
      res.writeHead(503)
      res.end('DO_NOT_LOG_UPSTREAM_SECRET')
      return
    }
    if (req.url === '/invalid') {
      res.end('{}')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'local reply' }] }]
      })
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      })
  )
  return 'http://127.0.0.1:' + server.address().port
}

test('HTTP timeout remains active while the response body stalls', async (t) => {
  const url = await localService(t)
  await assert.rejects(
    fetchWithTimeout(url + '/stall', {}, (r) => r.json(), 100, 'body timeout'),
    /body timeout/
  )
})

test('HTTP errors do not echo upstream response bodies', async (t) => {
  const url = await localService(t)
  await assert.rejects(
    fetchWithTimeout(url + '/error', {}, (r) => r.text(), 1000, 'timeout'),
    (error) => {
      assert.equal(error.message, 'HTTP 503')
      return true
    }
  )
})

test('AIClient rejects empty credentials without network traffic', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('unexpected network')
  })
  const result = await new AIClient({ apiKey: '   ' }).testConnection()
  assert.equal(result.success, false)
  assert.match(result.error, /密钥/)
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('AIClient handles success, invalid replies and disconnected services', async (t) => {
  const url = await localService(t)
  const realFetch = globalThis.fetch
  const client = new AIClient({ apiKey: 'test-only-key', baseURL: url + '/' })
  assert.equal(await client.callText('test'), 'local reply')
  t.mock.method(globalThis, 'fetch', () => realFetch(url + '/invalid'))
  assert.equal((await client.testConnection()).success, false)
  globalThis.fetch = async () => {
    throw new Error('connection refused')
  }
  assert.deepEqual(await client.testConnection(), { success: false, error: 'connection refused' })
})

test('bundled provider returns error events for missing keys and network failures', async (t) => {
  const { createProvider } = loadSource('resources/providers/volcengine-ark/provider.bundle.js')
  const collect = async (provider) => {
    const events = []
    for await (const event of provider.run({ screenshot: 'test-image' })) events.push(event)
    return events
  }
  assert.equal((await collect(createProvider({ providerConfig: {} })))[0].type, 'error')
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('connection refused')
  })
  const events = await collect(createProvider({ providerConfig: { apiKey: 'test-only-key' } }))
  assert.equal(events.at(-1).type, 'error')
  assert.match(events.at(-1).error, /connection refused/)
})

test('bundled provider aborts stalled response bodies and can recover on the next call', async (t) => {
  const url = await localService(t)
  const realFetch = globalThis.fetch
  const realSetTimeout = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) =>
    realSetTimeout(callback, ms === 90000 ? 100 : ms, ...args)
  )
  t.mock.method(globalThis, 'fetch', (_url, init) => realFetch(url + '/stall', init))
  const { createProvider } = loadSource('resources/providers/volcengine-ark/provider.bundle.js')
  const provider = createProvider({ providerConfig: { apiKey: 'test-only-key' } })
  const events = []
  for await (const event of provider.run({ screenshot: 'test-image' })) events.push(event)
  assert.equal(events.at(-1).type, 'error')
  assert.match(events.at(-1).error, /超时 \(90s\)/)
  globalThis.fetch = (_url, init) => realFetch(url, init)
  const recovered = []
  for await (const event of provider.run({ screenshot: 'test-image' })) recovered.push(event)
  assert.deepEqual(recovered.at(-1), { type: 'reply_text', content: 'local reply' })
})

test('connection test sends the manually selected model and trimmed key to the Ark route', async (t) => {
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push({
      url: String(url),
      authorization: init.headers.Authorization,
      body: JSON.parse(init.body)
    })
    return Response.json({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }]
    })
  })
  const client = new AIClient({
    apiKey: '  test-only-key  ',
    model: 'ep-test-only',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3/'
  })
  assert.deepEqual(await client.testConnection(), { success: true })
  assert.equal(seen[0].url, 'https://ark.cn-beijing.volces.com/api/v3/responses')
  assert.equal(seen[0].authorization, 'Bearer test-only-key')
  assert.equal(seen[0].body.model, 'ep-test-only')
  assert.deepEqual(seen[0].body.thinking, { type: 'disabled' })
  assert.deepEqual(seen[0].body.input, [{ role: 'user', content: '你好，请回复"连接成功"。' }])
})

test('vision call sends an image using the Responses input_image format', async (t) => {
  let request
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    request = JSON.parse(init.body)
    return Response.json({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'found' }] }]
    })
  })
  const client = new AIClient({ apiKey: 'test-only-key' })
  assert.equal(await client.detectVision('locate', 'data:image/png;base64,dGVzdA=='), 'found')
  assert.equal(request.model, 'doubao-seed-evolving')
  assert.deepEqual(request.thinking, { type: 'disabled' })
  assert.deepEqual(request.input[1].content, [
    { type: 'input_image', image_url: 'data:image/png;base64,dGVzdA==' },
    { type: 'input_text', text: 'locate' }
  ])
})

test('HTTP 404 points to model or endpoint access without logging response contents', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('DO_NOT_LOG_UPSTREAM_SECRET', { status: 404 })
  )
  const result = await new AIClient({
    apiKey: 'test-only-key',
    model: 'ep-unavailable'
  }).testConnection()
  assert.equal(result.success, false)
  assert.match(result.error, /HTTP 404.*模型或推理接入点/)
  assert.doesNotMatch(result.error, /DO_NOT_LOG_UPSTREAM_SECRET/)
})

test('bundled provider sends the selected model and credential to the same Ark route', async (t) => {
  let seen
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen = {
      url: String(url),
      authorization: init.headers.Authorization,
      body: JSON.parse(init.body)
    }
    return Response.json({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }]
    })
  })
  const { createProvider } = loadSource('resources/providers/volcengine-ark/provider.bundle.js')
  const events = []
  for await (const event of createProvider({
    providerConfig: { apiKey: '  test-only-key  ', model: 'ep-test-only' }
  }).run({ screenshot: 'test-image' }))
    events.push(event)
  assert.deepEqual(events.at(-1), { type: 'reply_text', content: 'ok' })
  assert.equal(seen.url, 'https://ark.cn-beijing.volces.com/api/v3/responses')
  assert.equal(seen.authorization, 'Bearer test-only-key')
  assert.equal(seen.body.model, 'ep-test-only')
  assert.deepEqual(seen.body.thinking, { type: 'disabled' })
  assert.deepEqual(seen.body.input[1].content[0], {
    type: 'input_image',
    image_url: 'data:image/png;base64,test-image'
  })
  assert.equal(seen.body.input[1].content[1].type, 'input_text')
  assert.match(seen.body.input[1].content[1].text, /^请逐条识别全部可见消息/)
  assert.match(seen.body.input[1].content[1].text, /recentSentMessages/)
})

test('image requests allow a longer response than the text connection check', async (t) => {
  const scheduled = []
  const realSetTimeout = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    scheduled.push(ms)
    return realSetTimeout(callback, ms, ...args)
  })
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] })
  )
  const client = new AIClient({ apiKey: 'test-only-key' })
  assert.deepEqual(await client.testConnection(), { success: true })
  assert.equal(await client.detectVision('locate', 'dGVzdA=='), 'ok')
  assert.deepEqual(
    scheduled.filter((ms) => ms === 30000 || ms === 90000),
    [30000, 90000]
  )
})
