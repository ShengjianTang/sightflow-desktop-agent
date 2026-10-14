const assert = require('node:assert/strict')
const { test } = require('node:test')
const { PNG } = require('pngjs')
const { loadSource } = require('./helpers.cjs')
const { ReplyGuard } = require('../src/core/reply-guard.ts')
const { captureStableChat, outgoingBubbleBottom } = require('../src/core/chat-observation.ts')
const { mergeMessageSequence, readVisibleMessages } = require('../src/core/chat-messages.ts')
const { parseChatDecision } = require('../src/core/chat-reply-policy.ts')
const {
  GenericChannelSession,
  createInitialGenericChannelState
} = require('../src/core/generic-channel-session.ts')
const { DesktopStateError } = require('../src/core/desktop-errors.ts')

const chatAreaBbox = [0, 0, 1000, 1000]
const frame = (historyId, conversationId = 'alice') => ({ historyId, conversationId, chatAreaBbox })
const incoming = (text, y, kind = 'text') => ({
  sender: 'incoming',
  kind,
  text,
  senderBbox: [20, y, 80, y + 60]
})
const own = (text, y) => ({ sender: 'self', kind: 'text', text, senderBbox: [920, y, 980, y + 60] })
const evidence = (messages) => ({
  latestMessage: messages.at(-1).text,
  sender: messages.at(-1).sender,
  senderBbox: messages.at(-1).senderBbox,
  messages
})
const decision = (messages, reply = '结合前文的回复') =>
  JSON.stringify({ action: 'reply', reason: 'incoming', reply, ...evidence(messages) })

function sessionHarness(overrides = {}) {
  let observation = frame('first'),
    events = [],
    running = true
  const sent = [],
    inputs = [],
    queue = [],
    scheduled = [],
    logs = []
  const device = {
    setAppType() {
      return undefined
    },
    clearChatBaseline() {
      return undefined
    },
    onSessionStop() {
      return undefined
    },
    screenshot: async () => 'frame',
    getObservationContext: () => observation,
    getCaptureContext: () => 'full_window',
    sendMessage: async (text) => sent.push(text),
    commitObservationBaseline: () => true,
    hasChatAreaChanged: async () => ({ hasDiff: false, hasBaseline: true }),
    hasUnreadMessage: async () => ({ hasUnread: false }),
    ...overrides
  }
  const ctx = {
    appType: 'wechat',
    state: createInitialGenericChannelState(),
    host: {
      isRunning: () => running,
      log: (_, text) => logs.push(text),
      trace() {
        return undefined
      },
      enqueue: (event) => queue.push(event),
      schedule: (event, ms) => scheduled.push({ event, ms }),
      runProvider: async function* (input) {
        inputs.push(input)
        yield* events
      }
    }
  }
  const session = new GenericChannelSession(device)
  return {
    session,
    ctx,
    device,
    sent,
    inputs,
    queue,
    scheduled,
    logs,
    set observation(value) {
      observation = value
    },
    set events(value) {
      events = value
    },
    set running(value) {
      running = value
    },
    async observe(messages, reply = '这是回复') {
      events = [{ type: 'reply_text', content: reply, ...evidence(messages) }]
      queue.length = 0
      await session.onEvent({ type: 'observe_chat' }, ctx)
      await new Promise(setImmediate)
      const event = queue.find((item) => item.type === 'provider.reply_text')
      assert.ok(event)
      await session.onEvent(event, ctx)
      return event
    }
  }
}

test('screenshot regression: old left avatar cannot authorize a duplicate or a reply to our own question', () => {
  const guard = new ReplyGuard()
  const original = evidence([incoming('我赌你的枪里没有子弹', 20)])
  guard.record('你赌了什么？', frame('before-send'), original)
  assert.match(guard.rejection(original, frame('own-bubble-rendered')), /已经回复/)
  assert.match(
    guard.rejection(evidence([incoming('你赌了什么?', 20)]), frame('changed-pixels')),
    /已发送回复相同/
  )
  const withOwnMessages = evidence([
    incoming('我赌你的枪里没有子弹', 20),
    own('你赌了什么？', 320),
    own('你赌了什么？', 480),
    own('没赌什么，就是问一下', 640)
  ])
  assert.match(
    guard.rejection({ ...withOwnMessages, sender: 'incoming' }, frame('duplicates')),
    /右侧|自己发送/
  )
})

