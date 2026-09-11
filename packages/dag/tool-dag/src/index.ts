/** Model tools for native DAG dispatchers and owner-bound DAG children. @module @deepseek-ai/dsh-tool-dag */

import type { Context } from '@deepseek-ai/cordis'
import { DagNodeId } from '@deepseek-ai/dsh-dag'
import type { DagCommandAccepted, DagProjection, DagService } from '@deepseek-ai/dsh-dag'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'tool-dag'
export const inject = ['tools', 'dag', 'systemPrompt']

/** Full tool set exposed only to a DAG dispatcher. */
export const DISPATCHER_TOOLS = [
  'dag_write',
  'dag_node_amend',
  'dag_dispatch',
  'dag_wait',
  'dag_status',
  'dag_node_inspect',
  'dag_node_redispatch',
  'dag_node_resume',
  'dag_node_steer',
  'dag_node_stop',
  'dag_node_reset',
] as const

const acceptedSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    accepted: { type: 'boolean' as const, required: true as const },
    revision: { type: 'integer' as const, required: true as const },
    operationId: { type: 'string' as const, required: true as const },
  },
} as const satisfies ValueSchemaSpec

const textSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: { text: { type: 'string' as const, required: true as const } },
} as const satisfies ValueSchemaSpec

/** Register dispatcher tools and their prompt instructions. */
export function apply(ctx: Context): void {
  registerDispatcherTools(ctx)
  ctx.systemPrompt.section({
    name: 'dag:dispatcher',
    order: 46,
    text: 'Use the DAG tools for dependency work. After dispatch, call dag_wait with the last revision. Do not poll dag_status. A command response means that the command was accepted; Git and child effects continue in the background.',
  })
}

