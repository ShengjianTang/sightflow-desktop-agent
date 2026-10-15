// Read-only performance report. Does not print messages or screenshots.
const fs = require('node:fs'),
  path = require('node:path')
function summarize(rows, markers = []) {
  const groups = new Map()
  for (const row of rows) {
    const m = row.performance
    if (!m?.batchId) continue
    const id = row.sessionId + ':' + m.batchId
    const batch = groups.get(id) || {
      id,
      sessionId: row.sessionId,
      batchId: m.batchId,
      stages: [],
      status: 'incomplete'
    }
    batch.stages.push({
      stage: m.stage,
      model: m.model,
      code: m.code,
      ms: row.outcome?.latencyMs,
      ts: row.ts
    })
    if (m.stage === 'batch_total' && row.outcome?.status === 'ok') batch.status = 'sent'
    if (m.stage === 'send' && row.outcome?.status === 'ok') batch.sentAt = row.ts
    if (['EMPTY_CHAT', 'NON_CHAT', 'DRAFT', 'SELF'].includes(m.code))
      batch.status = m.code.toLowerCase()
    if (row.outcome?.status === 'fail') batch.status = 'failed'
    groups.set(id, batch)
  }
  const batches = [...groups.values()].map((b) => {
    const marker = markers.find((m) => m.sessionId === b.sessionId && m.batchId === b.batchId)
    if (marker && b.sentAt) {
      const start =
        typeof marker.lastMessageVisibleAt === 'number'
          ? marker.lastMessageVisibleAt
          : Date.parse(marker.lastMessageVisibleAt)
      if (Number.isFinite(start) && b.sentAt >= start) b.endToEndMs = b.sentAt - start
    }
    return b
  })
  const times = batches
    .filter((b) => b.status === 'sent' && b.endToEndMs !== undefined)
    .map((b) => b.endToEndMs)
    .sort((a, b) => a - b)
  const median = times.length ? times[Math.floor(times.length / 2)] : null,
    p95 = times.length ? times[Math.ceil(times.length * 0.95) - 1] : null
  return {
    batches,
    markedSuccessfulBatches: times.length,
    markedIncompleteBatches: markers.length - times.length,
    medianMs: median,
    p95Ms: p95,
    latencyTargetMet:
      times.length >= 30 && times.length === markers.length && median <= 8000 && p95 <= 15000,
    note: 'Without user-recorded lastMessageVisibleAt markers this is stage timing only, not an end-to-end latency acceptance. Correctness and missed replies also require the test operator to sign off.'
  }
}
module.exports = { summarize }
if (require.main === module) {
  const files = process.argv.slice(2),
    markAt = files.indexOf('--markers')
  let markers = []
  if (markAt >= 0) {
    markers = JSON.parse(fs.readFileSync(files[markAt + 1], 'utf8'))
    files.splice(markAt, 2)
  }
  if (!files.length) {
    console.error(
      'Usage: node scripts/reply-latency-report.cjs <trace.jsonl> [more traces] [--markers markers.json]'
    )
    process.exitCode = 1
  } else {
    const rows = files.flatMap((f) =>
      fs
        .readFileSync(path.resolve(f), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((x) => JSON.parse(x))
    )
    console.log(JSON.stringify(summarize(rows, markers), null, 2))
  }
}
