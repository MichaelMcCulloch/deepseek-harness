import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { validateDagState } from '../src/invariant.ts'
import { DagNodeId } from '../src/ids.ts'
import { reduceDagState } from '../src/reducer.ts'
import type { DagReducerCommand, DagStartEvidence } from '../src/reducer.ts'
import { abstractDagState, referenceReduceDagState } from '../src/reference-reducer.ts'
import type { DagReferenceState } from '../src/reference-reducer.ts'
import { validateDagDeclaration } from '../src/validation.ts'
import type { DagNodeId as NodeId, DagNodeInput, DagNodeSnapshot, DagState } from '../src/types.ts'

const BRIEF = 'Implement this node.\nVALIDATION: run the focused test.\nACCEPTANCE: commit clean work.'

function input(id: string, deps: string[] = [], kind: 'task' | 'integration' = 'task'): DagNodeInput {
  return {
    id,
    content: `Implement ${id}`,
    brief: BRIEF,
    deps,
    status: 'pending',
    kind,
    ...kind === 'integration' ? { policy: 'delegate' as const } : {},
    files: [`src/${id}.ts`],
  }
}

const GRAPH = [
  input('a'),
  input('b'),
  input('c', ['a']),
  input('d', ['a']),
  input('e', ['c', 'd', 'b'], 'integration'),
  input('f', ['e']),
]

function declaration(): DagReducerCommand {
  const value = validateDagDeclaration(GRAPH)
  return {
    type: 'write',
    noticeNamespace: 'model-dispatcher',
    nodes: value.definitions.map(definition => ({ definition, status: 'pending' })),
    topologicalOrder: value.topologicalOrder,
  }
}

function binding(id: string) {
  return {
    childSessionId: SessionId(`child-${id}`),
    branch: `dsh/dag/model/g1/${id}`,
    worktree: `/tmp/model/${id}`,
  }
}

function evidence(node: DagNodeSnapshot): DagStartEvidence {
  if (node.branch === undefined || node.worktree === undefined || node.childSessionId === undefined) {
    throw new Error(`node ${node.id} has no committed binding`)
  }
  const base = '1'.repeat(40)
  return {
    branch: node.branch,
    worktree: node.worktree,
    frozenWaveBase: node.frozenWaveBase ?? base,
    preparedFrom: node.preparedFrom ?? node.frozenWaveBase ?? base,
    preparedHead: node.preparedHead ?? base,
    dependencyCommits: node.dependencyCommits,
    conflictedFiles: [],
    childSessionId: node.childSessionId,
  }
}

class ModelRun {
  production: DagState | null = null
  reference: DagReferenceState | null = null
  readonly snapshots: DagState[] = []

  apply(command: DagReducerCommand): DagState {
    const previous = this.production
    const result = reduceDagState(previous, command).state
    this.reference = referenceReduceDagState(this.reference, command)
    this.production = result
    expect(abstractDagState(result)).toEqual(this.reference)
    if (result !== previous) {
      validateDagState(previous, result)
      expect(JSON.parse(JSON.stringify(result))).toEqual(result)
      this.snapshots.push(result)
    }
    this.assertStaleEffectFences()
    return result
  }

  node(id: string): DagNodeSnapshot {
    const node = this.production?.nodes.find(row => row.id === DagNodeId(id))
    if (node === undefined) throw new Error(`missing model node ${id}`)
    return node
  }

  command(id: string): DagNodeSnapshot['commands'][number] {
    const node = this.node(id)
    const command = node.commands.findLast(row => row.operationId === node.currentOperationId)
    if (command === undefined) throw new Error(`node ${id} has no current command`)
    return command
  }

