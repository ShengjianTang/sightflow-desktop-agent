const assert = require('node:assert/strict')
const { test } = require('node:test')
const { PNG } = require('pngjs')
const { loadSource } = require('./helpers.cjs')
const { ReplyGuard } = require('../src/core/reply-guard.ts')
const {
  GenericChannelSession,
  createInitialGenericChannelState
} = require('../src/core/generic-channel-session.ts')
const { parseChatDecision } = require('../src/core/chat-reply-policy.ts')

const chatAreaBbox = [300, 100, 1000, 800]
const incomingAvatar = [320, 650, 360, 710]
const ownAvatar = [930, 650, 970, 710]
const observation = (historyId, conversationId = 'alice') => ({
  historyId,
  conversationId,
  chatAreaBbox
})
const ownMessage = (text) => ({
  sender: 'self',
  kind: 'text',
  text,
  senderBbox: [930, 500, 970, 560]
})
const evidence = (latestMessage, senderBbox = incomingAvatar, previous = []) => ({
  latestMessage,
  sender: 'incoming',
  senderBbox,
  messages: [...previous, { sender: 'incoming', kind: 'text', text: latestMessage, senderBbox }]
})

test('same analyzed frame, own avatars, and unverified outgoing echoes are blocked independently of reply wording', () => {
  const guard = new ReplyGuard()
  guard.record('这是游戏的截图吗？', observation('frame-1'))
  assert.match(guard.rejection(evidence('原问题'), observation('frame-1')), /同一聊天画面/)
  assert.match(
    guard.rejection(evidence('这是游戏的截图吗？', ownAvatar), observation('frame-2')),
    /右侧/
  )
  assert.match(
    guard.rejection({ latestMessage: '这是游戏的截图吗?' }, observation('frame-2')),
    /已发送回复相同/
  )
  assert.match(guard.rejection({ sender: 'self' }, observation('frame-2')), /自我回复/)
  assert.match(
    guard.rejection({ latestMessage: '错误识别' }, observation('frame-2')),
    /尚未确认新的左侧消息/
  )
})

test('a verified new incoming message can repeat sent/source text; state belongs to its conversation', () => {
  const guard = new ReplyGuard()
  guard.record('在的', observation('frame-1'))
  assert.equal(
    guard.rejection(evidence('在的', incomingAvatar, [ownMessage('在的')]), observation('frame-2')),
    undefined
  )
  assert.equal(guard.rejection(evidence('在吗'), observation('frame-3')), undefined)
  assert.equal(guard.rejection({ latestMessage: '在的' }, observation('frame-1', 'bob')), undefined)
  assert.deepEqual(guard.recent('alice'), ['在的'])
  assert.deepEqual(guard.recent('bob'), [])
  assert.match(
    guard.rejection(evidence('在的', [10, 650, 50, 710]), observation('frame-2')),
    /不在聊天记录区/
  )
  guard.clear()
  assert.deepEqual(guard.recent('alice'), [])
})

test('explicit self/unknown and invalid avatar evidence cannot masquerade as incoming', () => {
  const result = (sender, senderBbox) =>
    parseChatDecision(
      JSON.stringify({ action: 'reply', reason: 'incoming', sender, senderBbox, reply: 'wrong' })
    )
  assert.equal(result('self', ownAvatar).reason, 'self')
  assert.equal(result('unknown', null).needsReview, true)
  assert.equal(result('incoming', [0, 0, 2000, 300]).needsReview, true)
})