/** Register the full dispatcher command set. */
function registerDispatcherTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'dag_write',
    description: 'Declare or amend the complete dependency graph. Send every node on each call. An existing node repeats its live status and may correct its declared fields; omitting a node drops it and removes it from every surviving dependent. Use dag_node_amend to correct one node without re-sending the graph.',
    parameters: {
      nodes: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            content: { type: 'string', required: true },
            brief: { type: 'string', required: true, description: 'Must contain VALIDATION: and ACCEPTANCE: sections.' },
            deps: { type: 'array', required: true, items: { type: 'string' } },
            status: { type: 'string', required: true, enum: ['pending', 'starting', 'in_progress', 'completed', 'blocked', 'failed', 'interrupted'] },
            kind: { type: 'string', enum: ['task', 'integration'] },
            policy: { type: 'string', enum: ['delegate', 'ours', 'theirs'] },
            files: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      if_revision: { type: 'integer' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, properties: {
          accepted: { type: 'boolean', required: true },
          revision: { type: 'integer', required: true },
          operationId: { type: 'string', required: true },
          dropped: {
            type: 'array', required: true, items: {
              type: 'object', additionalProperties: false, properties: {
                id: { type: 'string', required: true },
                childSessionId: { type: 'string' },
                branch: { type: 'string' },
                worktree: { type: 'string' },
              },
            },
          },
          amended: {
            type: 'array', required: true, items: {
              type: 'object', additionalProperties: false, properties: {
                id: { type: 'string', required: true },
                fields: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          rewired: {
            type: 'array', required: true, items: {
              type: 'object', additionalProperties: false, properties: {
                id: { type: 'string', required: true },
                removedDeps: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          conflicts: {
            type: 'array', required: true, items: {
              type: 'object', additionalProperties: false, properties: {
                ids: { type: 'array', required: true, items: { type: 'string' } },
                files: { type: 'array', required: true, items: { type: 'string' } },
                reason: {
                  type: 'string', required: true,
                  enum: ['declared-files-overlap', 'contract-pin-overlap'],
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `DAG declaration accepted at revision ${value.revision}; ${value.amended.length} amended node(s), ${value.rewired.length} rewired node(s), ${value.conflicts.length} advisory conflict row(s).`,
      }],
    },
    execute(args, exec) {
      const agent = requireAgent(exec.agent, 'dag_write')
      const result = ctx.dag.write(agent, {
        nodes: args.nodes,
        ...args.if_revision === undefined ? {} : { if_revision: args.if_revision },
      })
      return Promise.resolve({
        accepted: true,
        revision: result.revision,
        operationId: result.operationId,
        dropped: result.dropped.map(row => ({
          id: row.id,
          ...row.childSessionId === undefined ? {} : { childSessionId: row.childSessionId },
          ...row.branch === undefined ? {} : { branch: row.branch },
          ...row.worktree === undefined ? {} : { worktree: row.worktree },
        })),
        amended: result.amended.map(row => ({ id: row.id, fields: [...row.fields] })),
        rewired: result.rewired.map(row => ({ id: row.id, removedDeps: [...row.removedDeps] })),
        conflicts: result.conflicts.map(row => ({ ids: [...row.ids], files: [...row.files], reason: row.reason })),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dag_node_amend',
    description: 'Correct the declared fields of one node without re-sending the graph. Omitted fields keep their value; the node keeps its id, status, recorded Git facts, completed work, and dependents.',
    parameters: {
      node_id: { type: 'string', required: true },
      content: { type: 'string' },
      brief: { type: 'string', description: 'Must contain VALIDATION: and ACCEPTANCE: sections.' },
      deps: { type: 'array', items: { type: 'string' } },
      kind: { type: 'string', enum: ['task', 'integration'] },
      policy: { type: 'string', enum: ['delegate', 'ours', 'theirs'] },
      files: { type: 'array', items: { type: 'string' } },
      if_revision: { type: 'integer' },
    },
    output: acceptedOutput('DAG amendment accepted'),
    execute(args, exec) {
      const agent = requireAgent(exec.agent, 'dag_node_amend')
      return Promise.resolve(acceptance(ctx.dag.amend(agent, DagNodeId(args.node_id), {
        ...args.content === undefined ? {} : { content: args.content },
        ...args.brief === undefined ? {} : { brief: args.brief },
        ...args.deps === undefined ? {} : { deps: args.deps },
        ...args.kind === undefined ? {} : { kind: args.kind },
        ...args.policy === undefined ? {} : { policy: args.policy },
        ...args.files === undefined ? {} : { files: args.files },
        ...guard(args),
      })))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dag_dispatch',
    description: 'Start distinct dependency-ready pending nodes. The response does not wait for Git or child creation.',
    parameters: {
      node_ids: { type: 'array', required: true, items: { type: 'string' } },
      if_revision: { type: 'integer' },
    },
    output: acceptedOutput('DAG dispatch accepted'),
    execute: (args, exec) => Promise.resolve(acceptance(ctx.dag.dispatch(
      requireAgent(exec.agent, 'dag_dispatch'),
      args.node_ids.map(DagNodeId),
      args.if_revision === undefined ? {} : { if_revision: args.if_revision },
    ))),
  }))

  ctx.tools.register(defineTool({
    name: 'dag_wait',
    description: 'Wait until a later actionable DAG notice has been injected. Use this after dispatch instead of status polling.',
    parameters: { after_revision: { type: 'integer', required: true } },
    output: textOutput('notice'),
    async execute(args, exec) {
      const result = await ctx.dag.wait(requireAgent(exec.agent, 'dag_wait'), args.after_revision, exec.signal)
      return { text: JSON.stringify({ revision: result.revision, notices: result.notices, state: result.state }) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dag_status',
    description: 'Read the current DAG board. Use dag_wait, not repeated status calls, while work runs.',
    parameters: {},
    output: textOutput('status'),
    execute(_args, exec) {
      const status = ctx.dag.status(requireAgent(exec.agent, 'dag_status'))
      return Promise.resolve({ text: status === null ? 'No DAG declaration.' : renderStatus(status) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dag_node_inspect',
    description: 'Inspect one node, including its durable child and local Git execution facts.',
    parameters: { node_id: { type: 'string', required: true } },
    output: textOutput('node'),
    execute(args, exec) {
      const node = ctx.dag.inspect(requireAgent(exec.agent, 'dag_node_inspect'), DagNodeId(args.node_id))
      const safe = {
        id: node.id, content: node.content, brief: node.brief, deps: node.deps, kind: node.kind, policy: node.policy,
        files: node.files, status: node.status, generation: node.generation,
        bindingGeneration: node.bindingGeneration,
        ...node.childSessionId === undefined ? {} : { childSessionId: node.childSessionId },
        ...node.branch === undefined ? {} : { branch: node.branch },
        ...node.worktree === undefined ? {} : { worktree: node.worktree },
        ...node.waveId === undefined ? {} : { waveId: node.waveId },
        ...node.frozenWaveBase === undefined ? {} : { frozenWaveBase: node.frozenWaveBase },
        dependencyCommits: node.dependencyCommits,
        conflictedFiles: node.conflictedFiles,
        ...node.settlement === undefined ? {} : { settlement: node.settlement },
        ...node.completedCommit === undefined ? {} : { completedCommit: node.completedCommit },
        ...node.preparedHead === undefined ? {} : { preparedHead: node.preparedHead },
        ...node.preparedFrom === undefined ? {} : { preparedFrom: node.preparedFrom },
        ...node.currentOperationId === undefined ? {} : { currentOperationId: node.currentOperationId },
        commands: node.commands,
      }
      return Promise.resolve({ text: JSON.stringify(safe) })
    },
  }))

  registerNodeCommand(ctx, 'dag_node_redispatch', 'Re-arm one failed node as pending for a later dag_dispatch call.', {}, (agent, nodeId, _args) => ctx.dag.redispatch(agent, nodeId, guard(_args)))
  registerNodeCommand(ctx, 'dag_node_resume', 'Resume one blocked, interrupted, or failed node with new instructions.', {
    message: { type: 'string', required: true },
  }, (agent, nodeId, args) => ctx.dag.resume(agent, nodeId, String(args['message']), guard(args)))
  registerNodeCommand(ctx, 'dag_node_steer', 'Interrupt and replace active node work. A suspended or failed node returns through starting.', {
    message: { type: 'string', required: true },
  }, (agent, nodeId, args) => ctx.dag.steer(agent, nodeId, String(args['message']), guard(args)))
  registerNodeCommand(ctx, 'dag_node_stop', 'Commit interrupted state, then cancel the node child.', {
    reason: { type: 'string' },
  }, (agent, nodeId, args) => {
    const reason = args['reason']
    return ctx.dag.stop(agent, nodeId, typeof reason === 'string' ? reason : undefined, guard(args))
  })
  registerNodeCommand(ctx, 'dag_node_reset', 'Reset tracked worktree state to the frozen base, an exact commit, or a local refs/heads ref. Untracked files remain.', {
    target: { type: 'string', required: true },
  }, (agent, nodeId, args) => ctx.dag.reset(agent, nodeId, String(args['target']), guard(args)))
}

/** Register one standard node-id mutation tool. */
function registerNodeCommand(
  ctx: Context,
  toolName: string,
  description: string,
  extra: Record<string, { type: 'string'; required?: true }>,
  run: (
    agent: NonNullable<Parameters<typeof requireAgent>[0]>,
    nodeId: ReturnType<typeof DagNodeId>,
    args: Record<string, unknown>,
  ) => DagCommandAccepted,
): void {
  ctx.tools.register(defineTool({
    name: toolName,
    description,
    parameters: {
      node_id: { type: 'string', required: true },
      ...extra,
      if_revision: { type: 'integer' },
    },
    output: acceptedOutput(`${toolName} accepted`),
    execute(args, exec) {
      return Promise.resolve(acceptance(run(requireAgent(exec.agent, toolName), DagNodeId(args.node_id), args)))
    },
  }))
}

/**
 * Build the scoped status tool for one DAG child.
 * @param dag - Host DAG service that authorizes the child identity.
 * @returns Owner-bound status tool.
 */
export function childStatusTool(dag: DagService): ToolDefinition {
  return defineTool({
    name: 'dag_status',
    description: 'Read graph topology, dependency status, and your node execution facts.',
    parameters: {},
    output: textOutput('status'),
    execute(_args, exec) {
      const child = requireAgent(exec.agent, 'dag_status')
      return Promise.resolve({ text: JSON.stringify(dag.statusFrom(child)) })
    },
  })
}

/**
 * Build the scoped completion-report tool.
 * @param dag - Host DAG service that authorizes the child identity.
 * @returns Owner-bound completion tool.
 */
export function childCompleteTool(dag: DagService): ToolDefinition {
  return defineTool({
    name: 'dag_node_complete',
    description: 'Report committed clean work for local Git validation. This accepts the command; completion follows only after validation succeeds.',
    parameters: {
      summary: { type: 'string', required: true },
      artifacts: { type: 'array', items: { type: 'json' } },
    },
    output: acceptedOutput('DAG completion validation accepted'),
    execute(args, exec) {
      exec.signal.throwIfAborted()
      const accepted = dag.completeFrom(
        requireAgent(exec.agent, 'dag_node_complete'),
        args.summary,
        args.artifacts ?? [],
      )
      exec.concludeTurn()
      return Promise.resolve(acceptance(accepted))
    },
  })
}

/**
 * Build the scoped blocked-report tool.
 * @param dag - Host DAG service that authorizes the child identity.
 * @returns Owner-bound block tool.
 */
export function childBlockTool(dag: DagService): ToolDefinition {
  return defineTool({
    name: 'dag_node_block',
    description: 'Suspend this DAG node with a clear reason when work cannot continue.',
    parameters: { reason: { type: 'string', required: true } },
    output: acceptedOutput('DAG block accepted'),
    execute(args, exec) {
      exec.signal.throwIfAborted()
      const accepted = dag.blockFrom(requireAgent(exec.agent, 'dag_node_block'), args.reason)
      exec.concludeTurn()
      return Promise.resolve(acceptance(accepted))
    },
  })
}

/** Standard accepted-command output definition. */
function acceptedOutput(label: string) {
  return {
    schema: acceptedSchema,
    render: (_args: unknown, value: { revision: number; operationId: string }) => [{ type: 'text' as const, text: `${label} at revision ${value.revision} as ${value.operationId}.` }],
  }
}

/** Standard text output definition. */
function textOutput(label: string) {
  return {
    schema: textSchema,
    render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: `${label}: ${value.text}` }],
  }
}

/** Detach one service acknowledgement for tool output. */
function acceptance(result: DagCommandAccepted) {
  return { accepted: result.accepted, revision: result.revision, operationId: result.operationId }
}

/** Build an optional compare-and-set guard from generic tool arguments. */
function guard(args: Record<string, unknown>): { if_revision?: number } {
  return typeof args['if_revision'] === 'number' ? { if_revision: args['if_revision'] } : {}
}

/** Require an owning live Agent at a model tool call. */
function requireAgent(agent: import('@deepseek-ai/dsh-agent').Agent | undefined, toolName: string): import('@deepseek-ai/dsh-agent').Agent {
  if (agent === undefined) throw new Error(`${toolName} requires an owning agent`)
  return agent
}

/** Render a compact safe dispatcher board. */
function renderStatus(status: DagProjection): string {
  return JSON.stringify({
    revision: status.revision,
    counts: status.counts,
    ready: status.readyNodeIds,
    nodes: status.nodes.map(node => ({ id: node.id, deps: node.deps, status: node.status, generation: node.generation })),
    waves: status.openWaves.map(wave => ({ id: wave.id, status: wave.status, pending: wave.pendingNodeIds })),
  })
}