  dispatch(ids: string[]): void {
    this.apply({
      type: 'dispatch',
      nodeIds: ids.map(DagNodeId),
      bindings: Object.fromEntries(ids.map(id => [id, binding(`${id}-g${this.node(id).generation + 1}`)])),
    })
    const waveId = this.node(ids[0] ?? '').waveId
    if (waveId === undefined || ids.some(id => this.node(id).waveId !== waveId)) throw new Error('dispatch did not reserve one wave identity')
    expect(this.production?.waves.some(wave => wave.id === waveId)).toBe(false)
    const fences = ids.map((id) => {
      const command = this.command(id)
      return {
        nodeId: DagNodeId(id),
        commandId: command.id,
        generation: command.generation,
        bindingGeneration: command.bindingGeneration,
        operationId: command.operationId,
      }
    })
    this.apply({ type: 'wave-probed', waveId, fences, branch: 'main', head: '1'.repeat(40) })
  }

  start(id: string): void {
    const node = this.node(id)
    const command = this.command(id)
    this.apply({
      type: 'command-running',
      nodeId: node.id,
      commandId: command.id,
      generation: command.generation,
      bindingGeneration: command.bindingGeneration,
      operationId: command.operationId,
    })
    const running = this.command(id)
    const prepared = evidence(this.node(id))
    if (running.kind === 'dispatch') {
      this.apply({
        type: 'git-prepared',
        nodeId: node.id,
        commandId: running.id,
        generation: running.generation,
        bindingGeneration: running.bindingGeneration,
        operationId: running.operationId,
        evidence: prepared,
      })
    }
    this.apply({
      type: 'start-succeeded',
      nodeId: node.id,
      commandId: running.id,
      generation: running.generation,
      bindingGeneration: running.bindingGeneration,
      operationId: running.operationId,
      evidence: prepared,
    })
  }

  complete(id: string): void {
    const node = this.node(id)
    this.apply({ type: 'complete', nodeId: node.id, summary: `Completed ${id}`, artifacts: [] })
    const command = this.command(id)
    expect(this.node(id).status).toBe('in_progress')
    this.apply({
      type: 'completion-succeeded',
      nodeId: node.id,
      commandId: command.id,
      generation: command.generation,
      bindingGeneration: command.bindingGeneration,
      operationId: command.operationId,
      evidence: { commit: id.charCodeAt(0).toString(16).repeat(40).slice(0, 40) },
    })
    expect(this.node(id).status).toBe('completed')
  }

  private assertStaleEffectFences(): void {
    if (this.production === null) return
    for (const node of this.production.nodes) {
      const command = node.commands.at(-1)
      if (command === undefined) continue
      const stale = reduceDagState(this.production, {
        type: 'command-failed',
        nodeId: node.id,
        commandId: command.id,
        generation: command.generation,
        bindingGeneration: command.bindingGeneration + 1,
        operationId: command.operationId,
        reason: 'stale callback',
      }).state
      expect(stale).toBe(this.production)
    }
  }
}

function runRootOrder(order: readonly ['a', 'b'] | readonly ['b', 'a']): DagState {
  const model = new ModelRun()
  model.apply(declaration())
  model.dispatch(['a', 'b'])
  for (const id of order) model.start(id)
  for (const id of order) model.complete(id)
  return model.production!
}

interface ExplorationBudget {
  readonly recovered: ReadonlySet<string>
  readonly redispatched: ReadonlySet<string>
  readonly reset: ReadonlySet<string>
  readonly faults: number
}

interface ExplorationState {
  readonly production: DagState
  readonly reference: DagReferenceState
  readonly budget: ExplorationBudget
  readonly history: readonly DagReducerCommand[]
}

interface ExplorationAction {
  readonly label: string
  readonly command: DagReducerCommand
  readonly budget?: ExplorationBudget
}

function setWith(values: ReadonlySet<string>, value: string): ReadonlySet<string> {
  return new Set([...values, value])
}

