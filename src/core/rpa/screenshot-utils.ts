import { intToRGBA, Jimp } from 'jimp'
import { desktopCapturer, screen } from 'electron'
import { getWindowInfo, getWechatWindowInfo } from './window-utils'
import { AppType, ScreenRect } from './types'

const IS_MAC = process.platform === 'darwin'

interface ScreenshotCache {
  screenshotBase64: string
  nativeImage: Electron.NativeImage
  bounds: { x: number; y: number; width: number; height: number }
  display: {
    id: number
    bounds: { x: number; y: number; width: number; height: number }
    scaleFactor: number
  }
  timestamp: number
}

const screenshotCache = new Map<string, ScreenshotCache>()
const screenshotPendingPromises = new Map<string, Promise<ScreenshotCache | null>>()
// RPADevice clears at the start of every poll and after actions. This short
// window is enough for local PNG diff + badge scans to share one desktop frame.
const SCREENSHOT_CACHE_DURATION = 500
let captureEpoch = 0

function getCropHash(crop?: { x: number; y: number; width: number; height: number }): string {
  if (!crop) return 'no-crop'
  return `${crop.x}-${crop.y}-${crop.width}-${crop.height}`
}

function getScreenshotCacheKey(
  displayId: number,
  crop?: { x: number; y: number; width: number; height: number }
): string {
  return `${displayId}-${getCropHash(crop)}`
}

export function clearScreenshotCache(): void {
  captureEpoch++
  screenshotCache.clear()
}

export function getChatContactAvatarBounds(): {
  x: number
  y: number
  width: number
  height: number
} {
  if (IS_MAC) {
    return { x: 72, y: 64, width: 46, height: 68 }
  }
  return { x: 70, y: 64, width: 46, height: 68 }
}

export const takeWeChatScreenshot = async ({ wechatType = 'wechat' }: { wechatType: AppType }) => {
  try {
    const windowInfo = await getWindowInfo(wechatType, true)
    if (!windowInfo) return { success: false, error: '未找到应用窗口' }
    return {
      success: true,
      screenshot: windowInfo.screenshot,
      bounds: windowInfo.bounds,
      scaleFactor: windowInfo.scaleFactor
    }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

export async function calculateRedDotPercentage(
  base64Image: string,
  onlyFirstQuadrant: boolean = false
): Promise<number | null> {
  try {
    const image = await Jimp.read(
      Buffer.from(base64Image.replace(/^data:image\/\w+;base64,/, ''), 'base64')
    )
    const { width, height } = image.bitmap
    const totalPixels = width * height
    if (totalPixels === 0) return null

    const centerX = width / 2
    const centerY = height / 2
    let redPixelCount = 0

    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if (onlyFirstQuadrant && (x <= centerX || y >= centerY)) continue
        const rgba = intToRGBA(image.getPixelColor(x, y))
        const { r, g, b, a } = rgba
        if (a > 128 && r > 150 && r > g * 1.5 && r > b * 1.5) redPixelCount++
      }
    }
    return (redPixelCount / totalPixels) * 100
  } catch {
    return null
  }
}