test('same transcript cannot be reused after scrolling, including an older own bubble with the same reply wording', () => {
  const guard = new ReplyGuard()
  const source = evidence([own('在的', 100), incoming('在吗', 400)])
  guard.record('在的', frame('f1'), source)
  const moved = evidence([own('在的', 10), incoming('在吗', 200)])
  assert.match(guard.rejection(moved, frame('scroll')), /已经回复/)
})

test('new repeated incoming text is accepted after the latest outgoing boundary, while an older boundary is not', () => {
  const guard = new ReplyGuard()
  guard.record('你赌了什么？', frame('f1'), evidence([incoming('我赌你的枪里没有子弹', 20)]))
  const repeat = evidence([own('你赌了什么？', 250), incoming('你赌了什么？', 500)])
  assert.equal(guard.rejection(repeat, frame('f2')), undefined)
  const repeatedSource = evidence([own('你赌了什么？', 250), incoming('我赌你的枪里没有子弹', 500)])
  assert.equal(guard.rejection(repeatedSource, frame('f3')), undefined)
  guard.record('新的回复', frame('f4'), evidence([incoming('另一个问题', 20)]))
  assert.match(guard.rejection(repeat, frame('f5')), /更早的回复|已发送回复相同/)
})

test('message order, direction and last-message agreement are validated as a whole', () => {
  const guard = new ReplyGuard()
  assert.match(
    guard.rejection(evidence([incoming('上', 500), incoming('下', 100)]), frame('f')),
    /顺序/
  )
  assert.match(
    guard.rejection(
      evidence([{ ...incoming('伪装', 100), senderBbox: [920, 100, 980, 160] }]),
      frame('f')
    ),
    /右侧/
  )
  assert.match(
    guard.rejection(
      { ...evidence([incoming('真内容', 100)]), latestMessage: '不同内容' },
      frame('f')
    ),
    /不一致/
  )
  assert.equal(
    parseChatDecision(decision([incoming('真内容', 100), own('已回答', 200)])).reason,
    'self'
  )
  assert.equal(
    readVisibleMessages([incoming('上', 100), { sender: 'self', text: '已回答' }]),
    undefined
  )
  assert.equal(
    parseChatDecision(
      JSON.stringify({
        action: 'reply',
        reason: 'incoming',
        reply: '不能发送',
        ...evidence([incoming('上', 100)]),
        messages: []
      })
    ).needsReview,
    true
  )
})

test('pending mixed-media burst and answered context are retained per conversation and clear on stop', () => {
  const guard = new ReplyGuard()
  const first = [
    incoming('明天下午有空吗', 100),
    incoming('帮我看一下这两个方案', 200),
    incoming('图片：两个布局方案', 300, 'image')
  ]
  guard.remember(evidence(first), frame('f1'))
  // Earlier bubbles scrolled off while a new sentence arrived during inference.
  const next = [
    incoming('图片：两个布局方案', 100, 'image'),
    incoming('第二个方案怎么样', 300),
    incoming('笑脸表情', 400, 'emoji')
  ]
  guard.remember(evidence(next), frame('f2'))
  assert.deepEqual(
    guard.context('alice').pendingIncomingMessages.map((m) => m.text),
    [...first.map((m) => m.text), ...next.slice(1).map((m) => m.text)]
  )
  guard.record('明天下午可以。第二个方案的布局更紧凑。', frame('f2'), evidence(next))
  const context = guard.context('alice')
  assert.equal(context.pendingIncomingMessages.length, 0)
  assert.equal(context.conversationHistory.length, 6)
  assert.equal(context.conversationHistory.at(-1).sender, 'self')
  assert.equal(context.conversationHistory[2].kind, 'image')
  assert.deepEqual(guard.context('bob').conversationHistory, [])
  context.conversationHistory[0].text = '外部修改'
  assert.equal(guard.context('alice').conversationHistory[0].text, first[0].text)
  guard.clear()
  assert.deepEqual(guard.context('alice').conversationHistory, [])
})