function semanticKey(candidate: ExplorationState): string {
  const state = candidate.production
  const waveValue = (wave: DagState['waves'][number]) => ({
    nodes: wave.nodeIds,
    status: wave.status,
    pending: wave.pendingNodeIds,
    completed: wave.completedNodeIds,
    failed: wave.failedNodeIds,
  })
  const waves = state.waves.map(waveValue).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  return JSON.stringify({
    nodes: state.nodes.map((node) => {
      const active = node.commands.find(command => command.state !== 'settled')
      const recordedWave = state.waves.find(wave => wave.id === node.waveId)
      const reservedWave = node.waveId === undefined || recordedWave !== undefined
        ? undefined
        : state.nodes.filter(row => row.waveId === node.waveId).map(row => row.id)
      return {
        id: node.id,
        status: node.status,
        generation: node.generation,
        bindingGeneration: node.bindingGeneration,
        active: active === undefined ? undefined : [active.kind, active.state],
        prepared: node.preparedHead !== undefined,
        settlement: node.settlement?.kind,
        wave: recordedWave === undefined ? reservedWave : waveValue(recordedWave),
      }
    }),
    waves,
    recovered: [...candidate.budget.recovered].sort(),
    redispatched: [...candidate.budget.redispatched].sort(),
    reset: [...candidate.budget.reset].sort(),
    faults: candidate.budget.faults,
  })
}

function commandFence(node: DagNodeSnapshot, command: DagNodeSnapshot['commands'][number]) {
  return {
    nodeId: node.id,
    commandId: command.id,
    generation: command.generation,
    bindingGeneration: command.bindingGeneration,
    operationId: command.operationId,
  }
}

function effectEvidence(node: DagNodeSnapshot): DagStartEvidence {
  if (node.branch === undefined || node.worktree === undefined || node.childSessionId === undefined
    || node.frozenWaveBase === undefined) throw new Error(`node ${node.id} lacks model effect evidence`)
  return {
    branch: node.branch,
    worktree: node.worktree,
    frozenWaveBase: node.frozenWaveBase,
    preparedFrom: node.preparedFrom ?? node.frozenWaveBase,
    preparedHead: node.preparedHead ?? node.frozenWaveBase,
    dependencyCommits: node.dependencyCommits,
    conflictedFiles: node.conflictedFiles,
    childSessionId: node.childSessionId,
  }
}

function dispatchSelections(state: DagState): readonly NodeId[][] {
  const ready = state.readyNodeIds.filter((id) => {
    const node = state.nodes.find(row => row.id === id)
    return node !== undefined && !node.commands.some(command => command.state !== 'settled')
  })
  if (ready.length === 0) return []
  return [ready.map(id => id)]
}

