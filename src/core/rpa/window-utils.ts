import { screen } from 'electron'
import activeWin from 'active-win'
import { AppType } from './types'
import { captureWechatWindow } from './screenshot-utils'

const IS_WINDOWS = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

// 包装带超时的 activeWin 调用
async function getOpenWindowsSafe(): Promise<any[]> {
  try {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('active-win getOpenWindows timeout')), 5000)
    })

    // 如果系统没有给权限，activeWin在某些版本可能卡死，强制5秒超时
    const windows = await Promise.race([activeWin.getOpenWindows(), timeoutPromise])
    return windows as any[]
  } catch (err: any) {
    console.error('[window-utils] getOpenWindowsSafe error or timeout:', err.message)
    return []
  }
}

export function matchWechatType(name: string, appType: AppType) {
  if ((appType as string) === 'whatsapp') {
    return ['‎WhatsApp', '‎WhatsApp.app', '‎WhatsApp.exe', 'WhatsApp'].includes(name)
  }
  const wechatName =
    appType === 'wechat' ? ['微信', '微信.app', 'WeChat', 'Weixin'] : ['企业微信', '企业微信.app']
  return wechatName.includes(name)
}

function getWechatWindow(appType: AppType, windows: any[]): any {
  let appTargetName: string[]
  let windowTitle: string[]

  if ((appType as string) === 'whatsapp') {
    appTargetName = ['‎WhatsApp', '‎WhatsApp.app', '‎WhatsApp.exe', 'WhatsApp']
    windowTitle = ['‎WhatsApp', '‎WhatsApp.app', '‎WhatsApp.exe', 'WhatsApp']
  } else {
    appTargetName =
      appType === 'wechat' ? ['微信', '微信.app', 'WeChat'] : ['企业微信', '企业微信.app']
    windowTitle = appType === 'wechat' ? ['微信', 'Weixin'] : ['企业微信']
  }

  const allWechatWindows = windows.filter((window: any) =>
    appTargetName.includes(window?.owner?.name)
  )

  if (allWechatWindows.length > 1) {
    const selected = allWechatWindows.find((window: any) => windowTitle.includes(window.title))
    return selected
  }
  if (allWechatWindows.length === 1) {
    return allWechatWindows[0]
  }
  return undefined
}

type PlatformWindow = {
  getBounds?: () => { x?: number; y?: number; width?: number; height?: number }
  bounds?: { x?: number; y?: number; width?: number; height?: number }
  [key: string]: any
}

async function getWechatWindowInWin(appType: AppType): Promise<PlatformWindow | null> {
  try {
    const { windowManager } = require('node-window-manager')
    const activeWechatWindow = windowManager.getActiveWindow()
    if (activeWechatWindow && matchWechatType(activeWechatWindow.getTitle(), appType)) {
      return activeWechatWindow
    }
    const foundWindow = windowManager
      .getWindows()
      ?.find((window: any) => matchWechatType(window.getTitle(), appType) && window.isVisible())
    return foundWindow || null
  } catch (err: any) {
    console.error('[window-utils] getWechatWindowInWin error:', err.message)
    return null
  }
}

async function getWechatWindowInMac(appType: AppType): Promise<PlatformWindow | null> {
  const windows = await getOpenWindowsSafe()
  if (!windows || windows.length === 0) {
    return null
  }
  return getWechatWindow(appType, windows) || null
}

function getWindowBounds(window: PlatformWindow): {
  x?: number
  y?: number
  width?: number
  height?: number
} | null {
  if (typeof window.getBounds === 'function') {
    return window.getBounds()
  }
  if (window.bounds) {
    return window.bounds
  }
  return null
}

function validateWindowBounds(
  bounds: { x?: number; y?: number; width?: number; height?: number } | null
): bounds is { x: number; y: number; width: number; height: number } {
  if (!bounds) return false
  if (
    bounds.x === undefined ||
    bounds.y === undefined ||
    !bounds.width ||
    !bounds.height ||
    (bounds.width && bounds.width < 100) ||
    (bounds.height && bounds.height < 100)
  ) {
    return false
  }
  const isVisible = bounds.width > 0 && bounds.height > 0
  return isVisible
}

interface WechatWindowInfoCache {
  result: any | null
  timestamp: number
}
// Short cache so window moves do not leave stale click targets.
const WINDOW_INFO_CACHE_DURATION = 500
const wechatWindowInfoCache = new Map<AppType, WechatWindowInfoCache>()
const wechatWindowInfoPendingPromises = new Map<AppType, Promise<any>>()

