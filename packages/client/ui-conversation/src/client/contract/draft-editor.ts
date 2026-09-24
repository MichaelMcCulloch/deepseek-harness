/** Editor-facing ranges, reference projections, and the composer keyboard interface. */
import type { LexicalEditor } from 'lexical'
import type { InputState } from './input.ts'
import type { InputSubmitMode } from './composer-submission.ts'
import type { ArbitrateKey, ArbitrateOutcome } from './editor-vocabulary.ts'

export type {
  ArbitrateKey, ArbitrateOutcome, Occurrence, ReferenceInsert, TokenSpan,
} from './editor-vocabulary.ts'

/**
 * The InputBar-exclusive keyboard/DOM command face: synchronous
 * returns and event-handler semantics that must not enter the public provide
 * channel. Handed to the composer-bar entry through its own inject —
 * package-internal, never across a plugin boundary. The session shell
 * satisfies it structurally. Text editing itself rides the shell's Lexical
 * editor (exposed here for the contenteditable binding); the members below
 * are the submit-plane and trigger-pipeline verbs the editor does not own.
 */
export interface ComposerKeyboard {
  /** Live machine state for event-handler reads (render reads go through useInput). */
  readonly snapshot: InputState
  /** The shell-owned Lexical editor the composer binds its contenteditable to. */
  readonly editor: LexicalEditor
  /** Submit with an explicit delivery mode resolved by the submission policy (Enter gestures and the primary Send button). */
  submit(mode: InputSubmitMode): void
  /**
   * Steer every still-pending queued message into the running turn (the
   * empty-draft accelerated-Enter gesture; the queue dock's per-row steer
   * button is the same operation applied to the whole queue).
   */
  steerQueue(): void
  /** Insert pasted plain text over the current editor selection (reference-placeholder-sanitized). */
  paste(text: string): void
  /**
   * The live selection as a detect-coordinate span (menu-launcher synthetic
   * hits replace it on pick); an absent selection answers a collapsed span at
   * the document end.
   */
  caretSpan(): EditSelection
  /** Keyboard arbitration while the menu is open ('pass' when no pipeline). */
  arbitrate(key: ArbitrateKey, composing: boolean): ArbitrateOutcome
  /** Space adjudication; true = the input applied a claim — caller preventDefaults. */
  space(): boolean
  /** Dismiss the popupSelect shell (any interaction outside the box). */
  dismissPopup(): void
  /**
   * Bind the mounted composer's file action and live intake availability.
   * @param picker - availability query and native file-dialog opener.
   * @returns the unbind disposer.
   */
  bindFilePicker(picker: { available(): boolean; open(): void }): () => void
}

/** Half-open [start, end) range/selection in detect-projection coordinates. */
export interface EditSelection {
  readonly start: number
  readonly end: number
}
