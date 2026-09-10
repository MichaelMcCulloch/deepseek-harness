import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  DagCommandId,
  DagNodeId,
  DagNoticeId,
  DagOperationId,
  DagWaveId,
} from '../src/ids.ts'
import { reduceDagState } from '../src/reducer.ts'
import {
  actionable,
  asError,
  errorText,
  hasActiveFence,
  messageRecorded,
  messageText,
  nonEmpty,
  noticeRecorded,
  ownerMetadata,
  positiveInteger,
  requiredOperation,
  requiredValue,
  resolveDagConfig,
  waitForShared,
  waveFences,
} from '../src/runtime.ts'
import type { DagEffectFence } from '../src/reducer.ts'
import type { DagNodeInput, DagState } from '../src/types.ts'
import { validateDagDeclaration } from '../src/validation.ts'

const brief = 'VALIDATION: run tests.\nACCEPTANCE: commit clean work.'

function input(): DagNodeInput {
  return {
    id: 'a',
    content: 'Do a',
    brief,
    deps: [],
    status: 'pending',
    files: ['src/a.ts'],
  }
}

function dispatched(): DagState {
  const declaration = validateDagDeclaration([input()])
  const written = reduceDagState(null, {
    type: 'write',
    noticeNamespace: 'runtime',
    nodes: declaration.definitions.map(definition => ({ definition, status: 'pending' })),
    topologicalOrder: declaration.topologicalOrder,
  }).state
  return reduceDagState(written, {
    type: 'dispatch',
    nodeIds: [DagNodeId('a')],
    bindings: { a: { childSessionId: SessionId('child-a'), branch: 'branch-a', worktree: '/tmp/a' } },
  }).state
}

function userMessage(id: string): UserMessage {
  return freezeMessage({
    id: MessageId(id),
    role: 'user',
    content: [{ type: 'text', text: id }],
    source: { kind: 'user' },
  })
}

function fakeAgent(
  nextTurn: readonly UserMessage[] = [],
  nextStep: readonly UserMessage[] = [],
  events: readonly unknown[] = [],
): Agent {
  return {
    inbox: { nextTurn, nextStep },
    session: { snapshotEvents: () => events },
  } as unknown as Agent
}

describe('DAG runtime scalar helpers', () => {
  it('requires operation ids and filters actionable delivered notices', () => {
    expect(requiredOperation({ state: dispatched(), operationId: DagOperationId('op') })).toBe('op')
    expect(() => requiredOperation({ state: dispatched() })).toThrow(expect.objectContaining({ code: 'dag-invalid-state' }))

    const state = {
      ...dispatched(),
      notices: [
        { id: DagNoticeId('pending'), kind: 'node-failed' as const, revision: 2, graphGeneration: 1, text: 'pending', delivered: false },
        { id: DagNoticeId('legacy'), kind: 'node-failed' as const, revision: 3, graphGeneration: 1, text: 'legacy', delivered: true },
        { id: DagNoticeId('new'), kind: 'node-failed' as const, revision: 2, graphGeneration: 1, text: 'new', delivered: true, deliveredRevision: 4 },
      ],
    }
    expect(actionable(state, 2).map(notice => notice.id)).toEqual(['legacy', 'new'])
    expect(actionable(state, 4)).toEqual([])
  })

  it('validates scalar configuration and text values', () => {
    expect(positiveInteger(1, 'value')).toBe(1)
    for (const value of [1.5, 0, Number.NaN]) expect(() => positiveInteger(value, 'value')).toThrow(/positive safe integer/)
    expect(nonEmpty(' value ', 'text')).toBe('value')
    expect(() => nonEmpty(' ', 'text')).toThrow(/non-empty/)
    const missing = new Error('missing value')
    expect(requiredValue('value', missing)).toBe('value')
    expect(() => { requiredValue(undefined, missing) }).toThrow(missing)
    expect(() => requiredValue(null, missing)).toThrow(missing)
    expect(errorText(new Error('failure'))).toBe('failure')
    expect(errorText('failure')).toBe('failure')
    const error = new Error('same')
    expect(asError(error, 'fallback')).toBe(error)
    expect(asError('cause', 'fallback')).toMatchObject({ message: 'fallback', cause: 'cause' })
  })

  it('resolves default and explicit DAG deployment configuration', () => {
    expect(resolveDagConfig({})).toMatchObject({
      gitExecutable: 'git',
      commandDeadlineMs: 120_000,
      terminationGraceMs: 5_000,
      outputLimitBytes: 8 * 1024 * 1024,
      subagentProvider: 'spawn',
    })
    expect(resolveDagConfig({
      dshHome: ' /tmp/dag-home ',
      gitExecutable: ' custom-git ',
      commandDeadlineMs: 1,
      terminationGraceMs: 2,
      outputLimitBytes: 3,
      subagentProvider: ' provider ',
    })).toEqual({
      dshHome: '/tmp/dag-home',
      gitExecutable: 'custom-git',
      commandDeadlineMs: 1,
      terminationGraceMs: 2,
      outputLimitBytes: 3,
      subagentProvider: 'provider',
    })
  })

  it('extracts only ordinary text from redirect messages', () => {
    const message: UserMessage = freezeMessage({
      id: MessageId('redirect'),
      role: 'user',
      content: [
        { type: 'reasoning', text: 'ignored' },
        { type: 'text', text: ' first ' },
        { type: 'text', text: 'second' },
      ],
      source: { kind: 'user' },
    })
    expect(messageText(message)).toBe('first \nsecond')
    expect(() => messageText(freezeMessage({
      id: MessageId('empty'), role: 'user', content: [], source: { kind: 'user' },
    }))).toThrow(expect.objectContaining({ code: 'dag-invalid-message' }))
  })
})

