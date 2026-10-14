const assert = require('node:assert/strict')
const { test } = require('node:test')
const { SiliconFlowClient, validateImageDataUrl } = require('../src/core/siliconflow-client.ts')
const { loadSource } = require('./helpers.cjs')

const image = 'data:image/png;base64,' + Buffer.from('test image').toString('base64')

test('saved settings take precedence over the process environment without exposing keys in status', async (t) => {
  const previousKey = process.env.SILICONFLOW_API_KEY
  const previousModel = process.env.SILICONFLOW_VISION_MODEL
  process.env.SILICONFLOW_API_KEY = 'environment-test-only'
  process.env.SILICONFLOW_VISION_MODEL = 'Qwen/env-model'
  t.after(() => {
    if (previousKey === undefined) delete process.env.SILICONFLOW_API_KEY
    else process.env.SILICONFLOW_API_KEY = previousKey
    if (previousModel === undefined) delete process.env.SILICONFLOW_VISION_MODEL
    else process.env.SILICONFLOW_VISION_MODEL = previousModel
  })
  const {
    siliconFlowStatus,
    createSiliconFlowClient
  } = require('../src/main/siliconflow-provider.ts')
  const status = siliconFlowStatus({ apiKey: 'saved-test-only', model: 'Qwen/saved-model' })
  assert.deepEqual(status, {
    configured: true,
    environmentConfigured: true,
    model: 'Qwen/saved-model'
  })
  assert.doesNotMatch(JSON.stringify(status), /test-only/)
  const seen = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    seen.push({ authorization: init.headers.Authorization, model: JSON.parse(init.body).model })
    return Response.json({ choices: [{ message: { content: 'ok' } }] })
  })
  await createSiliconFlowClient({
    apiKey: ' saved-test-only ',
    model: ' Qwen/saved-model '
  }).analyzeImage(image, '')
  await createSiliconFlowClient({}).analyzeImage(image, '')
  assert.deepEqual(seen, [
    { authorization: 'Bearer saved-test-only', model: 'Qwen/saved-model' },
    { authorization: 'Bearer environment-test-only', model: 'Qwen/env-model' }
  ])
})

test('image request sends the selected model, bearer key and image_url without persisting credentials', async (t) => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), init })
    return Response.json({ choices: [{ message: { content: '图片内容' } }] })
  })
  const client = new SiliconFlowClient('  test-only-key  ', ' Qwen/test-vision ')
  assert.equal(await client.analyzeImage(image, '识别图片'), '图片内容')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://api.siliconflow.cn/v1/chat/completions')
  assert.equal(requests[0].init.headers.Authorization, 'Bearer test-only-key')
  const body = JSON.parse(requests[0].init.body)
  assert.equal(body.model, 'Qwen/test-vision')
  assert.equal(body.messages[0].content[0].image_url.url, image)
  assert.equal(body.messages[0].content[1].text, '识别图片')
  assert.equal(body.stream, false)
  assert.doesNotMatch(requests[0].init.body, /test-only-key/)
})

test('invalid images and missing credentials never reach the network', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('network must not run')
  })
  assert.throws(() => validateImageDataUrl('data:text/plain;base64,WA=='), /图片格式无效/)
  assert.throws(() => validateImageDataUrl('data:image/png;base64,AA!'), /图片格式无效/)
  assert.throws(
    () => validateImageDataUrl('data:image/png;base64,' + 'A'.repeat(12_000_000)),
    /8 MB/
  )
  await assert.rejects(new SiliconFlowClient('  ').analyzeImage(image, ''), /SILICONFLOW_API_KEY/)
  await assert.rejects(
    new SiliconFlowClient('test-only-key').analyzeImage('bad', ''),
    /图片格式无效/
  )
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('HTTP failures and malformed replies are surfaced without exposing upstream bodies', async (t) => {
  const response = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('sensitive upstream body', { status: 401 })
  )
  const client = new SiliconFlowClient('test-only-key')
  await assert.rejects(client.analyzeImage(image, ''), (error) => {
    assert.match(error.message, /HTTP 401.*密钥/)
    assert.doesNotMatch(error.message, /sensitive upstream body/)
    return true
  })
  response.mock.mockImplementation(async () => Response.json({ choices: [] }))
  await assert.rejects(client.analyzeImage(image, ''), /缺少回复文本/)
  response.mock.mockImplementation(async () =>
    Response.json({ choices: [{ message: { content: [{ type: 'text', text: '可见文字' }] } }] })
  )
  assert.equal(await client.analyzeImage(image, ''), '可见文字')
})

test('vision provider skips missing screenshots, yields text or skip, and reports errors', async () => {
  const { createSiliconFlowProvider } = loadSource('src/main/siliconflow-provider.ts', {
    '../core/siliconflow-client': {
      SILICONFLOW_DEFAULT_MODEL: 'test-model',
      SILICONFLOW_PROVIDER_ID: 'siliconflow-vision'
    }
  })
  const replies = ['回复文字', JSON.stringify({ action: 'skip', reason: 'self' })]
  const prompts = []
  const provider = createSiliconFlowProvider({
    analyzeImage: async (screenshot, prompt) => {
      prompts.push([screenshot, prompt])
      const next = replies.shift()
      if (!next) throw new Error('mock failure')
      return next
    }
  })
  const collect = async (input) => {
    const events = []
    for await (const event of provider.run(input)) events.push(event)
    return events
  }
  assert.deepEqual(await collect({}), [{ type: 'skip' }])
  assert.deepEqual((await collect({ screenshot: image })).at(-1), {
    type: 'reply_text',
    content: '回复文字'
  })
  assert.deepEqual((await collect({ screenshot: image })).at(-1), {
    type: 'skip',
    category: 'self',
    reason: '最新消息是自己发送的，避免重复回复',
    latestMessage: undefined
  })
  assert.deepEqual((await collect({ screenshot: image })).at(-1), {
    type: 'error',
    error: 'mock failure'
  })
  assert.equal(prompts.length, 3)
  assert.match(prompts[0][1], /缩略图/)
  assert.match(prompts[0][1], /图片消息即使无法读取原图/)
  assert.match(prompts[0][1], /不要仅因图片细节不清就输出 \[SKIP\]/)
})
