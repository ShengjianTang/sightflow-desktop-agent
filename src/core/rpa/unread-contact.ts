import type { ScreenRect } from './types'
import type { RedBadge } from './red-badge'

export function isAvatarRect(rect: ScreenRect): boolean {
  return (
    rect.width >= 24 &&
    rect.height >= 24 &&
    rect.width <= 100 &&
    rect.height <= 100 &&
    rect.width / rect.height >= 0.65 &&
    rect.width / rect.height <= 1.65
  )
}

/** Never turn arbitrary model coordinates into a click: bind the avatar to a local red component. */
export function parseUnreadContact(
  response: string,
  candidates: RedBadge[],
  imageSize: { width: number; height: number },
  scaleFactor: number
): ScreenRect | null {
  const json = response
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  let value: { candidate?: unknown; avatarBbox?: unknown }
  try {
    value = JSON.parse(json)
  } catch {
    throw new Error('未读联系人复核返回无效JSON，稍后重试')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('未读联系人复核格式无效')
  if (value.candidate === null) return null
  if (
    !Number.isInteger(value.candidate) ||
    typeof value.candidate !== 'number' ||
    value.candidate < 0 ||
    value.candidate >= candidates.length
  )
    throw new Error('未读联系人复核未匹配可见红点，已取消点击')
  const b = value.avatarBbox
  if (
    !Array.isArray(b) ||
    b.length !== 4 ||
    !b.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1000) ||
    b[2] <= b[0] ||
    b[3] <= b[1]
  )
    throw new Error('未读联系人头像坐标无效，已取消点击')
  const avatar = {
    x: ((b[0] / 1000) * imageSize.width) / scaleFactor,
    y: ((b[1] / 1000) * imageSize.height) / scaleFactor,
    width: (((b[2] - b[0]) / 1000) * imageSize.width) / scaleFactor,
    height: (((b[3] - b[1]) / 1000) * imageSize.height) / scaleFactor
  }
  const badge = candidates[value.candidate]
  const badgeX = (badge.x + badge.width / 2) / scaleFactor
  const badgeY = (badge.y + badge.height / 2) / scaleFactor
  if (
    !isAvatarRect(avatar) ||
    Math.abs(badgeX - (avatar.x + avatar.width)) > Math.max(12, avatar.width * 0.35) ||
    Math.abs(badgeY - avatar.y) > Math.max(12, avatar.height * 0.35)
  )
    throw new Error('红点与联系人头像位置不匹配，已取消点击并等待重新识别')
  return avatar
}
