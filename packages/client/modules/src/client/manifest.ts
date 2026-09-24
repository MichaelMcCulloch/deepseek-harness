/**
 * Client module system: the browser peer of Node's internal ESM loader, built
 * as a lazy CJS table. The vendored cordis Loader consumes this object
 * through its `internal` contract (the only call site is `EntryTree.import` →
 * `internal.import`), which keeps entry governance (fiber lifecycle, inject
 * waiting, update/refresh) entirely on the vendored side while this package
 * owns code arrival.
 *
 * Lazy CJS model: executing a plugin bundle only REGISTERS its
 * factory (`window.__ModuleLoader__.load({id, factory})`); every module body
 * side effect — including CSS injection — lives inside the factory closure
 * and runs at materialization, not at script execution. Materialization
 * (factory(require) → exports) happens on first import/require and is
 * memoized in {@link ClientModuleLoader.loadCache}; a factory that requires
 * another registered-but-unmaterialized module materializes it recursively,
 * so load order needs no external sequencing.
 *
 * Resolution branch order (import): seed word → shell instance; memoized
 * record → exports; graph row → register its dependency factories and own
 * factory; registered factory → materialize; anything else → throw (loud —
 * the runtime mirror of the build-time bundle purity gate).
 * The synchronous `require` handed to factories walks the same order minus
 * the load branch. Loading is async, so a requested dynamic package must have
 * registered its factory before a consumer materializes.
 *
 * This file is the browser-safe contract face (zero node imports): the
 * `__DSH_BOOT__` wire types, the parsed-manifest leaves it re-exports, and the
 * internal loader contract. The package root is the host-side service that
 * composes the wire.
 */

import type {} from '@deepseek-ai/cordis'
import type { DshClientManifest } from '@deepseek-ai/dsh-package-manifest'
import type { ClientEntries } from './entries.ts'
import { optionalStringArray, type BootManifest } from './boot-manifest.ts'

export { optionalStringArray, parseBootManifest } from './boot-manifest.ts'
export type { BootManifest, BootModuleRow, BootPluginRow } from './boot-manifest.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The client module system the web shell builds at boot (provided by the `./client` wrapper plugin). */
    modules: ClientModuleLoader
  }
}

/**
 * One composed client entry pushed by the host (a graph row). Wire
 * single source: the host node half (package root) produces this same shape.
 * `immediately` marks stage-one prefetch. `inject` names package rows whose
 * factories must arrive before this row materializes, while Cordis separately
 * uses the same package edges to compose entries. `external` carries exact
 * non-inject module requests (see {@link WebBootGraph.entries}).
 */
export interface WebBootEntry {
  /** Entry name == package name. */
  id: string
  /**
   * Revisioned single-resource combo reference used by HMR. It is relative to
   * the document, so the browser resolves it under whatever mount served the page.
   */
  url: string
  /** Opaque plugin-artifact revision used for HMR cache busting. */
  rev: string
  /** Package-name dependency edges used for factory arrival and plugin composition. */
  inject?: string[]
  /** Stage-one prefetch mark: load the script for factory registration during module-face boot. */
  immediately?: boolean
  /** Non-baseline module specifiers this row requests; omitted when it requests none. */
  external?: string[]
}

/** Initial scheduling phase for one revisioned combo script. */
export type WebBootBatchPhase = 'bootstrap' | 'application'

/** One initial combo script; a scheduling phase may span several descriptors. */
export interface WebBootBatch {
  /** Parser-blocking bootstrap or preloaded application scheduling. */
  phase: WebBootBatchPhase
  /** Content-addressed combo script reference, document-relative like {@link WebBootEntry.url}. */
  url: string
  /** Revision derived from the ordered entry revisions. */
  rev: string
  /** Graph entry ids whose factories the script registers, in execution order. */
  entries: string[]
}

/** The composed client entry graph the host injects as `window.__DSH_BOOT__`. */
export interface WebBootGraph {
  /** Consistency anchor over the current entry and batch descriptors. */
  rev: string
  /**
   * Composed entries in module-graph order — a dynamic package row precedes
   * rows whose `external` requests that package. Cordis activation order is
   * unrelated and remains owned by fiber service waiting.
   */
  entries: WebBootEntry[]
  /** Initial combo descriptors; every entry belongs to exactly one descriptor. */
  batches: WebBootBatch[]
}

/**
 * Narrow an unknown parsed JSON value to the `dsh.client` declaration. Shared
 * by the node half's Loader scan and the roster generator, so both read a
 * package's browser declaration through one validator.
 * @param pkgName - package name used as the diagnostic prefix.
 * @param value - the raw `dsh.client` field of the package manifest.
 * @returns the validated declaration, or undefined when the field is absent.
 * @throws {Error} when the field is present but any member is malformed.
 */
