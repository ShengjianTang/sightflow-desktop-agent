// Uses synthetic fixtures only. Never starts Electron or sends to a contact.
require('../tests/register.cjs')
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  cp = require('node:child_process')
const {
  createSiliconFlowClient,
  createSiliconFlowProvider
} = require('../src/main/siliconflow-provider.ts')
const { ReplyGuard } = require('../src/core/reply-guard.ts')
const root = path.resolve(__dirname, '..'),
  out = path.join(root, '.local', process.env.REPLY_BENCHMARK_RUN || 'reply-batch-benchmark')
const models = ['Qwen/Qwen3-VL-30B-A3B-Instruct', 'Qwen/Qwen3-VL-8B-Instruct']
const inc = (text, kind = 'text', more = {}) => ({ sender: 'incoming', kind, text, ...more })
const own = (text) => ({ sender: 'self', kind: 'text', text })
const cases = []
for (let i = 0; i < 10; i++)
  cases.push({
    id: 'text-' + i,
    page: 'chat',
    draft: false,
    positive: true,
    expected: String(i + 12),
    messages: [
      own('上一题已经回答。'),
      inc('现在有 ' + (i + 5) + ' 个苹果。'),
      inc('再加 7 个，一共多少个？')
    ]
  })
const colors = [
  ['Red', '红'],
  ['Blue', '蓝'],
  ['Green', '绿'],
  ['Orange', '橙'],
  ['Purple', '紫']
]
for (let i = 0; i < 10; i++) {
  const c = colors[i % 5]
  cases.push({
    id: 'image-' + i,
    page: 'chat',
    draft: false,
    positive: true,
    expected: c[1],
    messages: [
      inc('帮我看这张图片。'),
      inc('彩色圆形', 'image', { color: c[0] }),
      inc('请告诉我圆形是什么颜色？')
    ]
  })
}
for (let i = 0; i < 10; i++)
  cases.push({
    id: 'emoji-' + i,
    page: 'chat',
    draft: false,
    positive: true,
    expected: '开心|高兴|快乐|笑|愉快',
    messages: [
      inc('这是我现在的心情。'),
      inc('笑脸', 'emoji'),
      inc(i % 2 ? '这个表情看起来开心吗？' : '你能看懂这个表情的情绪吗？')
    ]
  })
for (let i = 0; i < 3; i++)
  cases.push({
    id: 'self-' + i,
    page: 'chat',
    draft: false,
    positive: false,
    messages: [inc('现在可以开始了吗？'), own('可以，已经准备好了。')]
  })
for (let i = 0; i < 2; i++)
  cases.push({
    id: 'draft-' + i,
    page: 'chat',
    draft: true,
    positive: false,
    messages: [inc('请现在回复这个问题')]
  })
for (let i = 0; i < 2; i++)
  cases.push({ id: 'article-' + i, page: 'non_chat', draft: false, positive: false, messages: [] })
cases.push({ id: 'empty', page: 'empty', draft: false, positive: false, messages: [] })
for (let i = 0; i < 2; i++)
  cases.push({
    id: 'unknown-' + i,
    page: 'chat',
    draft: false,
    positive: false,
    hideAvatar: true,
    messages: [inc('头像不可见，无法确认发送方')]
  })
