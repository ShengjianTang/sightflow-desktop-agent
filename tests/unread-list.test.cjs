const assert = require('node:assert/strict')
const { test } = require('node:test')
const { PNG } = require('pngjs')
const { loadSource } = require('./helpers.cjs')
const {
  GenericChannelSession,
  createInitialGenericChannelState
} = require('../src/core/generic-channel-session.ts')

// Only the red-pixel mask of the reported 15px "6" badge; no contact names/chat data.
const SIX = [
  '000000111000000',
  '000011111111000',
  '001111111111100',
  '001111100011110',
  '011111000011110',
  '011110011111111',
  '111110000011111',
  '111110000001111',
  '111110011001111',
  '111110011001111',
  '011111000011110',
  '011111111111110',
  '001111111111100',
  '000111111111000',
  '000001111100000'
]
const windowBounds = { x: 100, y: 80, width: 880, height: 503 }
const list = { x: 20, y: 54, width: 240, height: 441 }
const target = { x: 32, y: 343, width: 36, height: 34 }
function box(rect, bounds = windowBounds) {
  return [
    (rect.x / bounds.width) * 1000,
    (rect.y / bounds.height) * 1000,
    ((rect.x + rect.width) / bounds.width) * 1000,
    ((rect.y + rect.height) / bounds.height) * 1000
  ]
}
function fromBox(bbox, bounds) {
  return {
    x: (bbox[0] / 1000) * bounds.width,
    y: (bbox[1] / 1000) * bounds.height,
    width: ((bbox[2] - bbox[0]) / 1000) * bounds.width,
    height: ((bbox[3] - bbox[1]) / 1000) * bounds.height
  }
}
function area(rect) {
  return { bbox: box(rect), coordinates: [0, 0] }
}

function scanner(seed, options = {}) {
  const scaleFactor = options.scaleFactor || 1
  let reviews = 0,
    change = false,
    bounds = { ...windowBounds },
    remembered
  const crops = [],
    progress = []
  const areas = {
    firstContact: seed ? area(seed) : null,
    contactListArea: area(list),
    chatEntranceArea: null
  }
  const capture = async (_, crop) => {
    crops.push(crop)
    const x = Math.floor(crop.x * scaleFactor),
      y = Math.floor(crop.y * scaleFactor)
    const png = new PNG({
      width: Math.ceil((crop.x + crop.width) * scaleFactor) - x,
      height: Math.ceil((crop.y + crop.height) * scaleFactor) - y
    })
    for (let py = 0; py < png.height; py++)
      for (let px = 0; px < png.width; px++) {
        const logicalX = Math.floor((x + px) / scaleFactor),
          logicalY = Math.floor((y + py) / scaleFactor)
        const red = !options.noBadge && SIX[logicalY - 334]?.[logicalX - 60] === '1'
        const i = (py * png.width + px) * 4
        png.data[i] = red ? 250 : 230
        png.data[i + 1] = red ? 81 : 230
        png.data[i + 2] = red ? 81 : 230
        png.data[i + 3] = 255
      }
    if (change) png.data[0] = 0
    return {
      success: true,
      screenshotBase64: PNG.sync.write(png).toString('base64'),
      display: { scaleFactor },
      bounds: {
        x: bounds.x + x / scaleFactor,
        y: bounds.y + y / scaleFactor,
        width: png.width / scaleFactor,
        height: png.height / scaleFactor
      }
    }
  }
  const api = loadSource('src/core/rpa/has-unread.ts', {
    './vision-utils': {
      getUnreadArea: async () => areas,
      bboxToCropBounds: fromBox,
      rememberUnreadAvatar: (_, contact) => {
        remembered = contact
        areas.firstContact = contact
      }
    },
    './window-utils': { getWindowInfo: async () => ({ bounds }) },
    './screenshot-utils': { captureWechatWindow: capture, clearScreenshotCache: () => {} }
  })
  const client = {
    detectVision: async (prompt) => {
      reviews++
      assert.match(prompt, /未读数字/)
      const crop = crops.at(-1)
      const relative = {
        ...target,
        x: target.x - Math.floor(crop.x * scaleFactor) / scaleFactor,
        y: target.y - Math.floor(crop.y * scaleFactor) / scaleFactor
      }
      if (options.changeDuringReview) change = true
      if (options.moveDuringReview) bounds = { ...bounds, x: bounds.x + 20 }
      if (options.result !== undefined) return options.result
      return JSON.stringify({
        candidate: 0,
        avatarBbox: box(relative, {
          width: Math.ceil(crop.width * scaleFactor) / scaleFactor,
          height: Math.ceil(crop.height * scaleFactor) / scaleFactor
        })
      })
    }
  }
  return {
    api,
    client,
    crops,
    progress,
    areas,
    get reviews() {
      return reviews
    },
    get remembered() {
      return remembered
    },
    async detect() {
      return api.hasUnreadMessage(client, 'wechat', (message) => progress.push(message))
    }
  }
}