export function parseDshClient(pkgName: string, value: unknown): DshClientManifest | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) {
    throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`)
  }
  const decl = value as Record<string, unknown>
  if (typeof decl.platform !== 'string') {
    throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`)
  }
  const inject = optionalStringArray(pkgName, 'dsh.client.inject', decl.inject)
  const external = optionalStringArray(pkgName, 'dsh.client.external', decl.external)
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') {
    throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`)
  }
  return {
    platform: decl.platform,
    ...(inject !== undefined ? { inject } : {}),
    ...(external !== undefined ? { external } : {}),
    ...(decl.immediately !== undefined ? { immediately: decl.immediately } : {}),
  }
}

/**
 * The bare package-root specifier `specifier` names, or undefined for a subpath, a path, or any scheme-qualified
 * specifier (`cordis:` builtins, `node:` modules, URLs).
 * @param specifier - Loader row name.
 * @returns the package name, or undefined.
 */
export function exactPackageSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/')
    return parts.length === 2 && parts.every(Boolean) ? specifier : undefined
  }
  return specifier.length > 0 && !specifier.includes('/') && !specifier.includes(':') ? specifier : undefined
}

/**
 * Normalize a module specifier onto the graph row that owns it: a plugin bundle
 * IS its package's client half, so `<id>/client` (the exports subpath external
 * bundles emit) and the bare package name resolve to the same exports. Both the
 * require path and graph composition normalize here, which is what lets each
 * importing package request the subpath its own code imports.
 * @param spec - module specifier as a bundle requires it or a declaration spells it.
 * @returns the specifier with a trailing `/client` removed.
 */
export function stripClientSuffix(spec: string): string {
  return spec.endsWith('/client') ? spec.slice(0, -'/client'.length) : spec
}

/** Module resolver passed into a registered Client bundle factory. */
export interface ClientBundleRequire {
  /** Resolve a module-table dependency synchronously. */
  (specifier: string): unknown
  /** Load and resolve a package-local dynamic chunk asynchronously. */
  async(specifier: string): Promise<unknown>
}

/** One client bundle's factory registration submitted through `window.__ModuleLoader__.load`. */
export interface ClientBundleRegistration {
  /** Plugin id (package name) — the registration key; must match the graph row being executed. */
  id: string
  /** Package-local chunk filename; absent for the package's `client.js` entry. */
  chunk?: string
  /**
   * Closure factory holding the whole bundle body: receives the module-table
   * require whose `async` operation loads generated chunks, and returns the
   * bundle's exports. The factory runs once, at materialization.
   */
  factory: (require: ClientBundleRequire) => Record<string, unknown>
}

/** Inputs passed by the web entry when it creates the client module system. */
export interface ClientModuleCreateOptions {
  /** Raw Host-injected boot graph; the modules bundle owns validation and projection. */
  boot: unknown
  /** Module-table seed: platform-singleton specifier → shell instance. */
  staticModules: Record<string, unknown>
  /** Bundle-load hook. Defaults to a same-origin classic `<script src>` element. */
  loadBundle?: (url: string) => Promise<void>
}

/** The modules bundle after its factory has been materialized by the HTML bootstrap facade. */
export interface ClientBootstrapModule {
  /** Graph/module id carried by the modules bundle registration. */
  id: string
  /** Materialized exports reused when Cordis later activates the modules entry. */
  exports: Record<string, unknown>
}

/** Per-module bookkeeping in {@link ClientModuleLoader.loadCache} (flat module-graph boundary). */
export interface ClientModuleRecord {
  /** Module id (entry name / package name). */
  id: string
  /** Materialized exports (`module.exports` from a factory or bootstrap registration). */
  exports: unknown
  /** Owned `<style data-plugin>` tag ids (`data-plugin-css` values) injected during materialization. */
  styles: string[]
  /** Observed `require()` edges (module-graph boundary; only table words can appear). */
  edges: Set<string>
}

/**
 * The internal-contract subset the vendored Loader and the client HMR plugin
 * consume. Mounted on `ctx.loader.internal` by the shell boot and provided
 * as `ctx.modules`.
 */
export interface ClientModuleLoader {
  /** Discriminant against Node's internal loader shapes ('v1'/'v2'). */
  version: 'client'
  /** Latest parsed Host graph, updated by live entry reconciliation. */
  manifest: BootManifest
  /** Page-owned entry reconciliation, shared by boot, graph updates and HMR. */
  entries: ClientEntries
  /** Materialized-module registry: entry or package-local chunk id → record. */
  loadCache: Map<string, ClientModuleRecord>
  /**
   * Internal contract consumed by the vendored Loader's `tree.import`. Resolves
   * `specifier` through the branch order documented on the module, fetching
   * and executing a bundle when needed.
   * @param specifier - module specifier (entry name or table word).
   * @param parentURL - importer URL (unused — the client module graph is flat).
   * @param attrs - Import attributes (unused; interface parity with Node's loader contract).
   * @returns the module's exports.
   */
  import(specifier: string, parentURL: string, attrs: Record<string, unknown>): Promise<unknown>
  /**
   * Stage-one arrival: load the entry's declared dynamic requests, then its
   * own script, to register their factories (no materialization — module side
   * effects wait for import).
   * No-op for materialized bootstrap ids. A registered graph row still
   * registers any unresolved declared requests before skipping its own script;
   * concurrent arrivals share one in-flight task. To force a fresh load (HMR),
   * {@link invalidate} first.
   * @param id - graph entry name.
   */
  prefetch(id: string): Promise<void>
  /**
   * The last failure of {@link import} or {@link prefetch} for one graph row:
   * transport, registration, dependency cascade, or factory execution. Cleared
   * by a later success and by {@link invalidate}. The boot audit reads it to
   * report why a Loader entry has no fiber.
   * @param id - graph entry name.
   * @returns the recorded failure, or `undefined` when the row never failed or succeeded since.
   */
  importError(id: string): Error | undefined
  /**
   * Full reset of one non-bootstrap package: drop its entry and chunk factories
   * and materialized records so the next prefetch/import loads its one-resource
   * combo script rather than the initial multi-resource request. The bootstrap
   * module remains materialized.
   * @param id - entry name to invalidate.
   * @param rev - New content revision from the HMR frame; omitted to reuse
   * the graph revision or for page-local modules that register directly.
   */
  invalidate(id: string, rev?: string): void
}
