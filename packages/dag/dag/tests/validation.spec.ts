import { describe, expect, it } from 'vitest'
import { validateDagDeclaration } from '../src/validation.ts'
import type { DagNodeInput } from '../src/types.ts'

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
    ['duplicate ids', [valid(), valid()]],
    ['self dependency', [valid({ deps: ['a'] })]],
    ['missing dependency', [valid({ deps: ['missing'] })]],
    ['cycle', [valid({ id: 'a', deps: ['b'] }), valid({ id: 'b', deps: ['a'] })]],
    ['unsafe path', [valid({ files: ['../secret'] })]],
    ['repository root path', [valid({ files: ['.'] })]],
    ['Git metadata path', [valid({ files: ['.git/config'] })]],
    ['control character path', [valid({ files: ['src/bad\nname.ts'] })]],
    ['Windows absolute path', [valid({ files: ['C:\\secret.txt'] })]],
    ['UNC path', [valid({ files: ['\\\\server\\share\\secret.txt'] })]],
    ['task policy', [valid({ policy: 'ours' })]],
    ['missing brief section', [valid({ brief: 'VALIDATION: test.' })]],
  ])('rejects %s', (_label, nodes) => {
    expect(() => validateDagDeclaration(nodes)).toThrow()
  })
})
