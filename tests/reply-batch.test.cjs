const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
  parseReplyTranscript,
  evidenceFromMessages,
  pendingMessages,
  reviewAppendOnly,
  mapPanelBox
} = require('../src/core/reply-protocol.ts')
const {
  createSiliconFlowProvider,
  createSiliconFlowClient,
  siliconFlowStatus
} = require('../src/main/siliconflow-provider.ts')
const { normalizeSettings, mergeSettings } = require('../src/main/settings.ts')
const { fetchWithTimeout } = require('../src/core/http-request.ts')
const incoming = (text, y = 200) => ({
  sender: 'incoming',
  kind: 'text',
  text,
  senderBbox: [20, y, 65, y + 40]
})
const self = (text, y = 100) => ({
  sender: 'self',
  kind: 'text',
  text,
  senderBbox: [935, y, 980, y + 40]
})
const input = {
  batchId: 'b1',
  appType: 'wechat',
  screenshot: 'synthetic',
  captureContext: 'conversation_panel',
  observation: {
    conversationId: 'alice',
    historyId: 'h1',
    chatAreaBbox: [200, 80, 1000, 800],
    panelBbox: [200, 0, 1000, 1000]
  }
}
const json = (messages, extra = {}) =>
  JSON.stringify({ page: 'chat', draft: false, messages, reply: '好的，收到。', ...extra })
async function collect(provider, extra = {}) {
  const result = []
  for await (const event of provider.run({ ...input, ...extra })) result.push(event)
  return result
}

