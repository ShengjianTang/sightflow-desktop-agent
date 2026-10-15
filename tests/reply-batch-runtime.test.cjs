const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
  GenericChannelSession,
  createInitialGenericChannelState
} = require('../src/core/generic-channel-session.ts')
const { createSiliconFlowProvider } = require('../src/main/siliconflow-provider.ts')
const { DesktopStateError } = require('../src/core/desktop-errors.ts')
const incoming = (text, y) => ({
  sender: 'incoming',
  kind: 'text',
  text,
  senderBbox: [20, y, 60, y + 40]
})
const own = (text, y) => ({ sender: 'self', kind: 'text', text, senderBbox: [940, y, 980, y + 40] })
const transcript = (messages, reply) =>
  JSON.stringify({ page: 'chat', draft: false, messages, reply })
function harness(replies) {
  let observation = {
      conversationId: 'alice',
      historyId: 'hA',
      chatAreaBbox: [0, 0, 1000, 800],
      panelBbox: [0, 0, 1000, 1000]
    },
    running = true
  const queue = [],
    scheduled = [],
    sent = [],
    requests = [],
    logs = [],
    metrics = []
  const provider = createSiliconFlowProvider({
    model: 'fixture',
    analyzeImage: async (image, prompt, system, signal) => {
      requests.push({ image, prompt, system, signal })
      const reply = replies.shift()
      if (reply instanceof Error) throw reply
      if (typeof reply === 'function') return reply(signal)
      if (!reply) throw Error('unexpected request')
      return reply
    }
  })
  const device = {
    setAppType() {
      return undefined
    },
    clearChatBaseline() {
      return undefined
    },
    setReplyPanelCapture() {
      return undefined
    },
    measureLayout: async () => ({ success: true }),
    screenshot: async () => observation.historyId,
    getCaptureContext: () => 'conversation_panel',
    getObservationContext: () => observation,
    inspectPendingReply: async () => ({
      changed: false,
      observation,
      screenshot: observation.historyId
    }),
    sendMessage: async (text) => sent.push(text),
    commitObservationBaseline: () => true,
    hasChatAreaChanged: async () => ({ hasDiff: false, hasBaseline: true }),
    hasUnreadMessage: async () => ({ hasUnread: false })
  }
  const ctx = {
    appType: 'wechat',
    state: createInitialGenericChannelState(),
    host: {
      isRunning: () => running,
      enqueue: (e) => queue.push(e),
      schedule: (e, ms) => scheduled.push({ e, ms }),
      trace: (e) => metrics.push(e),
      log: (kind, text) => logs.push({ kind, text }),
      runProvider: (i) => provider.run(i),
      reviewPendingReply: (i) => provider.reviewPendingReply(i)
    }
  }
  const session = new GenericChannelSession(device)
  return {
    session,
    ctx,
    device,
    queue,
    scheduled,
    sent,
    requests,
    logs,
    metrics,
    set observation(v) {
      observation = v
    },
    get observation() {
      return observation
    },
    set running(v) {
      running = v
    },
    async observe() {
      queue.length = 0
      await session.onEvent({ type: 'observe_chat' }, ctx)
      await new Promise(setImmediate)
      while (queue[0]?.type.startsWith('provider.')) await session.onEvent(queue.shift(), ctx)
    },
    async stop() {
      running = false
      await session.onStop(ctx)
    }
  }
}
test('A generation with B arriving sends A first, then B above our reply, preserving reply context', async () => {
  const a = incoming('A问题', 150),
    b = incoming('B问题', 300)
  const run = harness([
    transcript([a], '回答A'),
    transcript([a, b], ''),
    transcript([a, b, own('回答A', 450)], '回答B')
  ])
  let inspections = 0
  run.device.inspectPendingReply = async () => ({
    changed: ++inspections === 1,
    screenshot: 'hAB',
    observation: { ...run.observation, historyId: 'hAB' }
  })
  await run.observe()
  assert.deepEqual(run.sent, ['回答A'])
  assert.equal(run.queue[0].type, 'observe_chat')
  assert.equal(run.requests.length, 2)
  run.observation = { ...run.observation, historyId: 'hABown', outgoingBubbleBottom: 490 }
  await run.observe()
  assert.deepEqual(run.sent, ['回答A', '回答B'])
  assert.match(run.requests[2].prompt, /pendingBatch/)
  assert.match(run.requests[2].prompt, /回答A/)
  assert.equal(run.queue[0].type, 'check_unread')
})
test('duplicate terminal and stale batch decisions cannot send twice', async () => {
  const a = incoming('A', 150),
    run = harness([transcript([a], '一次')])
  await run.session.onEvent({ type: 'observe_chat' }, run.ctx)
  await new Promise(setImmediate)
  const event = run.queue.find((e) => e.type === 'provider.reply_text')
  await run.session.onEvent({ ...event, batchId: 'wrong' }, run.ctx)
  assert.equal(run.sent.length, 0)
  await run.session.onEvent(event, run.ctx)
  await run.session.onEvent(event, run.ctx)
  assert.deepEqual(run.sent, ['一次'])
})
test('same text in distinct A/B bubbles is not removed when B arrives during generation', async () => {
  const a = incoming('在吗', 150),
    b = incoming('在吗', 300),
    run = harness([
      transcript([a], '在的'),
      transcript([a, b], ''),
      transcript([a, b, own('在的', 450)], '还在')
    ])
  let checks = 0
  run.device.inspectPendingReply = async () => ({
    changed: ++checks === 1,
    screenshot: 'changed',
    observation: run.observation
  })
  // Identical single-message overlaps are intentionally ambiguous; no send is allowed until resolved.
  await run.observe()
  assert.equal(run.sent.length, 0)
  assert.ok(run.logs.some((e) => e.text.includes('AMBIGUOUS_TRANSCRIPT_OVERLAP')))
})
test('conversation switch or draft detected locally cancels before clipboard/send', async () => {
  for (const reason of ['会话切换', '草稿变化']) {
    const run = harness([transcript([incoming('问题', 150)], '回答')])
    run.device.inspectPendingReply = async () => {
      throw new DesktopStateError('conversation_changed', reason)
    }
    await run.observe()
    assert.deepEqual(run.sent, [])
    assert.equal(run.requests.length, 1)
  }
})
test('manual outgoing or non-chat found by review blocks pending answer', async () => {
  for (const review of [
    transcript([incoming('A', 150), own('人工已答', 300)], ''),
    JSON.stringify({ page: 'non_chat', draft: false, messages: [] })
  ]) {
    const run = harness([transcript([incoming('A', 150)], '答A'), review])
    run.device.inspectPendingReply = async () => ({
      changed: true,
      screenshot: 'changed',
      observation: run.observation
    })
    await run.observe()
    assert.equal(run.sent.length, 0)
  }
})
test('new message while verifying preserves generated answer for one bounded send review retry', async () => {
  const a = incoming('A', 150),
    b = incoming('B', 300),
    run = harness([transcript([a], '答A'), transcript([a, b], '')])
  let attempts = 0
  run.device.sendMessage = async (text) => {
    if (attempts++ === 0) throw new DesktopStateError('history_changed', 'new content')
    run.sent.push(text)
  }
  let inspections = 0
  run.device.inspectPendingReply = async () => ({
    changed: ++inspections > 1,
    screenshot: 'hAB',
    observation: run.observation
  })
  await run.observe()
  assert.equal(run.requests.length, 1)
  assert.equal(run.sent.length, 0)
  await run.session.onEvent(run.scheduled[0].e, run.ctx)
  assert.deepEqual(run.sent, ['答A'])
  assert.equal(run.requests.length, 2)
})
test('failure after paste records batch as handled and never replays the same reply', async () => {
  const run = harness([
    transcript([incoming('A', 150)], '答A'),
    transcript([incoming('A', 150)], '答A')
  ])
  let attempts = 0
  run.device.sendMessage = async () => {
    attempts++
    throw new DesktopStateError('send_failed', 'pasted', 'pasted')
  }
  await run.observe()
  await run.observe()
  assert.equal(attempts, 1)
  assert.equal(run.sent.length, 0)
})
test('engine stop aborts pending request and late output cannot enqueue a reply', async () => {
  let finish, seen
  const run = harness([
    (signal) => {
      seen = signal
      return new Promise((r) => {
        finish = r
      })
    }
  ])
  await run.session.onEvent({ type: 'observe_chat' }, run.ctx)
  await new Promise(setImmediate)
  await run.stop()
  assert.equal(seen.aborted, true)
  finish(transcript([incoming('A', 150)], '迟到回答'))
  await new Promise(setImmediate)
  assert.equal(run.queue.filter((e) => e.type === 'provider.reply_text').length, 0)
  assert.equal(run.sent.length, 0)
})

