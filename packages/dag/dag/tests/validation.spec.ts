import { describe, expect, it } from 'vitest'
import { DagNodeId } from '../src/ids.ts'
import { sameDefinition, validateDagDeclaration } from '../src/validation.ts'
import type { DagNodeDefinition, DagNodeInput, DagNodeSnapshot } from '../src/types.ts'

const valid = (overrides: Partial<DagNodeInput> = {}): DagNodeInput => ({
  id: 'a',
  content: 'Do A',
  brief: 'VALIDATION: test.\nACCEPTANCE: commit.',
  deps: [],
  status: 'pending',
  ...overrides,
})

describe('DAG declaration validation', () => {
  it.each([
    ['empty id', [valid({ id: ' ' })]],
    ['duplicate ids', [valid(), valid()]],
    ['empty content', [valid({ content: ' ' })]],
    ['self dependency', [valid({ deps: ['a'] })]],
    ['repeated dependency', [valid({ id: 'b', deps: ['a', 'a'] }), valid()]],
    ['missing dependency', [valid({ deps: ['missing'] })]],
    ['cycle', [valid({ id: 'a', deps: ['b'] }), valid({ id: 'b', deps: ['a'] })]],
    ['empty path', [valid({ files: [' '] })]],
    ['POSIX absolute path', [valid({ files: ['/secret.txt'] })]],
    ['unsafe path', [valid({ files: ['../secret'] })]],
    ['parent path', [valid({ files: ['..'] })]],
    ['repository root path', [valid({ files: ['.'] })]],
    ['Git metadata root', [valid({ files: ['.git'] })]],
    ['Git metadata path', [valid({ files: ['.git/config'] })]],
    ['control character path', [valid({ files: ['src/bad\nname.ts'] })]],
    ['Windows absolute path', [valid({ files: ['C:\\secret.txt'] })]],
    ['UNC path', [valid({ files: ['\\\\server\\share\\secret.txt'] })]],
    ['task policy', [valid({ policy: 'ours' })]],
    ['missing brief section', [valid({ brief: 'VALIDATION: test.' })]],
    ['missing validation section', [valid({ brief: 'ACCEPTANCE: commit.' })]],
  ])('rejects %s', (_label, nodes) => {
    expect(() => validateDagDeclaration(nodes)).toThrow()
  })

  it('normalizes a valid graph and returns its stable topological order', () => {
    const result = validateDagDeclaration([
      valid({ id: 'root', content: ' Root ', files: [' src\\root.ts '] }),
      valid({ id: 'integration', deps: [' root ', 'parallel'], kind: 'integration', policy: 'ours', files: ['src/result.ts'] }),
      valid({ id: 'parallel' }),
    ])
    expect(result.definitions).toEqual([
      expect.objectContaining({ id: 'root', content: 'Root', kind: 'task', policy: 'delegate', files: ['src/root.ts'] }),
      expect.objectContaining({ id: 'integration', deps: ['root', 'parallel'], kind: 'integration', policy: 'ours' }),
      expect.objectContaining({ id: 'parallel', files: [] }),
    ])
    expect(result.topologicalOrder).toEqual(['root', 'parallel', 'integration'])
  })

  it('compares every immutable node definition field', () => {
    const definition = validateDagDeclaration([
      valid({ id: 'dependency' }),
      valid({ id: 'a', deps: ['dependency'], files: ['src/a.ts'] }),
    ]).definitions[1]!
    const node: DagNodeSnapshot = {
      ...definition,
      status: 'pending',
      generation: 0,
      bindingGeneration: 0,
      dependencyCommits: [],
      conflictedFiles: [],
      commands: [],
    }
    expect(sameDefinition(node, definition)).toBe(true)

    const differences: DagNodeDefinition[] = [
      { ...definition, id: DagNodeId('b') },
      { ...definition, content: 'Different' },
      { ...definition, brief: 'VALIDATION: other.\nACCEPTANCE: other.' },
      { ...definition, kind: 'integration' },
      { ...definition, policy: 'ours' },
      { ...definition, deps: [] },
      { ...definition, deps: [DagNodeId('other')] },
      { ...definition, files: [] },
      { ...definition, files: ['src/other.ts'] },
    ]
    for (const changed of differences) expect(sameDefinition(node, changed)).toBe(false)
  })
})
