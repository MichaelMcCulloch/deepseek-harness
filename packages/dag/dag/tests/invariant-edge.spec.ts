import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import * as DagInvariant from '../src/invariant.ts'
import {
  DagCommandId,
  DagNodeId,
  DagOperationId,
} from '../src/ids.ts'
import { reduceDagState } from '../src/reducer.ts'
import type { DagReducerCommand, DagStartEvidence } from '../src/reducer.ts'
import type {
  DagNodeCommand,
  DagNodeInput,
  DagNodeSnapshot,
  DagNodeStatus,
  DagOperationReceipt,
  DagState,
  DagStatusCounts,
} from '../src/types.ts'
import { validateDagDeclaration } from '../src/validation.ts'

const brief = 'VALIDATION: run tests.\nACCEPTANCE: commit clean work.'
const baseCommit = '1'.repeat(40)
const preparedCommit = '2'.repeat(40)
const completedCommit = '3'.repeat(40)

function input(id: string, deps: readonly string[] = []): DagNodeInput {
  return {
    id,
    content: `Do ${id}`,
    brief,
    deps,
    status: 'pending',
    files: [`src/${id}.ts`],
  }
}

function writeCommand(inputs: readonly DagNodeInput[]): Extract<DagReducerCommand, { readonly type: 'write' }> {
  const declaration = validateDagDeclaration(inputs)
  return {
    type: 'write',
    noticeNamespace: 'invariant-dispatcher',
    nodes: declaration.definitions.map(definition => ({ definition, status: 'pending' })),
    topologicalOrder: declaration.topologicalOrder,
  }
}

function step(previous: DagState | null, command: DagReducerCommand): DagState {
  return reduceDagState(previous, command).state
}

function initial(inputs: readonly DagNodeInput[] = [input('a')]): DagState {
  return step(null, writeCommand(inputs))
}

function advance(state: DagState): DagState {
  return { ...state, revision: state.revision + 1 }
}

function expectInvalid(previous: DagState | null, state: DagState, message: RegExp): void {
  expect(() => { DagInvariant.validateDagState(previous, state) }).toThrow(message)
}

function statusCounts(nodes: readonly DagNodeSnapshot[]): DagStatusCounts {
  const counts: Record<DagNodeStatus, number> = {
    pending: 0,
    starting: 0,
    in_progress: 0,
    completed: 0,
    blocked: 0,
    failed: 0,
    interrupted: 0,
  }
  for (const node of nodes) counts[node.status]++
  return counts
}

function replaceFirst(state: DagState, node: DagNodeSnapshot): DagState {
  return { ...state, nodes: [node, ...state.nodes.slice(1)] }
}

interface Workflow {
  readonly declared: DagState
  readonly dispatched: DagState
  readonly probed: DagState
  readonly prepared: DagState
  readonly started: DagState
  readonly completionAccepted: DagState
  readonly completed: DagState
}

function workflow(): Workflow {
  const declared = initial()
  const dispatched = step(declared, {
    type: 'dispatch',
    nodeIds: [DagNodeId('a')],
    bindings: { a: { childSessionId: SessionId('child-a'), branch: 'branch-a', worktree: '/tmp/a' } },
  })
  const dispatchNode = dispatched.nodes[0]!
  const dispatchCommand = dispatchNode.commands[0]!
  const fence = {
    nodeId: dispatchNode.id,
    commandId: dispatchCommand.id,
    generation: dispatchCommand.generation,
    bindingGeneration: dispatchCommand.bindingGeneration,
    operationId: dispatchCommand.operationId,
  }
  const probed = step(dispatched, {
    type: 'wave-probed',
    waveId: dispatchNode.waveId!,
    fences: [fence],
    branch: 'main',
    head: baseCommit,
  })
  const evidence: DagStartEvidence = {
    branch: 'branch-a',
    worktree: '/tmp/a',
    frozenWaveBase: baseCommit,
    preparedFrom: baseCommit,
    preparedHead: preparedCommit,
    dependencyCommits: [],
    conflictedFiles: [],
    childSessionId: SessionId('child-a'),
  }
  const prepared = step(probed, { type: 'git-prepared', ...fence, evidence })
  const started = step(prepared, { type: 'start-succeeded', ...fence, evidence })
  const completionAccepted = step(started, {
    type: 'complete', nodeId: dispatchNode.id, summary: 'done', artifacts: [],
  })
  const completion = completionAccepted.nodes[0]!.commands.at(-1)!
  const completed = step(completionAccepted, {
    type: 'completion-succeeded',
    nodeId: dispatchNode.id,
    commandId: completion.id,
    generation: completion.generation,
    bindingGeneration: completion.bindingGeneration,
    operationId: completion.operationId,
    evidence: { commit: completedCommit },
  })
  return { declared, dispatched, probed, prepared, started, completionAccepted, completed }
}

