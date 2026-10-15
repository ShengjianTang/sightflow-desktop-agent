const assert = require('node:assert/strict')
const { test } = require('node:test')
const { summarize } = require('../scripts/reply-latency-report.cjs')
const { TraceRecorder } = require('../src/core/trace/trace-recorder.ts')
test('timing recorder retains structured metadata without requiring chat content', () => {
  const recorder = new TraceRecorder('.local/test-user-data/reply-timing-test')
  recorder.startSession({ appType: 'wechat', engineVersion: 'test', model: 'fixture' })
  const performance = { batchId: 'b', stage: 'reply_request', code: 'OK', model: 'fixture' }
  const row = recorder.record({
    phase: 'think',
    summary: 'request',
    performance,
    outcome: { status: 'ok', latencyMs: 500 }
  })
  assert.deepEqual(row.performance, performance)
  assert.equal(row.action, undefined)
  recorder.endSession()
})
test('latency report never treats model-only duration or unmarked traces as end-to-end acceptance', () => {
  const rows = [],
    markers = []
  for (let i = 0; i < 30; i++) {
    const id = 'batch-' + i,
      send = 100000 + i * 10000
    rows.push({
      sessionId: 's',
      ts: send,
      performance: { batchId: id, stage: 'send', code: 'OK' },
      outcome: { status: 'ok', latencyMs: 200 }
    })
    rows.push({
      sessionId: 's',
      ts: send,
      performance: { batchId: id, stage: 'batch_total', code: 'OK' },
      outcome: { status: 'ok', latencyMs: 1000 }
    })
    markers.push({ sessionId: 's', batchId: id, lastMessageVisibleAt: send - 7000 })
  }
  assert.equal(summarize(rows).latencyTargetMet, false)
  assert.equal(summarize(rows, markers).latencyTargetMet, true)
  assert.equal(summarize(rows, markers).medianMs, 7000)
  const withMissing = [...markers, { sessionId: 's', batchId: 'not-sent', lastMessageVisibleAt: 0 }]
  assert.equal(summarize(rows, withMissing).latencyTargetMet, false)
  assert.equal(summarize(rows, withMissing).markedIncompleteBatches, 1)
  markers[29].lastMessageVisibleAt -= 20000
  markers[28].lastMessageVisibleAt -= 20000
  assert.equal(summarize(rows, markers).latencyTargetMet, false)
})
