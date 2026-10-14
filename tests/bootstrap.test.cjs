const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
  GenericChannelSession,
  createInitialGenericChannelState
} = require('../src/core/generic-channel-session.ts')
const { loadSource } = require('./helpers.cjs')

function unreadContext(device) {
  const queued = [],
    logs = []
  return {
    session: new GenericChannelSession(device),
    queued,
    logs,
    ctx: {
      appType: 'wechat',
      state: createInitialGenericChannelState(),
      host: {
        isRunning: () => true,
        enqueue: (event) => queued.push(event),
        log: (type, message) => logs.push({ type, message }),
        trace() {
          return undefined
        }
      }
    }
  }
}

test('unread contact coordinates open the actual row and verify the chat changed', async () => {
  const clicks = []
  let checks = 0,
    cleared = false
  const run = unreadContext({
    setAppType() {
      return undefined
    },
    hasChatAreaChanged: async () => ({ hasDiff: ++checks > 1, hasBaseline: true }),
    hasUnreadMessage: async () => ({ hasUnread: true, unreadContactCoords: [100, 250] }),
    clickUnreadContact: async (coords) => clicks.push(coords),
    activeUnreadByClick: async () => {
      throw new Error('navigation should not be used for a known contact')
    },
    clearChatBaseline: () => {
      cleared = true
    }
  })
  await run.session.onEvent({ type: 'check_unread' }, run.ctx)
  assert.deepEqual(clicks, [[100, 250]])
  assert.equal(cleared, true)
  assert.deepEqual(run.queued, [{ type: 'observe_chat' }])
})

test('unchanged chat after contact click is not sent to the provider', async () => {
  const run = unreadContext({
    setAppType() {
      return undefined
    },
    hasChatAreaChanged: async () => ({ hasDiff: false, hasBaseline: true }),
    hasUnreadMessage: async () => ({ hasUnread: true, unreadContactCoords: [100, 250] }),
    clickUnreadContact: async () => {},
    clearChatBaseline() {
      throw new Error('keep baseline on failed click')
    }
  })
  await run.session.onEvent({ type: 'check_unread' }, run.ctx)
  assert.equal(run.queued[0].type, 'wait_retry')
  assert.equal(run.queued[0].reason, 'contact_not_ready')
})

test('idle polls run every 1.2s; detection errors are reported instead of called no unread', async () => {
  let error
  const run = unreadContext({
    setAppType() {
      return undefined
    },
    hasChatAreaChanged: async () => ({ hasDiff: false, hasBaseline: true }),
    hasUnreadMessage: async () => ({ hasUnread: false, error })
  })
  await run.session.onEvent({ type: 'check_unread' }, run.ctx)
  assert.equal(run.queued.shift().delayMs, 1200)
  error = '截图失败'
  await run.session.onEvent({ type: 'check_unread' }, run.ctx)
  assert.equal(run.queued[0].reason, 'detection_error')
  assert.match(run.logs[0].message, /截图失败/)
})

test('temporary contact click failures are reported and retried without stopping the engine', async () => {
  const run = unreadContext({
    setAppType: () => undefined,
    hasChatAreaChanged: async () => ({ hasDiff: false, hasBaseline: true }),
    hasUnreadMessage: async () => ({ hasUnread: true, unreadContactCoords: [100, 250] }),
    clickUnreadContact: async () => {
      throw new Error('旧坐标已失效')
    }
  })
  await run.session.onEvent({ type: 'check_unread' }, run.ctx)
  assert.equal(run.queued[0].reason, 'detection_error')
  assert.match(run.logs[0].message, /旧坐标已失效/)
})

function bootstrapContext(results) {
  const queued = []
  const scheduled = []
  const logs = []
  let running = true
  let stopped = 0
  const device = {
    setAppType() {
      return undefined
    },
    clearChatBaseline() {
      return undefined
    },
    async measureLayout() {
      return results.shift()
    }
  }
  const session = new GenericChannelSession(device)
  const context = {
    appType: 'wechat',
    state: createInitialGenericChannelState(),
    host: {
      enqueue: (event) => queued.push(event),
      schedule: (event, delayMs) => scheduled.push({ event, delayMs }),
      log: (type, message) => logs.push({ type, message }),
      trace() {
        return undefined
      },
      isRunning: () => running,
      async stopSession() {
        stopped++
        running = false
      }
    }
  }
  return {
    session,
    context,
    queued,
    scheduled,
    logs,
    get stopped() {
      return stopped
    },
    cancel() {
      running = false
    }
  }
}

test('transient layout timeout retries once before entering normal observation', async () => {
  const run = bootstrapContext([
    { success: false, error: '布局测量失败: AI API 请求超时 (90s)' },
    { success: true }
  ])
  await run.session.onStart(run.context)
  await run.session.onEvent(run.queued.shift(), run.context)
  assert.deepEqual(run.scheduled, [{ event: { type: 'bootstrap' }, delayMs: 5000 }])
  assert.equal(run.stopped, 0)
  assert.match(run.logs.at(-1).message, /重试一次/)
  await run.session.onEvent(run.scheduled.shift().event, run.context)
  assert.equal(run.stopped, 0)
  assert.equal(run.queued.at(-1).type, 'observe_chat')
})