test('overlapping observations keep distinct equal bubbles without duplicating already captured batches', () => {
  const a = incoming('在吗', 100),
    b = incoming('在吗', 200),
    c = incoming('第二个呢', 300)
  assert.equal(mergeMessageSequence([a], [a, b]).length, 2)
  assert.equal(mergeMessageSequence([a, b], [a, b, c]).length, 3)
  assert.equal(mergeMessageSequence([a, b, c], [a, b, c]).length, 3)
  assert.equal(mergeMessageSequence([a, b, c], [a, b]).length, 3)
})

test('whole batch sends once and both incoming history and outgoing text reach the next provider run', async () => {
  const run = sessionHarness()
  const messages = [
    incoming('明天下午有空吗', 100),
    incoming('请看一下图片', 200),
    incoming('图片：两个方案', 300, 'image'),
    incoming('第二个怎么样', 400)
  ]
  const event = await run.observe(messages, '明天下午可以，第二个方案可以这样调整。')
  assert.equal(run.sent.length, 1)
  assert.ok(run.logs.some((text) => /合并本会话 4 条/.test(text)))
  await run.session.onEvent(event, run.ctx)
  assert.equal(run.sent.length, 1)
  run.observation = frame('second')
  await run.observe(
    [own(run.sent[0], 200), incoming('那就按这个改', 500)],
    '好的，按第二个方案调整。'
  )
  assert.deepEqual(
    run.inputs[1].conversationHistory.map((m) => m.text),
    [...messages.map((m) => m.text), run.sent[0]]
  )
  assert.equal(run.sent.length, 2)
})

test('new incoming during inference cancels stale output, keeps the entire pending batch, and retries with context', async () => {
  const run = sessionHarness()
  let changed = true
  run.device.sendMessage = async (text) => {
    if (changed) throw new DesktopStateError('conversation_changed', '模型分析期间聊天内容已改变')
    run.sent.push(text)
  }
  await run.observe([incoming('明天下午有空吗', 100), incoming('帮我看方案', 200)], '旧回复')
  assert.equal(run.sent.length, 0)
  assert.equal(run.scheduled[0].event.type, 'observe_chat')
  changed = false
  run.observation = frame('second')
  await run.observe([incoming('第二个方案怎么样', 300)], '明天下午可以，第二个方案可以这样调整。')
  assert.deepEqual(
    run.inputs[1].pendingIncomingMessages.map((m) => m.text),
    ['明天下午有空吗', '帮我看方案']
  )
  assert.deepEqual(run.sent, ['明天下午可以，第二个方案可以这样调整。'])
  assert.ok(run.logs.some((text) => /合并本会话 3 条/.test(text)))
  run.observation = frame('third', 'bob')
  await run.observe([incoming('在吗', 100)], '在的')
  assert.deepEqual(run.inputs[2].pendingIncomingMessages, [])
  assert.deepEqual(run.inputs[2].conversationHistory, [])
})

test('queued terminal decisions remain protected from duplicate observe requests until consumed', async () => {
  const run = sessionHarness()
  run.events = [{ type: 'reply_text', content: '一次回复', ...evidence([incoming('在吗', 100)]) }]
  await run.session.onEvent({ type: 'observe_chat' }, run.ctx)
  await new Promise(setImmediate)
  await run.session.onEvent({ type: 'observe_chat' }, run.ctx)
  assert.equal(run.inputs.length, 1)
  const event = run.queue.find((item) => item.type === 'provider.reply_text')
  await run.session.onEvent(event, run.ctx)
  await run.session.onEvent(event, run.ctx)
  assert.deepEqual(run.sent, ['一次回复'])
})

test('burst capture waits for quiet, caps continuously changing frames, and cancels after stop', async () => {
  async function capture(ids, stop = false) {
    let i = -1,
      active = true
    const delays = []
    const source = { screenshot: async () => ids[++i], getObservationContext: () => frame(ids[i]) }
    const result = captureStableChat(
      source,
      () => active,
      async (ms) => {
        delays.push(ms)
        if (stop) active = false
      }
    )
    if (stop) await assert.rejects(result, /引擎已停止/)
    else assert.equal(await result, ids.at(-1))
    return { delays, captures: i + 1 }
  }
  assert.deepEqual(await capture(['a', 'b', 'b']), { delays: [800, 800], captures: 3 })
  assert.deepEqual(await capture(['a', 'b', 'c', 'd']), { delays: [800, 800, 800], captures: 4 })
  assert.deepEqual(await capture(['a'], true), { delays: [800], captures: 1 })
})