function sessionRun(overrides = {}) {
  const queued = [],
    scheduled = [],
    logs = [],
    sends = [],
    inputs = []
  let frame = observation('frame-1')
  let providerEvents = [
    { type: 'reply_text', content: '这是游戏的截图吗？', ...evidence('收到图片') }
  ]
  let commits = 0,
    freshBaselines = 0
  const device = {
    setAppType: () => {},
    clearChatBaseline: () => {},
    measureLayout: async () => ({ success: true }),
    screenshot: async () => 'test-frame',
    getCaptureContext: () => 'full_window',
    getObservationContext: () => frame,
    hasChatAreaChanged: async () => ({ hasDiff: false, hasBaseline: true }),
    hasUnreadMessage: async () => ({ hasUnread: false }),
    commitObservationBaseline: () => {
      commits++
      return true
    },
    setChatBaseline: async () => {
      freshBaselines++
      return true
    },
    sendMessage: async (text) => {
      sends.push(text)
    },
    ...overrides
  }
  const ctx = {
    appType: 'wechat',
    state: createInitialGenericChannelState(),
    host: {
      enqueue: (event) => queued.push(event),
      schedule: (event, delayMs) => scheduled.push({ event, delayMs }),
      log: (type, text) => logs.push({ type, text }),
      trace: () => {},
      isRunning: () => true,
      runProvider: async function* (input) {
        inputs.push(input)
        yield* providerEvents
      }
    }
  }
  const session = new GenericChannelSession(device)
  return {
    queued,
    scheduled,
    logs,
    sends,
    inputs,
    session,
    ctx,
    device,
    get commits() {
      return commits
    },
    get freshBaselines() {
      return freshBaselines
    },
    set frame(value) {
      frame = value
    },
    set events(value) {
      providerEvents = value
    },
    async observeReply() {
      queued.length = 0
      await session.onEvent({ type: 'observe_chat' }, ctx)
      await new Promise(setImmediate)
      const reply = queued.find((event) => event.type === 'provider.reply_text')
      assert.ok(reply)
      await session.onEvent(reply, ctx)
    }
  }
}

test('session preserves sender evidence, supplies recent sent context, and stops the question/answer self loop', async () => {
  const run = sessionRun()
  await run.observeReply()
  assert.deepEqual(run.sends, ['这是游戏的截图吗？'])
  run.frame = observation('frame-2')
  run.events = [
    {
      type: 'reply_text',
      content: '是的，是游戏的截图。',
      ...evidence('这是游戏的截图吗？', ownAvatar)
    }
  ]
  await run.observeReply()
  assert.deepEqual(run.inputs[1].recentSentMessages, ['这是游戏的截图吗？'])
  assert.equal(run.sends.length, 1)
  assert.ok(run.logs.some((item) => /已拦截自我回复/.test(item.text)))
  run.frame = observation('frame-3')
  run.events = [
    {
      type: 'reply_text',
      content: '是的，这是游戏界面。',
      ...evidence('这是游戏的截图吗？', incomingAvatar, [ownMessage('这是游戏的截图吗？')])
    }
  ]
  await run.observeReply()
  assert.equal(run.sends.length, 2)
  assert.equal(run.freshBaselines, 0)
  assert.equal(run.commits, 3)
})

test('one observation accepts one terminal event and stale decisions cannot send after restart', async () => {
  const run = sessionRun()
  run.events = [
    { type: 'reply_text', content: '第一条' },
    { type: 'reply_text', content: '重复事件' }
  ]
  await run.observeReply()
  assert.equal(run.queued.filter((event) => event.type === 'provider.reply_text').length, 1)
  const stale = run.queued.find((event) => event.type === 'provider.reply_text')
  await run.session.onStop(run.ctx)
  await run.session.onStart(run.ctx)
  await run.session.onEvent(stale, run.ctx)
  assert.deepEqual(run.sends, ['第一条'])
})

test('concurrent observe events share one provider run and pending results are discarded on stop', async () => {
  const run = sessionRun()
  let finish,
    calls = 0
  const pending = new Promise((resolve) => {
    finish = resolve
  })
  run.ctx.host.runProvider = async function* () {
    calls++
    await pending
    yield { type: 'reply_text', content: '已经过期的回复' }
  }
  await run.session.onEvent({ type: 'observe_chat' }, run.ctx)
  await run.session.onEvent({ type: 'observe_chat' }, run.ctx)
  assert.equal(calls, 1)
  await run.session.onStop(run.ctx)
  finish()
  await new Promise(setImmediate)
  assert.ok(!run.queued.some((event) => event.type === 'provider.reply_text'))
  assert.equal(run.sends.length, 0)
})