test('anchored identical A/B message bubbles remain separate and both get a reply', async () => {
  const anchor = own('更早的答复', 50),
    a = incoming('在吗', 180),
    b = incoming('在吗', 310)
  const run = harness([
    transcript([anchor, a], '在的'),
    transcript([anchor, a, b], ''),
    transcript([anchor, a, b, own('在的', 460)], '还在')
  ])
  let checks = 0
  run.device.inspectPendingReply = async () => ({
    changed: ++checks === 1,
    screenshot: 'changed',
    observation: run.observation
  })
  await run.observe()
  assert.deepEqual(run.sent, ['在的'])
  run.observation = { ...run.observation, historyId: 'hB' }
  await run.observe()
  assert.deepEqual(run.sent, ['在的', '还在'])
})

test('empty chat skips reply correction and returns to unread contact handling', async () => {
  const run = harness([JSON.stringify({ page: 'empty', draft: false, messages: [], reply: '' })])
  await run.observe()
  assert.equal(run.sent.length, 0)
  assert.equal(run.requests.length, 1)
  assert.equal(run.scheduled[0].e.type, 'bootstrap')
})
test('draft while waiting on B keeps B pending until the draft is cleared', async () => {
  const a = incoming('A', 150),
    b = incoming('B', 300),
    run = harness([
      transcript([a], '答A'),
      transcript([a, b], ''),
      JSON.stringify({ page: 'chat', draft: true, messages: [], reply: '' }),
      transcript([a, b, own('答A', 450)], '答B')
    ])
  let checks = 0
  run.device.inspectPendingReply = async () => ({
    changed: ++checks === 1,
    screenshot: 'changed',
    observation: run.observation
  })
  await run.observe()
  run.observation = { ...run.observation, historyId: 'draft' }
  await run.observe()
  assert.deepEqual(run.sent, ['答A'])
  run.observation = { ...run.observation, historyId: 'cleared' }
  await run.observe()
  assert.deepEqual(run.sent, ['答A', '答B'])
})

test('clearing a manual draft reobserves a pending batch without requiring a new chat message', async () => {
  const a = incoming('A', 150),
    b = incoming('B', 300)
  const run = harness([
    transcript([a], '答A'),
    transcript([a, b], ''),
    JSON.stringify({ page: 'chat', draft: true, messages: [], reply: '' })
  ])
  let checks = 0
  run.device.inspectPendingReply = async () => ({
    changed: ++checks === 1,
    screenshot: 'changed',
    observation: run.observation
  })
  await run.observe()
  run.observation = { ...run.observation, historyId: 'draft' }
  await run.observe()
  run.device.inspectPendingReply = async () => {
    throw new DesktopStateError('conversation_changed', '草稿清空')
  }
  await run.session.onEvent(run.queue.shift(), run.ctx)
  assert.equal(run.queue.at(-1).type, 'observe_chat')
  assert.deepEqual(run.sent, ['答A'])
})