test('shutdown during burst capture cannot start a provider or send a reply', async () => {
  let finish
  const capture = new Promise((resolve) => {
    finish = resolve
  })
  const run = sessionHarness({ captureStableScreenshot: async () => capture })
  const observing = run.session.onEvent({ type: 'observe_chat' }, run.ctx)
  await run.session.onStop(run.ctx)
  finish('frame')
  await observing
  assert.equal(run.inputs.length, 0)
  assert.equal(run.sent.length, 0)
})

function pngFrame(rectangles, scale = 1) {
  const png = new PNG({ width: 600 * scale, height: 400 * scale })
  png.data.fill(255)
  for (const [left, top, right, bottom, color] of rectangles) {
    for (let y = top * scale; y < bottom * scale; y++) {
      for (let x = left * scale; x < right * scale; x++) {
        const i = (y * png.width + x) * 4
        png.data[i] = color[0]
        png.data[i + 1] = color[1]
        png.data[i + 2] = color[2]
      }
    }
  }
  return PNG.sync.write(png)
}

test('local green-bubble evidence blocks an old left avatar even on the first run; a new lower incoming remains allowed', () => {
  const guard = new ReplyGuard()
  for (const scale of [1, 2]) {
    const png = pngFrame(
      [
        [436, 120, 546, 155, [158, 236, 158]],
        [390, 230, 546, 268, [158, 236, 158]]
      ],
      scale
    )
    const bottom = outgoingBubbleBottom(png.toString('base64'), chatAreaBbox)
    assert.equal(bottom, 670)
    assert.match(
      guard.rejection(evidence([incoming('我赌你的枪里没有子弹', 20)]), {
        ...frame('f'),
        outgoingBubbleBottom: bottom
      }),
      /画面下方/
    )
    assert.equal(
      guard.rejection(evidence([incoming('新的对方问题', 800)]), {
        ...frame('f2'),
        outgoingBubbleBottom: bottom
      }),
      undefined
    )
  }
  const leftImage = pngFrame([[80, 100, 320, 220, [158, 236, 158]]])
  assert.equal(outgoingBubbleBottom(leftImage.toString('base64'), chatAreaBbox), undefined)
  assert.equal(outgoingBubbleBottom('invalid', chatAreaBbox), undefined)
})

test('manual capture mode rejects a new message arriving after analysis before typing', async () => {
  let current = pngFrame([]),
    sends = 0
  const { BoxSelectDevice } = loadSource('src/core/box-select-device.ts', {
    './rpa/screenshot-utils': {
      clearScreenshotCache() {
        return undefined
      },
      captureChatMainArea: async () => ({
        toPNG: () => current,
        toDataURL: () => current.toString('base64')
      })
    },
    './rpa/input-utils': {
      sendReplyByCoordsAction: async () => {
        sends++
        return true
      }
    },
    './rpa/vision-utils': { getInputAreaFromCache: () => ({ coordinates: [100, 300] }) },
    './rpa/image-compare': loadSource('src/core/rpa/image-compare.ts', { './screenshot-utils': {} })
  })
  const device = new BoxSelectDevice()
  await device.screenshot()
  current = pngFrame([[40, 250, 300, 300, [30, 30, 30]]])
  await assert.rejects(device.sendMessage('过时回复'), /聊天内容已改变/)
  assert.equal(sends, 0)
})

