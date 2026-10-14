const assert = require('node:assert/strict')
const { test } = require('node:test')
const { PNG } = require('pngjs')
const { loadSource } = require('./helpers.cjs')

const bounds = { x: 100, y: 80, width: 1000, height: 700 }
const screen = { dipToScreenPoint: ({ x, y }) => ({ x: 1920 + (x - 1280) * 1.5, y: y * 1.5 }) }
function layoutApi(info = () => ({ bounds, scaleFactor: 1.5 })) {
  return loadSource('src/core/rpa/vision-utils.ts', {
    './window-utils': { getWindowInfo: async () => info(), getWindowInfoSync: info },
    './screenshot-utils': {
      captureWechatWindow: async () => ({
        success: true,
        bounds: info().bounds,
        screenshotBase64: 'frame'
      })
    }
  })
}
function cache(overrides = {}) {
  return {
    appType: 'wechat',
    timestamp: 1,
    chatEntranceArea: null,
    firstContact: null,
    searchInputBox: null,
    headerArea: null,
    chatMainArea: { bbox: [320, 100, 980, 650], coordinates: [0, 0] },
    messageInputArea: null,
    ...overrides
  }
}

test('bbox/point stay in DIP at 100/125/150% and reject invalid model rectangles', () => {
  const api = layoutApi()
  for (const scale of [1, 1.25, 1.5]) {
    assert.deepEqual(api.bboxToScreenCoords([300, 600, 900, 900], bounds, scale), [700, 605])
    assert.deepEqual(api.pointToScreenCoords([600, 750], bounds, scale), [700, 605])
  }
  assert.equal(api.parseBBoxes('<bbox>0,0,1001,20</bbox>').length, 0)
  assert.equal(api.parseBBoxes('<bbox>20,20,10,40</bbox>').length, 0)
})

test('cached VLM input coordinates follow window moves; manual rectangles remain explicit', () => {
  let current = { bounds: { ...bounds }, scaleFactor: 1.5 }
  const api = layoutApi(() => current)
  api.setLayoutCache(
    'wechat',
    cache({ messageInputArea: { bbox: [400, 750, 900, 920], coordinates: [0, 0] } })
  )
  const before = api.getInputAreaFromCache('wechat').coordinates
  current = { ...current, bounds: { ...bounds, x: 350 } }
  const after = api.getInputAreaFromCache('wechat').coordinates
  assert.equal(after[0] - before[0], 250)
  assert.equal(after[1], before[1])
  const manual = { rect: bounds, coordinates: [400, 600], source: 'box-select' }
  api.setLayoutCache('wechat', cache({ messageInputArea: manual }))
  assert.equal(api.getInputAreaFromCache('wechat'), manual)
})

test('layout inference captures the actual input box and replaces stale cached inputs', async () => {
  const api = layoutApi()
  api.setLayoutCache(
    'wechat',
    cache({ messageInputArea: { bbox: [0, 0, 20, 30], coordinates: [1, 1] } })
  )
  const boxes = '<bbox>70,20,300,80</bbox><bbox>320,20,980,90</bbox><bbox>320,100,980,650</bbox>'
  const result = await api.detectWechatLayout(
    { detectVision: async () => boxes + '<bbox>340,730,950,920</bbox>' },
    'wechat'
  )
  assert.equal(result.success, true)
  assert.equal(api.getInputAreaFromCache('wechat').source, 'vlm')
  assert.deepEqual(api.getInputAreaFromCache('wechat').coordinates, [745, 658])
  await api.detectWechatLayout({ detectVision: async () => boxes }, 'wechat')
  assert.ok(api.getInputAreaFromCache('wechat').coordinates[1] > 500)
  assert.equal(api.getInputAreaFromCache('wechat').source, undefined)
})

test('bubble-cropped history does not force a second vision call for a verified editor', async () => {
  const api = layoutApi(() => ({ bounds: { x: 0, y: 0, width: 880, height: 530 }, scaleFactor: 1 }))
  let calls = 0
  const boxes =
    '<bbox>87,80,283,134</bbox><bbox>342,76,647,154</bbox>' +
    '<bbox>343,171,660,708</bbox><bbox>350,720,840,849</bbox>'
  const result = await api.detectWechatLayout(
    { detectVision: async () => (calls++, boxes) },
    'wechat'
  )
  assert.equal(result.success, true)
  assert.equal(calls, 1)
  assert.deepEqual(api.getInputAreaFromCache('wechat').bbox, [350, 720, 840, 849])
  assert.deepEqual(api.getLayoutCache('wechat').chatMainArea.bbox, [343, 171, 840, 708])
})