test('empty chat bootstrap opens a visible unread contact without requiring an editor/navigation button', async () => {
  const clicks = []
  const run = sessionRun({
    measureLayout: async () => ({
      success: false,
      recoverable: true,
      canOpenUnread: true,
      error: '尚未打开聊天'
    }),
    hasUnreadMessage: async () => ({ hasUnread: true, unreadContactCoords: [35, 140] }),
    clickUnreadContact: async (point) => clicks.push(point)
  })
  await run.session.onEvent({ type: 'bootstrap' }, run.ctx)
  assert.deepEqual(clicks, [[35, 140]])
  assert.equal(run.queued.at(-1).type, 'bootstrap')
  assert.equal(run.scheduled.length, 0)
})

test('web pages and uncertain layouts do not scan/click contacts during bootstrap', async () => {
  let scans = 0
  const run = sessionRun({
    measureLayout: async () => ({ success: false, recoverable: true, error: '公众号页面' }),
    hasUnreadMessage: async () => {
      scans++
      return { hasUnread: true }
    }
  })
  await run.session.onEvent({ type: 'bootstrap' }, run.ctx)
  assert.equal(scans, 0)
  assert.equal(run.scheduled[0].event.type, 'bootstrap')
})

test('an invalid active-chat layout returns to bootstrap rather than an endless diff failure', async () => {
  const run = sessionRun({
    hasChatAreaChanged: async () => ({
      hasDiff: false,
      hasBaseline: false,
      error: '没有输入框',
      needsLayout: true
    })
  })
  await run.session.onEvent({ type: 'check_unread' }, run.ctx)
  assert.equal(run.scheduled[0].event.type, 'bootstrap')
})

function visionRun() {
  const bounds = { x: 0, y: 0, width: 850, height: 600 }
  return loadSource('src/core/rpa/vision-utils.ts', {
    './window-utils': { getWindowInfo: async () => ({ bounds, scaleFactor: 1 }) },
    './screenshot-utils': {
      captureWechatWindow: async () => ({ success: true, bounds, screenshotBase64: 'frame' })
    }
  })
}

test('tagged unread layout retains a visible avatar without navigation and uses its cache', async () => {
  const api = visionRun()
  let calls = 0
  const client = {
    detectVision: async () => {
      calls++
      return '<firstContact><bbox>2,190,43,265</bbox></firstContact>'
    }
  }
  const first = await api.getUnreadArea(client, 'wechat')
  assert.equal(first.chatEntranceArea, null)
  assert.deepEqual(first.firstContact.bbox, [2, 190, 43, 265])
  assert.ok((await api.getUnreadArea(client, 'wechat')).firstContact)
  assert.equal(calls, 1)
})

test('only the empty chat placeholder layout permits opening unread contacts', async () => {
  const api = visionRun()
  const empty = await api.detectWechatLayout({ detectVision: async () => '[EMPTY_CHAT]' }, 'wechat')
  assert.equal(empty.recoverable, true)
  assert.equal(empty.canOpenUnread, true)
  const page = await api.detectWechatLayout(
    { detectVision: async () => '[NO_CHAT_INPUT]' },
    'wechat'
  )
  assert.equal(page.recoverable, true)
  assert.ok(!page.canOpenUnread)
})

