const assert = require('node:assert/strict')
const { test } = require('node:test')
const { loadSource } = require('./helpers.cjs')
const { PNG } = require('pngjs')
const {
  GenericChannelSession,
  createInitialGenericChannelState
} = require('../src/core/generic-channel-session.ts')
const { DesktopStateError } = require('../src/core/desktop-errors.ts')
const { parseChatDecision } = require('../src/core/chat-reply-policy.ts')

const incoming = JSON.stringify({
  action: 'reply',
  reason: 'incoming',
  latestMessage: '有人没',
  reply: '在的，怎么啦？'
})
const self = JSON.stringify({ action: 'skip', reason: 'self', latestMessage: '在的，怎么啦？' })
const page = JSON.stringify({ action: 'skip', reason: 'non_chat', latestMessage: '公众号文章' })
async function collect(provider, extra = {}) {
  const result = []
  for await (const event of provider.run({
    screenshot: 'frame',
    captureContext: 'full_window',
    ...extra
  }))
    result.push(event)
  return result
}
function silicon(replies) {
  const prompts = []
  const { createSiliconFlowProvider } = loadSource('src/main/siliconflow-provider.ts', {
    '../core/siliconflow-client': {
      SILICONFLOW_DEFAULT_MODEL: 'test-model',
      SILICONFLOW_PROVIDER_ID: 'siliconflow-vision'
    }
  })
  return {
    prompts,
    provider: createSiliconFlowProvider({
      analyzeImage: async (_, prompt) => {
        prompts.push(prompt)
        if (!replies.length) throw new Error('unexpected model request')
        return replies.shift()
      }
    })
  }
}

test('SiliconFlow answers ordinary group questions and verifies an unexplained SKIP once', async () => {
  const run = silicon(['[SKIP]', incoming])
  const events = await collect(run.provider)
  assert.equal(run.prompts.length, 2)
  assert.match(run.prompts[0], /不要求被@/)
  assert.deepEqual(events.at(-1), {
    type: 'reply_text',
    content: '在的，怎么啦？',
    latestMessage: '有人没'
  })
})

test('self messages, public pages and drafts are skipped with reasons without forced replies', async () => {
  const run = silicon([self, page, JSON.stringify({ action: 'skip', reason: 'draft' })])
  for (const category of ['self', 'non_chat', 'draft']) {
    const event = (await collect(run.provider)).at(-1)
    assert.equal(event.type, 'skip')
    assert.equal(event.category, category)
    assert.ok(event.reason)
  }
  assert.equal(run.prompts.length, 3)
})

test('ambiguous model decisions stop after one review; malformed JSON never becomes a sent message', async () => {
  const run = silicon(['[SKIP]', '[SKIP]', '{bad json}'])
  const first = (await collect(run.provider)).at(-1)
  assert.equal(first.category, 'uncertain')
  assert.equal(run.prompts.length, 2)
  assert.equal((await collect(run.provider)).at(-1).type, 'error')
  assert.throws(
    () => parseChatDecision('{"action":"reply","reason":"self","reply":"wrong"}'),
    /返回格式无效/
  )
})

test('Ark shares the group/skip protocol and never sends decision JSON as chat text', async (t) => {
  const replies = ['[SKIP]', incoming, self, page]
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    bodies.push(JSON.parse(options.body))
    return Response.json({
      output: [{ type: 'message', content: [{ type: 'output_text', text: replies.shift() }] }]
    })
  })
  const { createProvider } = loadSource('resources/providers/volcengine-ark/provider.bundle.js')
  const provider = createProvider({ providerConfig: { apiKey: 'test-only-key' } })
  assert.deepEqual((await collect(provider)).at(-1), {
    type: 'reply_text',
    content: '在的，怎么啦？',
    latestMessage: '有人没'
  })
  assert.equal((await collect(provider)).at(-1).category, 'self')
  assert.equal((await collect(provider)).at(-1).category, 'non_chat')
  assert.equal(bodies.length, 4)
  assert.match(bodies[0].input[0].content, /不要求被@/)
})

