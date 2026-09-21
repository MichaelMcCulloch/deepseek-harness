/** Host-plane setup for owner-bound DAG children. @module @deepseek-ai/dsh-tool-dag/child */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-dag'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { childBlockTool, childCompleteTool, childStatusTool, DISPATCHER_TOOLS } from './index.ts'

export const name = 'tool-dag-child'
export const inject = ['tools', 'dag', 'subagents', 'systemPrompt']

/** Register one scoped tool and prompt contribution for each DAG-owned child. */
export function apply(ctx: Context): void {
  const dag = ctx.dag
  ctx.effect(() => ctx.subagents.registerContinuableSetup((childCtx, owner) => {
    if (owner?.controller !== 'dag') return () => {}
    const disposers = [
      childCtx.tools.restrict({ deny: DISPATCHER_TOOLS }),
      childCtx.tools.register(childStatusTool(dag)),
      childCtx.tools.register(childCompleteTool(dag)),
      childCtx.tools.register(childBlockTool(dag)),
      childCtx.systemPrompt.section({
        name: 'dag:child',
        order: 46,
        text: 'You are a DAG child. You can read the graph and your execution facts, but you cannot control other nodes. End successful work with dag_node_complete. End work that cannot continue with dag_node_block. A stop cancels the current turn. Steering cancels and replaces the current work.',
      }),
    ]
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }), 'tool-dag: owner-bound child setup')
}
