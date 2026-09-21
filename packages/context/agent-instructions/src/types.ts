/**
 * Instruction-file records shared by discovery, reconciliation, and rendering.
 *
 * @module @deepseek-ai/dsh-agent-instructions/types
 */

import type { FsVersion } from '@deepseek-ai/dsh-fs'

/** An instruction candidate identified by absolute and model-facing paths. */
export interface InstructionFile {
  absolutePath: string
  displayPath: string
}

/** An instruction file whose UTF-8 content was read successfully. */
export interface LoadedInstructionFile extends InstructionFile {
  content: string
  /** Provider freshness token when the file was loaded through `ctx.fs`. */
  version?: FsVersion
}
