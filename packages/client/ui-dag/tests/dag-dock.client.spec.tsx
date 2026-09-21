// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import type { DagNodeId, DagProjection } from '@deepseek-ai/dsh-dag/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { DagBoard, DagDock } from '../src/client/DagDock.tsx'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { apply as applyHost } from '../src/index.ts'

afterEach(cleanup)

const nodeId = (value: string): DagNodeId => value as DagNodeId

function board(): DagProjection {
  return {
    revision: 8,
    graphGeneration: 2,
    nodes: [
      {
        id: nodeId('root'), content: 'Prepare the base', deps: [], kind: 'task', policy: 'delegate', files: ['src/root.ts'],
        status: 'completed', generation: 1, branch: 'dsh/dag/x/g2/root', dependencyCommits: [], conflictedFiles: [], completedCommit: '1'.repeat(40),
      },
      {
        id: nodeId('tail'), content: 'Integrate the result', deps: [nodeId('root')], kind: 'integration', policy: 'delegate', files: [],
        status: 'pending', generation: 0, dependencyCommits: ['1'.repeat(40)], conflictedFiles: [],
      },
    ],
    counts: { pending: 1, starting: 0, in_progress: 0, completed: 1, blocked: 0, failed: 0, interrupted: 0 },
    readyNodeIds: [nodeId('tail')],
    openWaves: [],
  }
}

async function bench() {
  const ctx = new Context()
  const sessions = {
    binding: () => ({
      sessionId: 'session',
      session: { projections: { faceOf: () => ({ getSnapshot: () => board(), subscribe: () => () => {} }) } },
      ctx,
    }),
  }
  ctx.provide('sessions', sessions)
  new UiConversation(ctx, sessions as never)
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: { 'conversation.input.dock': { kind: 'list', scope: 'session' } },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber }
}

describe('read-only DAG dock', () => {
  it('keeps the host half empty', () => {
    expect(applyHost).toBeTypeOf('function')
    applyHost()
  })

  it('hides before the first projection and shows counts in topological order', () => {
    const t = makeTranslate(en)
    const empty = render(<DagBoard dag={null} t={t} />)
    expect(empty.container.firstChild).toBeNull()
    cleanup()

    render(<DagBoard dag={board()} t={t} />)
    expect(screen.getByText('Task Graph')).toBeTruthy()
    expect(screen.getByText('Pending: 1')).toBeTruthy()
    expect(screen.getByText('Completed: 1')).toBeTruthy()
    expect(screen.getByText('Ready: 1')).toBeTruthy()
    expect(screen.getAllByRole('listitem').map(row => row.textContent)).toEqual([
      'root: Prepare the baseCompleted',
      'tail: Integrate the resultPending',
    ])
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('uses both locale-owned dictionaries', () => {
    const english = render(<DagBoard dag={board()} t={makeTranslate(en)} />)
    expect(english.getByText('Task Graph')).toBeTruthy()
    cleanup()
    const chinese = render(<DagBoard dag={board()} t={makeTranslate(zh)} />)
    expect(chinese.getByText('任务图')).toBeTruthy()
    expect(chinese.getByText('就绪: 1')).toBeTruthy()
  })

  it('reads the dag projection through the dock adapter', () => {
    const value = board()
    const props = { useProjection: () => value, t: makeTranslate(en) } as unknown as Parameters<typeof DagDock>[0]
    const result = render(<DagDock {...props} />)
    expect(result.getByText('Task Graph')).toBeTruthy()
  })

  it('registers order 15 and removes the dock when the plugin unloads', async () => {
    const { ctx, fiber } = await bench()
    const entry = () => ctx.slots.entries('conversation.input.dock').find(row => row.options.id === 'dag')
    expect(entry()?.options).toMatchObject({ id: 'dag', order: 15 })
    expect(entry()?.locale).toBe('dag')
    await fiber.dispose()
    expect(entry()).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