test('unrelated editor remains blocked when it does not overlap the chat panel', async () => {
  const api = layoutApi()
  const boxes =
    '<bbox>70,20,300,80</bbox><bbox>320,20,660,90</bbox>' +
    '<bbox>320,100,660,650</bbox><bbox>700,730,950,920</bbox>'
  let calls = 0
  const result = await api.detectWechatLayout(
    { detectVision: async () => (calls++, calls === 1 ? boxes : '[NO_CHAT_INPUT]') },
    'wechat'
  )
  assert.equal(result.success, false)
  assert.equal(result.recoverable, true)
  assert.equal(calls, 2)
  assert.equal(api.getLayoutCache('wechat'), null)
})

test('overlapping chat/editor boxes trim history instead of aborting startup', async () => {
  const api = layoutApi()
  let calls = 0
  const result = await api.detectWechatLayout(
    {
      detectVision: async () => {
        calls++
        return '<bbox>70,20,300,80</bbox><bbox>320,20,980,90</bbox><bbox>320,100,980,850</bbox><bbox>340,730,950,920</bbox>'
      }
    },
    'wechat'
  )
  assert.equal(result.success, true)
  assert.equal(calls, 1)
  assert.equal(api.getLayoutCache('wechat').chatMainArea.bbox[3], 718)
  assert.equal(api.getInputAreaFromCache('wechat').source, 'vlm')
})

test('tiny input boxes get one targeted review; web pages have a recoverable no-input result', async () => {
  const api = layoutApi()
  const responses = [
    '<bbox>70,20,300,80</bbox><bbox>320,20,980,90</bbox><bbox>320,100,980,850</bbox><bbox>340,900,950,905</bbox>',
    '<bbox>340,750,950,920</bbox>'
  ]
  let calls = 0
  const repaired = await api.detectWechatLayout(
    {
      detectVision: async () => {
        calls++
        return responses.shift()
      }
    },
    'wechat'
  )
  assert.equal(repaired.success, true)
  assert.equal(calls, 2)
  const page = await api.detectWechatLayout(
    { detectVision: async () => '[NO_CHAT_INPUT]' },
    'wechat'
  )
  assert.equal(page.success, false)
  assert.equal(page.recoverable, true)
  assert.equal(api.getLayoutCache('wechat'), null)
})

test('mouse conversion happens exactly once for manual and VLM input on a mixed-DPI display', async () => {
  let endpoint
  const input = loadSource('src/core/rpa/input-utils.ts', {
    electron: {
      screen,
      clipboard: {
        writeText() {
          return undefined
        }
      }
    },
    './window-utils': {},
    './vision-utils': {},
    './screenshot-utils': {
      clearScreenshotCache() {
        return undefined
      }
    },
    './util': {
      delay: async () => {},
      randomDelayIn: async () => {},
      getRobot: () => ({
        getMousePos: () => ({ x: 1920, y: 0 }),
        moveMouse: (x, y) => {
          endpoint = [x, y]
        },
        mouseClick() {
          return undefined
        },
        keyTap() {
          return undefined
        }
      })
    }
  })
  assert.equal(await input.sendReplyByCoordsAction(1600, 600, 'test'), true)
  assert.deepEqual(endpoint, process.platform === 'win32' ? [2400, 900] : [1600, 600])
})

