const assert = require('node:assert/strict')
const { once } = require('node:events')
const { randomInt } = require('node:crypto')
const http = require('node:http')
const { test } = require('node:test')
const { loadSource } = require('./helpers.cjs')

const controller = {
  isRunning: () => false,
  start: async () => ({ ok: false, reason: 'no_vision_key' }),
  pause: async () => ({ ok: true })
}
async function reserve(port = 0) {
  const server = http.createServer()
  server.listen(port, '127.0.0.1')
  try {
    await once(server, 'listening')
    return server
  } catch (error) {
    server.close()
    throw error
  }
}
async function close(server) {
  await new Promise((resolve) => server.close(resolve))
}
async function adjacentPorts(t) {
  for (let attempt = 0; attempt < 10; attempt++) {
    // Keep reserved pairs outside Windows' ephemeral client-port range.
    const port = randomInt(20000, 40000)
    let primary
    try {
      primary = await reserve(port)
    } catch {
      continue
    }
    try {
      const fallback = await reserve(port + 1)
      t.after(() => close(primary))
      t.after(() => close(fallback))
      return { primary, fallback, port }
    } catch {
      await close(primary)
    }
  }
  throw new Error('Cannot reserve adjacent local test ports')
}

test('Skill HTTP API reports missing config and stays usable after controller errors', async (t) => {
  const service = loadSource('src/main/skill-server.ts')
  let fail = false
  const port = await service.startSkillServer(
    {
      ...controller,
      start: async () => {
        if (fail) throw new Error('test connection error')
        return { ok: false, reason: 'no_vision_key' }
      }
    },
    0
  )
  t.after(() => service.stopSkillServer())
  const url = 'http://127.0.0.1:' + port
  const missing = await fetch(url + '/skill/start', { method: 'POST' })
  assert.equal(missing.status, 400)
  assert.equal((await missing.json()).error, 'no_vision_key')
  fail = true
  const failed = await fetch(url + '/skill/start', { method: 'POST' })
  assert.equal(failed.status, 500)
  assert.equal((await failed.json()).error, 'engine_failed')
  const status = await fetch(url + '/skill/status')
  assert.deepEqual(await status.json(), { ok: true, status: 'stopped' })
})

test(
  'Skill server tries the fallback port once and reports the actual port',
  { timeout: 5000 },
  async (t) => {
    const { fallback, port } = await adjacentPorts(t)
    const service = loadSource('src/main/skill-server.ts')
    t.after(() => service.stopSkillServer())
    await close(fallback)
    assert.equal(await service.startSkillServer(controller, port), port + 1)
    const response = await fetch('http://127.0.0.1:' + (port + 1) + '/skill/status')
    assert.equal(response.status, 200)
    await response.json()
  }
)

test(
  'both occupied ports fail safely, and a later start can recover',
  { timeout: 5000 },
  async (t) => {
    const { primary, port } = await adjacentPorts(t)
    const service = loadSource('src/main/skill-server.ts')
    t.after(() => service.stopSkillServer())
    assert.equal(await service.startSkillServer(controller, port), null)
    await close(primary)
    assert.equal(await service.startSkillServer(controller, port), port)
  }
)