function failedProbe(): { readonly declared: DagState; readonly dispatched: DagState; readonly failed: DagState } {
  const declared = initial()
  const dispatched = step(declared, {
    type: 'dispatch',
    nodeIds: [DagNodeId('a')],
    bindings: { a: { childSessionId: SessionId('child-a'), branch: 'branch-a', worktree: '/tmp/a' } },
  })
  const node = dispatched.nodes[0]!
  const command = node.commands[0]!
  const failed = step(dispatched, {
    type: 'wave-probe-failed',
    waveId: node.waveId!,
    fences: [{
      nodeId: node.id,
      commandId: command.id,
      generation: command.generation,
      bindingGeneration: command.bindingGeneration,
      operationId: command.operationId,
    }],
    reason: 'probe failed',
  })
  return { declared, dispatched, failed }
}

function acceptedCandidate(
  previous: DagState,
  cause: string,
  nextStatus: DagNodeStatus,
  nodeIds: readonly ReturnType<typeof DagNodeId>[] = [previous.nodes[0]!.id],
): DagState {
  const counter = previous.operationCounter + 1
  const receipt: DagOperationReceipt = {
    id: DagOperationId(`op-${counter}`),
    cause,
    acceptedRevision: previous.revision + 1,
    nodeIds,
  }
  const nodes = previous.nodes.map((node, index) => index === 0 ? { ...node, status: nextStatus } : node)
  return {
    ...previous,
    revision: previous.revision + 1,
    graphGeneration: previous.graphGeneration + (cause === 'write' ? 1 : 0),
    operationCounter: counter,
    nodes,
    receipts: [...previous.receipts, receipt],
  }
}

describe('DAG invariant accepted histories', () => {
  it('accepts generated public operations, effects, notices, and wave settlement', () => {
    const flow = workflow()
    DagInvariant.validateDagState(null, flow.declared)
    for (const [previous, next] of [
      [flow.declared, flow.dispatched],
      [flow.dispatched, flow.probed],
      [flow.probed, flow.prepared],
      [flow.prepared, flow.started],
      [flow.started, flow.completionAccepted],
      [flow.completionAccepted, flow.completed],
    ] as const) DagInvariant.validateDagState(previous, next)

    const rewritten = step(flow.declared, writeCommand([input('a')]))
    DagInvariant.validateDagState(flow.declared, rewritten)

    const fault = failedProbe()
    DagInvariant.validateDagState(fault.dispatched, fault.failed)
    const redispatched = step(fault.failed, { type: 'redispatch', nodeId: DagNodeId('a') })
    DagInvariant.validateDagState(fault.failed, redispatched)
    const failedReset = step(fault.failed, { type: 'reset', nodeId: DagNodeId('a'), target: baseCommit })
    DagInvariant.validateDagState(fault.failed, failedReset)

    const corrected = step(flow.declared, {
      type: 'amend',
      nodeId: DagNodeId('a'),
      definition: { ...flow.declared.nodes[0]!, content: 'Corrected a' },
      topologicalOrder: [DagNodeId('a')],
    })
    DagInvariant.validateDagState(flow.declared, corrected)
    const failedNode = replaceFirst(flow.started, { ...flow.started.nodes[0]!, status: 'failed' })
    DagInvariant.validateDagState(failedNode, step(failedNode, { type: 'resume', nodeId: DagNodeId('a'), message: 'Try again.' }))
    DagInvariant.validateDagState(failedNode, step(failedNode, { type: 'steer', nodeId: DagNodeId('a'), message: 'Replace.' }))

    const reset = step(flow.declared, { type: 'reset', nodeId: DagNodeId('a'), target: baseCommit })
    DagInvariant.validateDagState(flow.declared, reset)
    const resetCommand = reset.nodes[0]!.commands.at(-1)!
    const resetSettled = step(reset, {
      type: 'command-settled', nodeId: DagNodeId('a'), commandId: resetCommand.id,
      generation: resetCommand.generation, bindingGeneration: resetCommand.bindingGeneration,
      operationId: resetCommand.operationId,
    })
    DagInvariant.validateDagState(reset, resetSettled)

    const blocked = step(flow.started, { type: 'block', nodeId: DagNodeId('a'), reason: 'wait' })
    DagInvariant.validateDagState(flow.started, blocked)
    for (const command of [
      { type: 'resume' as const, nodeId: DagNodeId('a'), message: 'continue' },
      { type: 'steer' as const, nodeId: DagNodeId('a'), message: 'change' },
      { type: 'stop' as const, nodeId: DagNodeId('a'), reason: 'stop' },
    ]) DagInvariant.validateDagState(blocked, step(blocked, command))
    DagInvariant.validateDagState(flow.started, step(flow.started, {
      type: 'steer', nodeId: DagNodeId('a'), message: 'change',
    }))
    DagInvariant.validateDagState(flow.started, step(flow.started, {
      type: 'stop', nodeId: DagNodeId('a'), reason: 'stop',
    }))
    DagInvariant.validateDagState(flow.dispatched, step(flow.dispatched, {
      type: 'stop', nodeId: DagNodeId('a'), reason: 'stop',
    }))

    const notice = fault.failed.notices[0]!
    const delivered = step(fault.failed, { type: 'notice-delivered', noticeId: notice.id })
    DagInvariant.validateDagState(fault.failed, delivered)
    DagInvariant.validateDagState(flow.probed, advance(flow.probed))
  })
})

