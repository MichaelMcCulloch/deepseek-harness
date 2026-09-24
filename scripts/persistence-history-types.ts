/** Acknowledged persistence-change records and the verified per-root history they accumulate into. */
import type { PersistenceRoot, PersistenceSchemaInventory } from './persistence-schema-model.ts'

/** The author's acknowledgement of one mechanically classified transition. */
export type PersistenceDecision = 'same-version' | 'version-bump'

/** One root's successor; null after values preserve a deletion in its history. */
export interface PersistenceChange {
  readonly root: string
  readonly previous: string | null
  readonly after: string | null
  readonly decision: PersistenceDecision
}

/** A document's machine record, independent of its translated prose. */
export interface PersistenceChangeRecord {
  readonly schemaVersion: 1
  readonly id: string
  readonly baseline: boolean
  readonly changes: readonly PersistenceChange[]
}

/** A parsed acknowledgement and its self-contained after schemas. */
export interface PersistenceHistoryEntry {
  readonly record: PersistenceChangeRecord
  readonly snapshot: PersistenceSchemaInventory
}

/** One root's verified history tip; null marks a root removed in an acknowledged change. */
export interface Tip {
  readonly id: string
  readonly root: PersistenceRoot | null
}

/** Verified per-root history tips; historical schemas need not match the current tree. */
export interface PersistenceHistory {
  readonly entries: readonly PersistenceHistoryEntry[]
  readonly tips: ReadonlyMap<string, Tip>
}
