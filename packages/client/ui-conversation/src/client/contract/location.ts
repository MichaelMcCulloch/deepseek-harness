/**
 * Turn and Step boundaries, the business readers their owners publish, and the
 * Node/timeline identities a view target materializes from them. The grouping
 * contract and the conversation contract both name these, so they live here
 * rather than in either.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/** Merge-extensible business values published against one Turn. */
export interface ConversationTurnDataMap {}

/** Merge-extensible business values published against one Step. */
export interface ConversationStepDataMap {}

/** Observable value for one independently owned Location-data key. */
export interface ConversationLocationDataSource<Value> {
  /** @returns the current value. */
  readonly getSnapshot: () => Value
  /** @param listener - callback for value changes. @returns the unsubscribe function. */
  readonly subscribe: (listener: () => void) => () => void
}

/** Stable keyed reader for independently owned Location business values. */
export interface ConversationLocationDataStore<DataMap extends object> {
  /**
   * Read one business value without exposing another owner's mutable State.
   * @param key - declaration-merged business key.
   * @returns latest immutable value, when its owning Context has published one.
   */
  get<Key extends keyof DataMap & string>(key: Key): Readonly<DataMap[Key]> | undefined
  /**
   * Observe one business value without subscribing to unrelated Location keys.
   * @param key - declaration-merged business key.
   * @returns identity-stable source for the current value.
   */
  source<Key extends keyof DataMap & string>(
    key: Key,
  ): ConversationLocationDataSource<Readonly<DataMap[Key]> | undefined>
}

/** Immutable resolved boundary for one Agent step. */
export interface StepLocation {
  readonly turn: number
  readonly step: number
  readonly start: SessionEvent<'step/start'> | undefined
  readonly end: SessionEvent<'step/end'> | undefined
  readonly status: 'open' | 'closed' | 'unknown'
  /** Stable reader for Step-scoped business values. */
  readonly data: ConversationLocationDataStore<ConversationStepDataMap>
}

/** Immutable resolved boundary for one Agent turn. */
export interface TurnLocation {
  readonly turn: number
  readonly start: SessionEvent<'turn/start'> | undefined
  readonly end: SessionEvent<'turn/end'> | undefined
  readonly status: 'open' | 'closed' | 'unknown'
  readonly steps: readonly StepLocation[]
  /** Stable reader for Turn-scoped business values. */
  readonly data: ConversationLocationDataStore<ConversationTurnDataMap>
}

/** Reference-stable Turn/Step facts published beside view Nodes. */
export interface ConversationTimelineSnapshot {
  readonly turnOrder: readonly number[]
  readonly turns: ReadonlyMap<number, TurnLocation>
}

/** Target-neutral identity returned by a business Definition. */
export interface ConversationViewNode {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly target: string
  readonly data: unknown
}
