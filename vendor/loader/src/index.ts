import { Loader } from './config/entry.ts'
import type { Entry, EntryOptions } from './config/entry.ts'

/** Re-export entry node APIs. */
export { Entry, type EntryOptions, Loader } from './config/entry.ts'
/** Re-export nested entry group APIs. */
export * from './config/group.ts'
/** Re-export service isolation helpers. */
export * from './config/isolate.ts'
/** Re-export entry tree persistence APIs. */
export * from './config/tree.ts'
/** Re-export loader config expression helpers. */
export * from './config/utils.ts'
/** Re-export Node internal module loader compatibility types. */
export * from './internal.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'exit'(signal: NodeJS.Signals): Promise<void>
    'loader/config-update'(): void
    'loader/entry-init'(entry: Entry): void
    'loader/partial-dispose'(entry: Entry, legacy: Partial<EntryOptions>, active: boolean): void
    /**
     * Volatile config values were committed into the running fiber without a remount; dispatched to the owning fiber only.
     * @param paths - changed config paths as key arrays; every value is committed before dispatch.
     * @mode emit
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
    /**
     * Refresh entry context before applying config.
     * @param entry - entry containing the new raw config and optional current fiber.
     * @param next - continue context refresh and Loader's config update.
     * @mode waterfall
     */
    'loader/patch-context'(entry: Entry, next: () => void): void
  }

  interface Context {
    loader: Loader
  }

  interface EnvData {
    startTime?: number
  }

  interface Fiber {
    entry?: Entry
  }
}

export default Loader
