export type DesktopErrorCode =
  | 'target_unavailable'
  | 'focus_changed'
  | 'layout_invalid'
  | 'not_chat'
  | 'conversation_changed'
  | 'history_changed'
  | 'send_failed'

/** An expected desktop state change; keep the engine alive and never replay a send. */
export class DesktopStateError extends Error {
  readonly name = 'DesktopStateError'
  constructor(
    readonly code: DesktopErrorCode,
    message: string,
    readonly sendPhase: 'before_paste' | 'pasted' | 'submitted' = 'before_paste'
  ) {
    super(message)
  }
}

export function isDesktopStateError(error: unknown): error is DesktopStateError {
  return (
    error instanceof DesktopStateError ||
    (error instanceof Error && error.name === 'DesktopStateError')
  )
}
