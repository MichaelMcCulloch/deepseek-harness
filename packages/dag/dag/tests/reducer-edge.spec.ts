import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  DagCommandId,
  DagNodeId,
  DagNoticeId,
  DagOperationId,
  DagWaveId,
} from '../src/ids.ts'
import {
  DAG_NODE_STATUSES,
  isDagIntegrationPolicy,
  projectDag,
  reduceDagState,
} from '../src/reducer.ts'
import type { DagReducerCommand, DagStartEvidence } from '../src/reducer.ts'
import { validateDagDeclaration } from '../src/validation.ts'
import { DAG_STATE_VERSION } from '../src/types.ts'
import type {
  DagNodeCommand,
  DagNodeInput,
  DagNodeSnapshot,
  DagNodeStatus,
  DagState,
  DagStatusCounts,
  DagWaveSnapshot,
} from '../src/types.ts'

const brief = 'VALIDATION: run tests.\nACCEPTANCE: commit clean work.'
const baseCommit = '1'.repeat(40)
const preparedCommit = '2'.repeat(40)
const completedCommit = '3'.repeat(40)

const input = (id: string, overrides: Partial<DagNodeInput> = {}): DagNodeInput => ({
  id,
  content: `Do ${id}`,
  brief,
  deps: [],
  status: 'pending',
  files: [`src/${id}.ts`],
  ...overrides,
})

function writeCommand(
  inputs: readonly DagNodeInput[],
  statuses: Readonly<Record<string, DagNodeStatus>> = {},
  noticeNamespace = 'test-dispatcher',
): DagReducerCommand {
  const declaration = validateDagDeclaration(inputs)
  return {
    type: 'write',
    noticeNamespace,
    nodes: declaration.definitions.map(definition => ({
      definition,
      status: statuses[definition.id] ?? 'pending',
    })),
    topologicalOrder: declaration.topologicalOrder,
  }
}

function step(state: DagState | null, command: DagReducerCommand): DagState {
  return reduceDagState(state, command).state
}

function counts(nodes: readonly DagNodeSnapshot[]): DagStatusCounts {
  const result: Record<DagNodeStatus, number> = {
    pending: 0,
    starting: 0,
    in_progress: 0,
    completed: 0,
    blocked: 0,
    failed: 0,
    interrupted: 0,
  }
  for (const node of nodes) result[node.status]++
  return result
}

function mailbox(
  kind: DagNodeCommand['kind'] = 'dispatch',
  overrides: Partial<DagNodeCommand> = {},
): DagNodeCommand {
  const operationId = overrides.operationId ?? DagOperationId('op-1')
  const generation = overrides.generation ?? 1
  return {
    id: DagCommandId(`${operationId}-a-g${generation}-${kind}`),
    operationId,
    kind,
    state: 'accepted',
    generation,
    bindingGeneration: 1,
    acceptedRevision: 1,
    ...overrides,
  }
}

function node(overrides: Partial<DagNodeSnapshot> = {}): DagNodeSnapshot {
  return {
    id: DagNodeId('a'),
    content: 'Do a',
    brief,
    deps: [],
    kind: 'task',
    policy: 'delegate',
    files: ['src/a.ts'],
    status: 'pending',
    generation: 0,
    bindingGeneration: 0,
    dependencyCommits: [],
    conflictedFiles: [],
    commands: [],
    ...overrides,
  }
}

function state(
  nodes: readonly DagNodeSnapshot[] = [node()],
  overrides: Partial<DagState> = {},
): DagState {
  return {
    version: DAG_STATE_VERSION,
    noticeNamespace: 'test-dispatcher',
    revision: 1,
    graphGeneration: 1,
    operationCounter: 1,
    nodes,
    topologicalOrder: nodes.map(row => row.id),
    readyNodeIds: nodes.filter(row => row.status === 'pending').map(row => row.id),
    counts: counts(nodes),
    waves: [],
    activeCommandIds: nodes.flatMap(row => row.commands.filter(command => command.state !== 'settled').map(command => command.id)),
    receipts: [],
    notices: [],
    ...overrides,
  }
}

function activeNode(
  kind: DagNodeCommand['kind'] = 'dispatch',
  status: DagNodeStatus = 'starting',
  overrides: Partial<DagNodeSnapshot> = {},
): DagNodeSnapshot {
  const command = mailbox(kind)
  return node({
    status,
    generation: command.generation,
    bindingGeneration: command.bindingGeneration,
    currentOperationId: command.operationId,
    childSessionId: SessionId('child-a'),
    branch: 'branch-a',
    worktree: '/tmp/a',
    waveId: DagWaveId('wave-1'),
    frozenWaveBase: baseCommit,
    dependencyCommits: [],
    conflictedFiles: [],
    commands: [command],
    ...overrides,
  })
}

type FenceCommandType = 'command-running' | 'command-settled' | 'command-failed'

function fenceCommand<T extends FenceCommandType>(
  type: T,
  candidate: DagNodeSnapshot,
): Extract<DagReducerCommand, { readonly type: T }> {
  const command = candidate.commands.at(-1)!
  const shared = {
    nodeId: candidate.id,
    commandId: command.id,
    generation: candidate.generation,
    bindingGeneration: candidate.bindingGeneration,
    operationId: candidate.currentOperationId!,
  }
  const result = type === 'command-failed'
    ? { type, ...shared, reason: 'effect failed' }
    : { type, ...shared }
  return result as Extract<DagReducerCommand, { readonly type: T }>
}