describe('DAG invariant state and accepted-edge validation', () => {
  it('rejects invalid state counters, namespaces, and receipt deltas', () => {
    const declared = initial()
    const next = advance(declared)
    for (const [candidate, message] of [
      [{ ...declared, version: 0 }, /state version/],
      [{ ...declared, noticeNamespace: ' ' }, /noticeNamespace/],
      [{ ...declared, revision: 0 }, /revision/],
      [{ ...declared, revision: 1.5 }, /revision/],
      [{ ...declared, graphGeneration: 0 }, /graphGeneration/],
      [{ ...declared, graphGeneration: 1.5 }, /graphGeneration/],
      [{ ...declared, operationCounter: 0 }, /operationCounter/],
      [{ ...declared, operationCounter: 1.5 }, /operationCounter/],
      [{ ...declared, receipts: [] }, /operation delta/],
    ] as const) expectInvalid(null, candidate, message)

    for (const [candidate, message] of [
      [{ ...next, noticeNamespace: 'other' }, /noticeNamespace changed/],
      [{ ...next, revision: declared.revision }, /does not follow/],
      [{ ...next, graphGeneration: declared.graphGeneration + 2 }, /graphGeneration.*monotonic/],
      [{ ...next, operationCounter: declared.operationCounter + 2 }, /at most one operation/],
      [{ ...next, operationCounter: declared.operationCounter + 1 }, /operation delta/],
    ] as const) expectInvalid(declared, candidate, message)
    const rewritten = step(declared, writeCommand([input('a')]))
    expectInvalid(rewritten, { ...advance(rewritten), graphGeneration: declared.graphGeneration }, /graphGeneration.*monotonic/)
    const dispatched = workflow().dispatched
    expectInvalid(dispatched, { ...advance(dispatched), operationCounter: declared.operationCounter }, /operationCounter regressed/)
  })

  it('rejects malformed new receipts and graph-generation changes', () => {
    const declared = initial()
    const accepted = acceptedCandidate(declared, 'reset', 'pending')
    const receipt = accepted.receipts.at(-1)!
    expectInvalid(declared, { ...accepted, receipts: [...declared.receipts, { ...receipt, cause: 'unknown' }] }, /unknown operation cause/)
    expectInvalid(declared, {
      ...accepted,
      receipts: [...declared.receipts, { ...receipt, acceptedRevision: accepted.revision + 1 }],
    }, /does not name its snapshot revision/)
    expectInvalid(declared, { ...accepted, receipts: [...declared.receipts, { ...receipt, nodeIds: [DagNodeId('a'), DagNodeId('a')] }] }, /repeats node ids/)
    expectInvalid(null, { ...declared, receipts: [{ ...declared.receipts[0]!, cause: 'reset' }] }, /first DAG snapshot/)
    expectInvalid(null, { ...declared, graphGeneration: 2 }, /graphGeneration must increase exactly/)
    expectInvalid(declared, {
      ...advance(declared), graphGeneration: declared.graphGeneration + 1,
    }, /graphGeneration must increase exactly/)
    expectInvalid(declared, { ...acceptedCandidate(declared, 'write', 'pending'), graphGeneration: declared.graphGeneration }, /graphGeneration must increase exactly/)
  })

  it('rejects every invalid accepted node edge', () => {
    const base = initial()
    const prior = (status: DagNodeStatus): DagState => replaceFirst(base, { ...base.nodes[0]!, status })
    const cases: readonly [string, DagNodeStatus, DagNodeStatus][] = [
      ['write', 'pending', 'failed'],
      ['dispatch', 'blocked', 'starting'],
      ['dispatch', 'pending', 'in_progress'],
      ['redispatch', 'pending', 'pending'],
      ['redispatch', 'failed', 'starting'],
      ['resume', 'pending', 'starting'],
      ['resume', 'blocked', 'pending'],
      ['resume', 'interrupted', 'pending'],
      ['steer', 'pending', 'starting'],
      ['steer', 'in_progress', 'starting'],
      ['steer', 'blocked', 'pending'],
      ['steer', 'interrupted', 'pending'],
      ['stop', 'pending', 'interrupted'],
      ['stop', 'starting', 'pending'],
      ['stop', 'in_progress', 'pending'],
      ['stop', 'blocked', 'pending'],
      ['reset', 'in_progress', 'in_progress'],
      ['reset', 'pending', 'failed'],
      ['reset', 'failed', 'pending'],
      ['complete', 'pending', 'in_progress'],
      ['complete', 'in_progress', 'completed'],
      ['block', 'pending', 'blocked'],
      ['block', 'in_progress', 'failed'],
    ]
    for (const [cause, before, after] of cases) {
      expectInvalid(prior(before), acceptedCandidate(prior(before), cause, after), /does not match accepted/)
    }

    const injected = { ...base.nodes[0]!, id: DagNodeId('b'), status: 'starting' as const }
    const candidate = acceptedCandidate(base, 'dispatch', 'pending', [injected.id])
    expectInvalid(base, {
      ...candidate,
      nodes: [...candidate.nodes, injected],
      topologicalOrder: [...candidate.topologicalOrder, injected.id],
    }, /appeared without a write operation/)
  })
})