test('a red numbered badge at the window edge is found without a navigation area at multiple DPIs', async () => {
  for (const scaleFactor of [1, 1.25, 1.5, 2]) {
    const api = loadSource('src/core/rpa/has-unread.ts', {
      './window-utils': {
        getWindowInfo: async () => ({ bounds: { x: 0, y: 0, width: 850, height: 600 } })
      },
      './vision-utils': {
        getUnreadArea: async () => ({
          chatEntranceArea: null,
          firstContact: { bbox: [0, 200, 43, 260], coordinates: [18, 138] }
        }),
        bboxToCropBounds: () => ({ x: 0, y: 120, width: 36.5, height: 36 })
      },
      './screenshot-utils': {
        captureWechatWindow: async (_, crop) => {
          const png = new PNG({
            width: Math.ceil(crop.width * scaleFactor),
            height: Math.ceil(crop.height * scaleFactor)
          })
          for (let y = 0; y < png.height; y++)
            for (let x = 0; x < png.width; x++) {
              const localX = crop.x + x / scaleFactor,
                localY = crop.y + y / scaleFactor
              const red =
                (localX - 36) ** 2 + (localY - 125) ** 2 < 49 &&
                !(Math.abs(localX - 36) < 1 && Math.abs(localY - 125) < 3)
              const i = (y * png.width + x) * 4
              png.data[i] = 255
              png.data[i + 1] = red ? 40 : 255
              png.data[i + 2] = red ? 40 : 255
              png.data[i + 3] = 255
            }
          return {
            success: true,
            bounds: crop,
            display: { scaleFactor },
            screenshotBase64: PNG.sync.write(png).toString('base64')
          }
        }
      }
    })
    const result = await api.hasUnreadMessage({}, 'wechat')
    assert.equal(result.success, true)
    assert.equal(result.hasUnread, true)
    assert.ok(Math.abs(result.unreadContactCoords[0] - 18) <= 1)
    assert.ok(result.unreadContactCoords[1] >= 125 && result.unreadContactCoords[1] < 134)
  }
})

test('analyzed baseline crop matches poll crops at fractional window sizes and different DPIs', async () => {
  for (const scaleFactor of [1, 1.25, 1.5, 2]) {
    const bounds = { x: 100, y: 80, width: 937.3, height: 613.7 }
    const bbox = [337, 113, 983, 721]
    let cropRect, saved
    const image = {
      getSize: () => ({
        width: Math.round(bounds.width * scaleFactor),
        height: Math.round(bounds.height * scaleFactor)
      }),
      crop: (rect) => {
        cropRect = rect
        return { toPNG: () => PNG.sync.write(new PNG({ width: rect.width, height: rect.height })) }
      }
    }
    const { RPADevice } = loadSource('src/core/rpa-device.ts', {
      './ai-client': { AIClient: class {} },
      './rpa/screenshot-utils': {
        clearScreenshotCache: () => {},
        captureWechatWindow: async () => ({
          success: true,
          nativeImage: image,
          screenshotBase64: 'frame',
          bounds,
          display: { scaleFactor }
        })
      },
      './rpa/input-utils': {},
      './rpa/has-unread': {},
      './rpa/image-compare': {
        setChatBaselineImage: (value) => {
          saved = value
        }
      },
      './rpa/window-utils': { getWechatWindowInfo: async () => ({ bounds, foreground: true }) },
      './rpa/vision-utils': { getLayoutCache: () => ({ chatMainArea: { bbox } }) }
    })
    const device = new RPADevice()
    await device.screenshot()
    const left = (bbox[0] / 1000) * bounds.width,
      top = (bbox[1] / 1000) * bounds.height
    const cropWidth = (bbox[2] / 1000) * bounds.width - left,
      cropHeight = (bbox[3] / 1000) * bounds.height - top
    assert.deepEqual(cropRect, {
      x: Math.floor(left * scaleFactor),
      y: Math.floor(top * scaleFactor),
      width: Math.ceil((left + cropWidth) * scaleFactor) - Math.floor(left * scaleFactor),
      height: Math.ceil((top + cropHeight) * scaleFactor) - Math.floor(top * scaleFactor)
    })
    assert.equal(device.commitObservationBaseline(), true)
    assert.equal(PNG.sync.read(saved.toPNG()).width, cropRect.width)
  }
})

test('malformed optional Provider evidence is rejected before session input', async () => {
  const { BundleProviderAdapter } = loadSource('src/main/provider-bundle.ts', {
    electron: { app: {} }
  })
  for (const invalid of [
    { senderBbox: 'invalid' },
    { senderBbox: [0, 0, NaN, 50] },
    { sender: 'other' },
    { latestMessage: 42 }
  ]) {
    const provider = new BundleProviderAdapter(
      {
        run: async function* () {
          yield { type: 'reply_text', content: 'reply', ...invalid }
        }
      },
      { id: 'test' }
    )
    const events = []
    for await (const event of provider.run({ screenshot: 'frame' })) events.push(event)
    assert.equal(events[0].type, 'error')
  }
})

