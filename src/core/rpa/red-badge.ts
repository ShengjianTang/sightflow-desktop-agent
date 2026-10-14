/** Small, compact red components (unread badges), rather than total red area. */
export interface RedBadge {
  x: number
  y: number
  width: number
  height: number
  pixels: number
}

export function findRedBadges(
  bitmap: { width: number; height: number; data: Uint8Array },
  scaleFactor = 1
): RedBadge[] {
  const { width, height, data } = bitmap
  const mask = new Uint8Array(width * height)
  for (let i = 0; i < mask.length; i++) {
    const offset = i * 4
    const r = data[offset],
      g = data[offset + 1],
      b = data[offset + 2]
    mask[i] =
      data[offset + 3] > 128 && r >= 185 && g < 130 && b < 140 && r - g > 80 && r - b > 70 ? 1 : 0
  }
  const queue = new Int32Array(mask.length)
  const badges: RedBadge[] = []
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    let head = 0,
      tail = 1
    queue[0] = i
    mask[i] = 0
    let left = width,
      right = 0,
      top = height,
      bottom = 0
    while (head < tail) {
      const index = queue[head++]
      const x = index % width,
        y = Math.floor(index / width)
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
      const neighbors = [
        x > 0 ? index - 1 : -1,
        x + 1 < width ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y + 1 < height ? index + width : -1
      ]
      for (const next of neighbors) {
        if (next >= 0 && mask[next]) {
          mask[next] = 0
          queue[tail++] = next
        }
      }
    }
    const w = right - left + 1,
      h = bottom - top + 1
    const density = tail / (w * h)
    const logicalW = w / scaleFactor,
      logicalH = h / scaleFactor
    // Allow round dots and rounded number pills; reject red avatars/lines/noise.
    // A component on the ROI boundary is incomplete: caller includes a padding margin.
    if (
      left > 0 &&
      top > 0 &&
      right < width - 1 &&
      bottom < height - 1 &&
      tail >= 8 * scaleFactor * scaleFactor &&
      logicalW >= 3 &&
      logicalH >= 3 &&
      logicalW <= 65 &&
      logicalH <= 28 &&
      logicalW / logicalH >= 0.55 &&
      logicalW / logicalH <= 3.5 &&
      density >= 0.3 &&
      density < 0.95
    ) {
      badges.push({ x: left, y: top, width: w, height: h, pixels: tail })
    }
  }
  return badges.sort((a, b) => a.y - b.y)
}
