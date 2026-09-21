/** Virtual executable registry used by the Worker process launcher. */
import { basename } from '../../module-system/posix-path.ts'
import type { VirtualExecutable } from '../types.ts'
import { LANDLOCK_EXECUTABLE } from './landlock.ts'

// The virtual-executable vocabulary lives in `../types.ts` with the rest of
// the shell types; re-exported here so the process launcher's callers keep
// resolving it beside `virtualExecutable`.
export type {
  VirtualExecutable,
  VirtualExecutableDelegate,
  VirtualExecutableExit,
  VirtualExecutablePreparation,
  VirtualExecutableSyncResult,
} from '../types.ts'

const EXECUTABLES: ReadonlyMap<string, VirtualExecutable> = new Map([
  [LANDLOCK_EXECUTABLE.name, LANDLOCK_EXECUTABLE],
])

/**
 * Resolve a Worker platform executable by logical name.
 * @param path - Bare name or executable path passed to `spawn`.
 * @returns Its implementation, or undefined for the normal command table.
 */
export function virtualExecutable(path: string): VirtualExecutable | undefined {
  return EXECUTABLES.get(basename(path))
}