function evidence(overrides: Partial<DagStartEvidence> = {}): DagStartEvidence {
  return {
    branch: 'branch-a',
    worktree: '/tmp/a',
    frozenWaveBase: baseCommit,
    preparedFrom: baseCommit,
    preparedHead: preparedCommit,
    dependencyCommits: [],
    conflictedFiles: [],
    childSessionId: SessionId('child-a'),
    ...overrides,
  }
}

function effectCommand(
  type: 'git-prepared' | 'start-succeeded',
  candidate: DagNodeSnapshot,
  gitEvidence: DagStartEvidence = evidence(),
): DagReducerCommand {
  const command = candidate.commands.at(-1)!
  return {
    type,
    nodeId: candidate.id,
    commandId: command.id,
    generation: candidate.generation,
    bindingGeneration: candidate.bindingGeneration,
    operationId: candidate.currentOperationId!,
    evidence: gitEvidence,
  }
}

describe('DAG declaration and public command rejections', () => {
  it('rejects unstable namespaces and commands before declaration', () => {
    expect(() => step(null, writeCommand([input('a')], {}, ' '))).toThrow(/namespace/)
    const declared = step(null, writeCommand([input('a')]))
    expect(() => step(declared, writeCommand([input('a')], {}, 'other'))).toThrow(/namespace/)
    expect(() => step(null, { type: 'dispatch', nodeIds: [], bindings: {} })).toThrow(/no declaration/)
    expect(() => step(declared, { type: 'block', nodeId: DagNodeId('missing'), reason: 'blocked' })).toThrow(/unknown DAG node/)
  })

  it.each(['starting', 'in_progress', 'blocked'] as const)('refuses removal of a %s node', (status) => {
    const current = state([node({ status })])
    expect(() => step(current, writeCommand([]))).toThrow(/cannot remove active node/)
  })

  it('returns every preserved artifact for dropped inactive nodes', () => {
    const current = state([
      node({ id: DagNodeId('plain') }),
      node({ id: DagNodeId('child'), status: 'failed', childSessionId: SessionId('child') }),
      node({ id: DagNodeId('branch'), status: 'completed', branch: 'branch' }),
      node({ id: DagNodeId('worktree'), status: 'interrupted', worktree: '/tmp/worktree' }),
    ])
    const result = reduceDagState(current, writeCommand([]))
    expect(result.dropped).toEqual([
      { id: 'plain' },
      { id: 'child', childSessionId: 'child' },
      { id: 'branch', branch: 'branch' },
      { id: 'worktree', worktree: '/tmp/worktree' },
    ])
  })

  it('requires new status, corrects inactive declarations, and locks active ones', () => {
    const definition = validateDagDeclaration([input('a')]).definitions[0]!
    expect(() => step(null, {
      type: 'write', noticeNamespace: 'test-dispatcher', nodes: [{ definition, status: 'completed' }],
      topologicalOrder: [definition.id],
    })).toThrow(/must be pending/)

    const current = step(null, writeCommand([input('a')]))
    expect(() => step(current, writeCommand([input('a')], { a: 'failed' }))).toThrow(/repeat live status/)

    const corrected = reduceDagState(current, writeCommand([input('a', { content: 'Changed', files: ['src/other.ts'] })]))
    expect(corrected.amended).toEqual([{ id: 'a', fields: ['content', 'files'] }])
    expect(corrected.state.nodes[0]).toMatchObject({ content: 'Changed', files: ['src/other.ts'], generation: 0, status: 'pending' })

    const active = state([node({ status: 'in_progress' })])
    expect(() => step(active, writeCommand([input('a', { content: 'Changed' })], { a: 'in_progress' })))
      .toThrow(/stop it first/)

    const prepared = state([
      node({ id: DagNodeId('a') }),
      node({
        id: DagNodeId('b'), status: 'failed', frozenWaveBase: baseCommit,
        dependencyCommits: [completedCommit], deps: [DagNodeId('a')],
      }),
    ], { topologicalOrder: [DagNodeId('a'), DagNodeId('b')] })
    expect(() => step(prepared, writeCommand([input('a'), input('b')], { a: 'pending', b: 'failed' })))
      .toThrow(/recorded local Git preparation/)
  })

  it('corrects one node declaration without disturbing its execution facts or siblings', () => {
    const declared = step(null, writeCommand([input('a'), input('b', { deps: ['a'] })]))
    const prepared = state([
      declared.nodes[0]!,
      {
        ...declared.nodes[1]!,
        status: 'failed' as const,
        generation: 3,
        bindingGeneration: 3,
        childSessionId: SessionId('child-b'),
        branch: 'branch-b',
        worktree: '/tmp/b',
        frozenWaveBase: baseCommit,
        dependencyCommits: [completedCommit],
        conflictedFiles: [],
        settlement: { kind: 'failed' as const, reason: 'bounded failure' },
        commands: [],
      },
    ])
    const corrected = reduceDagState(prepared, {
      type: 'amend',
      nodeId: DagNodeId('b'),
      definition: {
        ...declared.nodes[1]!,
        content: 'Corrected b',
        files: ['src/b-fixed.ts'],
      },
      topologicalOrder: [DagNodeId('a'), DagNodeId('b')],
    })
    expect(corrected.amended).toEqual([{ id: 'b', fields: ['content', 'files'] }])
    expect(corrected.state.nodes[1]).toMatchObject({
      id: 'b',
      content: 'Corrected b',
      files: ['src/b-fixed.ts'],
      status: 'failed',
      generation: 3,
      childSessionId: 'child-b',
      frozenWaveBase: baseCommit,
      settlement: { kind: 'failed' },
    })
    expect(corrected.state.nodes[0]).toBe(prepared.nodes[0])

    expect(() => step(prepared, {
      type: 'amend',
      nodeId: DagNodeId('missing'),
      definition: declared.nodes[0]!,
      topologicalOrder: [DagNodeId('a'), DagNodeId('b')],
    })).toThrow(/unknown DAG node/)
    expect(() => step(prepared, {
      type: 'amend',
      nodeId: DagNodeId('b'),
      definition: declared.nodes[1]!,
      topologicalOrder: [DagNodeId('a'), DagNodeId('b')],
    })).toThrow(/already matches/)
    expect(() => step(prepared, {
      type: 'amend',
      nodeId: DagNodeId('b'),
      definition: { ...declared.nodes[1]!, deps: [] },
      topologicalOrder: [DagNodeId('a'), DagNodeId('b')],
    })).toThrow(/recorded local Git preparation/)
  })

  it('rejects an amendment of a node holding active child work', () => {
    const current = state([node({ status: 'blocked', commands: [mailbox('dispatch')] })])
    expect(() => step(current, {
      type: 'amend',
      nodeId: DagNodeId('a'),
      definition: {
        ...validateDagDeclaration([input('a')]).definitions[0]!,
        brief: `${brief}\nMore detail.`,
      },
      topologicalOrder: [DagNodeId('a')],
    })).toThrow(/stop it first/)
  })

  it('reports file and contract-pin conflicts and retains only declared waves', () => {
    const initial = reduceDagState(null, writeCommand([
      input('a', { files: ['src/shared.ts'], brief: `${brief}\nCONTRACT: API-1\nCONTRACT:   ` }),
      input('b', { files: ['src/shared.ts'], brief: `${brief}\nCONTRACT: API-1` }),
    ]))
    const first = initial.state
    expect(initial.conflicts?.map(row => row.reason)).toEqual(['declared-files-overlap', 'contract-pin-overlap'])
    const wave: DagWaveSnapshot = {
      id: DagWaveId('wave-1'), nodeIds: [DagNodeId('a')], rootBranch: 'main', rootHead: baseCommit,
      status: 'settled', pendingNodeIds: [], completedNodeIds: [DagNodeId('a')], failedNodeIds: [],
    }
    const withWave = { ...first, waves: [wave] }
    const result = reduceDagState(withWave, writeCommand([input('a', {
      files: ['src/shared.ts'], brief: `${brief}\nCONTRACT: API-1\nCONTRACT:   `,
    })]))
    expect(result.conflicts).toEqual([])
    expect(result.state.waves).toEqual([wave])

  })

  it('validates dispatch selection, dependencies, and deterministic bindings', () => {
    const declared = step(null, writeCommand([input('a'), input('b', { deps: ['a'] })]))
    expect(() => step(declared, { type: 'dispatch', nodeIds: [], bindings: {} })).toThrow(/distinct node ids/)
    expect(() => step(declared, {
      type: 'dispatch', nodeIds: [DagNodeId('a'), DagNodeId('a')], bindings: {},
    })).toThrow(/distinct node ids/)
    expect(() => step(declared, {
      type: 'dispatch', nodeIds: [DagNodeId('b')],
      bindings: { b: { childSessionId: SessionId('b'), branch: 'b', worktree: '/tmp/b' } },
    })).toThrow(/incomplete dependency/)
    expect(() => step(declared, { type: 'dispatch', nodeIds: [DagNodeId('a')], bindings: {} })).toThrow(/lacks a binding/)

    const started = step(declared, {
      type: 'dispatch', nodeIds: [DagNodeId('a')],
      bindings: { a: { childSessionId: SessionId('a'), branch: 'a', worktree: '/tmp/a' } },
    })
    expect(() => step(started, {
      type: 'dispatch', nodeIds: [DagNodeId('a')],
      bindings: { a: { childSessionId: SessionId('a'), branch: 'a', worktree: '/tmp/a' } },
    })).toThrow(/not pending/)
    expect(started.nodes.find(row => row.id === DagNodeId('b'))?.status).toBe('pending')
  })
})