test('invalid input cache and lost focus stop text sends before clipboard and Enter', async () => {
  const actions = []
  let coords = [9000, 9000]
  let active = 37
  const target = {
    id: 37,
    bringToTop() {
      return undefined
    }
  }
  const api = loadSource('src/core/rpa/input-utils.ts', {
    electron: {
      screen: { dipToScreenPoint: (point) => point },
      clipboard: { writeText: () => actions.push('paste') }
    },
    './screenshot-utils': {
      clearScreenshotCache() {
        return undefined
      }
    },
    './window-utils': {
      getWindowInfo: async () => ({ bounds, scaleFactor: 1, wechatWindow: target })
    },
    './vision-utils': { getInputAreaFromCache: () => ({ coordinates: coords }) },
    'node-window-manager': { windowManager: { getActiveWindow: () => ({ id: active }) } },
    './util': {
      delay: async () => {},
      randomDelayIn: async () => {},
      getRobot: () => ({
        getMousePos: () => ({ x: 0, y: 0 }),
        moveMouse: () => {
          active = 99
        },
        mouseClick: () => actions.push('click'),
        keyTap: (key) => actions.push(key)
      })
    }
  })
  await assert.rejects(api.sendReplyAction('wechat', 'test'), /坐标不可用/)
  assert.deepEqual(actions, [])
  if (process.platform === 'win32') {
    coords = [700, 670]
    await assert.rejects(api.sendReplyAction('wechat', 'test'), /失去焦点/)
    assert.deepEqual(actions, [])
  }
})

function bitmap(width, height, paint) {
  const image = new PNG({ width, height })
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const red = paint(x, y)
      image.data[i] = red ? 250 : 255
      image.data[i + 1] = red ? 50 : 255
      image.data[i + 2] = red ? 60 : 255
      image.data[i + 3] = 255
    }
  return image
}

test('small unread circles survive large crop denominators; solid red avatars and noise do not', () => {
  const { findRedBadges } = require('../src/core/rpa/red-badge.ts')
  for (const scale of [1, 1.25, 1.5, 2]) {
    const image = bitmap(
      Math.round(60 * scale),
      Math.round(500 * scale),
      (x, y) => (x - 35 * scale) ** 2 + (y - 120 * scale) ** 2 < (5 * scale) ** 2
    )
    assert.equal(findRedBadges(image, scale).length, 1)
  }
  assert.equal(
    findRedBadges(bitmap(60, 500, (x, y) => x >= 10 && x < 50 && y >= 50 && y < 90)).length,
    0
  )
  assert.equal(findRedBadges(bitmap(60, 500, (x, y) => x === 30 && y === 50)).length, 0)
})

test('unread scan finds the row below pinned contacts without calling the model again', async () => {
  const areas = {
    chatEntranceArea: { bbox: [0, 70, 60, 140], coordinates: [30, 74] },
    firstContact: { bbox: [80, 143, 120, 206], coordinates: [100, 122] }
  }
  const api = loadSource('src/core/rpa/has-unread.ts', {
    './window-utils': {
      getWindowInfo: async () => ({ bounds: { x: 0, y: 0, width: 1000, height: 700 } })
    },
    './vision-utils': {
      getUnreadArea: async () => areas,
      bboxToCropBounds: (bbox, rect) => ({
        x: (bbox[0] / 1000) * rect.width,
        y: (bbox[1] / 1000) * rect.height,
        width: ((bbox[2] - bbox[0]) / 1000) * rect.width,
        height: ((bbox[3] - bbox[1]) / 1000) * rect.height
      })
    },
    './screenshot-utils': {
      captureWechatWindow: async (_, crop) => {
        const image = bitmap(
          Math.ceil(crop.width),
          Math.ceil(crop.height),
          (x, y) => (x + crop.x - 120) ** 2 + (y + crop.y - 210) ** 2 < 36
        )
        return {
          success: true,
          bounds: crop,
          display: { scaleFactor: 1 },
          screenshotBase64: 'data:image/png;base64,' + PNG.sync.write(image).toString('base64')
        }
      }
    }
  })
  const result = await api.hasUnreadMessage({}, 'wechat')
  assert.equal(result.success, true)
  assert.equal(result.hasUnread, true)
  assert.ok(Math.abs(result.unreadContactCoords[0] - 100) <= 1)
  assert.ok(result.unreadContactCoords[1] >= 210 && result.unreadContactCoords[1] <= 218)
})

