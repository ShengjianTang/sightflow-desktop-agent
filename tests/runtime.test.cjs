const assert = require('node:assert/strict')
const { test } = require('node:test')
const { setImmediate: nextTurn } = require('node:timers/promises')
const { RuntimeHost } = require('../src/core/runtime-host.ts')
const {
  GenericChannelSession,
  createInitialGenericChannelState
} = require('../src/core/generic-channel-session.ts')

function device() {
  return {
    setAppType() {
      /* no desktop in offline tests */
    },
    clearChatBaseline() {
      /* no image baseline in offline tests */
    },
    measureLayout: async () => ({ success: true }),
    screenshot: async () => 'test-image',
    sendMessage: async () => {
      throw new Error('must not send')
    }
  }
}

test('provider connection errors schedule retry without crashing the session', async (t) => {
  const logs = []
  let reported
  const errorSeen = new Promise((resolve) => {
    reported = resolve
  })
  const host = new RuntimeHost({
    appType: 'generic',
    initialState: createInitialGenericChannelState(),
    channel: new GenericChannelSession(device()),
    provider: {
      async *run() {
        yield { type: 'thinking', content: 'test' }
        throw new Error('connection refused')
      }
    },
    onLog: (type, message) => {
      logs.push([type, message])
      if (type === 'error') reported()
    }
  })
  t.after(() => host.stopSession('test_cleanup'))
  await host.startSession()
  await errorSeen
  await nextTurn()
  assert.equal(host.isRunning(), true)
  assert.ok(logs.some(([type, text]) => type === 'error' && text.includes('connection refused')))
  await host.stopSession('test_stop')
  assert.equal(host.isRunning(), false)
})

test('a late provider response is discarded after the session stops', async () => {
  let finish
  let began
  const ready = new Promise((resolve) => {
    began = resolve
  })
  const wait = new Promise((resolve) => {
    finish = resolve
  })
  let sent = 0
  const fakeDevice = device()
  fakeDevice.sendMessage = async () => {
    sent++
  }
  const host = new RuntimeHost({
    appType: 'generic',
    initialState: createInitialGenericChannelState(),
    channel: new GenericChannelSession(fakeDevice),
    provider: {
      async *run() {
        began()
        await wait
        yield { type: 'reply_text', content: 'late reply' }
      }
    },
    onLog() {
      /* quiet test logger */
    }
  })
  await host.startSession()
  await ready
  await host.stopSession('test_stop')
  finish()
  await nextTurn()
  assert.equal(sent, 0)
})

test('background event and device cleanup failures remain handled', async () => {
  const logs = []
  const host = new RuntimeHost({
    appType: 'generic',
    initialState: {},
    provider: {},
    channel: {
      onStart(ctx) {
        ctx.host.enqueue({ type: 'bootstrap' })
      },
      async onEvent() {
        throw new Error('event failed')
      },
      async onStop() {
        throw new Error('cleanup failed')
      }
    },
    onLog: (_type, message) => logs.push(message)
  })
  await host.startSession()
  await nextTurn()
  assert.equal(host.isRunning(), false)
  assert.ok(logs.includes('event failed'))
  assert.ok(logs.includes('cleanup failed'))
})