function explorationActions(candidate: ExplorationState): ExplorationAction[] {
  const state = candidate.production
  const actions: ExplorationAction[] = []
  const canFault = candidate.budget.faults < 1
  const faultBudget = (): ExplorationBudget => ({ ...candidate.budget, faults: candidate.budget.faults + 1 })
  for (const notice of state.notices) {
    if (!notice.delivered) {
      actions.push({ label: 'notice-delivered', command: { type: 'notice-delivered', noticeId: notice.id } })
    }
  }
  for (const ids of dispatchSelections(state)) {
    actions.push({
      label: ids.length > 1 ? 'dispatch-parallel' : 'dispatch',
      command: {
        type: 'dispatch',
        nodeIds: ids,
        bindings: Object.fromEntries(ids.map((id) => {
          const node = state.nodes.find(row => row.id === id)!
          return [id, binding(`${id}-g${node.generation + 1}`)]
        })),
      },
    })
  }

  const unprobed = new Map<string, DagNodeSnapshot[]>()
  for (const node of state.nodes) {
    if (node.status !== 'starting' || node.waveId === undefined
      || state.waves.some(wave => wave.id === node.waveId)) continue
    const rows = unprobed.get(node.waveId) ?? []
    rows.push(node)
    unprobed.set(node.waveId, rows)
  }
  for (const nodes of unprobed.values()) {
    const waveId = nodes[0]!.waveId!
    const fences = nodes.flatMap((node) => {
      const command = node.commands.find(row => row.state !== 'settled')
      return command === undefined ? [] : [commandFence(node, command)]
    })
    actions.push({ label: 'wave-probe-success', command: { type: 'wave-probed', waveId, fences, branch: 'main', head: '1'.repeat(40) } })
    if (canFault) actions.push({
      label: 'wave-probe-failure',
      command: { type: 'wave-probe-failed', waveId, fences, reason: 'bounded root probe failure' },
      budget: faultBudget(),
    })
  }

  for (const node of state.nodes) {
    const active = node.commands.find(command => command.state !== 'settled')
    if (active !== undefined) {
      const fence = commandFence(node, active)
      if (active.state === 'accepted') {
        actions.push({ label: 'command-running', command: { type: 'command-running', ...fence } })
      } else if (active.kind === 'dispatch') {
        const open = state.waves.some(wave => wave.id === node.waveId && wave.status === 'open' && wave.nodeIds.includes(node.id))
        if (open && node.preparedHead === undefined) {
          actions.push({ label: 'git-prepared', command: { type: 'git-prepared', ...fence, evidence: effectEvidence(node) } })
        } else if (open) {
          actions.push({ label: 'start-success', command: { type: 'start-succeeded', ...fence, evidence: effectEvidence(node) } })
        }
        if (canFault) actions.push({
          label: 'effect-failure', command: { type: 'command-failed', ...fence, reason: 'bounded dispatch effect failure' }, budget: faultBudget(),
        })
      } else if (active.kind === 'resume' || active.kind === 'steer') {
        if (node.branch !== undefined && node.worktree !== undefined && node.childSessionId !== undefined
          && node.frozenWaveBase !== undefined && node.preparedHead === undefined) {
          actions.push({ label: 'git-prepared', command: { type: 'git-prepared', ...fence, evidence: effectEvidence(node) } })
        } else if (node.branch !== undefined && node.worktree !== undefined && node.childSessionId !== undefined
          && node.frozenWaveBase !== undefined) {
          actions.push({ label: 'start-success', command: { type: 'start-succeeded', ...fence, evidence: effectEvidence(node) } })
        }
        if (canFault) actions.push({
          label: 'effect-failure', command: { type: 'command-failed', ...fence, reason: 'bounded child delivery failure' }, budget: faultBudget(),
        })
      } else if (active.kind === 'complete') {
        const digit = ((node.id.charCodeAt(0) + node.generation) % 16).toString(16)
        actions.push({ label: 'completion-success', command: { type: 'completion-succeeded', ...fence, evidence: { commit: digit.repeat(40) } } })
        if (canFault) actions.push({
          label: 'effect-failure', command: { type: 'command-failed', ...fence, reason: 'bounded completion evidence failure' }, budget: faultBudget(),
        })
      } else {
        actions.push({ label: 'command-settled', command: { type: 'command-settled', ...fence } })
        if (canFault) actions.push({
          label: 'effect-failure', command: { type: 'command-failed', ...fence, reason: 'bounded command effect failure' }, budget: faultBudget(),
        })
      }
    }

    if (canFault && (node.status === 'starting' || node.status === 'in_progress' || node.status === 'blocked')) {
      actions.push({ label: 'stop', command: { type: 'stop', nodeId: node.id, reason: 'bounded stop' }, budget: faultBudget() })
    }
    if (node.status === 'in_progress' && active === undefined) {
      actions.push({ label: 'complete', command: { type: 'complete', nodeId: node.id, summary: `complete ${node.id}`, artifacts: [] } })
      if (canFault) actions.push({
        label: 'block', command: { type: 'block', nodeId: node.id, reason: 'bounded block' }, budget: faultBudget(),
      })
      const command = node.commands.findLast(row => row.operationId === node.currentOperationId)
      if (canFault && command !== undefined) {
        actions.push({
          label: 'child-ended',
          command: { type: 'child-ended', ...commandFence(node, command), reason: 'bounded unreported turn' },
          budget: faultBudget(),
        })
      }
      if (canFault && !candidate.budget.recovered.has(node.id)) {
        actions.push({
          label: 'steer',
          command: { type: 'steer', nodeId: node.id, message: 'bounded replacement' },
          budget: { ...faultBudget(), recovered: setWith(candidate.budget.recovered, node.id) },
        })
      }
    }
    if ((node.status === 'blocked' || node.status === 'interrupted') && !candidate.budget.recovered.has(node.id)) {
      const nextBudget = { ...candidate.budget, recovered: setWith(candidate.budget.recovered, node.id) }
      actions.push({ label: 'resume', command: { type: 'resume', nodeId: node.id, message: 'bounded resume' }, budget: nextBudget })
      if (canFault) actions.push({
        label: 'steer',
        command: { type: 'steer', nodeId: node.id, message: 'bounded replacement' },
        budget: { ...nextBudget, faults: candidate.budget.faults + 1 },
      })
    }
    if (node.status === 'failed' && !candidate.budget.reset.has(node.id) && node.worktree !== undefined && node.frozenWaveBase !== undefined) {
      actions.push({
        label: 'reset',
        command: { type: 'reset', nodeId: node.id, target: node.frozenWaveBase },
        budget: { ...candidate.budget, reset: setWith(candidate.budget.reset, node.id) },
      })
    }
    if (node.status === 'failed' && !candidate.budget.redispatched.has(node.id)) {
      actions.push({
        label: 'redispatch',
        command: { type: 'redispatch', nodeId: node.id },
        budget: { ...candidate.budget, redispatched: setWith(candidate.budget.redispatched, node.id) },
      })
    }
  }
  return actions
}