test('chat diff and unread ROI share one desktop frame, invalidated after UI actions', async () => {
  let captures = 0
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.5 }
  const fakeImage = (width, height) => ({
    getSize: () => ({ width, height }),
    toDataURL: () => 'frame',
    crop: (rect) => fakeImage(rect.width, rect.height)
  })
  const api = loadSource('src/core/rpa/screenshot-utils.ts', {
    electron: {
      screen: {},
      desktopCapturer: {
        getSources: async () => {
          captures++
          return [{ display_id: '1', thumbnail: fakeImage(2880, 1620) }]
        }
      }
    },
    './window-utils': { getWechatWindowInfo: async () => ({ display, bounds }) }
  })
  const result = await api.captureWechatWindow('wechat', { x: 300, y: 20, width: 400, height: 200 })
  assert.equal(result.nativeImage.getSize().width, 600)
  await api.captureWechatWindow('wechat', { x: 20, y: 40, width: 30, height: 30 })
  assert.equal(captures, 1)
  api.clearScreenshotCache()
  await api.captureWechatWindow('wechat')
  assert.equal(captures, 2)
})

test(
  'native Windows bounds normalize once; moves rebase clicks and resizes invalidate layout',
  {
    skip: process.platform !== 'win32'
  },
  async () => {
    let nativeBounds = { x: 2250, y: 150, width: 900, height: 600 }
    let layout = cache()
    let layoutClears = 0,
      baselineClears = 0
    const target = { id: 37, getTitle: () => '微信', getBounds: () => nativeBounds }
    const api = loadSource('src/core/rpa/window-utils.ts', {
      electron: {
        screen: {
          screenToDipRect: (_, rect) => ({
            x: rect.x / 1.5,
            y: rect.y / 1.5,
            width: rect.width / 1.5,
            height: rect.height / 1.5
          }),
          getDisplayMatching: () => ({
            id: 2,
            scaleFactor: 1.5,
            bounds: { x: 1280, y: 0, width: 1280, height: 720 }
          })
        }
      },
      'node-window-manager': { windowManager: { getActiveWindow: () => target } },
      'active-win': {},
      './screenshot-utils': {
        clearScreenshotCache() {
          return undefined
        }
      },
      './image-compare': {
        clearChatBaseline: () => {
          baselineClears++
        }
      },
      './vision-utils': {
        getLayoutCache: () => layout,
        setLayoutCache: (_, value) => {
          layout = value
        },
        clearLayoutCache: () => {
          layoutClears++
          layout = null
        },
        bboxToScreenCoords: (_, rect) => [rect.x + 200, rect.y + 200]
      }
    })
    const first = await api.getWechatWindowInfo('wechat', true)
    assert.deepEqual(first.bounds, { x: 1500, y: 100, width: 600, height: 400 })
    nativeBounds = { ...nativeBounds, x: 2400 }
    await api.getWechatWindowInfo('wechat', true)
    assert.deepEqual(layout.chatMainArea.coordinates, [1800, 300])
    assert.equal(layoutClears, 0)
    nativeBounds = { ...nativeBounds, width: 975 }
    await api.getWechatWindowInfo('wechat', true)
    assert.equal(layoutClears, 1)
    assert.equal(baselineClears, 1)
  }
)

test('manual image sends can remeasure a cleared input layout without running the engine', async () => {
  let measured = false
  const actions = []
  const api = loadSource('src/core/rpa/input-utils.ts', {
    electron: {
      screen: { dipToScreenPoint: (point) => point },
      clipboard: { writeImage: () => actions.push('paste') }
    },
    './window-utils': {
      getWindowInfo: async () => ({
        bounds,
        wechatWindow: {
          id: 37,
          bringToTop() {
            return undefined
          }
        }
      })
    },
    './vision-utils': {
      getInputAreaFromCache: () => (measured ? { coordinates: [700, 650] } : null)
    },
    './screenshot-utils': {
      clearScreenshotCache() {
        return undefined
      }
    },
    'node-window-manager': { windowManager: { getActiveWindow: () => ({ id: 37 }) } },
    './util': {
      delay: async () => {},
      getRobot: () => ({
        getMousePos: () => ({ x: 0, y: 0 }),
        moveMouse() {
          return undefined
        },
        mouseClick() {
          return undefined
        },
        keyTap: (key) => actions.push(key)
      })
    }
  })
  await api.sendImageAction('wechat', {}, async () => {
    measured = true
  })
  assert.equal(measured, true)
  assert.deepEqual(actions, ['paste', 'v', 'enter'])
})