const args = process.argv.slice(2)
async function main() {
  fs.mkdirSync(out, { recursive: true })
  const manifest = path.join(out, 'cases.json')
  if (args.includes('--prepare')) {
    fs.writeFileSync(manifest, JSON.stringify(cases, null, 2))
    const r = cp.spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, 'create-reply-benchmark.ps1'),
        '-CasesPath',
        manifest,
        '-OutputDir',
        out
      ],
      { encoding: 'utf8' }
    )
    if (r.status !== 0) throw Error(r.stderr || 'render failed')
    console.log(r.stdout.trim())
    return
  }
  if (!fs.existsSync(path.join(out, 'empty.png'))) throw Error('Run --prepare first')
  const config = JSON.parse(
    fs.readFileSync(
      path.join(os.homedir(), 'AppData/Roaming/sightflow-desktop-agent/settings.json'),
      'utf8'
    )
  ).siliconFlow
  const resultPath = path.join(out, 'results.jsonl'),
    results = []
  if (args.includes('--resume') && fs.existsSync(resultPath))
    results.push(
      ...fs
        .readFileSync(resultPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((x) => JSON.parse(x))
    )
  else if (fs.existsSync(resultPath))
    throw Error('Results exist; use --resume or move the previous result file')
  const limitArg = args.indexOf('--limit'),
    limit = limitArg < 0 ? cases.length : Number(args[limitArg + 1])
  for (const [index, fixture] of cases.slice(0, limit).entries()) {
    const order = index % 2 ? [...models].reverse() : models
    for (const model of order) {
      if (results.some((r) => r.id === fixture.id && r.model === model)) continue
      const start = Date.now(),
        events = []
      const observation = {
        conversationId: 'synthetic',
        historyId: fixture.id,
        chatAreaBbox: [0, 90, 1000, 795],
        ...(fixture.messages.some((m) => m.sender === 'self') ? { outgoingBubbleBottom: 225 } : {}),
        panelBbox: [0, 0, 1000, 1000]
      }
      const client = createSiliconFlowClient({ ...config, replyModel: model }, 'reply')
      const provider = createSiliconFlowProvider(client)
      for await (const event of provider.run({
        screenshot:
          'data:image/png;base64,' +
          fs.readFileSync(path.join(out, fixture.id + '.png')).toString('base64'),
        appType: 'wechat',
        batchId: fixture.id,
        captureContext: 'conversation_panel',
        observation
      }))
        events.push(event)
      const terminal = events.findLast((e) => ['reply_text', 'skip', 'error'].includes(e.type))
      const block =
        terminal?.type === 'reply_text'
          ? new ReplyGuard().rejection(terminal, observation)
          : undefined
      const replies = terminal?.type === 'reply_text' && !block
      const semantic =
        !fixture.positive || new RegExp(fixture.expected).test(terminal?.content || '')
      const countOK =
        !fixture.positive ||
        terminal?.messages?.filter((m) => m.sender === 'incoming').length ===
          fixture.messages.filter((m) => m.sender === 'incoming').length
      const correct = fixture.positive
        ? Boolean(replies && semantic && countOK)
        : !replies && terminal?.type === 'skip'
      const record = {
        id: fixture.id,
        model,
        positive: fixture.positive,
        elapsedMs: Date.now() - start,
        correct,
        semantic,
        countOK,
        block,
        terminal,
        metrics: events.filter((e) => e.type === 'metric'),
        synthetic: true,
        sent: false
      }
      fs.appendFileSync(resultPath, JSON.stringify(record) + '\n')
      results.push(record)
      console.log(
        JSON.stringify({
          id: record.id,
          model,
          elapsedMs: record.elapsedMs,
          correct,
          type: terminal?.type,
          code: record.block || terminal?.reason || terminal?.error || 'OK'
        })
      )
    }
  }
  const summary = models.map((model) => {
    const rows = results.filter((r) => r.model === model),
      positive = rows.filter((r) => r.positive),
      times = positive.map((r) => r.elapsedMs).sort((a, b) => a - b)
    const median = times.length ? times[Math.floor(times.length / 2)] : null,
      p95 = times.length ? times[Math.ceil(times.length * 0.95) - 1] : null
    return {
      model,
      cases: rows.length,
      positive: positive.length,
      negative: rows.length - positive.length,
      correct: rows.filter((r) => r.correct).length,
      medianProviderMs: median,
      p95ProviderMs: p95,
      candidate:
        rows.length === 40 && rows.every((r) => r.correct) && median <= 5000 && p95 <= 12000
    }
  })
  fs.writeFileSync(
    path.join(out, 'summary.json'),
    JSON.stringify(
      {
        summary,
        latencyNote:
          'Provider timing only, excludes detection, capture and sending; target reserves 3s local time. Real 30-batch WeChat acceptance is required.',
        syntheticOnly: true,
        configurationChanged: false
      },
      null,
      2
    )
  )
  console.log(JSON.stringify(summary, null, 2))
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