export async function getWechatWindowInfo(appType: AppType, forceRefresh = false) {
  const cached = wechatWindowInfoCache.get(appType)
  const now = Date.now()
  if (!forceRefresh && cached && now - cached.timestamp < WINDOW_INFO_CACHE_DURATION) {
    return cached.result
  }

  const pendingPromise = wechatWindowInfoPendingPromises.get(appType)
  if (pendingPromise) return pendingPromise

  const queryPromise = (async () => {
    try {
      const wechatWindow = IS_WINDOWS
        ? await getWechatWindowInWin(appType)
        : IS_MAC
          ? await getWechatWindowInMac(appType)
          : null
      if (!wechatWindow) {
        wechatWindowInfoCache.delete(appType)
        return null
      }

      const nativeBounds = getWindowBounds(wechatWindow)
      if (!validateWindowBounds(nativeBounds)) return null

      // Win32 GetWindowRect uses screen coordinates; Electron capture and displays use DIP.
      // Convert the whole rectangle so displays with different origins/scales work too.
      let bounds = IS_WINDOWS ? screen.screenToDipRect(null, nativeBounds) : nativeBounds

      const display = screen.getDisplayMatching({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height
      })

      // Maximized Win32 windows include invisible borders outside the display.
      // Normalize capture bounds to the visible portion so bbox and crop still agree.
      const left = Math.max(bounds.x, display.bounds.x)
      const top = Math.max(bounds.y, display.bounds.y)
      const right = Math.min(bounds.x + bounds.width, display.bounds.x + display.bounds.width)
      const bottom = Math.min(bounds.y + bounds.height, display.bounds.y + display.bounds.height)
      if (right - left < bounds.width * 0.9 || bottom - top < bounds.height * 0.9) {
        console.warn('[window-utils] 目标窗口跨屏或大部分位于屏幕外，请将窗口完整放在一个显示器内')
        return null
      }
      bounds = { x: left, y: top, width: right - left, height: bottom - top }

      const result = {
        wechatWindow,
        foreground: IS_WINDOWS
          ? require('node-window-manager').windowManager.getActiveWindow()?.id === wechatWindow.id
          : true,
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        wechatType: appType,
        display: { id: display.id, scaleFactor: display.scaleFactor, bounds: display.bounds }
      }
      const previous = wechatWindowInfoCache.get(appType)?.result
      const resized =
        previous &&
        (previous.bounds.width !== bounds.width ||
          previous.bounds.height !== bounds.height ||
          previous.display.scaleFactor !== display.scaleFactor ||
          previous.display.id !== display.id ||
          previous.wechatWindow.id !== wechatWindow.id)
      const moved = previous && (previous.bounds.x !== bounds.x || previous.bounds.y !== bounds.y)
      if (resized || moved) {
        const { clearLayoutCache, getLayoutCache, setLayoutCache, bboxToScreenCoords } =
          await import('./vision-utils')
        const { clearScreenshotCache } = await import('./screenshot-utils')
        clearScreenshotCache()
        const layout = getLayoutCache(appType)
        if (layout?.chatMainArea?.bbox) {
          if (resized) {
            const { clearChatBaseline } = await import('./image-compare')
            clearLayoutCache(appType)
            clearChatBaseline()
          } else {
            for (const item of [
              layout.chatEntranceArea,
              layout.firstContact,
              layout.searchInputBox,
              layout.headerArea,
              layout.chatMainArea,
              layout.messageInputArea
            ]) {
              if (item?.bbox)
                item.coordinates = bboxToScreenCoords(item.bbox, bounds, display.scaleFactor)
            }
            setLayoutCache(appType, layout)
          }
        }
        console.log('[window-utils] Window geometry changed; refreshed layout coordinates', {
          previous: previous.bounds,
          current: bounds,
          remeasure: Boolean(resized)
        })
      }
      wechatWindowInfoCache.set(appType, { result, timestamp: Date.now() })
      return result
    } catch (e) {
      console.error('getWechatWindowInfo error:', e)
      return null
    } finally {
      wechatWindowInfoPendingPromises.delete(appType)
    }
  })()

  wechatWindowInfoPendingPromises.set(appType, queryPromise)
  return queryPromise
}

export const getWindowInfo = async (
  appType: AppType = 'wechat',
  includeScreenshot: boolean = true,
  forceRefresh = false
) => {
  if (!includeScreenshot) {
    const result = await getWechatWindowInfo(appType, forceRefresh)
    if (!result) return null
    return {
      wechatWindow: result.wechatWindow,
      bounds: result.bounds,
      wechatType: result.wechatType,
      scaleFactor: result.display.scaleFactor
    }
  }

  try {
    const windowCore = await getWechatWindowInfo(appType)
    if (!windowCore) return null

    const result = await captureWechatWindow(appType)
    if (!result.success || !result.screenshotBase64) return null

    return {
      wechatWindow: windowCore.wechatWindow,
      bounds: result.bounds!,
      wechatType: windowCore.wechatType,
      scaleFactor: result.display!.scaleFactor,
      screenshot: result.screenshotBase64
    }
  } catch (error) {
    console.error('getWindowInfo failure:', error)
    return null
  }
}

/**
 * 同步获取窗口信息（从内存缓存读取，不发起系统调用）
 * 前提：measureLayout 时已经调过 getWindowInfo/getWechatWindowInfo，缓存有数据
 */
export function getWindowInfoSync(appType: AppType): {
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
} | null {
  const cached = wechatWindowInfoCache.get(appType)
  if (!cached?.result) return null

  return {
    bounds: cached.result.bounds,
    scaleFactor: cached.result.display?.scaleFactor || 1
  }
}
