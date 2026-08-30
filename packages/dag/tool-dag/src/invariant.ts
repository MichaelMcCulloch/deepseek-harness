/** Tool-DAG runtime invariant registration. @module @deepseek-ai/dsh-tool-dag/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'tool-dag-invariant'
/** Required runtime invariant registry. */
export const inject = ['invariants']

/**
 * No runtime invariant: tool registrations are effect-scoped adapters over the
 * DAG service, which owns and validates all durable state.
 */
const install: InvariantInstaller = () => {}

/** Register package ownership; tool definitions have no mutable companion state. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(
  '@deepseek-ai/dsh-tool-dag',
  install,
))
