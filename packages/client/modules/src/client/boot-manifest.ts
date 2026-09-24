/** The parsed boot manifest and its wire parser, shared by the module table and entry reconciliation. */
/** The npm-package view of one boot row: what the module table needs to fetch the bundle. */
export interface BootModuleRow {
  /** Entry name == package name (module-table key). */
  id: string
  /** Revisioned single-resource combo reference: the fallback when the row's batch fails and the reload target after HMR invalidation. */
  url: string
  /** Content-addressed combo reference used before the first HMR invalidation. */
  initialUrl: string
  /** Opaque plugin-artifact revision used after HMR invalidation. */
  rev: string
  /** Injected package rows whose factories arrive before this row materializes. */
  inject: string[]
  /** Module specifiers this row requests from the module table ([] when the wire omits them). */
  external: string[]
}

/** The cordis-plugin view of one boot row: what entry composition needs (optional wire fields normalized). */
export interface BootPluginRow {
  /** Entry name == package name. */
  id: string
  /** Package-name dependency edges ([] when the wire omits them). */
  inject: string[]
  /** Stage-one prefetch tier (false when the wire omits it). */
  immediately: boolean
}

/** The parsed boot manifest: one wire, two consumer views. */
export interface BootManifest {
  /** Consistency anchor over the whole graph. */
  rev: string
  /** Rows as the module table consumes them. */
  modules: BootModuleRow[]
  /** Rows as entry composition consumes them. */
  plugins: BootPluginRow[]
}

/**
 * Validate an optional string-array field read from a `dsh.client` declaration
 * or from the boot wire.
 * @param subject - diagnostic prefix naming the package or the wire row.
 * @param field - field name as it appears in the diagnostic.
 * @param value - the raw field value.
 * @returns the validated array, or undefined when the field is absent.
 * @throws {Error} when the value is present but is not an array of strings.
 */
export function optionalStringArray(subject: string, field: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`client-modules: ${subject} ${field} must be a string array`)
  }
  return value as string[]
}

/**
 * Parse `window.__DSH_BOOT__` into the two consumer views. Wire boundary:
 * a missing or malformed graph throws (the shell shows the loud failure —
 * a page without a valid manifest cannot boot anything).
 * @param wire - the raw `window.__DSH_BOOT__` value.
 * @returns the manifest with optional plugin-view fields normalized.
 */
export function parseBootManifest(wire: unknown): BootManifest {
  if (typeof wire !== 'object' || wire === null) {
    throw new Error('client-modules: window.__DSH_BOOT__ is missing or not an object')
  }
  const graph = wire as Record<string, unknown>
  if (typeof graph.rev !== 'string') {
    throw new Error('client-modules: boot manifest rev must be a string')
  }
  if (!Array.isArray(graph.entries)) {
    throw new Error('client-modules: boot manifest entries must be an array')
  }
  if (!Array.isArray(graph.batches)) {
    throw new Error('client-modules: boot manifest batches must be an array')
  }
  const moduleFields: Omit<BootModuleRow, 'initialUrl'>[] = []
  const plugins: BootPluginRow[] = []
  const seenEntryIds = new Set<string>()
  for (const value of graph.entries as unknown[]) {
    if (typeof value !== 'object' || value === null) {
      throw new Error('client-modules: boot manifest entry is not an object')
    }
    const row = value as Record<string, unknown>
    const where = typeof row.id === 'string' ? `"${row.id}"` : JSON.stringify(row)
    if (typeof row.id !== 'string' || typeof row.url !== 'string' || typeof row.rev !== 'string') {
      throw new Error(`client-modules: boot manifest entry ${where} must carry string id/url/rev`)
    }
    if (seenEntryIds.has(row.id)) throw new Error(`client-modules: duplicate graph entry "${row.id}"`)
    seenEntryIds.add(row.id)
    const subject = `boot manifest entry ${where}`
    const inject = optionalStringArray(subject, 'inject', row.inject)
    const external = optionalStringArray(subject, 'external', row.external)
    if (row.immediately !== undefined && typeof row.immediately !== 'boolean') {
      throw new Error(`client-modules: boot manifest entry ${where} immediately must be a boolean`)
    }
    moduleFields.push({
      id: row.id,
      url: row.url,
      rev: row.rev,
      inject: inject === undefined ? [] : [...inject],
      external: external === undefined ? [] : [...external],
    })
    plugins.push({
      id: row.id,
      inject: inject === undefined ? [] : [...inject],
      immediately: row.immediately === true,
    })
  }

  const entryIds = new Set(moduleFields.map(row => row.id))
  const initialUrls = new Map<string, string>()
  const batchUrls = new Set<string>()
  for (const value of graph.batches as unknown[]) {
    if (typeof value !== 'object' || value === null) {
      throw new Error('client-modules: boot manifest batch is not an object')
    }
    const batch = value as Record<string, unknown>
    const phase = batch.phase
    if (phase !== 'bootstrap' && phase !== 'application') {
      throw new Error(`client-modules: boot manifest batch phase must be "bootstrap" or "application", received ${JSON.stringify(phase)}`)
    }
    if (typeof batch.url !== 'string' || typeof batch.rev !== 'string') {
      throw new Error(`client-modules: boot manifest ${phase} batch must carry string url/rev`)
    }
    if (batchUrls.has(batch.url)) {
      throw new Error(`client-modules: boot manifest carries duplicate batch URL ${JSON.stringify(batch.url)}`)
    }
    batchUrls.add(batch.url)
    const entries = optionalStringArray(`boot manifest ${phase} batch`, 'entries', batch.entries)
    if (entries === undefined || entries.length === 0) {
      throw new Error(`client-modules: boot manifest ${phase} batch entries must be a non-empty string array`)
    }
    for (const id of entries) {
      if (!entryIds.has(id)) {
        throw new Error(`client-modules: boot manifest ${phase} batch names unknown entry "${id}"`)
      }
      if (initialUrls.has(id)) {
        throw new Error(`client-modules: boot manifest entry "${id}" belongs to more than one batch`)
      }
      initialUrls.set(id, batch.url)
    }
  }
  const modules = moduleFields.map((row): BootModuleRow => {
    const initialUrl = initialUrls.get(row.id)
    if (initialUrl === undefined) {
      throw new Error(`client-modules: boot manifest entry "${row.id}" belongs to no initial-load batch`)
    }
    return { ...row, initialUrl }
  })
  return { rev: graph.rev, modules, plugins }
}
