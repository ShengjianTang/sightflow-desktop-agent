/**
 * Skill HTTP Server — 为 OpenClaw 提供本地 HTTP 控制接口
 *
 * 仅监听 127.0.0.1，提供以下端点：
 * - POST /skill/start  — 启动智能体
 * - POST /skill/pause  — 暂停智能体
 * - GET  /skill/status — 查询当前运行状态
 *
 * 所有调用都会路由到 SkillEngineController 提供的回调里执行。
 * 回调本身复用主进程已有的引擎启动 / 停止 / 状态查询逻辑，避免逻辑重复。
 */
import * as http from 'http'

const DEFAULT_PRIMARY_PORT = 12680

function readPort(value: string | undefined, fallback: number): number {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : fallback
}

const PRIMARY_PORT = readPort(process.env.SIGHTFLOW_SKILL_PORT, DEFAULT_PRIMARY_PORT)

export type SkillStartReason =
  | 'no_vision_key'
  | 'no_provider'
  | 'missing_required_field'
  | 'engine_failed'
  | 'already_running'
  | 'operation_in_progress'
  | 'wizard_cancelled'

export type SkillPauseReason = 'not_running' | 'pause_failed'

export interface SkillStartResult {
  ok: boolean
  reason?: SkillStartReason
  message?: string
}

export interface SkillPauseResult {
  ok: boolean
  reason?: SkillPauseReason
  message?: string
}

export interface SkillEngineController {
  /** 启动引擎；返回业务级结果，不抛异常 */
  start(): Promise<SkillStartResult>
  /** 暂停引擎；返回业务级结果，不抛异常 */
  pause(): Promise<SkillPauseResult>
  /** 查询当前是否在运行 */
  isRunning(): boolean
}

let server: http.Server | null = null
let controller: SkillEngineController | null = null
let startPromise: Promise<number | null> | null = null

/** 并发锁：同一时间只能有一个 start/pause 操作 */
let skillOperationLock = false

function jsonResponse(
  res: http.ServerResponse,
  statusCode: number,
  body: Record<string, unknown>
): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  })
  res.end(JSON.stringify(body))
}

/** 读取 POST body（最大 1KB，防止滥用；当前所有端点都不需要 body） */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1024) {
        req.destroy()
        reject(new Error('body_too_large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

const START_STATUS_MAP: Record<SkillStartReason, number> = {
  already_running: 409,
  operation_in_progress: 409,
  no_vision_key: 400,
  no_provider: 400,
  missing_required_field: 400,
  engine_failed: 500,
  wizard_cancelled: 409
}

const PAUSE_STATUS_MAP: Record<SkillPauseReason, number> = {
  not_running: 409,
  pause_failed: 500
}

async function handleStart(res: http.ServerResponse): Promise<void> {
  if (!controller) {
    jsonResponse(res, 503, { ok: false, error: 'controller_unavailable' })
    return
  }

  if (skillOperationLock) {
    jsonResponse(res, 409, { ok: false, error: 'operation_in_progress' })
    return
  }

  if (controller.isRunning()) {
    jsonResponse(res, 409, { ok: false, error: 'already_running' })
    return
  }

  skillOperationLock = true
  try {
    const result = await controller.start()
    if (result.ok) {
      jsonResponse(res, 200, { ok: true })
    } else {
      const reason = result.reason || 'engine_failed'
      const status = START_STATUS_MAP[reason] ?? 500
      jsonResponse(res, status, {
        ok: false,
        error: reason,
        message: result.message
      })
    }
  } catch (error) {
    console.error('[Skill Server] start error:', error)
    jsonResponse(res, 500, { ok: false, error: 'engine_failed' })
  } finally {
    skillOperationLock = false
  }
}

async function handlePause(res: http.ServerResponse): Promise<void> {
  if (!controller) {
    jsonResponse(res, 503, { ok: false, error: 'controller_unavailable' })
    return
  }

  if (skillOperationLock) {
    jsonResponse(res, 409, { ok: false, error: 'operation_in_progress' })
    return
  }

  if (!controller.isRunning()) {
    jsonResponse(res, 409, { ok: false, error: 'not_running' })
    return
  }

  skillOperationLock = true
  try {
    const result = await controller.pause()
    if (result.ok) {
      jsonResponse(res, 200, { ok: true })
    } else {
      const reason = result.reason || 'pause_failed'
      const status = PAUSE_STATUS_MAP[reason] ?? 500
      jsonResponse(res, status, {
        ok: false,
        error: reason,
        message: result.message
      })
    }
  } catch (error) {
    console.error('[Skill Server] pause error:', error)
    jsonResponse(res, 500, { ok: false, error: 'pause_failed' })
  } finally {
    skillOperationLock = false
  }
}

function handleStatus(res: http.ServerResponse): void {
  if (!controller) {
    jsonResponse(res, 503, { ok: false, error: 'controller_unavailable' })
    return
  }
  jsonResponse(res, 200, {
    ok: true,
    status: controller.isRunning() ? 'running' : 'stopped'
  })
}

async function requestHandler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { method, url } = req

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    })
    res.end()
    return
  }

  try {
    if (url === '/skill/start' && method === 'POST') {
      await readBody(req)
      await handleStart(res)
    } else if (url === '/skill/pause' && method === 'POST') {
      await readBody(req)
      await handlePause(res)
    } else if (url === '/skill/status' && method === 'GET') {
      handleStatus(res)
    } else {
      jsonResponse(res, 404, { ok: false, error: 'not_found' })
    }
  } catch (error) {
    console.error('[Skill Server] 请求处理异常:', error)
    jsonResponse(res, 500, { ok: false, error: 'internal_error' })
  }
}

/** Returns the actual port, or null when neither port is available. */
export function startSkillServer(
  engineController: SkillEngineController,
  primaryPort = PRIMARY_PORT
): Promise<number | null> {
  if (startPromise) return startPromise
  controller = engineController
  const candidate = http.createServer((req, res) => {
    requestHandler(req, res).catch((error) => {
      console.error('[Skill Server] Unhandled error:', error)
      if (!res.headersSent && !res.destroyed) {
        jsonResponse(res, 500, { ok: false, error: 'internal_error' })
      }
    })
  })
  server = candidate
  let fallbackAttempted = false
  const fallbackPort = primaryPort < 65535 ? primaryPort + 1 : DEFAULT_PRIMARY_PORT

  startPromise = new Promise((resolve) => {
    candidate.once('listening', () => {
      const address = candidate.address()
      const port = address && typeof address !== 'string' ? address.port : primaryPort
      console.log(`[Skill Server] 已启动，监听 http://127.0.0.1:${port}`)
      resolve(port)
    })
    candidate.once('close', () => resolve(null))
    candidate.on('error', (error: NodeJS.ErrnoException) => {
      if (server !== candidate) {
        resolve(null)
        return
      }
      if (error.code === 'EADDRINUSE' && !fallbackAttempted) {
        fallbackAttempted = true
        console.warn(`[Skill Server] 端口 ${primaryPort} 被占用，尝试 ${fallbackPort}`)
        candidate.listen(fallbackPort, '127.0.0.1')
        return
      }
      console.error('[Skill Server] 启动失败:', error.message)
      server = null
      controller = null
      startPromise = null
      skillOperationLock = false
      candidate.close(() => {})
      resolve(null)
    })
    candidate.listen(primaryPort, '127.0.0.1')
  })
  return startPromise
}

export function stopSkillServer(): void {
  const closingServer = server
  server = null
  controller = null
  startPromise = null
  skillOperationLock = false
  closingServer?.close(() => {
    console.log('[Skill Server] 已关闭')
  })
}
