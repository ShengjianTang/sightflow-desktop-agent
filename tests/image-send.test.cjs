const assert = require('node:assert/strict')
const { test } = require('node:test')
const { loadSource } = require('./helpers.cjs')

function imageSender(activeWindow, actions) {
  const target = { id: 37, bringToTop: () => actions.push('focus') }
  const robot = {
    getMousePos: () => ({ x: 100, y: 100 }),
    moveMouse: () => undefined,
    mouseClick: () => actions.push('click'),
    keyTap: (key) => actions.push(key)
  }
  const { sendImageAction } = loadSource('src/core/rpa/input-utils.ts', {
    electron: {
      clipboard: { writeImage: () => actions.push('clipboard') },
      screen: { dipToScreenPoint: (point) => point }
    },
    './screenshot-utils': { clearScreenshotCache: () => {} },
    './window-utils': {
      getWindowInfo: async () => ({
        bounds: { x: 0, y: 0, width: 1000, height: 700 },
        scaleFactor: 1,
        wechatWindow: target
      })
    },
    './vision-utils': { getInputAreaFromCache: () => ({ coordinates: [400, 600] }) },
    './util': { getRobot: () => robot, delay: async () => undefined },
    'node-window-manager': { windowManager: { getActiveWindow: activeWindow } }
  })
  return sendImageAction
}

test('image send requires the target window to retain focus through paste and enter', async () => {
  const actions = []
  let focused = { id: 99 }
  const send = imageSender(() => focused, actions)
  await assert.rejects(send('wechat', {}), /未获得焦点/)
  assert.deepEqual(actions, ['focus'])

  focused = { id: 37 }
  await send('wechat', {})
  assert.deepEqual(actions.slice(-4), ['click', 'clipboard', 'v', 'enter'])
})

test('lost focus after paste never presses Enter and reports possible partial send', async () => {
  const actions = []
  const send = imageSender(() => ({ id: actions.includes('v') ? 99 : 37 }), actions)
  await assert.rejects(send('wework', {}), /可能已粘贴但未发送/)
  assert.ok(actions.includes('v'))
  assert.ok(!actions.includes('enter'))
})
