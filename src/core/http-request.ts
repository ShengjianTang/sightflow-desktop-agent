/** Keep the timeout active until the response body has been consumed. */
export async function fetchWithTimeout<T>(
  url: string | URL,
  init: RequestInit,
  readBody: (response: Response) => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  const controller = new AbortController()
  const externalSignal = init.signal
  const abortExternal = () => controller.abort(externalSignal?.reason)
  if (externalSignal?.aborted) abortExternal()
  else externalSignal?.addEventListener('abort', abortExternal, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (!response.ok) {
      await response.body?.cancel()
      // Do not expose response bodies: upstream services can echo credentials.
      throw new Error(`HTTP ${response.status}`)
    }
    return await readBody(response)
  } catch (error) {
    if (externalSignal?.aborted) throw new DOMException('请求已取消', 'AbortError')
    if (timedOut) throw new Error(timeoutMessage)
    throw error
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', abortExternal)
  }
}

/** Ark returns 404 for unavailable model IDs/endpoints as well as missing routes. */
export function formatArkHttpError(status: number): string {
  if (status === 401) return 'HTTP 401：API Key 无效或未正确传递，请检查火山方舟密钥'
  if (status === 403) return 'HTTP 403：无权访问该模型或推理接入点，请检查开通状态与权限'
  if (status === 404)
    return 'HTTP 404：模型或推理接入点不存在、未开通或无访问权限；请检查模型/接入点 ID 和服务地址'
  return `HTTP ${status}`
}