describe('DAG invariant node and mailbox validation', () => {
  it('rejects duplicate nodes and every invalid node-generation form', () => {
    const declared = initial()
    const candidate = advance(declared)
    expectInvalid(declared, { ...candidate, nodes: [candidate.nodes[0]!, candidate.nodes[0]!] }, /duplicate node/)
    for (const value of [
      { generation: 0.5 },
      { bindingGeneration: 0.5 },
      { generation: -1 },
      { bindingGeneration: -1 },
      { generation: 0, bindingGeneration: 1 },
    ]) expectInvalid(declared, replaceFirst(candidate, { ...candidate.nodes[0]!, ...value }), /invalid generations/)
  })

  it('rejects definition, lifecycle, and generation mutations', () => {
    const declared = initial()
    const node = declared.nodes[0]!
    expectInvalid(declared, replaceFirst(advance(declared), { ...node, content: 'changed' }), /changed its definition without a declaration operation/)
    expectInvalid(declared, replaceFirst(advance(declared), { ...node, status: 'completed', completedCommit }), /illegal edge/)
    expectInvalid(declared, replaceFirst(advance(declared), { ...node, generation: 2, bindingGeneration: 2 }), /changed generations/)

    const prior = replaceFirst(declared, { ...node, generation: 1, bindingGeneration: 1 })
    expectInvalid(prior, replaceFirst(advance(prior), { ...prior.nodes[0]!, generation: 2, bindingGeneration: 1 }), /changed generations/)
    expectInvalid(declared, acceptedCandidate(declared, 'dispatch', 'starting'), /generation does not match/)
    const complete = acceptedCandidate(replaceFirst(declared, { ...node, status: 'in_progress' }), 'complete', 'in_progress')
    expectInvalid(replaceFirst(declared, { ...node, status: 'in_progress' }), replaceFirst(complete, {
      ...complete.nodes[0]!, generation: 1, bindingGeneration: 1,
    }), /generation does not match/)
  })

  it('rejects removed, rewritten, and backward mailbox history', () => {
    const flow = workflow()
    const command = flow.dispatched.nodes[0]!.commands[0]!
    expectInvalid(flow.dispatched, replaceFirst(advance(flow.dispatched), {
      ...flow.dispatched.nodes[0]!, commands: [],
    }), /removed mailbox history/)

    const rewrites: readonly Partial<DagNodeCommand>[] = [
      { id: DagCommandId('other') },
      { operationId: DagOperationId('other') },
      { kind: 'reset' },
      { generation: command.generation + 1 },
      { bindingGeneration: command.bindingGeneration - 1 },
      { message: 'changed' },
      { target: baseCommit },
      { acceptedRevision: command.acceptedRevision + 1 },
    ]
    for (const rewrite of rewrites) expectInvalid(flow.dispatched, replaceFirst(advance(flow.dispatched), {
      ...flow.dispatched.nodes[0]!, commands: [{ ...command, ...rewrite }],
    }), /rewrote mailbox history/)

    const fault = failedProbe()
    expectInvalid(fault.failed, replaceFirst(advance(fault.failed), {
      ...fault.failed.nodes[0]!, commands: [{ ...fault.failed.nodes[0]!.commands[0]!, outcome: 'succeeded' }],
    }), /changed a settled command/)
    const running = step(flow.dispatched, {
      type: 'command-running',
      nodeId: DagNodeId('a'),
      commandId: command.id,
      generation: command.generation,
      bindingGeneration: command.bindingGeneration,
      operationId: command.operationId,
    })
    expectInvalid(running, replaceFirst(advance(running), {
      ...running.nodes[0]!, commands: [{ ...running.nodes[0]!.commands[0]!, state: 'accepted' }],
    }), /moved a running command backward/)
  })

  it('requires accepted operations for all public-only status edges', () => {
    const declared = initial()
    const node = declared.nodes[0]!
    for (const [before, after] of [
      ['pending', 'starting'],
      ['failed', 'pending'],
      ['failed', 'starting'],
      ['blocked', 'starting'],
      ['interrupted', 'starting'],
      ['starting', 'interrupted'],
      ['in_progress', 'interrupted'],
      ['blocked', 'interrupted'],
      ['in_progress', 'blocked'],
    ] as const) {
      const previous = replaceFirst(declared, { ...node, status: before })
      const candidate = replaceFirst(advance(previous), { ...node, status: after })
      expectInvalid(previous, candidate, /without an accepted operation/)
    }
  })

  it('requires immutable completion, binding, and Git evidence', () => {
    const flow = workflow()
    expectInvalid(flow.completed, replaceFirst(advance(flow.completed), {
      ...flow.completed.nodes[0]!, completedCommit: '4'.repeat(40),
    }), /changed its commit/)
    const { completedCommit: _completedCommit, ...completedWithoutCommit } = flow.started.nodes[0]!
    expectInvalid(flow.started, replaceFirst(advance(flow.started), {
      ...completedWithoutCommit, status: 'completed',
    }), /lacks Git evidence/)
    expectInvalid(flow.started, replaceFirst(advance(flow.started), {
      ...flow.started.nodes[0]!, status: 'completed', completedCommit: 'bad',
    }), /invalid completion Git evidence/)

    const declared = initial()
    for (const binding of [
      { childSessionId: SessionId('child') },
      { branch: 'branch' },
      { worktree: '/tmp/a' },
    ]) expectInvalid(declared, replaceFirst(advance(declared), {
      ...declared.nodes[0]!, ...binding,
    }), /incomplete child binding/)

    const completed = flow.completed.nodes[0]!
    const { frozenWaveBase: _frozenWaveBase, ...completedWithoutBase } = completed
    expectInvalid(
      flow.completionAccepted,
      replaceFirst(flow.completed, completedWithoutBase),
      /lacks prepared Git or child settlement evidence/,
    )
    const { preparedHead: _preparedHead, ...completedWithoutPreparedHead } = completed
    expectInvalid(
      flow.completionAccepted,
      replaceFirst(flow.completed, completedWithoutPreparedHead),
      /lacks prepared Git or child settlement evidence/,
    )
    expectInvalid(flow.completionAccepted, replaceFirst(flow.completed, {
      ...completed, settlement: { kind: 'failed', reason: 'bad' },
    }), /lacks prepared Git or child settlement evidence/)

    expectInvalid(flow.probed, replaceFirst(advance(flow.probed), {
      ...flow.probed.nodes[0]!, frozenWaveBase: 'bad',
    }), /invalid frozen wave evidence/)
    expectInvalid(flow.probed, replaceFirst(advance(flow.probed), {
      ...flow.probed.nodes[0]!, dependencyCommits: [baseCommit],
    }), /invalid frozen wave evidence/)
    expectInvalid(declared, replaceFirst(advance(declared), {
      ...declared.nodes[0]!, preparedHead: preparedCommit,
    }), /invalid prepared Git evidence/)
    expectInvalid(flow.probed, replaceFirst(advance(flow.probed), {
      ...flow.probed.nodes[0]!, preparedHead: 'bad',
    }), /invalid prepared Git evidence/)
    expectInvalid(flow.prepared, replaceFirst(advance(flow.prepared), {
      ...flow.prepared.nodes[0]!, preparedFrom: 'bad',
    }), /invalid pre-preparation Git evidence/)
    expectInvalid(declared, replaceFirst(advance(declared), {
      ...declared.nodes[0]!, preparedFrom: baseCommit,
    }), /invalid pre-preparation Git evidence/)
  })

  it('corrects declarations only through write or amend operations', () => {
    const flow = workflow()
    const node = flow.prepared.nodes[0]!
    const amended = (overrides: Partial<DagNodeSnapshot>): DagState => {
      const counter = flow.prepared.operationCounter + 1
      return advance({
        ...flow.prepared,
        operationCounter: counter,
        receipts: [...flow.prepared.receipts, {
          id: DagOperationId(`op-${counter}`),
          cause: 'amend',
          acceptedRevision: flow.prepared.revision + 1,
          nodeIds: [node.id],
        }],
        nodes: [{ ...node, ...overrides }, ...flow.prepared.nodes.slice(1)],
      })
    }
    DagInvariant.validateDagState(flow.prepared, amended({ content: 'Corrected a' }))
    expectInvalid(flow.prepared, amended({ deps: [DagNodeId('b')] }), /changed dependencies after recording local Git preparation/)
    expectInvalid(flow.prepared, amended({ content: 'Corrected a', status: 'in_progress' }), /does not match accepted amend operation/)
  })

  it('rejects duplicate, malformed, concurrent, and unfenced commands', () => {
    const declared = initial([input('a'), input('b')])
    const dispatched = step(declared, {
      type: 'dispatch',
      nodeIds: [DagNodeId('a'), DagNodeId('b')],
      bindings: {
        a: { childSessionId: SessionId('a'), branch: 'a', worktree: '/tmp/a' },
        b: { childSessionId: SessionId('b'), branch: 'b', worktree: '/tmp/b' },
      },
    })
    const first = dispatched.nodes[0]!
    const second = dispatched.nodes[1]!
    expectInvalid(declared, {
      ...dispatched,
      nodes: [first, { ...second, commands: [{ ...second.commands[0]!, id: first.commands[0]!.id }] }],
    }, /duplicate command/)

    const command = first.commands[0]!
    for (const mutation of [
      { generation: 0.5 },
      { bindingGeneration: 0.5 },
      { bindingGeneration: -1 },
      { generation: 0, bindingGeneration: 1 },
    ]) expectInvalid(declared, replaceFirst(dispatched, {
      ...first, commands: [{ ...command, ...mutation }],
    }), /command.*invalid generations/)
    for (const acceptedRevision of [0, dispatched.revision + 1]) expectInvalid(declared, replaceFirst(dispatched, {
      ...first, commands: [{ ...command, acceptedRevision }],
    }), /invalid accepted revision/)

    const secondActive: DagNodeCommand = {
      ...command,
      id: DagCommandId('op-2-a-g1-resume'),
      kind: 'resume',
    }
    expectInvalid(declared, replaceFirst(dispatched, { ...first, commands: [command, secondActive] }), /more than one active command/)

    for (const mutation of [
      { commands: [{ ...command, generation: 0, bindingGeneration: 0 }] },
      { commands: [{ ...command, bindingGeneration: 0 }] },
      { currentOperationId: DagOperationId('other') },
    ]) expectInvalid(declared, replaceFirst(dispatched, { ...first, ...mutation }), /unfenced active command/)
  })

  it('rejects incompatible active commands and invalid current operation links', () => {
    const flow = workflow()
    expectInvalid(flow.dispatched, replaceFirst(advance(flow.dispatched), {
      ...flow.dispatched.nodes[0]!, status: 'in_progress',
    }), /active dispatch command/)

    const invalidPrior = replaceFirst(flow.declared, {
      ...flow.declared.nodes[0]!, status: 'starting',
    })
    expectInvalid(invalidPrior, advance(invalidPrior), /lacks an active command/)

    const fault = failedProbe().failed
    const settled = fault.nodes[0]!.commands[0]!
    expectInvalid(fault, replaceFirst(advance(fault), {
      ...fault.nodes[0]!, currentOperationId: DagOperationId('missing'),
    }), /current operation/)
    expectInvalid(fault, replaceFirst(advance(fault), {
      ...fault.nodes[0]!,
      currentOperationId: settled.operationId,
      commands: [settled, { ...settled, id: DagCommandId('second') }],
    }), /current operation/)
  })
})