describe('root probe transitions', () => {
  const dispatched = (): { state: DagState; candidate: DagNodeSnapshot; command: DagNodeCommand } => {
    const initial = step(null, writeCommand([input('a')]))
    const next = step(initial, {
      type: 'dispatch', nodeIds: [DagNodeId('a')],
      bindings: { a: { childSessionId: SessionId('child-a'), branch: 'branch-a', worktree: '/tmp/a' } },
    })
    return { state: next, candidate: next.nodes[0]!, command: next.nodes[0]!.commands[0]! }
  }

  it('validates probe evidence and ignores existing or fully stale waves', () => {
    const value = dispatched()
    const fence = {
      nodeId: value.candidate.id,
      commandId: value.command.id,
      generation: value.candidate.generation,
      bindingGeneration: value.candidate.bindingGeneration,
      operationId: value.command.operationId,
    }
    expect(() => step(value.state, {
      type: 'wave-probed', waveId: value.candidate.waveId!, fences: [fence], branch: ' ', head: baseCommit,
    })).toThrow(/invalid local Git evidence/)
    expect(() => step(value.state, {
      type: 'wave-probed', waveId: value.candidate.waveId!, fences: [fence], branch: 'main', head: 'bad',
    })).toThrow(/invalid local Git evidence/)

    const made = step(value.state, {
      type: 'wave-probed', waveId: value.candidate.waveId!, fences: [fence, fence], branch: 'main', head: baseCommit,
    })
    expect(step(made, {
      type: 'wave-probed', waveId: value.candidate.waveId!, fences: [fence], branch: 'main', head: baseCommit,
    })).toBe(made)
    expect(step(value.state, {
      type: 'wave-probed', waveId: DagWaveId('other'), fences: [fence], branch: 'main', head: baseCommit,
    })).toBe(value.state)
    expect(step(value.state, {
      type: 'wave-probed', waveId: value.candidate.waveId!, fences: [{ ...fence, nodeId: DagNodeId('missing') }],
      branch: 'main', head: baseCommit,
    })).toBe(value.state)
  })

  it('requires completed dependency commits and reuses exact preparation inputs', () => {
    const dep = node({ id: DagNodeId('dep'), status: 'completed' })
    const candidate = activeNode('dispatch', 'starting', { deps: [dep.id], dependencyCommits: [completedCommit] })
    const current = state([dep, candidate])
    const fence = {
      nodeId: candidate.id,
      commandId: candidate.commands[0]!.id,
      generation: candidate.generation,
      bindingGeneration: candidate.bindingGeneration,
      operationId: candidate.currentOperationId!,
    }
    expect(() => step(current, {
      type: 'wave-probed', waveId: candidate.waveId!, fences: [fence], branch: 'main', head: baseCommit,
    })).toThrow(/lacks a completed commit/)

    const withCommit = state([{ ...dep, completedCommit }, candidate])
    const made = step(withCommit, {
      type: 'wave-probed', waveId: candidate.waveId!, fences: [fence], branch: 'main', head: baseCommit,
    })
    expect(made.nodes[1]).toMatchObject({ frozenWaveBase: baseCommit, dependencyCommits: [completedCommit] })

    const exact = state([{ ...dep, completedCommit }, { ...candidate, frozenWaveBase: baseCommit }])
    const reused = step(exact, {
      type: 'wave-probed', waveId: candidate.waveId!, fences: [fence], branch: 'main', head: baseCommit,
    })
    expect(reused.nodes[1]).toBe(exact.nodes[1])

    const changedLength = state([{ ...dep, completedCommit }, { ...candidate, frozenWaveBase: baseCommit, dependencyCommits: [] }])
    expect(step(changedLength, {
      type: 'wave-probed', waveId: candidate.waveId!, fences: [fence], branch: 'main', head: baseCommit,
    }).nodes[1]?.dependencyCommits).toEqual([completedCommit])
    const changedCommit = state([{ ...dep, completedCommit }, {
      ...candidate, frozenWaveBase: baseCommit, dependencyCommits: ['4'.repeat(40)], preparedHead: preparedCommit,
    }])
    expect(step(changedCommit, {
      type: 'wave-probed', waveId: candidate.waveId!, fences: [fence], branch: 'main', head: baseCommit,
    }).nodes[1]?.preparedHead).toBeUndefined()
  })

  it('ignores stale failed probes and settles each matched node once', () => {
    const value = dispatched()
    const fence = {
      nodeId: value.candidate.id,
      commandId: value.command.id,
      generation: value.candidate.generation,
      bindingGeneration: value.candidate.bindingGeneration,
      operationId: value.command.operationId,
    }
    const staleCommands: DagReducerCommand[] = [
      { type: 'wave-probe-failed', waveId: value.candidate.waveId!, fences: [], reason: 'failed' },
      { type: 'wave-probe-failed', waveId: DagWaveId('other'), fences: [fence], reason: 'failed' },
      { type: 'wave-probe-failed', waveId: value.candidate.waveId!, fences: [{ ...fence, generation: 99 }], reason: 'failed' },
    ]
    for (const command of staleCommands) expect(step(value.state, command)).toBe(value.state)

    const wrongKind = activeNode('reset', 'starting')
    const wrongKindState = state([wrongKind])
    expect(step(wrongKindState, {
      type: 'wave-probe-failed', waveId: wrongKind.waveId!, fences: [{
        nodeId: wrongKind.id,
        commandId: wrongKind.commands[0]!.id,
        generation: wrongKind.generation,
        bindingGeneration: wrongKind.bindingGeneration,
        operationId: wrongKind.currentOperationId!,
      }], reason: 'failed',
    })).toBe(wrongKindState)

    const failed = step(value.state, {
      type: 'wave-probe-failed', waveId: value.candidate.waveId!, fences: [fence], reason: 'failed',
    })
    expect(failed.nodes[0]).toMatchObject({ status: 'failed', commands: [{ outcome: 'failed' }] })
  })

  it('retains older mailbox rows and deduplicates an existing wave notice after probe failure', () => {
    const value = dispatched()
    const older = mailbox('reset', {
      id: DagCommandId('op-0-a-g0-reset'),
      operationId: DagOperationId('op-0'),
      generation: 0,
      state: 'settled',
      outcome: 'succeeded',
    })
    const candidate = { ...value.candidate, commands: [older, value.command] }
    const wave: DagWaveSnapshot = {
      id: candidate.waveId!,
      nodeIds: [candidate.id],
      rootBranch: 'main',
      rootHead: baseCommit,
      status: 'open',
      pendingNodeIds: [candidate.id],
      completedNodeIds: [],
      failedNodeIds: [],
    }
    const initial = state([candidate], { waves: [wave] })
    const command: DagReducerCommand = {
      type: 'wave-probe-failed',
      waveId: candidate.waveId!,
      fences: [{
        nodeId: candidate.id,
        commandId: value.command.id,
        generation: candidate.generation,
        bindingGeneration: candidate.bindingGeneration,
        operationId: candidate.currentOperationId!,
      }],
      reason: 'probe failed',
    }
    const settled = step(initial, command)
    const waveNotice = settled.notices.find(row => row.kind === 'wave-settled')!
    const repeated = step({ ...initial, notices: [waveNotice] }, command)

    expect(repeated.nodes[0]?.commands).toMatchObject([
      { id: older.id, outcome: 'succeeded' },
      { id: value.command.id, outcome: 'failed' },
    ])
    expect(repeated.notices.filter(row => row.id === waveNotice.id)).toHaveLength(1)
  })
})