export async function captureWechatWindow(
  appType: AppType = 'wechat',
  crop?: { x: number; y: number; width: number; height: number }
): Promise<any> {
  try {
    const windowCoreResult = await getWechatWindowInfo(appType)
    if (!windowCoreResult) return { success: false, error: '未找到窗口' }

    const {
      display,
      bounds,
      display: { scaleFactor }
    } = windowCoreResult
    const epoch = captureEpoch
    const cacheKey = `${epoch}-${appType}-${scaleFactor}-${getCropHash(bounds)}-${getScreenshotCacheKey(display.id, crop)}`

    // One full frame per poll; chat diff and unread scans crop that same frame.
    // Capturing the desktop separately for every tiny ROI was the expensive part.
    if (crop) {
      const full = await captureWechatWindow(appType)
      if (!full.success || !full.nativeImage) return full
      const x = Math.max(0, Math.floor(crop.x * scaleFactor))
      const y = Math.max(0, Math.floor(crop.y * scaleFactor))
      const size = full.nativeImage.getSize()
      const width = Math.min(size.width, Math.ceil((crop.x + crop.width) * scaleFactor)) - x
      const height = Math.min(size.height, Math.ceil((crop.y + crop.height) * scaleFactor)) - y
      if (width <= 0 || height <= 0) return { success: false, error: '截图区域超出窗口范围' }
      const nativeImage = full.nativeImage.crop({ x, y, width, height })
      return {
        ...full,
        nativeImage,
        screenshotBase64: nativeImage.toDataURL(),
        bounds: {
          x: bounds.x + x / scaleFactor,
          y: bounds.y + y / scaleFactor,
          width: width / scaleFactor,
          height: height / scaleFactor
        }
      }
    }

    const cached = screenshotCache.get(cacheKey)
    const now = Date.now()
    if (cached && now - cached.timestamp < SCREENSHOT_CACHE_DURATION) {
      const resultBounds = bounds
      console.log('[captureWechatWindow] 命中缓存:', {
        appType,
        cacheKey,
        ageMs: now - cached.timestamp,
        hasNativeImage: Boolean(cached.nativeImage),
        crop: crop || null
      })
      return {
        success: true,
        screenshotBase64: cached.screenshotBase64,
        nativeImage: cached.nativeImage,
        bounds: resultBounds,
        display: cached.display,
        timestamp: Date.now()
      }
    }

    const pending = screenshotPendingPromises.get(cacheKey)
    if (pending) {
      const result = await pending
      return result ? { success: true, ...result } : { success: false, error: '截图失败' }
    }
    // Bound obsolete geometry entries during continuous window dragging.
    if (screenshotCache.size > 20) screenshotCache.clear()
    const capturePromise = (async (): Promise<ScreenshotCache | null> => {
      try {
        const physicalWidth = Math.round(display.bounds.width * scaleFactor)
        const physicalHeight = Math.round(display.bounds.height * scaleFactor)

        // Add a timeout to desktopCapturer.getSources to prevent deadlocks
        let timeout: ReturnType<typeof setTimeout> | undefined
        const timeoutPromise = new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('desktopCapturer timeout')), 5000)
        })

        const screenSources = (await Promise.race([
          desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: physicalWidth, height: physicalHeight }
          }),
          timeoutPromise
        ]).finally(() => clearTimeout(timeout))) as Electron.DesktopCapturerSource[]

        const matchedScreenSource = screenSources.find(
          (s) => String(s.display_id) === String(display.id)
        )
        if (!matchedScreenSource) return null

        const cropRect = {
          x: Math.round((bounds.x - display.bounds.x) * scaleFactor),
          y: Math.round((bounds.y - display.bounds.y) * scaleFactor),
          width: Math.round(bounds.width * scaleFactor),
          height: Math.round(bounds.height * scaleFactor)
        }

        const croppedNativeImage = matchedScreenSource.thumbnail.crop(cropRect)
        const croppedScreenshot = croppedNativeImage.toDataURL()

        const resultBounds = bounds
        const cacheResult: ScreenshotCache = {
          screenshotBase64: croppedScreenshot,
          nativeImage: croppedNativeImage,
          bounds: resultBounds,
          display,
          timestamp: Date.now()
        }
        if (captureEpoch === epoch) screenshotCache.set(cacheKey, cacheResult)
        return cacheResult
      } catch (error) {
        console.error('Screenshot capture error:', error)
        return null
      } finally {
        screenshotPendingPromises.delete(cacheKey)
      }
    })()

    screenshotPendingPromises.set(cacheKey, capturePromise)
    const captureResult = await capturePromise

    if (!captureResult) return { success: false, error: '截图失败', display }

    return {
      success: true,
      screenshotBase64: captureResult.screenshotBase64,
      nativeImage: captureResult.nativeImage,
      bounds: captureResult.bounds,
      display: captureResult.display
    }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

/**
 * 按绝对屏幕坐标矩形截图（box-select 路线用）。
 *
 * `rect` 是逻辑像素的绝对屏幕坐标（来自用户框选向导）。函数会查到该坐标所在
 * 显示器，按 scaleFactor 转成物理像素裁剪，返回 base64 dataURL + NativeImage。
 *
 * 没有像 captureWechatWindow 那样的缓存：BoxSelectDevice 自己控制采集节奏，
 * 一次轮询里 hasUnreadMessage / hasChatAreaChanged 都是各自截图各自比较，
 * 多余缓存反而引入"diff 不刷新"的微妙 bug。
 */