test('new protocol derives evidence from ordered messages and maps crop coordinates exactly once', () => {
  const d = parseReplyTranscript(json([self('上一条回复'), incoming('新问题', 300)]), input)
  assert.deepEqual(
    mapPanelBox([20, 300, 65, 340], input.observation.panelBbox),
    [216, 300, 252, 340]
  )
  const e = evidenceFromMessages(d.messages)
  assert.equal(e.latestMessage, '新问题')
  assert.equal(e.sender, 'incoming')
  assert.deepEqual(e.senderBbox, [216, 300, 252, 340])
})
test('conflicting legacy fields, unknown senders, reversed order and out-of-panel avatars are rejected', () => {
  assert.throws(
    () => parseReplyTranscript(json([incoming('新问题')], { latestMessage: '别的内容' }), input),
    /CONFLICTING_LEGACY_FIELDS/
  )
  assert.throws(
    () => parseReplyTranscript(json([{ ...incoming('看不清'), sender: 'unknown' }]), input),
    /INVALID_MESSAGE_LIST/
  )
  assert.throws(
    () => parseReplyTranscript(json([incoming('下', 400), incoming('上', 200)]), input),
    /INVALID_MESSAGE_ORDER/
  )
  assert.throws(
    () =>
      parseReplyTranscript(
        json([{ ...incoming('右侧伪装'), senderBbox: [920, 200, 980, 250] }]),
        input
      ),
    /SENDER_GEOMETRY|AVATAR_EDGE/
  )
})
test('empty page, non-chat, draft and latest self do not request a second generation', async () => {
  for (const data of [
    { page: 'empty', draft: false, messages: [] },
    { page: 'non_chat', draft: false, messages: [] },
    { page: 'chat', draft: true, messages: [] },
    { page: 'chat', draft: false, messages: [self('已回复')] }
  ]) {
    let calls = 0
    const p = createSiliconFlowProvider({
      model: 'test',
      analyzeImage: async () => {
        calls++
        return JSON.stringify(data)
      }
    })
    const events = await collect(p)
    assert.equal(events.at(-1).type, 'skip')
    assert.equal(calls, 1)
  }
})
test('invalid JSON gets one targeted correction and never echoes raw invalid model text', async () => {
  const prompts = [],
    answers = ['{bad secret-text}', json([incoming('在吗')])]
  const p = createSiliconFlowProvider({
    model: 'test',
    analyzeImage: async (_, prompt) => {
      prompts.push(prompt)
      return answers.shift()
    }
  })
  const events = await collect(p)
  assert.equal(events.at(-1).type, 'reply_text')
  assert.equal(prompts.length, 2)
  assert.match(prompts[1], /INVALID_JSON/)
  assert.doesNotMatch(prompts[1], /secret-text/)
  assert.equal(events.filter((e) => e.type === 'metric').length, 2)
  assert.ok(events.every((e) => e.batchId === 'b1'))
})
test('two malformed decisions terminate with uncertain, never a third call', async () => {
  let calls = 0
  const events = await collect(
    createSiliconFlowProvider({
      model: 'test',
      analyzeImage: async () => {
        calls++
        return '{}'
      }
    })
  )
  assert.equal(calls, 2)
  assert.equal(events.at(-1).category, 'uncertain')
})
test('append-only review rejects scroll-back, unrelated pages and an intervening manual reply', () => {
  const a = incoming('A', 100),
    b = incoming('B', 200),
    c = incoming('C', 300)
  assert.deepEqual(reviewAppendOnly([a, b], [a, b, c]).appended, [c])
  assert.equal(reviewAppendOnly([a, b], [b]).safe, false)
  assert.equal(reviewAppendOnly([a], [incoming('X')]).safe, false)
  assert.equal(
    reviewAppendOnly([a, b], [a, b, self('人工回复', 300)]).code,
    'MANUAL_REPLY_DETECTED'
  )
})
test('pending batch before our own bottom reply is answered once, with repeated messages kept', () => {
  const a = incoming('好的', 100),
    b = incoming('好的', 200),
    own = self('答复A', 300)
  const pendingBatch = {
    id: 'pending',
    conversationId: 'alice',
    messages: [b],
    beforeReply: [a, b],
    afterReply: '答复A'
  }
  assert.deepEqual(pendingMessages([a, b, own], { ...input, pendingBatch }), [b])
  assert.throws(
    () => pendingMessages([a, b, self('人工干预', 300)], { ...input, pendingBatch }),
    /MANUAL_REPLY/
  )
  assert.equal(
    pendingMessages([a, b, own], {
      ...input,
      observation: { conversationId: 'bob' },
      pendingBatch
    }),
    undefined
  )
})
test('pending provider answers incoming messages above own reply while ordinary self stays skipped', async () => {
  const a = incoming('问题A', 100),
    b = incoming('问题B', 200),
    own = self('回答A', 300)
  const converted = [a, b].map((m) => ({
    ...m,
    senderBbox: mapPanelBox(m.senderBbox, input.observation.panelBbox)
  }))
  const p = createSiliconFlowProvider({
    model: 'test',
    analyzeImage: async () => json([a, b, own])
  })
  const events = await collect(p, {
    pendingBatch: {
      id: 'p',
      conversationId: 'alice',
      messages: [converted[1]],
      beforeReply: converted,
      afterReply: '回答A'
    }
  })
  assert.equal(events.at(-1).type, 'reply_text')
  assert.equal(events.at(-1).latestMessage, '问题B')
  assert.equal((await collect(p)).at(-1).category, 'self')
})
test('reply model selection is independent, persisted across switches, and never leaks keys', async () => {
  const settings = mergeSettings(normalizeSettings(null), {
    siliconFlow: { apiKey: 'test-only', model: 'vision', replyModel: ' reply ' }
  })
  assert.equal(settings.siliconFlow.replyModel, 'reply')
  const status = siliconFlowStatus(settings.siliconFlow)
  assert.equal(status.model, 'vision')
  assert.equal(status.replyModel, 'reply')
  assert.doesNotMatch(JSON.stringify(status), /test-only/)
  assert.equal(createSiliconFlowClient(settings.siliconFlow).model, 'vision')
  assert.equal(createSiliconFlowClient(settings.siliconFlow, 'reply').model, 'reply')
  assert.equal(
    createSiliconFlowClient({ ...settings.siliconFlow, replyModel: '' }, 'reply').model,
    'vision'
  )
  assert.equal(
    mergeSettings(settings, { siliconFlow: { model: 'v2' } }).siliconFlow.replyModel,
    'reply'
  )
})
test('external cancellation remains active while the response body stalls and differs from timeout', async (t) => {
  const controller = new AbortController()
  let seenSignal
  t.mock.method(globalThis, 'fetch', async (_, init) => {
    seenSignal = init.signal
    return {
      ok: true,
      json: () =>
        new Promise((_, reject) =>
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        )
    }
  })
  const result = fetchWithTimeout(
    'https://example.invalid',
    { signal: controller.signal },
    (r) => r.json(),
    1000,
    'timeout'
  )
  await new Promise(setImmediate)
  controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
  assert.equal(seenSignal.aborted, true)
})
test('cancelled reply does not emit a late terminal event or correction', async () => {
  const controller = new AbortController()
  let finish
  const p = createSiliconFlowProvider({
    model: 'test',
    analyzeImage: () =>
      new Promise((r) => {
        finish = r
      })
  })
  const result = collect(p, { signal: controller.signal })
  await new Promise(setImmediate)
  controller.abort()
  finish(json([incoming('迟到')]))
  assert.deepEqual(await result, [])
})