describe('public node lifecycle commands', () => {
  it('validates resume, steer, stop, reset, complete, and block states and text', () => {
    const pending = state()
    expect(() => step(pending, { type: 'resume', nodeId: DagNodeId('a'), message: 'go' })).toThrow(/cannot resume/)
    expect(() => step(state([node({ status: 'blocked' })]), {
      type: 'resume', nodeId: DagNodeId('a'), message: ' ',
    })).toThrow(/message must be non-empty/)
    expect(() => step(pending, { type: 'steer', nodeId: DagNodeId('a'), message: 'go' })).toThrow(/cannot steer/)
    expect(() => step(state([node({ status: 'in_progress' })]), {
      type: 'steer', nodeId: DagNodeId('a'), message: ' ',
    })).toThrow(/message must be non-empty/)
    expect(() => step(pending, { type: 'stop', nodeId: DagNodeId('a'), reason: 'stop' })).toThrow(/cannot stop/)
    expect(() => step(state([node({ status: 'in_progress' })]), {
      type: 'reset', nodeId: DagNodeId('a'), target: baseCommit,
    })).toThrow(/cannot reset/)
    expect(() => step(pending, { type: 'complete', nodeId: DagNodeId('a'), summary: 'done', artifacts: [] }))
      .toThrow(/cannot complete/)
    expect(() => step(state([node({ status: 'in_progress', commands: [mailbox()] })]), {
      type: 'complete', nodeId: DagNodeId('a'), summary: 'done', artifacts: [],
    })).toThrow(/active command/)
    expect(() => step(state([node({ status: 'in_progress' })]), {
      type: 'complete', nodeId: DagNodeId('a'), summary: ' ', artifacts: [],
    })).toThrow(/summary must be non-empty/)
    expect(() => step(pending, { type: 'block', nodeId: DagNodeId('a'), reason: 'blocked' })).toThrow(/cannot block/)
    expect(() => step(state([node({ status: 'in_progress' })]), {
      type: 'block', nodeId: DagNodeId('a'), reason: ' ',
    })).toThrow(/reason must be non-empty/)
    expect(() => step(pending, { type: 'redispatch', nodeId: DagNodeId('a') })).toThrow(/not failed/)
  })

  it('accepts resume and steer from every resumable state', () => {
    for (const status of ['blocked', 'interrupted', 'failed'] as const) {
      const resumed = step(state([node({ status, settlement: { kind: status, reason: 'old' } })]), {
        type: 'resume', nodeId: DagNodeId('a'), message: '  continue  ',
      })
      expect(resumed.nodes[0]).toMatchObject({ status: 'starting', commands: [{ kind: 'resume', message: 'continue' }] })
      expect(resumed.nodes[0]?.settlement).toBeUndefined()

      const steered = step(state([node({ status, settlement: { kind: status, reason: 'old' } })]), {
        type: 'steer', nodeId: DagNodeId('a'), message: '  replace  ',
      })
      expect(steered.nodes[0]).toMatchObject({ status: 'starting', commands: [{ kind: 'steer', message: 'replace' }] })
    }
    const active = step(state([node({ status: 'in_progress', frozenWaveBase: baseCommit })]), {
      type: 'steer', nodeId: DagNodeId('a'), message: 'replace',
    })
    expect(active.nodes[0]).toMatchObject({ status: 'in_progress' })
  })

  it('stops every stoppable state and deduplicates its deterministic notice', () => {
    for (const status of ['starting', 'in_progress', 'blocked'] as const) {
      const current = state([node({ status })])
      const stopped = step(current, { type: 'stop', nodeId: DagNodeId('a'), reason: 'stop' })
      expect(stopped.nodes[0]).toMatchObject({ status: 'interrupted', settlement: { kind: 'interrupted' } })
      const duplicate = state([node({ status })], { notices: stopped.notices })
      expect(step(duplicate, { type: 'stop', nodeId: DagNodeId('a'), reason: 'stop' }).notices).toEqual(stopped.notices)
    }
  })

  it.each([
    baseCommit,
    preparedCommit,
    'refs/heads/main',
    'refs/heads/team/feature',
  ])('accepts reset target %s', (target) => {
    const reset = step(state([node({ frozenWaveBase: baseCommit })]), {
      type: 'reset', nodeId: DagNodeId('a'), target,
    })
    expect(reset.nodes[0]?.commands[0]).toMatchObject({ kind: 'reset', target })
  })

  it.each([
    'refs/heads/',
    'refs/heads//bad',
    'refs/heads/bad/',
    'refs/heads/bad.',
    'refs/heads/bad..name',
    'refs/heads/bad//name',
    'refs/heads/bad@{name',
    'refs/heads/bad name',
    'refs/heads/.hidden/name',
    'refs/heads/bad.lock',
  ])('rejects unsafe local reset ref %s', (target) => {
    expect(() => step(state(), { type: 'reset', nodeId: DagNodeId('a'), target })).toThrow(/reset target/)
  })

  it('accepts completion, block, and redispatch while preserving their generation rules', () => {
    const settled = mailbox('dispatch', { state: 'settled', outcome: 'succeeded' })
    const current = state([node({
      status: 'in_progress', generation: 2, bindingGeneration: 3, commands: [settled], settlement: { kind: 'failed', reason: 'old' },
    })])
    const completed = step(current, {
      type: 'complete', nodeId: DagNodeId('a'), summary: '  done  ', artifacts: [{ kind: 'commit' }],
    })
    expect(completed.nodes[0]).toMatchObject({
      status: 'in_progress', generation: 2, bindingGeneration: 3,
      settlement: { kind: 'completed', summary: 'done', artifacts: [{ kind: 'commit' }] },
    })

    const blocked = step(state([node({ status: 'in_progress', commands: [mailbox()] })]), {
      type: 'block', nodeId: DagNodeId('a'), reason: '  waiting  ',
    })
    expect(blocked.nodes[0]).toMatchObject({ status: 'blocked', settlement: { kind: 'blocked', reason: 'waiting' } })
    expect(blocked.nodes[0]?.commands[0]).toMatchObject({ state: 'settled', outcome: 'cancelled' })

    const failed = node({
      status: 'failed', generation: 2, bindingGeneration: 2, completedCommit,
      currentOperationId: DagOperationId('op-1'), settlement: { kind: 'failed', reason: 'old' }, commands: [mailbox()],
    })
    const redispatched = step(state([failed]), { type: 'redispatch', nodeId: failed.id })
    expect(redispatched.nodes[0]).toMatchObject({ status: 'pending', generation: 3, bindingGeneration: 3 })
    expect(redispatched.nodes[0]?.completedCommit).toBeUndefined()
  })
})