test('both Providers forward the incoming evidence and review missing sender proof only once after sending', async (t) => {
  const safe = JSON.stringify({
    action: 'reply',
    reason: 'incoming',
    reply: '直接回答对方',
    ...evidence('对方的问题')
  })
  const missing = JSON.stringify({
    action: 'reply',
    reason: 'incoming',
    latestMessage: '自己刚发的话',
    reply: '不应发送'
  })
  const { createSiliconFlowProvider } = loadSource('src/main/siliconflow-provider.ts', {
    '../core/siliconflow-client': {
      SILICONFLOW_DEFAULT_MODEL: 'test',
      SILICONFLOW_PROVIDER_ID: 'test'
    }
  })
  const sfReplies = [missing, safe, missing, missing],
    sfPrompts = []
  const sf = createSiliconFlowProvider({
    analyzeImage: async (_, prompt) => {
      sfPrompts.push(prompt)
      return sfReplies.shift()
    }
  })
  const arkReplies = [missing, safe, missing, missing],
    bodies = []
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    bodies.push(JSON.parse(options.body))
    return Response.json({
      output: [{ type: 'message', content: [{ type: 'output_text', text: arkReplies.shift() }] }]
    })
  })
  const { createProvider } = loadSource('resources/providers/volcengine-ark/provider.bundle.js')
  const ark = createProvider({
    providerConfig: { apiKey: 'test-only-key', systemPrompt: '保持简短' }
  })
  for (const provider of [sf, ark]) {
    const collect = async () => {
      const events = []
      for await (const event of provider.run({
        screenshot: 'frame',
        observation: observation('frame-2'),
        recentSentMessages: ['自己刚发的话']
      }))
        events.push(event)
      return events.at(-1)
    }
    assert.deepEqual(await collect(), {
      type: 'reply_text',
      content: '直接回答对方',
      ...evidence('对方的问题')
    })
    assert.equal((await collect()).category, 'uncertain')
  }
  assert.equal(sfPrompts.length, 4)
  assert.equal(bodies.length, 4)
  assert.match(sfPrompts[0], /自己刚发的话/)
  assert.match(bodies[0].input[1].content[1].text, /自己刚发的话/)
  assert.match(bodies[0].input[0].content, /senderBbox/)
  assert.match(bodies[0].input[0].content, /保持简短/)
})

test('both built-in Providers demand sender proof on the first structured response when a chat region exists', async (t) => {
  const missing = JSON.stringify({
    action: 'reply',
    reason: 'incoming',
    latestMessage: '在吗',
    reply: '在的'
  })
  const { createSiliconFlowProvider } = loadSource('src/main/siliconflow-provider.ts', {
    '../core/siliconflow-client': {
      SILICONFLOW_DEFAULT_MODEL: 'test',
      SILICONFLOW_PROVIDER_ID: 'test'
    }
  })
  let sfCalls = 0,
    arkCalls = 0
  const silicon = createSiliconFlowProvider({
    analyzeImage: async () => {
      sfCalls++
      return missing
    }
  })
  t.mock.method(globalThis, 'fetch', async () => {
    arkCalls++
    return Response.json({
      output: [{ type: 'message', content: [{ type: 'output_text', text: missing }] }]
    })
  })
  const { createProvider } = loadSource('resources/providers/volcengine-ark/provider.bundle.js')
  const ark = createProvider({ providerConfig: { apiKey: 'test-only-key' } })
  for (const provider of [silicon, ark]) {
    const events = []
    for await (const event of provider.run({
      screenshot: 'frame',
      observation: observation('frame-1')
    }))
      events.push(event)
    assert.equal(events.at(-1).type, 'skip')
    assert.equal(events.at(-1).category, 'uncertain')
  }
  assert.equal(sfCalls, 2)
  assert.equal(arkCalls, 2)
})