describe('DAG runtime owner and delivery helpers', () => {
  it('accepts only the exact durable owner record', () => {
    const valid = { controller: 'dag', metadata: { version: 1, dispatcherSessionId: 'dispatcher', nodeId: 'a' } } as const
    expect(ownerMetadata(valid)).toEqual({ version: 1, dispatcherSessionId: 'dispatcher', nodeId: 'a' })
    const invalid = [
      { controller: 'other', metadata: valid.metadata },
      { controller: 'dag', metadata: null },
      { controller: 'dag', metadata: [] },
      { controller: 'dag', metadata: 'text' },
      { controller: 'dag', metadata: { version: 1, dispatcherSessionId: 'dispatcher' } },
      { controller: 'dag', metadata: { version: 1, dispatcherSessionId: 'dispatcher', nodeId: 'a', extra: true } },
      { controller: 'dag', metadata: { version: 2, dispatcherSessionId: 'dispatcher', nodeId: 'a' } },
      { controller: 'dag', metadata: { version: 1, dispatcherSessionId: 1, nodeId: 'a' } },
      { controller: 'dag', metadata: { version: 1, dispatcherSessionId: '', nodeId: 'a' } },
      { controller: 'dag', metadata: { version: 1, dispatcherSessionId: 'dispatcher', nodeId: 1 } },
      { controller: 'dag', metadata: { version: 1, dispatcherSessionId: 'dispatcher', nodeId: '' } },
    ]
    for (const binding of invalid) expect(() => ownerMetadata(binding as never))
      .toThrow(expect.objectContaining({ code: 'dag-invalid-owner' }))
  })

  it('finds deterministic messages in each inbox and session location', () => {
    const wanted = userMessage('wanted')
    const other = userMessage('other')
    expect(messageRecorded(fakeAgent([wanted]), wanted.id)).toBe(true)
    expect(messageRecorded(fakeAgent([other], [wanted]), wanted.id)).toBe(true)
    expect(messageRecorded(fakeAgent([other], [other], [{
      type: 'user/message', data: wanted,
    }]), wanted.id)).toBe(true)
    expect(messageRecorded(fakeAgent([other], [other], [{
      type: 'turn/start', data: { turn: 1 },
    }]), wanted.id)).toBe(false)
  })

  it('finds notices in pending inboxes and claimed session events', () => {
    const noticeId = DagNoticeId('notice')
    const notice = freezeMessage({
      id: MessageId('notice-message'),
      role: 'user',
      content: [{ type: 'text', text: 'notice' }],
      source: { kind: 'dag-notice', form: 'notice', noticeId, summary: 'notice' },
    })
    const other = userMessage('other')
    expect(noticeRecorded(fakeAgent([notice]), noticeId)).toBe(true)
    expect(noticeRecorded(fakeAgent([other], [], [{ type: 'user/message', data: notice }]), noticeId)).toBe(true)
    expect(noticeRecorded(fakeAgent([other], [], [{ type: 'turn/start', data: { turn: 1 } }]), noticeId)).toBe(false)
  })
})