describe('DAG invariant topology and derived state validation', () => {
  it('rejects receipts that name unknown nodes or incomplete writes', () => {
    const declared = initial()
    expectInvalid(declared, acceptedCandidate(declared, 'reset', 'pending', [DagNodeId('missing')]), /receipt names an unknown node/)
    expectInvalid(declared, acceptedCandidate(declared, 'write', 'pending', []), /complete declaration/)
  })

  it('requires the topological order to contain each node once and remain stable', () => {
    const declared = initial([input('a'), input('b')])
    const next = advance(declared)
    expectInvalid(declared, { ...next, topologicalOrder: [DagNodeId('a')] }, /topologicalOrder/)
    expectInvalid(declared, { ...next, topologicalOrder: [DagNodeId('a'), DagNodeId('a')] }, /topologicalOrder/)
    expectInvalid(declared, { ...next, topologicalOrder: [DagNodeId('a'), DagNodeId('missing')] }, /topologicalOrder/)
    expectInvalid(declared, { ...next, topologicalOrder: [DagNodeId('b'), DagNodeId('a')] }, /changed without a write operation/)
  })

  it('rejects missing, reversed, and incomplete dependencies', () => {
    const declared = initial([input('a'), input('b')])
    const [a, b] = declared.nodes
    expectInvalid(null, {
      ...declared,
      nodes: [a!, { ...b!, deps: [DagNodeId('missing')] }],
    }, /invalid topological dependency/)
    expectInvalid(null, {
      ...declared,
      nodes: [a!, { ...b!, deps: [a!.id] }],
      topologicalOrder: [b!.id, a!.id],
    }, /invalid topological dependency/)

    const dependent = {
      ...declared,
      nodes: [a!, { ...b!, deps: [a!.id], status: 'in_progress' as const }],
      topologicalOrder: [a!.id, b!.id],
      counts: { ...declared.counts, pending: 1, in_progress: 1 },
      readyNodeIds: [a!.id],
    }
    expectInvalid(dependent, advance(dependent), /started before dependency/)
  })

  it('rejects undeclared removal and active removal during a write', () => {
    const declared = initial()
    const emptyCounts = statusCounts([])
    expectInvalid(declared, {
      ...advance(declared),
      nodes: [],
      topologicalOrder: [],
      readyNodeIds: [],
      counts: emptyCounts,
    }, /topologicalOrder changed without a write operation/)

    const dispatched = workflow().dispatched
    const counter = dispatched.operationCounter + 1
    expectInvalid(dispatched, {
      ...dispatched,
      revision: dispatched.revision + 1,
      graphGeneration: dispatched.graphGeneration + 1,
      operationCounter: counter,
      nodes: [],
      topologicalOrder: [],
      readyNodeIds: [],
      counts: emptyCounts,
      activeCommandIds: [],
      receipts: [...dispatched.receipts, {
        id: DagOperationId(`op-${counter}`), cause: 'write',
        acceptedRevision: dispatched.revision + 1, nodeIds: [],
      }],
    }, /active node.*removed/)
  })

  it('checks every status count, ready node, and active command projection', () => {
    const declared = initial([input('a'), input('b', ['a'])])
    for (const status of ['pending', 'starting', 'in_progress', 'completed', 'blocked', 'failed', 'interrupted'] as const) {
      expectInvalid(declared, {
        ...advance(declared),
        counts: { ...declared.counts, [status]: declared.counts[status] + 1 },
      }, new RegExp(`status count ${status}`))
    }
    expectInvalid(declared, { ...advance(declared), readyNodeIds: [] }, /readyNodeIds/)

    const dispatched = workflow().dispatched
    expectInvalid(dispatched, { ...advance(dispatched), activeCommandIds: [] }, /activeCommandIds/)
  })
})

