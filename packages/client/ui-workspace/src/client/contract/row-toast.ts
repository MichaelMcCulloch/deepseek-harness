/** Transient Workspace notices published by row actions and rendered by the overlay toast entry. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One transient Workspace notice rendered by the overlay toast entry. */
export type RowToast =
  | { kind: 'archived'; sessionId: SessionId }
  | { kind: 'stoppedAndArchived'; sessionId: SessionId }
  | { kind: 'pinFailed' }
  | { kind: 'unpinFailed' }
  | { kind: 'archivedNotOpenable' }
  | { kind: 'defaultWorkspaceFailed' }
  /**
   * An explicit New Session request that failed. `message` is untranslated:
   * a Host refusal as `code: message` — the stable code stays in the copy so
   * a report can be searched by it — and any other failure's own message.
   */
  | { kind: 'createFailed'; message: string }