test('scan includes unread rows above the reference avatar and below folded pinned sections', async () => {
  const run = scanner({ x: 32, y: 407, width: 36, height: 36 })
  const result = await run.detect()
  assert.equal(result.hasUnread, true)
  assert.equal(run.reviews, 0)
  assert.equal(result.unreadContactCoords[0], 150)
  assert.ok(result.unreadContactCoords[1] >= 421 && result.unreadContactCoords[1] <= 429)
  assert.ok(run.crops[0].y < 334)
})

test('whole-row, tiny inner icon, clipped and missing avatar seeds recover via the full list at multiple DPIs', async () => {
  const seeds = [
    { x: 20, y: 84, width: 240, height: 65 },
    { x: 42, y: 110, width: 16, height: 16 },
    { x: 32, y: 60, width: 36, height: 10 },
    null
  ]
  for (const scaleFactor of [1, 1.25, 1.5, 2])
    for (const seed of seeds) {
      const run = scanner(seed, { scaleFactor })
      const result = await run.detect()
      assert.equal(result.success, true)
      assert.equal(result.hasUnread, true)
      assert.deepEqual(result.unreadContactCoords, [150, 440])
      assert.equal(run.reviews, 1)
      assert.ok(run.remembered)
      assert.match(run.progress[0], /正在复核/)
      const next = await run.detect()
      assert.equal(next.hasUnread, true)
      assert.equal(run.reviews, 1, 'corrected avatar column uses pixel-only scans')
    }
})

test('no red pixels means no model review; unconfirmed pixels are not blindly clicked and reviews are throttled', async (t) => {
  const empty = scanner(null, { noBadge: true })
  assert.equal((await empty.detect()).hasUnread, false)
  assert.equal(empty.reviews, 0)
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  const run = scanner(null, { result: '{"candidate":null}' })
  assert.equal((await run.detect()).hasUnread, false)
  const waiting = await run.detect()
  assert.match(waiting.detail, /等待未读联系人复核/)
  assert.equal(run.reviews, 1)
  now += 5001
  await run.detect()
  assert.equal(run.reviews, 2)
  run.api.clearUnreadDetectionCache('wechat')
  await run.detect()
  assert.equal(run.reviews, 3)
})

test('out-of-list model coordinates, invalid candidate indices and non-avatar boxes never produce clicks', async () => {
  for (const result of [
    '{"candidate":7,"avatarBbox":[1,1,2,2]}',
    '{"candidate":0,"avatarBbox":[-10,600,300,900]}',
    '{"candidate":0,"avatarBbox":[0,630,990,780]}',
    '{"candidate":0,"avatarBbox":[100,100,250,180]}',
    '{not json}'
  ]) {
    const run = scanner(null, { result })
    const found = await run.detect()
    assert.equal(found.success, false)
    assert.ok(found.error)
    assert.equal(found.unreadContactCoords, undefined)
  }
})

test('a list reorder or window move during model verification cancels stale coordinates', async () => {
  for (const option of ['changeDuringReview', 'moveDuringReview']) {
    const run = scanner(null, { [option]: true })
    const found = await run.detect()
    assert.equal(found.success, true)
    assert.equal(found.hasUnread, false)
    assert.equal(found.unreadContactCoords, undefined)
    assert.match(found.detail, /变化/)
    assert.equal(run.remembered, undefined)
  }
})

function layoutApi() {
  return loadSource('src/core/rpa/vision-utils.ts', {
    './window-utils': { getWindowInfo: async () => ({ bounds: windowBounds, scaleFactor: 1 }) },
    './screenshot-utils': {
      captureWechatWindow: async () => ({
        success: true,
        bounds: windowBounds,
        screenshotBase64: 'test-frame'
      })
    }
  })
}