describe('DAG invariant receipt and notice validation', () => {
  it('rejects receipt count, identity, revision, sequence, and command-reference errors', () => {
    const declared = initial()
    const receipt = declared.receipts[0]!
    const noReceipts = { ...declared, receipts: [] }
    expectInvalid(noReceipts, advance(noReceipts), /operationCounter does not match/)

    const duplicateReceipts = {
      ...declared,
      operationCounter: 2,
      receipts: [receipt, { ...receipt }],
    }
    expectInvalid(duplicateReceipts, advance(duplicateReceipts), /duplicate operation receipt/)
    for (const acceptedRevision of [0, declared.revision + 2]) {
      const prior = { ...declared, receipts: [{ ...receipt, acceptedRevision }] }
      expectInvalid(prior, advance(prior), /receipt.*invalid revision/)
    }
    const outOfSequence = { ...declared, receipts: [{ ...receipt, id: DagOperationId('op-2') }] }
    expectInvalid(outOfSequence, advance(outOfSequence), /out of sequence/)

    const dispatched = workflow().dispatched
    const node = dispatched.nodes[0]!
    const command = node.commands[0]!
    expectInvalid(declared, replaceFirst(dispatched, {
      ...node,
      currentOperationId: DagOperationId('missing'),
      commands: [{ ...command, operationId: DagOperationId('missing') }],
    }), /lacks an operation receipt/)
  })

  it('rejects malformed and duplicate notices', () => {
    const failed = failedProbe().failed
    const notice = failed.notices[0]!
    expectInvalid(failed, { ...advance(failed), notices: [notice, notice] }, /duplicate notice/)
    for (const revision of [0, failed.revision + 2]) {
      expectInvalid(failed, { ...advance(failed), notices: [{ ...notice, revision }] }, /notice.*invalid revision/)
    }
    expectInvalid(failed, { ...advance(failed), notices: [{ ...notice, delivered: true }] }, /inconsistent delivery/)
    expectInvalid(failed, {
      ...advance(failed), notices: [{ ...notice, delivered: false, deliveredRevision: failed.revision }],
    }, /inconsistent delivery/)
    for (const deliveredRevision of [Number.NaN, notice.revision - 1, failed.revision + 2]) {
      expectInvalid(failed, {
        ...advance(failed), notices: [{ ...notice, delivered: true, deliveredRevision }],
      }, /invalid delivery revision/)
    }
  })

  it('preserves notice facts and records delivery once at the current revision', () => {
    const failed = failedProbe().failed
    const notice = failed.notices[0]!
    const delivered = step(failed, { type: 'notice-delivered', noticeId: notice.id })
    const deliveredNotice = delivered.notices[0]!
    const { deliveredRevision: _deliveredRevision, ...undeliveredNotice } = deliveredNotice
    expectInvalid(delivered, {
      ...advance(delivered), notices: [{ ...undeliveredNotice, delivered: false }],
    }, /lost delivery state/)
    expectInvalid(failed, {
      ...advance(failed), notices: [{ ...notice, text: 'changed' }],
    }, /notice.*changed/)
    expectInvalid(failed, {
      ...advance(failed), notices: [{ ...notice, delivered: true, deliveredRevision: failed.revision }],
    }, /delivery does not name its snapshot revision/)
    expectInvalid(delivered, {
      ...advance(delivered), notices: [{ ...deliveredNotice, deliveredRevision: delivered.revision + 1 }],
    }, /changed its delivery revision/)
    expectInvalid(failed, { ...advance(failed), notices: [] }, /notice.*removed/)
  })
})

