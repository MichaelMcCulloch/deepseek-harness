/** Package-owned invariant registration for the read-only DAG dock. @module @deepseek-ai/dsh-client-ui-dag/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'client-ui-dag-invariant'
/** Required runtime invariant registry. */
export const inject = ['invariants']

/**
 * No runtime invariant: the plugin owns one effect-scoped dock and locale
 * registration, while the host DAG package validates all projected state.
 */
const install: InvariantInstaller = () => {}

/** Register UI package ownership; projection state is owned by the host DAG package. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(
  '@deepseek-ai/dsh-client-ui-dag',
  install,
))
