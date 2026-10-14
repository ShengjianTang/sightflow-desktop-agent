export type ToastType = 'success' | 'error'

export const TOAST_EVENT = 'sightflow:toast'

export interface ToastDetail {
  message: string
  type: ToastType
}

export function showToast(message: string, type: ToastType): void {
  window.dispatchEvent(
    new CustomEvent<ToastDetail>(TOAST_EVENT, {
      detail: { message, type }
    })
  )
}