test('repeated timeout stops after one retry, while permanent layout errors stop immediately', async () => {
  const timedOut = bootstrapContext([
    { success: false, error: 'AI API 请求超时 (90s)' },
    { success: false, error: 'AI API 请求超时 (90s)' }
  ])
  await timedOut.session.onStart(timedOut.context)
  await timedOut.session.onEvent(timedOut.queued.shift(), timedOut.context)
  await timedOut.session.onEvent(timedOut.scheduled.shift().event, timedOut.context)
  assert.equal(timedOut.stopped, 1)
  assert.equal(timedOut.scheduled.length, 0)

  const invalid = bootstrapContext([{ success: false, error: '布局检测未返回任何区域' }])
  await invalid.session.onStart(invalid.context)
  await invalid.session.onEvent(invalid.queued.shift(), invalid.context)
  assert.equal(invalid.stopped, 1)
  assert.equal(invalid.scheduled.length, 0)
})

test('a layout response arriving after stop cannot restart observation', async () => {
  let finish
  const pending = new Promise((resolve) => {
    finish = resolve
  })
  const run = bootstrapContext([pending])
  await run.session.onStart(run.context)
  const inFlight = run.session.onEvent(run.queued.shift(), run.context)
  run.cancel()
  finish({ success: true })
  await inFlight
  assert.deepEqual(run.queued, [])
  assert.deepEqual(run.scheduled, [])
})

test('RPA startup only requests the required chat layout', async () => {
  let layoutCalls = 0
  let unreadCalls = 0
  const { RPADevice } = loadSource('src/core/rpa-device.ts', {
    './ai-client': {
      AIClient: class {
        updateConfig() {
          return undefined
        }
      }
    },
    './rpa/screenshot-utils': {
      captureWechatWindow: async () => ({ success: true, screenshotBase64: 'frame' })
    },
    './rpa/input-utils': {},
    './rpa/has-unread': {},
    './rpa/image-compare': {},
    './rpa/window-utils': { getWechatWindowInfo: async () => ({ bounds: {} }) },
    './rpa/vision-utils': {
      detectUnreadArea: async () => {
        unreadCalls++
      },
      detectWechatLayout: async () => {
        layoutCalls++
        return { success: true, chatMainArea: { coordinates: [200, 200] } }
      },
      getInputAreaFromCache: () => ({ coordinates: [200, 300] })
    }
  })
  const device = new RPADevice()
  device.setApiKey('test-only-key')
  assert.deepEqual(await device.measureLayout(), { success: true })
  assert.equal(layoutCalls, 1)
  assert.equal(unreadCalls, 0)
})

test('failed optional unread detection cools down and resets on session cleanup', async (t) => {
  t.mock.method(console, 'error', () => {})
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  let calls = 0
  const { getUnreadArea, clearLayoutCache } = loadSource('src/core/rpa/vision-utils.ts', {
    './screenshot-utils': {
      captureWechatWindow: async () => ({ success: true, screenshotBase64: 'test-image' })
    },
    './window-utils': {
      getWindowInfo: async () => ({ bounds: { width: 500, height: 500 }, scaleFactor: 1 })
    }
  })
  const client = {
    async detectVision() {
      calls++
      throw new Error('AI API 请求超时 (90s)')
    }
  }
  assert.equal((await getUnreadArea(client, 'wechat')).chatEntranceArea, null)
  assert.equal((await getUnreadArea(client, 'wechat')).chatEntranceArea, null)
  assert.equal(calls, 1)
  now += 5_001
  await getUnreadArea(client, 'wechat')
  assert.equal(calls, 2)
  clearLayoutCache('wechat')
  await getUnreadArea(client, 'wechat')
  assert.equal(calls, 3)
})

test('a skipped provider response is re-analyzed once when the chat area changed', async () => {
  let diffCalls = 0
  let baselineCalls = 0
  const queued = []
  const device = {
    setAppType() {
      return undefined
    },
    clearChatBaseline() {
      return undefined
    },
    async hasChatAreaChanged() {
      diffCalls++
      return { hasDiff: diffCalls === 1, hasBaseline: true }
    },
    async setChatBaseline() {
      baselineCalls++
      return true
    }
  }
  const session = new GenericChannelSession(device)
  const ctx = {
    appType: 'wechat',
    state: createInitialGenericChannelState(),
    host: {
      enqueue: (event) => queued.push(event),
      schedule: () => undefined,
      log: () => undefined,
      trace: () => undefined,
      isRunning: () => true,
      stopSession: async () => undefined
    }
  }

  await session.onEvent({ type: 'provider.skip' }, ctx)
  assert.deepEqual(queued, [{ type: 'observe_chat' }])
  assert.equal(diffCalls, 1)
  assert.equal(baselineCalls, 1)

  queued.length = 0
  await session.onEvent({ type: 'provider.skip' }, ctx)
  assert.deepEqual(queued, [{ type: 'check_unread' }])
  assert.equal(diffCalls, 1)
  assert.equal(baselineCalls, 2)
})