test('main layout yields the full list independently of the malformed avatar without another layout request', async () => {
  const api = layoutApi()
  api.setLayoutCache('wechat', {
    appType: 'wechat',
    timestamp: Date.now(),
    chatEntranceArea: null,
    firstContact: area({ x: 20, y: 84, width: 240, height: 65 }),
    searchInputBox: area({ x: 32, y: 25, width: 180, height: 26 }),
    chatMainArea: area({ x: 260, y: 60, width: 610, height: 270 })
  })
  const found = await api.getUnreadArea(
    {
      detectVision: async () => {
        throw new Error('unneeded request')
      }
    },
    'wechat'
  )
  const rect = fromBox(found.contactListArea.bbox, windowBounds)
  assert.ok(rect.x <= 32 && rect.x + rect.width >= 75)
  assert.ok(rect.y <= 60 && rect.y + rect.height >= 490)
})

test('list-only tagged layout is accepted and legacy avatar-only caches expire', async (t) => {
  let now = 1000,
    calls = 0
  t.mock.method(Date, 'now', () => now)
  const api = layoutApi()
  const client = {
    detectVision: async () => {
      calls++
      return calls === 1
        ? '<firstContact><bbox>40,120,80,190</bbox></firstContact>'
        : '<contactList><bbox>20,110,295,980</bbox></contactList>'
    }
  }
  await api.getUnreadArea(client, 'wechat')
  await api.getUnreadArea(client, 'wechat')
  assert.equal(calls, 1)
  now += 30_001
  const found = await api.getUnreadArea(client, 'wechat')
  assert.ok(found.contactListArea)
  assert.equal(found.firstContact, null)
  assert.equal(calls, 2)
})

function sessionRun(overrides = {}) {
  const queued = [],
    logs = [],
    clicks = []
  let cleared = 0
  const device = {
    setAppType: () => {},
    hasChatAreaChanged: async () => ({ hasDiff: false, hasBaseline: true }),
    hasUnreadMessage: async () => ({ hasUnread: true, unreadContactCoords: [150, 440] }),
    clickUnreadContact: async (point) => clicks.push(point),
    clearUnreadCache: () => {
      cleared++
    },
    clearChatBaseline: () => {},
    ...overrides
  }
  return {
    queued,
    logs,
    clicks,
    get cleared() {
      return cleared
    },
    session: new GenericChannelSession(device),
    ctx: {
      appType: 'wechat',
      state: createInitialGenericChannelState(),
      host: {
        isRunning: () => true,
        enqueue: (event) => queued.push(event),
        schedule: () => {},
        log: (_, message) => logs.push(message),
        trace: () => {}
      }
    }
  }
}

test('recovered list detection proceeds through contact click to observation without navigation', async () => {
  const scan = scanner({ x: 20, y: 84, width: 240, height: 65 })
  let checks = 0
  const run = sessionRun({
    hasUnreadMessage: () => scan.detect(),
    hasChatAreaChanged: async () => ({ hasDiff: ++checks > 1, hasBaseline: true })
  })
  await run.session.onEvent({ type: 'check_unread' }, run.ctx)
  assert.deepEqual(run.clicks, [[150, 440]])
  assert.equal(run.queued.at(-1).type, 'observe_chat')
})

test('failed switches and failed layout detection invalidate old coordinates instead of retrying forever', async () => {
  for (const overrides of [
    {},
    { hasUnreadMessage: async () => ({ hasUnread: false, error: '头像定位无效' }) }
  ]) {
    const run = sessionRun(overrides)
    await run.session.onEvent({ type: 'check_unread' }, run.ctx)
    await run.session.onEvent({ type: 'check_unread' }, run.ctx)
    assert.equal(run.cleared, 1)
    assert.ok(run.logs.some((line) => /已清除旧/.test(line)))
  }
})

test('waiting logs carry the actual list detection outcome, and stop during review prevents a click', async () => {
  const detail = '列表有红色候选，等待未读联系人复核（最多 5 秒）'
  const run = sessionRun({ hasUnreadMessage: async () => ({ hasUnread: false, detail }) })
  await run.session.onEvent({ type: 'check_unread' }, run.ctx)
  await run.session.onEvent(run.queued[0], run.ctx)
  assert.ok(run.logs.some((line) => line.includes(detail)))
  const stopped = sessionRun()
  stopped.ctx.host.isRunning = () => false
  await stopped.session.onEvent({ type: 'check_unread' }, stopped.ctx)
  assert.deepEqual(stopped.clicks, [])
})