describe('effect fences and settlements', () => {
  it('ignores every stale fence component and repeats running idempotently', () => {
    const candidate = activeNode()
    const current = state([candidate])
    const command = fenceCommand('command-running', candidate)
    const stale: DagReducerCommand[] = [
      { ...command, generation: 2 },
      { ...command, bindingGeneration: 2 },
      { ...command, operationId: DagOperationId('op-other') },
      { ...command, commandId: DagCommandId('missing') },
    ]
    for (const entry of stale) expect(step(current, entry)).toBe(current)

    const commandMismatches = [
      mailbox('dispatch', { id: DagCommandId('missing') }),
      mailbox('dispatch', { generation: 2 }),
      mailbox('dispatch', { bindingGeneration: 2 }),
      mailbox('dispatch', { operationId: DagOperationId('op-other') }),
      mailbox('dispatch', { state: 'settled', outcome: 'succeeded' }),
    ]
    for (const mismatched of commandMismatches) {
      const mismatchedState = state([{ ...candidate, commands: [mismatched] }])
      expect(step(mismatchedState, command)).toBe(mismatchedState)
    }

    const running = step(current, command)
    expect(running.nodes[0]?.commands[0]?.state).toBe('running')
    expect(step(running, fenceCommand('command-running', running.nodes[0]!))).toBe(running)
  })

  it('validates prepared Git evidence against every durable binding field', () => {
    const candidate = activeNode()
    const current = state([candidate])
    const mismatches: DagStartEvidence[] = [
      evidence({ branch: 'other' }),
      evidence({ worktree: '/other' }),
      evidence({ childSessionId: SessionId('other') }),
      evidence({ frozenWaveBase: '4'.repeat(40) }),
      evidence({ dependencyCommits: [completedCommit] }),
    ]
    const withDependency = activeNode('dispatch', 'starting', { dependencyCommits: [completedCommit] })
    mismatches.push(evidence({ dependencyCommits: ['4'.repeat(40)] }))
    for (const gitEvidence of mismatches.slice(0, -1)) {
      expect(() => step(current, effectCommand('git-prepared', candidate, gitEvidence))).toThrow(/does not match/)
    }
    expect(() => step(state([withDependency]), effectCommand('git-prepared', withDependency, mismatches.at(-1))))
      .toThrow(/does not match/)
    expect(() => step(current, effectCommand('git-prepared', candidate, evidence({ preparedHead: 'bad' }))))
      .toThrow(/does not match/)

    const wrongStatus = activeNode('dispatch', 'in_progress')
    const wrongStatusState = state([wrongStatus])
    expect(step(wrongStatusState, effectCommand('git-prepared', wrongStatus))).toBe(wrongStatusState)
    const wrongKind = activeNode('complete', 'starting')
    const wrongKindState = state([wrongKind])
    expect(step(wrongKindState, effectCommand('git-prepared', wrongKind))).toBe(wrongKindState)
    const already = activeNode('dispatch', 'starting', { preparedHead: preparedCommit })
    const alreadyState = state([already])
    expect(step(alreadyState, effectCommand('git-prepared', already))).toBe(alreadyState)

    const prepared = step(current, effectCommand('git-prepared', candidate))
    expect(prepared.nodes[0]).toMatchObject(evidence())
  })

  it('validates start settlement and accepts starting or active steering turns', () => {
    for (const kind of ['dispatch', 'resume', 'steer'] as const) {
      const candidate = activeNode(kind, 'starting', { preparedHead: preparedCommit })
      const started = step(state([candidate]), effectCommand('start-succeeded', candidate))
      expect(started.nodes[0]).toMatchObject({ status: 'in_progress', commands: [{ outcome: 'succeeded' }] })
    }
    const steering = activeNode('steer', 'in_progress', { preparedHead: preparedCommit })
    expect(step(state([steering]), effectCommand('start-succeeded', steering)).nodes[0]?.status).toBe('in_progress')

    const wrong = activeNode('reset', 'starting', { preparedHead: preparedCommit })
    const wrongState = state([wrong])
    expect(step(wrongState, effectCommand('start-succeeded', wrong))).toBe(wrongState)
    const mismatchBase = activeNode('dispatch', 'starting', { preparedHead: preparedCommit })
    const badEvidence: DagStartEvidence[] = [
      evidence({ preparedHead: '4'.repeat(40) }),
      evidence({ conflictedFiles: ['a'] }),
    ]
    const conflictNode = activeNode('dispatch', 'starting', { preparedHead: preparedCommit, conflictedFiles: ['a'] })
    badEvidence.push(evidence({ conflictedFiles: ['b'] }))
    expect(() => step(state([mismatchBase]), effectCommand('start-succeeded', mismatchBase, badEvidence[0]))).toThrow(/does not match/)
    expect(() => step(state([mismatchBase]), effectCommand('start-succeeded', mismatchBase, badEvidence[1]))).toThrow(/does not match/)
    expect(() => step(state([conflictNode]), effectCommand('start-succeeded', conflictNode, badEvidence[2]))).toThrow(/does not match/)
  })

  it('requires a matching completion command and valid commit evidence', () => {
    const complete = activeNode('complete', 'in_progress', {
      settlement: { kind: 'completed', summary: 'done', artifacts: [] },
      preparedHead: preparedCommit,
    })
    const command = complete.commands[0]!
    const completion = (candidate: DagNodeSnapshot, commit = completedCommit): DagReducerCommand => ({
      type: 'completion-succeeded',
      nodeId: candidate.id,
      commandId: candidate.commands[0]!.id,
      generation: candidate.generation,
      bindingGeneration: candidate.bindingGeneration,
      operationId: candidate.currentOperationId!,
      evidence: { commit },
    })
    for (const stale of [
      { ...complete, status: 'starting' as const },
      { ...complete, commands: [{ ...command, kind: 'dispatch' as const }] },
      { ...complete, settlement: { kind: 'blocked' as const, reason: 'wait' } },
    ]) {
      const staleState = state([stale])
      expect(step(staleState, completion(stale))).toBe(staleState)
    }
    expect(() => step(state([complete]), completion(complete, 'bad'))).toThrow(/invalid local Git evidence/)

    const outside = step(state([complete]), completion(complete))
    expect(outside.nodes[0]).toMatchObject({ status: 'completed', completedCommit })
    expect(outside.notices.map(row => row.kind)).toContain('node-completed')

    const wave: DagWaveSnapshot = {
      id: complete.waveId!, nodeIds: [complete.id], rootBranch: 'main', rootHead: baseCommit,
      status: 'open', pendingNodeIds: [complete.id], completedNodeIds: [], failedNodeIds: [],
    }
    const inside = step(state([complete], { waves: [wave] }), completion(complete))
    expect(inside.notices.filter(row => row.kind === 'node-completed')).toEqual([])
    expect(inside.waves[0]).toMatchObject({ status: 'settled', completedNodeIds: ['a'] })
  })

  it('keeps interrupted effect failures interrupted and fails other nodes once', () => {
    const interrupted = activeNode('stop', 'interrupted')
    const interruptedResult = step(state([interrupted]), fenceCommand('command-failed', interrupted))
    expect(interruptedResult.nodes[0]).toMatchObject({ status: 'interrupted' })
    expect(interruptedResult.notices).toEqual([])

    const running = activeNode('dispatch', 'starting')
    const failed = step(state([running]), fenceCommand('command-failed', running))
    expect(failed.nodes[0]).toMatchObject({ status: 'failed', settlement: { kind: 'failed' } })
    expect(failed.notices.map(row => row.kind)).toEqual(['node-failed'])
  })

  it('settles only stop and reset commands, with optional detail', () => {
    const dispatch = activeNode('dispatch', 'starting')
    const dispatchState = state([dispatch])
    expect(step(dispatchState, fenceCommand('command-settled', dispatch))).toBe(dispatchState)

    for (const kind of ['stop', 'reset'] as const) {
      const candidate = activeNode(kind, kind === 'stop' ? 'interrupted' : 'failed')
      const settled = step(state([candidate]), {
        ...fenceCommand('command-settled', candidate),
        ...kind === 'stop' ? { detail: 'stopped' } : {},
      })
      expect(settled.nodes[0]?.commands[0]).toMatchObject({ state: 'settled', outcome: 'succeeded' })
      if (kind === 'stop') expect(settled.nodes[0]?.commands[0]?.detail).toBe('stopped')
      else expect(settled.nodes[0]?.commands[0]?.detail).toBeUndefined()
    }
  })
})