describe('DAG runtime effect fences', () => {
  it('captures only active dispatch, resume, and steer commands for one wave', () => {
    const state = dispatched()
    const node = state.nodes[0]!
    const waveId = node.waveId!
    expect(waveFences(state, waveId)).toEqual([expect.objectContaining({ nodeId: 'a', commandId: node.commands[0]!.id })])
    expect(waveFences(state, DagWaveId('other'))).toEqual([])
    const { currentOperationId: _currentOperationId, ...nodeWithoutOperation } = node
    expect(waveFences({ ...state, nodes: [nodeWithoutOperation] }, waveId)).toEqual([])
    for (const command of [
      { ...node.commands[0]!, operationId: DagOperationId('other') },
      { ...node.commands[0]!, generation: 2 },
      { ...node.commands[0]!, bindingGeneration: 2 },
      { ...node.commands[0]!, kind: 'reset' as const },
      { ...node.commands[0]!, state: 'settled' as const },
    ]) expect(waveFences({ ...state, nodes: [{ ...node, commands: [command] }] }, waveId)).toEqual([])
    for (const kind of ['resume', 'steer'] as const) {
      expect(waveFences({ ...state, nodes: [{ ...node, commands: [{ ...node.commands[0]!, kind }] }] }, waveId)).toHaveLength(1)
    }
  })

  it('requires every node and command fence fact to remain current', () => {
    const state = dispatched()
    const node = state.nodes[0]!
    const command = node.commands[0]!
    const exact: DagEffectFence = {
      nodeId: node.id,
      commandId: command.id,
      generation: node.generation,
      bindingGeneration: node.bindingGeneration,
      operationId: command.operationId,
    }
    expect(hasActiveFence(null, [exact])).toBe(false)
    expect(hasActiveFence(state, [exact])).toBe(true)
    for (const candidate of [
      { ...exact, nodeId: DagNodeId('missing') },
      { ...exact, generation: 2 },
      { ...exact, bindingGeneration: 2 },
      { ...exact, operationId: DagOperationId('other') },
      { ...exact, commandId: DagCommandId('missing') },
    ]) expect(hasActiveFence(state, [candidate])).toBe(false)
    expect(hasActiveFence({ ...state, nodes: [{
      ...node, commands: [{ ...command, state: 'settled' }],
    }] }, [exact])).toBe(false)
  })
})

describe('DAG shared effect waits', () => {
  it('resolves, rejects, and cancels without owning the shared promise', async () => {
    await expect(waitForShared(Promise.resolve('done'), new AbortController().signal)).resolves.toBe('done')
    const failure = new Error('failed')
    await expect(waitForShared(Promise.reject(failure), new AbortController().signal)).rejects.toBe(failure)
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Arbitrary shared-promise rejection is the tested input.
    await expect(waitForShared(Promise.reject('failed'), new AbortController().signal)).rejects.toMatchObject({
      message: 'shared DAG effect failed', cause: 'failed',
    })

    const already = new AbortController()
    already.abort(failure)
    expect(() => waitForShared(Promise.resolve('unused'), already.signal)).toThrow(failure)

    const pending = Promise.withResolvers<string>()
    const controller = new AbortController()
    const waiting = waitForShared(pending.promise, controller.signal)
    controller.abort('cancelled')
    await expect(waiting).rejects.toMatchObject({ message: 'shared DAG effect wait was aborted', cause: 'cancelled' })
    pending.resolve('ignored')
  })
})
