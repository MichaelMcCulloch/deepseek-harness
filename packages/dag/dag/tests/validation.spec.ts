import { describe, expect, it } from 'vitest'
import { DagNodeId } from '../src/ids.ts'
import {
  changedDefinitionFields,
  dependencyOwnershipViolations,
  rewireOmittedDependencies,
  validateDagDeclaration,
} from '../src/validation.ts'
import type { DagNodeDefinition, DagNodeDefinitionField, DagNodeInput, DagNodeSnapshot } from '../src/types.ts'

const valid = (overrides: Partial<DagNodeInput> = {}): DagNodeInput => ({
  id: 'a',
  content: 'Do A',
  brief: 'VALIDATION: test.\nACCEPTANCE: commit.',
  deps: [],
  status: 'pending',
  ...overrides,
})

/** Project one declaration row into the durable node an amendment would replace. */
const snapshotOf = (input: DagNodeInput): DagNodeSnapshot => ({
  id: DagNodeId(input.id),
  content: input.content,
  brief: input.brief,
  deps: input.deps.map(DagNodeId),
  kind: input.kind ?? 'task',
  policy: input.policy ?? 'delegate',
  files: input.files ?? [],
  status: input.status,
  generation: 0,
  bindingGeneration: 0,
  dependencyCommits: [],
  conflictedFiles: [],
  commands: [],
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

  it('reports every changed node definition field', () => {
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
    expect(changedDefinitionFields(node, definition)).toEqual([])

    const differences: readonly (readonly [DagNodeDefinition, readonly DagNodeDefinitionField[]])[] = [
      [{ ...definition, content: 'Different' }, ['content']],
      [{ ...definition, brief: 'VALIDATION: other.\nACCEPTANCE: other.' }, ['brief']],
      [{ ...definition, kind: 'integration' }, ['kind']],
      [{ ...definition, policy: 'ours' }, ['policy']],
      [{ ...definition, deps: [] }, ['deps']],
      [{ ...definition, deps: [DagNodeId('other')] }, ['deps']],
      [{ ...definition, files: [] }, ['files']],
      [{ ...definition, files: ['src/other.ts'] }, ['files']],
    ]
    for (const [changed, fields] of differences) expect(changedDefinitionFields(node, changed)).toEqual(fields)
    expect(changedDefinitionFields(node, {
      ...definition,
      content: 'Different',
      deps: [DagNodeId('other')],
      files: ['src/other.ts'],
    })).toEqual(['content', 'deps', 'files'])
  })

  it('rejects a task node that claims files a transitive dependency already owns', () => {
    expect(() => validateDagDeclaration([
      valid({ id: 'dep', files: ['src/shared.ts'] }),
      valid({ id: 'a', deps: ['dep'], files: ['src/shared.ts'] }),
    ])).toThrow(/already owned by dependency "dep"/)

    expect(() => validateDagDeclaration([
      valid({ id: 'root', files: ['src/shared.ts'] }),
      valid({ id: 'mid', deps: ['root'] }),
      valid({ id: 'a', deps: ['mid'], files: ['src/shared.ts'] }),
    ])).toThrow(/already owned by dependency "root"/)

    expect(validateDagDeclaration([
      valid({ id: 'dep', files: ['src/shared.ts'] }),
      valid({ id: 'a', deps: ['dep'], files: ['src/a.ts'] }),
      valid({ id: 'integration', deps: ['dep'], kind: 'integration', files: ['src/shared.ts'] }),
      valid({ id: 'unowned', deps: ['dep'] }),
    ]).definitions).toHaveLength(4)
  })

  it('rewires dependencies that name a node the durable graph already declared', () => {
    const rewritten = rewireOmittedDependencies([
      valid({ id: 'b', deps: ['dropped', 'kept', 'typo'] }),
      valid({ id: 'kept' }),
    ], new Set(['dropped', 'kept']))
    expect(rewritten.rewired).toEqual([{ id: 'b', removedDeps: ['dropped'] }])
    expect(rewritten.inputs[0]?.deps).toEqual(['kept', 'typo'])
    expect(rewritten.inputs[1]).toEqual(valid({ id: 'kept' }))

    const untouched = rewireOmittedDependencies([valid({ id: 'a', deps: ['b'] })], new Set())
    expect(untouched.rewired).toEqual([])
    expect(untouched.inputs[0]?.deps).toEqual(['b'])
  })

  it('reports every ownership violation together instead of the first one', () => {
    const nodes = [
      valid({ id: 'one', files: ['src/one.ts'] }),
      valid({ id: 'two', deps: ['one'], files: ['src/one.ts'] }),
      valid({ id: 'three', files: ['src/three.ts'] }),
      valid({ id: 'four', deps: ['three'], files: ['src/three.ts'] }),
    ]
    expect(() => validateDagDeclaration(nodes))
      .toThrow(/declared-file ownership violations: .*"two".*"one".*"four".*"three"/s)

    const clean = validateDagDeclaration([valid({ id: 'one', files: ['src/one.ts'] })]).definitions
    expect(dependencyOwnershipViolations(clean)).toEqual([])
  })

  it('retains only the ownership violations the durable graph already carried', () => {
    const nodes = [
      valid({ id: 'one', files: ['src/one.ts'] }),
      valid({ id: 'two', deps: ['one'], files: ['src/one.ts'] }),
      valid({ id: 'three', files: ['src/three.ts'] }),
      valid({ id: 'four', deps: ['three'], files: ['src/three.ts'] }),
    ]
    const prior = nodes.map(snapshotOf)
    const changed = (id: string, overrides: Partial<DagNodeInput>): DagNodeInput[] =>
      nodes.map(node => node.id === id ? { ...node, ...overrides } : node)

    // Clearing one edge leaves the untouched edge exactly as the durable graph had it.
    const repaired = validateDagDeclaration(changed('two', { files: ['src/two.ts'] }), { priorNodes: prior })
    expect(dependencyOwnershipViolations(repaired.definitions)).toEqual([
      { claimant: DagNodeId('four'), dependency: DagNodeId('three'), files: ['src/three.ts'] },
    ])

    // A repair order is never forced: the dependency side may change first.
    expect(() => validateDagDeclaration(
      changed('one', { files: ['src/one.ts', 'src/spare.ts'] }),
      { priorNodes: prior },
    )).not.toThrow()

    // Widening a known edge is refused.
    expect(() => validateDagDeclaration([
      { ...nodes[0]!, files: ['src/one.ts', 'src/extra.ts'] },
      { ...nodes[1]!, files: ['src/one.ts', 'src/extra.ts'] },
      nodes[2]!,
      nodes[3]!,
    ], { priorNodes: prior })).toThrow(/node "two" claims files already owned by dependency "one": src\/one.ts, src\/extra.ts/)

    // A new violating edge is refused even though the graph already violated another one.
    expect(() => validateDagDeclaration([
      nodes[0]!,
      nodes[1]!,
      nodes[2]!,
      { ...nodes[3]!, deps: ['three', 'one'], files: ['src/three.ts', 'src/one.ts'] },
    ], { priorNodes: prior })).toThrow(/node "four" claims files already owned by dependency "one"/)

    // A complete declaration keeps refusing every violation.
    expect(() => validateDagDeclaration(nodes, { priorNodes: [] })).toThrow(/declared-file ownership violations/)
  })
})
