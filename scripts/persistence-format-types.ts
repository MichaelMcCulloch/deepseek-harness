/** Complete format references assembled from historical checkouts; the renderer and the archive owner both name them. */
import type { PersistenceSchemaInventory } from './persistence-schema-model.ts'

/** Historical checkout that supplies a format's complete declared persistence inventory. */
export type PersistenceFormatSource = { readonly tag: string } | { readonly pullRequest: number }

/** One complete format reference; the current catalog follows the historical entries. */
export interface PersistenceFormatEntry {
  readonly version: number
  readonly document: string
  readonly schemaPath: string
  readonly inventory: PersistenceSchemaInventory
  readonly source?: PersistenceFormatSource
}

/** Contiguous format references ending at the source-declared writer version. */
export interface PersistenceFormats {
  readonly currentVersion: number
  readonly entries: readonly PersistenceFormatEntry[]
}