test('both built-in providers pass full multimodal batches and conversation memory and reject malformed/contradictory transcripts', async (t) => {
  const messages = [
    incoming('请看这两个方案', 100),
    incoming('图片：两个方案', 200, 'image'),
    incoming('第二个怎么样', 300)
  ]
  const safe = decision(messages, '第二个方案可以这样调整。')
  const bad = decision([incoming('较新', 500), incoming('较早', 100)])
  const self = decision([incoming('我赌你的枪里没有子弹', 20), own('你赌了什么？', 300)])
  const missing = JSON.stringify({
    action: 'reply',
    reason: 'incoming',
    reply: '旧协议',
    latestMessage: '在吗',
    sender: 'incoming',
    senderBbox: [20, 100, 80, 160]
  })
  const sfQueue = [safe, bad, bad, self, missing, missing],
    arkQueue = [...sfQueue]
  const sfPrompts = [],
    arkBodies = []
  const { createSiliconFlowProvider } = loadSource('src/main/siliconflow-provider.ts', {
    '../core/siliconflow-client': {
      SILICONFLOW_DEFAULT_MODEL: 'test',
      SILICONFLOW_PROVIDER_ID: 'test'
    }
  })
  const silicon = createSiliconFlowProvider({
    analyzeImage: async (_, prompt) => {
      sfPrompts.push(prompt)
      return sfQueue.shift()
    }
  })
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    arkBodies.push(JSON.parse(options.body))
    return Response.json({
      output: [{ type: 'message', content: [{ type: 'output_text', text: arkQueue.shift() }] }]
    })
  })
  const { createProvider } = loadSource('resources/providers/volcengine-ark/provider.bundle.js')
  const ark = createProvider({ providerConfig: { apiKey: 'test-only-key' } })
  const history = [
    { sender: 'incoming', kind: 'text', text: '明天下午有空吗' },
    { sender: 'self', kind: 'text', text: '有空的' }
  ]
  const pending = [{ sender: 'incoming', kind: 'text', text: '帮我看一下方案' }]
  for (const provider of [silicon, ark]) {
    const run = async () => {
      const events = []
      for await (const event of provider.run({
        screenshot: 'frame',
        observation: frame('f'),
        conversationHistory: history,
        pendingIncomingMessages: pending
      }))
        events.push(event)
      return events.at(-1)
    }
    assert.deepEqual((await run()).messages, messages)
    assert.equal((await run()).category, 'uncertain')
    assert.equal((await run()).category, 'self')
    assert.equal((await run()).category, 'uncertain')
  }
  assert.equal(sfPrompts.length, 6)
  assert.equal(arkBodies.length, 6)
  for (const prompt of [sfPrompts[0], arkBodies[0].input[1].content[1].text]) {
    assert.match(prompt, /明天下午有空吗/)
    assert.match(prompt, /帮我看一下方案/)
    assert.match(prompt, /一次|批次/)
    assert.match(prompt, /不能只回答最后一句|不得只看最后一句/)
  }
})

test('provider adapter rejects malformed messages rather than discarding the broken own-message entry', async () => {
  const { BundleProviderAdapter } = loadSource('src/main/provider-bundle.ts', {
    electron: { app: {} }
  })
  const provider = new BundleProviderAdapter(
    {
      run: async function* () {
        yield {
          type: 'reply_text',
          content: '不应发送',
          messages: [incoming('在吗', 100), { sender: 'self', text: '已回复' }]
        }
      }
    },
    { id: 'test' }
  )
  const events = []
  for await (const event of provider.run({ screenshot: 'frame' })) events.push(event)
  assert.equal(events[0].type, 'error')
})

test('a manual own reply closes a cancelled pending batch instead of leaking it into the next request', async () => {
  const run = sessionHarness({
    sendMessage: async () => {
      throw new DesktopStateError('conversation_changed', '内容改变')
    }
  })
  await run.observe([incoming('原问题', 100)])
  run.events = [
    { type: 'skip', category: 'self', latestMessage: '我已经手动处理了', reason: '自己的消息' }
  ]
  run.observation = frame('manual-reply')
  run.queue.length = 0
  await run.session.onEvent({ type: 'observe_chat' }, run.ctx)
  await new Promise(setImmediate)
  await run.session.onEvent(
    run.queue.find((event) => event.type === 'provider.skip'),
    run.ctx
  )
  run.observation = frame('after-manual')
  run.device.sendMessage = async (text) => run.sent.push(text)
  await run.observe([own('我已经手动处理了', 200), incoming('这是另一个问题', 400)])
  assert.deepEqual(run.inputs.at(-1).pendingIncomingMessages, [])
  assert.deepEqual(
    run.inputs.at(-1).conversationHistory.map((m) => m.text),
    ['原问题', '我已经手动处理了']
  )
})
