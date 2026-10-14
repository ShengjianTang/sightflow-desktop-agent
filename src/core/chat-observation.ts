import { PNG } from 'pngjs'
import type { BBox } from './rpa/vision-utils'
import type { ChatObservation } from './session-types'
import { DesktopStateError } from './desktop-errors'

/** A conservative extra signal for the standard green, right-aligned WeChat bubble.
 * Absence is not evidence that a message is incoming (other themes/apps still use the transcript).
 */
export function outgoingBubbleBottom(screenshot: string, chat?: BBox): number | undefined {
  if (!chat) return undefined
  try {
    const png = PNG.sync.read(
      Buffer.from(screenshot.replace(/^data:image\/png;base64,/, ''), 'base64')
    )
    const left = Math.floor((chat[0] * png.width) / 1000)
    const right = Math.ceil((chat[2] * png.width) / 1000)
    const width = right - left
    const top = Math.max(0, Math.floor((chat[1] * png.height) / 1000))
    const bottom = Math.min(png.height, Math.ceil((chat[3] * png.height) / 1000))
    const startX = Math.max(0, Math.floor(left + width * 0.65))
    const endX = Math.min(png.width, Math.ceil(left + width * 0.92))
    let rows = 0,
      lastBottom: number | undefined
    for (let y = top; y < bottom; y++) {
      let run = 0,
        matched = false
      for (let x = startX; x < endX; x++) {
        const i = (y * png.width + x) * 4
        const r = png.data[i],
          g = png.data[i + 1],
          b = png.data[i + 2]
        const green = g >= 120 && g - r >= 28 && g - b >= 20 && Math.abs(r - b) < 100
        run = green ? run + 1 : 0
        if (run >= Math.max(16, width * 0.04) && x >= left + width * 0.85) matched = true
      }
      rows = matched ? rows + 1 : 0
      if (rows >= Math.max(6, png.height * 0.008)) lastBottom = ((y + 1) * 1000) / png.height
    }
    return lastBottom
  } catch {
    return undefined
  }
}

interface ObservationSource {
  screenshot(): Promise<string>
  getObservationContext?(): ChatObservation | undefined
}

/** Gather a short burst locally, without extra model calls or changing the processed baseline. */
export async function captureStableChat(
  source: ObservationSource,
  isRunning: () => boolean,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<string> {
  let screenshot = await source.screenshot()
  let previous = source.getObservationContext?.()
  // 800 ms quiet time, at most 2.4 s of sampling even with animations or a continuous burst.
  for (let sample = 0; sample < 3 && previous; sample++) {
    if (!isRunning()) throw new DesktopStateError('target_unavailable', '引擎已停止，取消消息观察')
    await pause(800)
    if (!isRunning()) throw new DesktopStateError('target_unavailable', '引擎已停止，取消消息观察')
    screenshot = await source.screenshot()
    const current = source.getObservationContext?.()
    if (
      !current ||
      (previous.conversationId === current.conversationId &&
        previous.historyId === current.historyId)
    )
      break
    previous = current
  }
  return screenshot
}
