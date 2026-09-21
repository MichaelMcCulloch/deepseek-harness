import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  DagCommandId,
  DagNodeId,
  DagNoticeId,
  DagOperationId,
  DagWaveId,
  dagSlug,
  dispatcherHash,
  shortHash,
} from '../src/ids.ts'

describe('DAG identifier helpers', () => {
  it('brands protocol identifiers without changing their wire values', () => {
    expect([
      DagNodeId('node'),
      DagOperationId('operation'),
      DagCommandId('command'),
      DagWaveId('wave'),
      DagNoticeId('notice'),
    ]).toEqual(['node', 'operation', 'command', 'wave', 'notice'])
  })

  it('creates stable short hashes for text and dispatcher sessions', () => {
    expect(shortHash('dispatcher')).toMatch(/^[0-9a-f]{12}$/)
    expect(dispatcherHash(SessionId('dispatcher'))).toBe(shortHash('dispatcher'))
  })

  it('normalizes and bounds a portable label', () => {
    expect(dagSlug(' Feature / BIG_name ')).toBe('feature-big-name')
    expect(dagSlug('a'.repeat(60))).toBe('a'.repeat(48))
  })

  it('uses a safe fallback when a label has no portable characters', () => {
    expect(dagSlug('---')).toBe('node')
  })
})