describe('DAG invariant wave validation', () => {
  it('rejects invalid wave identity, membership, and settlement partitions', () => {
    const probed = workflow().probed
    const wave = probed.waves[0]!
    expectInvalid(probed, { ...advance(probed), waves: [wave, wave] }, /duplicate wave/)
    expectInvalid(probed, { ...advance(probed), waves: [{ ...wave, rootBranch: ' ' }] }, /invalid frozen root evidence/)
    expectInvalid(probed, { ...advance(probed), waves: [{ ...wave, rootHead: 'bad' }] }, /invalid frozen root evidence/)
    expectInvalid(probed, {
      ...advance(probed), waves: [{ ...wave, nodeIds: [wave.nodeIds[0]!, wave.nodeIds[0]!] }],
    }, /invalid node ids/)
    expectInvalid(probed, {
      ...advance(probed), waves: [{ ...wave, nodeIds: [DagNodeId('missing')], pendingNodeIds: [DagNodeId('missing')] }],
    }, /invalid node ids/)
    expectInvalid(probed, {
      ...advance(probed), waves: [{ ...wave, pendingNodeIds: [wave.nodeIds[0]!, wave.nodeIds[0]!] }],
    }, /invalid settlement slots/)
    expectInvalid(probed, {
      ...advance(probed), waves: [{ ...wave, pendingNodeIds: [DagNodeId('missing')] }],
    }, /invalid settlement slots/)
    expectInvalid(probed, {
      ...advance(probed), waves: [{ ...wave, completedNodeIds: [wave.nodeIds[0]!] }],
    }, /settles a slot more than once/)
    expectInvalid(probed, {
      ...advance(probed), waves: [{ ...wave, pendingNodeIds: [] }],
    }, /settles a slot more than once/)
    expectInvalid(probed, {
      ...advance(probed), waves: [{ ...wave, status: 'settled' }],
    }, /closed wave.*pending slots/)
  })

  it('keeps frozen wave identity and settled slots immutable', () => {
    const flow = workflow()
    const open = flow.probed.waves[0]!
    expectInvalid(flow.probed, {
      ...advance(flow.probed), waves: [{ ...open, nodeIds: [], pendingNodeIds: [] }],
    }, /changed its frozen identity/)
    expectInvalid(flow.probed, { ...advance(flow.probed), waves: [{ ...open, rootBranch: 'other' }] }, /changed its frozen identity/)
    expectInvalid(flow.probed, { ...advance(flow.probed), waves: [{ ...open, rootHead: '4'.repeat(40) }] }, /changed its frozen identity/)

    const completedWave = flow.completed.waves[0]!
    expectInvalid(flow.completed, {
      ...advance(flow.completed),
      waves: [{ ...completedWave, completedNodeIds: [], failedNodeIds: [completedWave.nodeIds[0]!] }],
    }, /changed an already settled slot/)

    const dispatchCommand = flow.probed.nodes[0]!.commands[0]!
    const failed = step(flow.probed, {
      type: 'command-failed',
      nodeId: DagNodeId('a'),
      commandId: dispatchCommand.id,
      generation: dispatchCommand.generation,
      bindingGeneration: dispatchCommand.bindingGeneration,
      operationId: dispatchCommand.operationId,
      reason: 'failed',
    })
    const failedWave = failed.waves[0]!
    expectInvalid(failed, {
      ...advance(failed),
      waves: [{ ...failedWave, failedNodeIds: [], completedNodeIds: [failedWave.nodeIds[0]!] }],
    }, /changed an already settled slot/)
    expectInvalid(flow.completed, {
      ...advance(flow.completed), waves: [{ ...completedWave, status: 'open' }],
    }, /closed wave.*changed/)
  })

  it('allows wave removal only when a write removes one of its inactive nodes', () => {
    const flow = workflow()
    expectInvalid(flow.probed, { ...advance(flow.probed), waves: [] }, /wave.*disappeared/)
    const rewrite = writeCommand([input('a')])
    const rewritten = step(flow.probed, {
      ...rewrite,
      nodes: rewrite.nodes.map(row => ({ ...row, status: 'starting' as const })),
    })
    expectInvalid(flow.probed, { ...rewritten, waves: [] }, /wave.*disappeared/)

    const removed = step(flow.completed, writeCommand([]))
    expect(() => { DagInvariant.validateDagState(flow.completed, removed) }).not.toThrow()
  })
})