test('avatarBbox protocol is accepted but conflicting aliases remain rejected', () => {
  const m = incoming('新消息', 200)
  const { senderBbox, ...other } = m
  const parsed = parseReplyTranscript(json([{ ...other, avatarBbox: senderBbox }]), input)
  assert.equal(parsed.messages[0].text, '新消息')
  assert.throws(
    () => parseReplyTranscript(json([{ ...m, avatarBbox: [10, 100, 20, 120] }]), input),
    /CONFLICTING_LEGACY_FIELDS/
  )
})
test('correction cannot pass by deleting messages from a rejected transcript', async () => {
  const bad = [incoming('A', 100), { ...incoming('B', 200), senderBbox: [100, 200, 900, 240] }]
  const answers = [json(bad), json([incoming('A', 100)])]
  const p = createSiliconFlowProvider({ model: 'test', analyzeImage: async () => answers.shift() })
  const events = await collect(p)
  assert.equal(events.at(-1).category, 'uncertain')
  assert.match(events.at(-1).reason, /CORRECTION_DROPPED_MESSAGES/)
})

test('local evidence rejects a model that omits a visible own bubble or places incoming avatar away from the edge', () => {
  const ownInput = { ...input, observation: { ...input.observation, outgoingBubbleBottom: 225 } }
  assert.throws(
    () => parseReplyTranscript(json([incoming('new', 150)], {}), ownInput),
    /LATEST_SELF_OMITTED/
  )
  assert.throws(
    () =>
      parseReplyTranscript(
        json([{ ...incoming('fake', 150), senderBbox: [300, 150, 360, 200] }]),
        input
      ),
    /AVATAR_EDGE_UNCONFIRMED/
  )
})

test('PNG evidence rejects a blank avatar patch and accepts an actual bounded avatar', () => {
  const { PNG } = require('pngjs')
  const { avatarHasPixelEvidence } = require('../src/core/reply-protocol.ts')
  const png = new PNG({ width: 400, height: 400 })
  for (let p = 0; p < png.data.length; p += 4) {
    png.data[p] = png.data[p + 1] = png.data[p + 2] = 30
    png.data[p + 3] = 255
  }
  const box = [20, 200, 100, 280]
  assert.equal(avatarHasPixelEvidence(png, box), false)
  for (let y = 80; y < 112; y++)
    for (let x = 8; x < 40; x++) {
      const p = (y * 400 + x) * 4
      png.data[p] = 70
      png.data[p + 1] = 130
      png.data[p + 2] = 180
    }
  assert.equal(avatarHasPixelEvidence(png, box), true)
})

test('confirmed pending B remains answerable when answered A scrolls offscreen', () => {
  const a = incoming('A', 100),
    b = incoming('B', 200),
    response = self('答A', 350)
  const pendingBatch = {
    id: 'p',
    conversationId: 'alice',
    messages: [b],
    beforeReply: [a, b],
    afterReply: '答A'
  }
  assert.deepEqual(pendingMessages([b, response], { ...input, pendingBatch }), [b])
  assert.throws(
    () => pendingMessages([incoming('X', 200), response], { ...input, pendingBatch }),
    /PENDING_BOUNDARY_UNCERTAIN/
  )
})
