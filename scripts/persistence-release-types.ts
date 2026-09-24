/** The validated release archive's records; the offline verifier and the facts renderer both name them. */
import type { PersistenceTypeChange } from './persistence-changes.ts'
import type { PersistenceRoot, PersistenceSchemaInventory } from './persistence-schema-model.ts'

/** Published identity and version constants observed in one pinned tag. */
export interface PersistenceRelease {
  readonly tag: string
  readonly sourceDate: string
  readonly publishedAt: string | null
  readonly sessionFormatVersion: number
}

/** Offline corpus captured from the repository's alpha and release-candidate tags. */
export interface PersistenceReleaseManifest {
  readonly schemaVersion: 1
  readonly capturedAt: string
  readonly releases: readonly PersistenceRelease[]
}

/** One changed root between consecutive archived releases. */
export interface PersistenceReleaseChange {
  readonly root: string
  readonly before: string | null
  readonly after: string | null
}

/** Machine declaration shared byte-for-byte by a release's bilingual documents. */
export interface PersistenceReleaseRecord {
  readonly schemaVersion: 1
  readonly tag: string
  readonly previous: string | null
  readonly sessionFormatVersion: number
  readonly changes: readonly PersistenceReleaseChange[]
}

/** Validated release, changed after schemas, and complete reconstructed root state. */
export interface PersistenceReleaseEntry {
  readonly release: PersistenceRelease
  readonly record: PersistenceReleaseRecord
  readonly snapshot: PersistenceSchemaInventory
  readonly roots: ReadonlyMap<string, PersistenceRoot>
  readonly differences: readonly (PersistenceTypeChange & { readonly root: string })[]
}

/** Complete validated archive; classifications describe modern rules, not historical migration obligations. */
export interface PersistenceReleases {
  readonly manifest: PersistenceReleaseManifest
  readonly entries: readonly PersistenceReleaseEntry[]
}