describe('normal child turn settlement', () => {
  it('ignores every stale or already-completed child turn', () => {
    const candidate = activeNode('dispatch', 'in_progress')
    const command = candidate.commands[0]!
    const ended: DagReducerCommand = {
      type: 'child-ended', nodeId: candidate.id, commandId: command.id,
      generation: candidate.generation, bindingGeneration: candidate.bindingGeneration,
      operationId: candidate.currentOperationId!, reason: 'ended without report',
    }
    const stale = [
      { ...candidate, generation: 2 },
      { ...candidate, bindingGeneration: 2 },
      { ...candidate, currentOperationId: DagOperationId('other') },
      { ...candidate, commands: [] },
      { ...candidate, status: 'blocked' as const },
      { ...candidate, settlement: { kind: 'completed' as const, summary: 'done', artifacts: [] } },
    ]
    for (const value of stale) {
      const staleState = state([value])
      expect(step(staleState, ended)).toBe(staleState)
    }
  })

  it('fails a matching starting or in-progress child and leaves other commands unchanged', () => {
    for (const status of ['starting', 'in_progress'] as const) {
      const candidate = activeNode('dispatch', status, {
        commands: [mailbox('reset', { state: 'settled', outcome: 'succeeded' }), mailbox('dispatch')],
      })
      const ended = {
        type: 'child-ended' as const,
        nodeId: candidate.id,
        commandId: candidate.commands[1]!.id,
        generation: candidate.generation,
        bindingGeneration: candidate.bindingGeneration,
        operationId: candidate.currentOperationId!,
        reason: 'ended without report',
      }
      const failed = step(state([candidate]), ended)
      expect(failed.nodes[0]).toMatchObject({ status: 'failed', settlement: { kind: 'failed' } })
      expect(failed.nodes[0]?.commands.map(row => row.outcome)).toEqual(['succeeded', 'failed'])
    }
  })
})