export async function captureScreenRegion(rect: ScreenRect): Promise<{
  success: boolean
  screenshotBase64?: string
  nativeImage?: Electron.NativeImage
  error?: string
  display?: { id: number; bounds: Electron.Rectangle; scaleFactor: number }
}> {
  try {
    const display = screen.getDisplayMatching({
      x: rect.x,
      y: rect.y,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height)
    })

    const scaleFactor = display.scaleFactor || 1
    const physicalWidth = Math.round(display.bounds.width * scaleFactor)
    const physicalHeight = Math.round(display.bounds.height * scaleFactor)

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('desktopCapturer timeout')), 5000)
    })
    const screenSources = (await Promise.race([
      desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: physicalWidth, height: physicalHeight }
      }),
      timeoutPromise
    ])) as Electron.DesktopCapturerSource[]

    const matchedSource =
      screenSources.find((s) => String(s.display_id) === String(display.id)) || screenSources[0]
    if (!matchedSource) return { success: false, error: '未找到匹配的屏幕源' }

    const cropRect = {
      x: Math.round((rect.x - display.bounds.x) * scaleFactor),
      y: Math.round((rect.y - display.bounds.y) * scaleFactor),
      width: Math.max(1, Math.round(rect.width * scaleFactor)),
      height: Math.max(1, Math.round(rect.height * scaleFactor))
    }

    const cropped = matchedSource.thumbnail.crop(cropRect)
    return {
      success: true,
      screenshotBase64: cropped.toDataURL(),
      nativeImage: cropped,
      display: { id: display.id, bounds: display.bounds, scaleFactor }
    }
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) }
  }
}

/**
 * 截图 chatMainArea 区域，返回 NativeImage
 *
 * 从 LayoutCache 获取 chatMainArea.bbox → 计算 crop 区域 → 局部截图
 * 用于 diff 检测：对比前后两张 chatMainArea 截图判断是否有新消息
 */
export async function captureChatMainArea(appType: AppType): Promise<Electron.NativeImage | null> {
  try {
    // 延迟导入避免循环引用
    const { getLayoutCache, bboxToCropBounds } = await import('./vision-utils')

    const layout = getLayoutCache(appType)
    if (!layout?.chatMainArea) {
      console.log('[captureChatMainArea] 未找到 chatMainArea 缓存')
      return null
    }

    if (layout.chatMainArea.rect) {
      const screenshotResult = await captureScreenRegion(layout.chatMainArea.rect)
      if (!screenshotResult.success || !screenshotResult.nativeImage) {
        console.log('[captureChatMainArea] 绝对区域截图失败:', screenshotResult.error)
        return null
      }
      return screenshotResult.nativeImage
    }

    if (!layout.chatMainArea.bbox) {
      console.log('[captureChatMainArea] chatMainArea 缺少 bbox/rect')
      return null
    }

    const windowInfo = await getWindowInfo(appType, false)
    if (!windowInfo?.bounds) {
      console.log('[captureChatMainArea] 获取窗口信息失败')
      return null
    }

    // 从归一化 bbox (0-1000) 计算出 crop 区域（逻辑像素）
    const cropBounds = bboxToCropBounds(layout.chatMainArea.bbox, windowInfo.bounds)
    const crop = {
      x: cropBounds.x,
      y: cropBounds.y,
      width: cropBounds.width,
      height: cropBounds.height
    }

    const screenshotResult = await captureWechatWindow(appType, crop)
    if (!screenshotResult.success) {
      console.log('[captureChatMainArea] 截图失败:', screenshotResult.error)
      return null
    }

    if (screenshotResult.nativeImage) {
      return screenshotResult.nativeImage
    }

    console.log('[captureChatMainArea] 截图结果无 nativeImage:', {
      appType,
      crop,
      keys: Object.keys(screenshotResult),
      hasScreenshotBase64: Boolean(screenshotResult.screenshotBase64)
    })
    return null
  } catch (error: any) {
    console.error('[captureChatMainArea] 异常:', error)
    return null
  }
}