function sessionRun(overrides = {}) {
  const queued = [],
    scheduled = [],
    logs = []
  let sends = 0,
    stopped = false
  const device = {
    setAppType: () => undefined,
    clearChatBaseline: () => undefined,
    setChatBaseline: async () => true,
    hasChatAreaChanged: async () => ({ hasDiff: false, hasBaseline: true }),
    hasUnreadMessage: async () => ({ hasUnread: false }),
    sendMessage: async () => {
      sends++
    },
    screenshot: async () => 'frame',
    measureLayout: async () => ({ success: true }),
    ...overrides
  }
  return {
    queued,
    scheduled,
    logs,
    device,
    get sends() {
      return sends
    },
    get stopped() {
      return stopped
    },
    session: new GenericChannelSession(device),
    ctx: {
      appType: 'wechat',
      state: createInitialGenericChannelState(),
      host: {
        enqueue: (event) => queued.push(event),
        schedule: (event, delayMs) => scheduled.push({ event, delayMs }),
        log: (type, text) => logs.push({ type, text }),
        trace: () => undefined,
        isRunning: () => true,
        stopSession: async () => {
          stopped = true
        }
      }
    }
  }
}

test('recoverable startup waits for a chat page rather than stopping the engine', async () => {
  let calls = 0
  const run = sessionRun({
    measureLayout: async () =>
      ++calls === 1
        ? { success: false, recoverable: true, error: '当前页面没有聊天输入框' }
        : { success: true }
  })
  await run.session.onEvent({ type: 'bootstrap' }, run.ctx)
  assert.equal(run.stopped, false)
  assert.deepEqual(run.scheduled, [{ event: { type: 'bootstrap' }, delayMs: 5000 }])
  await run.session.onEvent(run.scheduled[0].event, run.ctx)
  assert.equal(run.queued.at(-1).type, 'observe_chat')
})

test('web/browser focus changes during observe/send keep the session alive without replaying old replies', async () => {
  let attempted = 0
  const run = sessionRun({
    screenshot: async () => {
      throw new DesktopStateError('focus_changed', '请返回聊天窗口')
    },
    sendMessage: async () => {
      attempted++
      throw new DesktopStateError('focus_changed', '窗口失去焦点')
    }
  })
  await run.session.onEvent({ type: 'observe_chat' }, run.ctx)
  await run.session.onEvent({ type: 'provider.reply_text', content: '旧回复' }, run.ctx)
  assert.equal(run.stopped, false)
  assert.equal(attempted, 1)
  assert.ok(run.queued.every((event) => event.type === 'wait_retry'))
  assert.ok(run.logs.some((item) => /引擎保持运行/.test(item.text)))
})

test('uncertain send after Enter only updates the baseline; original reply is not re-enqueued', async () => {
  const run = sessionRun({
    sendMessage: async () => {
      throw new DesktopStateError('focus_changed', '发送后焦点改变', 'submitted')
    }
  })
  await run.session.onEvent({ type: 'provider.reply_text', content: '旧回复' }, run.ctx)
  assert.equal(run.stopped, false)
  assert.ok(run.logs.some((item) => /不会自动重发/.test(item.text)))
  assert.ok(!run.queued.some((event) => event.type === 'provider.reply_text'))
})

test('public page skips do not click red badges; returning to a changed chat resumes observation', async () => {
  let changed = false,
    unreadScans = 0
  const run = sessionRun({
    hasChatAreaChanged: async () => ({ hasDiff: changed, hasBaseline: true }),
    hasUnreadMessage: async () => {
      unreadScans++
      return { hasUnread: true }
    }
  })
  await run.session.onEvent(
    { type: 'provider.skip', reason: '当前为公众号或网页', category: 'non_chat' },
    run.ctx
  )
  await run.session.onEvent({ type: 'check_unread' }, run.ctx)
  assert.equal(unreadScans, 0)
  changed = true
  await run.session.onEvent({ type: 'check_unread' }, run.ctx)
  assert.equal(run.queued.at(-1).type, 'observe_chat')
})

test('baseline refresh failure after a normal reply does not crash or repeat the send', async () => {
  const run = sessionRun({
    setChatBaseline: async () => {
      throw new DesktopStateError('focus_changed', '已打开网页')
    }
  })
  await run.session.onEvent({ type: 'provider.reply_text', content: '回复' }, run.ctx)
  assert.equal(run.sends, 1)
  assert.equal(run.stopped, false)
  assert.equal(run.queued.at(-1).type, 'check_unread')
})