describe('notice delivery, projections, and policy vocabulary', () => {
  it('marks one pending notice once', () => {
    const notice = {
      id: DagNoticeId('notice-1'), kind: 'node-failed' as const, revision: 1, graphGeneration: 1,
      nodeId: DagNodeId('a'), text: 'failed', delivered: false,
    }
    const current = state([], { notices: [notice] })
    const delivered = step(current, { type: 'notice-delivered', noticeId: notice.id })
    expect(delivered.notices[0]).toMatchObject({ delivered: true, deliveredRevision: 2 })
    expect(step(delivered, { type: 'notice-delivered', noticeId: notice.id })).toBe(delivered)
    expect(step(current, { type: 'notice-delivered', noticeId: DagNoticeId('missing') })).toBe(current)
  })

  it('projects optional execution fields and rejects an invalid topological row', () => {
    const full = node({
      branch: 'branch', waveId: DagWaveId('wave'), settlement: { kind: 'failed', reason: 'failed' }, completedCommit,
    })
    const open: DagWaveSnapshot = {
      id: DagWaveId('open'), nodeIds: [full.id], rootBranch: 'main', rootHead: baseCommit,
      status: 'open', pendingNodeIds: [full.id], completedNodeIds: [], failedNodeIds: [],
    }
    const settled = { ...open, id: DagWaveId('settled'), status: 'settled' as const }
    const projection = projectDag(state([full, node({ id: DagNodeId('minimal') })], { waves: [open, settled] }))
    expect(projection.nodes[0]).toMatchObject({ branch: 'branch', waveId: 'wave', completedCommit })
    expect(projection.nodes[1]).not.toHaveProperty('branch')
    expect(projection.openWaves).toEqual([open])
    expect(() => projectDag(state([full], { topologicalOrder: [DagNodeId('missing')] }))).toThrow(/unknown node/)
  })

  it('recognizes only the three integration policies and lists every node status', () => {
    expect(['delegate', 'ours', 'theirs'].every(isDagIntegrationPolicy)).toBe(true)
    expect(isDagIntegrationPolicy('invalid')).toBe(false)
    expect(DAG_NODE_STATUSES).toEqual([
      'pending', 'starting', 'in_progress', 'completed', 'blocked', 'failed', 'interrupted',
    ])
  })
})
