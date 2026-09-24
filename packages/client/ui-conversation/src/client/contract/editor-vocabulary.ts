/** Draft ranges, reference inserts, and trigger-menu arbitration results shared by the input machine and the editor binding. */

/** Pick-time draft span guarded by the input revision. */
export interface TokenSpan {
  readonly start: number
  readonly end: number
  readonly draftRev: number
}

/** Structured reference inserted by an input-trigger source. */
export interface ReferenceInsert {
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly appearance?: 'session' | 'file' | 'folder'
  readonly clipboardText: string
}

/** Keyboard keys intercepted by an open trigger menu. */
export type ArbitrateKey = 'up' | 'down' | 'enter' | 'escape' | 'tab' | 'tabBack'

/** Trigger-menu keyboard routing result. */
export type ArbitrateOutcome = 'consumed' | 'pick-highlighted' | 'pass'

/**
 * One reference occurrence projected from the editor's chip nodes, in
 * clipboard-text coordinates. Identity is occurrenceId — a stable per-shell
 * assignment per chip NodeKey, so same-named references stay independently
 * addressable and survive undo. label/appearance/clipboardText are the
 * owner's insert-time projections cached on the node (invalid flips instead
 * of dropping the occurrence).
 */
export interface Occurrence {
  /** Shell-assigned stable identity (monotonic per shell, keyed by NodeKey). */
  readonly occurrenceId: number
  /** Owning source name (serializer routing key). */
  readonly source: string
  /** Owner-scoped reference id. */
  readonly ref: string
  /** Offset in the clipboard-text projection. */
  readonly offset: number
  /** Length in the clipboard-text projection; the occurrence occupies exactly [offset, offset+length). */
  readonly length: number
  /** Inline display label (insert-time cache). */
  readonly label: string
  /** Optional domain glyph (insert-time cache). */
  readonly appearance?: ReferenceInsert['appearance']
  /** Clipboard / persistence projection, e.g. `/name` (insert-time cache, never the model form). */
  readonly clipboardText: string
  /** Owner-resolution failure flag: the chip renders the failure treatment. */
  readonly invalid?: boolean
}