function rpaRun() {
  let foreground = true,
    frame = 'full-frame',
    header = 0,
    sent = 0,
    layoutCalls = 0,
    history = 0,
    baseline = null
  const validLayout = {
    chatMainArea: { bbox: [320, 100, 980, 700] },
    headerArea: { bbox: [320, 20, 980, 90] }
  }
  let layout = validLayout
  let layoutResult = { success: true, chatMainArea: validLayout.chatMainArea }
  const compare = loadSource('src/core/rpa/image-compare.ts', { './screenshot-utils': {} })
  const image = {
    getSize: () => ({ width: 1000, height: 700 }),
    crop: (rect) => {
      const color = rect.y < 70 ? header : history
      return {
        toPNG: () => {
          const png = new PNG({ width: 8, height: 4 })
          png.data.fill(color)
          for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255
          return PNG.sync.write(png)
        }
      }
    }
  }
  const { RPADevice } = loadSource('src/core/rpa-device.ts', {
    './ai-client': { AIClient: class {} },
    './rpa/screenshot-utils': {
      clearScreenshotCache: () => undefined,
      captureWechatWindow: async () => ({
        success: true,
        screenshotBase64: frame,
        nativeImage: image
      })
    },
    './rpa/input-utils': {
      sendReplyAction: async () => {
        sent++
        return true
      }
    },
    './rpa/has-unread': {},
    './rpa/window-utils': {
      getWechatWindowInfo: async () => ({
        foreground,
        bounds: { width: 1000, height: 700 },
        wechatWindow: { id: 37 }
      })
    },
    './rpa/image-compare': {
      ...compare,
      setChatBaselineImage: (image) => {
        baseline = image.toPNG()
      }
    },
    './rpa/vision-utils': {
      getLayoutCache: () => layout,
      getInputAreaFromCache: () => ({ coordinates: [750, 600] }),
      detectWechatLayout: async () => {
        layoutCalls++
        layout = layoutResult.success ? validLayout : null
        return layoutResult
      }
    }
  })
  const rpa = new RPADevice()
  rpa.setVisionClient({ detectVision: async () => '' })
  return {
    rpa,
    get sent() {
      return sent
    },
    get layoutCalls() {
      return layoutCalls
    },
    set foreground(value) {
      foreground = value
    },
    set frame(value) {
      frame = value
    },
    set header(value) {
      header = value
    },
    set history(value) {
      history = value
    },
    get baseline() {
      return baseline
    },
    set layoutResult(value) {
      layoutResult = value
    }
  }
}

test('RPA supplies the full window; a browser focus change blocks capture and sending', async () => {
  const run = rpaRun()
  assert.equal(await run.rpa.screenshot(), 'full-frame')
  assert.equal(run.rpa.getCaptureContext(), 'full_window')
  await run.rpa.sendMessage('正常回复')
  assert.equal(run.sent, 1)
  run.foreground = false
  await assert.rejects(run.rpa.screenshot(), /暂不在前台/)
  await assert.rejects(run.rpa.sendMessage('旧回复'), /暂不在前台/)
  assert.equal(run.sent, 1)
})

test('a changed conversation header cancels the old model reply before desktop input', async () => {
  const run = rpaRun()
  await run.rpa.screenshot()
  run.header = 255
  await assert.rejects(run.rpa.sendMessage('旧回复'), /聊天对象或页面已改变/)
  assert.equal(run.sent, 0)
})

test('new messages arriving during inference cancel the stale reply and keep the analyzed baseline', async () => {
  const run = rpaRun()
  await run.rpa.screenshot()
  const observation = run.rpa.getObservationContext()
  run.history = 255
  await assert.rejects(run.rpa.sendMessage('旧问题的回复'), /聊天内容已改变/)
  assert.equal(run.sent, 0)
  assert.equal(run.rpa.commitObservationBaseline(), true)
  assert.equal(PNG.sync.read(run.baseline).data[0], 0)
  assert.equal(run.rpa.getObservationContext().historyId, observation.historyId)
  await run.rpa.screenshot()
  assert.notEqual(run.rpa.getObservationContext().historyId, observation.historyId)
})

test('an unchanged non-chat startup page avoids repeated VLM calls and resumes when it changes', async () => {
  const run = rpaRun()
  run.layoutResult = { success: false, recoverable: true, error: '当前为公众号页面' }
  assert.equal((await run.rpa.measureLayout()).recoverable, true)
  assert.equal((await run.rpa.measureLayout()).recoverable, true)
  assert.equal(run.layoutCalls, 1)
  run.frame = 'chat-frame'
  run.layoutResult = { success: true, chatMainArea: { bbox: [320, 100, 980, 700] } }
  assert.equal((await run.rpa.measureLayout()).success, true)
  assert.equal(run.layoutCalls, 2)
})