function assertRestartReplay(history: readonly DagReducerCommand[], expected: DagState): void {
  let replay: DagState | null = null
  for (const command of history) replay = reduceDagState(replay, command).state
  if (JSON.stringify(replay) !== JSON.stringify(expected)) throw new Error('bounded restart replay diverged from live state')
  if (JSON.stringify(JSON.parse(JSON.stringify(expected))) !== JSON.stringify(expected)) throw new Error('bounded snapshot JSON replay diverged')
}

function assertStaleCallbacksHaveNoEffect(state: DagState): number {
  let checked = 0
  for (const node of state.nodes) {
    const command = node.commands.at(-1)
    if (command === undefined) continue
    const stale = reduceDagState(state, {
      type: 'command-failed',
      nodeId: node.id,
      commandId: command.id,
      generation: command.generation,
      bindingGeneration: command.bindingGeneration + 1,
      operationId: command.operationId,
      reason: 'bounded stale callback',
    }).state
    if (stale !== state) throw new Error(`stale callback changed node ${node.id}`)
    checked++
  }
  return checked
}

describe('bounded native DAG model', () => {
  it('exhaustively explores the bounded command and effect state space', () => {
    const declared = reduceDagState(null, declaration()).state
    const reference = referenceReduceDagState(null, declaration())
    const initial: ExplorationState = {
      production: declared,
      reference,
      budget: { recovered: new Set(), redispatched: new Set(), reset: new Set(), faults: 0 },
      history: [declaration()],
    }
    const queue: ExplorationState[] = [initial]
    const visited = new Set([semanticKey(initial)])
    const labels = new Set<string>()
    const completed = new Set<string>()
    let staleCallbacks = 0
    let restartPoints = 0
    const maximumStates = 25_000

    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]!
      staleCallbacks += assertStaleCallbacksHaveNoEffect(current.production)
      assertRestartReplay(current.history, current.production)
      restartPoints++
      for (const action of explorationActions(current)) {
        labels.add(action.label)
        const result = reduceDagState(current.production, action.command).state
        const nextReference = referenceReduceDagState(current.reference, action.command)
        if (result === current.production) continue
        validateDagState(current.production, result)
        expect(abstractDagState(result)).toEqual(nextReference)
        for (const node of result.nodes) {
          if (node.status === 'completed') completed.add(node.id)
        }
        const next: ExplorationState = {
          production: result,
          reference: nextReference,
          budget: action.budget ?? current.budget,
          history: [...current.history, action.command],
        }
        const key = semanticKey(next)
        if (visited.has(key)) continue
        visited.add(key)
        queue.push(next)
        if (queue.length > maximumStates) throw new Error(`bounded DAG model exceeded ${maximumStates} semantic states`)
      }
    }

    expect([...completed].sort()).toEqual(GRAPH.map(node => node.id).sort())
    expect([...labels]).toEqual(expect.arrayContaining([
      'dispatch-parallel', 'wave-probe-success', 'wave-probe-failure', 'command-running', 'git-prepared',
      'start-success', 'completion-success', 'effect-failure', 'complete', 'block', 'stop', 'steer',
      'resume', 'child-ended', 'redispatch', 'reset', 'command-settled',
      'notice-delivered',
    ]))
    expect(visited.size).toBeGreaterThan(1_000)
    expect(staleCallbacks).toBeGreaterThan(visited.size)
    expect(restartPoints).toBe(visited.size)
  }, 30_000)

  it('enumerates roots, fan-out, fan-in, integration, tail, and recovery cycles', () => {
    const model = new ModelRun()
    model.apply(declaration())

    model.dispatch(['a', 'b'])
    model.start('a')
    model.start('b')
    model.complete('b')
    model.complete('a')

    model.dispatch(['c', 'd'])
    model.start('c')
    model.apply({ type: 'block', nodeId: DagNodeId('c'), reason: 'Need a decision.' })
    model.apply({ type: 'resume', nodeId: DagNodeId('c'), message: 'Use the approved choice.' })
    model.start('c')
    model.complete('c')

    model.start('d')
    const d = model.node('d')
    const dCommand = model.command('d')
    model.apply({
      type: 'child-ended',
      nodeId: d.id,
      commandId: dCommand.id,
      generation: d.generation,
      bindingGeneration: d.bindingGeneration,
      operationId: dCommand.operationId,
      reason: 'Child ended without a final report.',
    })
    model.apply({ type: 'redispatch', nodeId: DagNodeId('d') })
    model.dispatch(['d'])
    model.start('d')
    model.complete('d')

    model.dispatch(['e'])
    model.start('e')
    model.apply({ type: 'steer', nodeId: DagNodeId('e'), message: 'Use the recorded merge order.' })
    model.start('e')
    model.complete('e')

    model.dispatch(['f'])
    model.start('f')
    model.apply({ type: 'stop', nodeId: DagNodeId('f'), reason: 'Pause for review.' })
    expect(model.node('f').status).toBe('interrupted')
    const stop = model.command('f')
    model.apply({
      type: 'command-settled',
      nodeId: DagNodeId('f'),
      commandId: stop.id,
      generation: stop.generation,
      bindingGeneration: stop.bindingGeneration,
      operationId: stop.operationId,
    })
    model.apply({ type: 'resume', nodeId: DagNodeId('f'), message: 'Continue after review.' })
    model.start('f')
    model.complete('f')

    expect(model.production?.counts.completed).toBe(6)
    expect(model.production?.readyNodeIds).toEqual([])
    expect(model.production?.waves.every(wave => wave.status === 'settled')).toBe(true)
    expect(new Set(model.production?.notices.map(notice => notice.id)).size).toBe(model.production?.notices.length)
    expect(model.snapshots.length).toBeGreaterThan(40)
  })

  it('gives parallel effect barriers one sequential result for either root order', () => {
    const left = runRootOrder(['a', 'b'])
    const right = runRootOrder(['b', 'a'])
    expect(abstractDagState(left)).toEqual(abstractDagState(right))
    expect(left.waves).toEqual(right.waves)
    expect(left.notices).toEqual(right.notices)
  })

  it('rejects a completion result that matches ids but has the wrong binding generation', () => {
    const model = new ModelRun()
    model.apply(declaration())
    model.dispatch(['a'])
    model.start('a')
    model.apply({ type: 'complete', nodeId: DagNodeId('a'), summary: 'Complete a', artifacts: [] })
    const command = model.command('a')
    const before = model.production!
    const after = reduceDagState(before, {
      type: 'completion-succeeded',
      nodeId: DagNodeId('a'),
      commandId: command.id,
      generation: command.generation,
      bindingGeneration: command.bindingGeneration + 1,
      operationId: command.operationId,
      evidence: { commit: 'a'.repeat(40) },
    }).state
    expect(after).toBe(before)
  })
})