describe('DAG invariant plugin lifecycle', () => {
  it('seeds existing sessions and validates new session events before publication', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const seeded = ctx.sessions.create(SessionId('seeded-dag-invariant'))
    const first = initial()
    seeded.append('dag/state', { state: first })
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(DagInvariant)

    const live = ctx.sessions.create(SessionId('live-dag-invariant'))
    live.append('turn/start', { turn: 1 })
    live.append('dag/state', { state: first })
    const second = advance(first)
    live.append('dag/state', { state: second })
    expect(() => live.append('dag/state', { state: { ...advance(second), version: 0 } }))
      .toThrow(InvariantError)
    expect(() => live.append('dag/state', { state: advance(second) })).not.toThrow()

    ctx.emit('internal/dispatch', 'emit', 'not-session-event', [], null)
  })

  it('attributes non-Error validation failures from the exact pre-commit event', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(DagInvariant)
    const session = ctx.sessions.create(SessionId('throwing-dag-invariant'))
    const throwingState = new Proxy({}, {
      get() { throw 'non-error state failure' },
    })
    const event = {
      type: 'dag/state',
      seq: 0,
      time: 1,
      data: { state: throwingState },
    }
    expect(() => {
      ctx.emit(scopeTarget(session, undefined), 'session/event', session, event as never)
    }).toThrow(/non-error state failure/)
  })
})
