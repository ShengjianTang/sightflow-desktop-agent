const assert = require('node:assert/strict')
const { test } = require('node:test')
const { PNG } = require('pngjs')
const { loadSource } = require('./helpers.cjs')
function image(width, height, data) {
  const png = new PNG({ width, height })
  if (data) png.data = Buffer.from(data)
  else
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = png.data[i + 1] = png.data[i + 2] = 30
      png.data[i + 3] = 255
    }
  return {
    png,
    getSize: () => ({ width, height }),
    toPNG: () => PNG.sync.write(png),
    toDataURL: () => 'data:image/png;base64,' + PNG.sync.write(png).toString('base64'),
    crop: ({ x, y, width: w, height: h }) => {
      const out = Buffer.alloc(w * h * 4)
      for (let row = 0; row < h; row++)
        png.data.copy(
          out,
          row * w * 4,
          ((y + row) * width + x) * 4,
          ((y + row) * width + x + w) * 4
        )
      return image(w, h, out)
    }
  }
}
function mark(img, x, y, w = 20, h = 20) {
  for (let row = y; row < y + h; row++)
    for (let col = x; col < x + w; col++) {
      const p = (row * img.png.width + col) * 4
      img.png.data[p] = 220
      img.png.data[p + 1] = 40
    }
}
function harness(scale = 1) {
  let current = image(1000 * scale, 700 * scale),
    committed,
    sends = 0
  const layout = {
    headerArea: { bbox: [250, 0, 1000, 90] },
    chatMainArea: { bbox: [250, 100, 990, 780] },
    messageInputArea: { bbox: [260, 820, 940, 960] }
  }
  const deviceApi = loadSource('src/core/rpa-device.ts', {
    './chat-observation': { outgoingBubbleBottom: () => undefined },
    './ai-client': {},
    './rpa/screenshot-utils': {
      clearScreenshotCache() {
        return undefined
      },
      captureWechatWindow: async () => ({
        success: true,
        nativeImage: current,
        screenshotBase64: current.toDataURL(),
        bounds: { x: 0, y: 0, width: 1000, height: 700 },
        display: { scaleFactor: scale }
      })
    },
    './rpa/window-utils': {
      getWechatWindowInfo: async () => ({ foreground: true }),
      getWindowInfoSync: () => ({
        bounds: { x: 0, y: 0, width: 1000, height: 700 },
        scaleFactor: scale
      })
    },
    './rpa/has-unread': {},
    './rpa/input-utils': {
      sendReplyAction: async () => {
        sends++
        return true
      }
    },
    './rpa/vision-utils': { getLayoutCache: () => layout },
    './rpa/image-compare': {
      setChatBaselineImage: (img) => {
        committed = img
      },
      clearChatBaseline() {
        return undefined
      },
      comparePngBuffers: (a, b) => ({ hasChanged: !a.equals(b) })
    }
  })
  const device = new deviceApi.RPADevice()
  device.setReplyPanelCapture(true)
  return {
    device,
    get current() {
      return current
    },
    set current(v) {
      current = v
    },
    get committed() {
      return committed
    },
    get sends() {
      return sends
    }
  }
}
test('conversation panel crop maps correctly at 100/125/150 percent DPI while baseline stays native', async () => {
  for (const scale of [1, 1.25, 1.5]) {
    const h = harness(scale),
      url = await h.device.screenshot(),
      png = PNG.sync.read(Buffer.from(url.split(',')[1], 'base64'))
    assert.equal(png.width, Math.round(1000 * scale) - Math.floor(250 * scale))
    assert.equal(png.height, 700 * scale)
    assert.deepEqual(h.device.getObservationContext().panelBbox, [
      (Math.floor(250 * scale) / (1000 * scale)) * 1000,
      0,
      1000,
      1000
    ])
    assert.equal(h.device.getCaptureContext(), 'conversation_panel')
    assert.equal(h.device.commitObservationBaseline(), true)
    assert.ok(h.committed.getSize().width > 0)
    assert.ok(h.device.getObservationContext().editorId)
  }
})
test('history additions allow review, header changes and editor typing block before send', async () => {
  for (const kind of ['history', 'header', 'draft']) {
    const h = harness()
    await h.device.screenshot()
    mark(
      h.current,
      kind === 'header' ? 350 : 400,
      kind === 'header' ? 20 : kind === 'draft' ? 600 : 200
    )
    if (kind === 'history') assert.equal((await h.device.inspectPendingReply()).changed, true)
    else await assert.rejects(h.device.inspectPendingReply(), /会话|输入框/)
    assert.equal(h.sends, 0)
  }
})
test('blinking caret is tolerated but typing during remote review is rechecked before send', async () => {
  const h = harness()
  await h.device.screenshot()
  mark(h.current, 300, 600, 2, 18)
  assert.equal((await h.device.inspectPendingReply()).changed, false)
  mark(h.current, 350, 610, 22, 16)
  await assert.rejects(h.device.sendMessage('never paste'), /草稿/)
  assert.equal(h.sends, 0)
})
test('stop during pre-paste delay never reaches clipboard or Enter', async () => {
  const controller = new AbortController(),
    actions = []
  const input = loadSource('src/core/rpa/input-utils.ts', {
    electron: {
      screen: { dipToScreenPoint: (p) => p },
      clipboard: { writeText: () => actions.push('clipboard') }
    },
    './window-utils': {},
    './vision-utils': {},
    './screenshot-utils': {
      clearScreenshotCache() {
        return undefined
      }
    },
    './util': {
      delay: async () => undefined,
      randomDelayIn: async () => controller.abort(),
      getRobot: () => ({
        getMousePos: () => ({ x: 100, y: 200 }),
        moveMouse() {
          return undefined
        },
        mouseClick: () => actions.push('click'),
        keyTap: () => actions.push('key')
      })
    }
  })
  await assert.rejects(
    input.sendReplyByCoordsAction(100, 200, 'test', undefined, controller.signal),
    /引擎已停止/
  )
  assert.deepEqual(actions, [])
})
