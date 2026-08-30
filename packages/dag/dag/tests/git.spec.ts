import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { DagGit } from '../src/git.ts'
import type { DagNodeSnapshot } from '../src/types.ts'
import { DagNodeId } from '../src/ids.ts'

const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim()

describe('local DAG Git effects', () => {
  let temporary = ''
  let root = ''
  let home = ''
  let ctx: Context
  let fiber: Awaited<ReturnType<Context['plugin']>>
  let git: DagGit
  const signal = new AbortController().signal

  const snapshot = (id: string, overrides: Partial<DagNodeSnapshot> = {}): DagNodeSnapshot => ({
    id: DagNodeId(id),
    content: `Implement ${id}`,
    brief: 'VALIDATION: test.\nACCEPTANCE: commit.',
    deps: [],
    kind: 'task',
    policy: 'delegate',
    files: ['owned.txt'],
    status: 'starting',
    generation: 1,
    bindingGeneration: 1,
    dependencyCommits: [],
    conflictedFiles: [],
    commands: [],
    ...overrides,
  })

  const dependency = async (branch: string, changes: Readonly<Record<string, string>>): Promise<string> => {
    const base = run(root, 'rev-parse', 'HEAD')
    const worktree = join(temporary, `dependency-${branch}`)
    run(root, 'branch', branch, base)
    run(root, 'worktree', 'add', worktree, branch)
    for (const [path, content] of Object.entries(changes)) {
      const target = join(worktree, path)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, content)
    }
    run(worktree, 'add', '.')
    run(worktree, 'commit', '-m', `dependency ${branch}`)
    const commit = run(worktree, 'rev-parse', 'HEAD')
    run(root, 'worktree', 'remove', worktree)
    return commit
  }

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'dsh-dag-git-'))
    root = join(temporary, 'root')
    home = join(temporary, 'home')
    await import('node:fs/promises').then(fs => fs.mkdir(root, { recursive: true }))
    run(root, 'init', '-b', 'main')
    run(root, 'config', 'user.email', 'dag@example.invalid')
    run(root, 'config', 'user.name', 'DAG Test')
    await writeFile(join(root, 'owned.txt'), 'base\n')
    run(root, 'add', 'owned.txt')
    run(root, 'commit', '-m', 'base')
    ctx = new Context()
    fiber = await ctx.plugin(LocalSubprocessRuntime)
    git = new DagGit(ctx, {
      dshHome: home,
      gitExecutable: 'git',
      commandDeadlineMs: 10_000,
      terminationGraceMs: 200,
      outputLimitBytes: 1024 * 1024,
    })
  })

  afterEach(async () => {
    await fiber.dispose()
    await rm(temporary, { recursive: true, force: true })
  })

  it('accepts one clean symbolic root and rejects dirt and detached HEAD', async () => {
    await expect(git.probeRoot(root, signal)).resolves.toMatchObject({ branch: 'main', head: run(root, 'rev-parse', 'HEAD') })
    run(root, 'branch', 'upstream')
    run(root, 'branch', '--set-upstream-to=upstream', 'main')
    await expect(git.probeRoot(root, signal)).resolves.toMatchObject({ branch: 'main', head: run(root, 'rev-parse', 'HEAD') })
    await writeFile(join(root, 'untracked.txt'), 'dirt\n')
    await expect(git.probeRoot(root, signal)).rejects.toThrow(/clean root worktree/)
    await rm(join(root, 'untracked.txt'))
    run(root, 'checkout', '--detach')
    await expect(git.probeRoot(root, signal)).rejects.toThrow(/symbolic local root branch/)
  })

  it('creates a local worktree, validates a new clean commit, and preserves untracked files on reset', async () => {
    const base = run(root, 'rev-parse', 'HEAD')
    const worktree = join(home, 'dag', 'worktrees', 'v1', 'session', 'g1', 'node-a')
    const node: DagNodeSnapshot = {
      id: DagNodeId('a'),
      content: 'Edit owned file',
      brief: 'VALIDATION: test.\nACCEPTANCE: commit.',
      deps: [],
      kind: 'task',
      policy: 'delegate',
      files: ['owned.txt'],
      status: 'starting',
      generation: 1,
      bindingGeneration: 1,
      dependencyCommits: [],
      conflictedFiles: [],
      commands: [],
    }
    const prepared = await git.prepare(root, node, 'dsh/dag/session/g1/node-a', worktree, base, [], signal)
    await writeFile(join(worktree, 'owned.txt'), 'complete\n')
    run(worktree, 'add', 'owned.txt')
    run(worktree, 'commit', '-m', 'complete node')
    const executable: DagNodeSnapshot = {
      ...node,
      status: 'in_progress',
      branch: prepared.branch,
      worktree: prepared.worktree,
      frozenWaveBase: base,
      preparedHead: prepared.head,
    }
    const completed = await git.validateCompletion(executable, signal)
    expect(completed).not.toBe(base)
    await writeFile(join(worktree, 'keep.txt'), 'untracked\n')
    const conflicting = await dependency('reset-conflict', { 'owned.txt': 'dependency conflict\n' })
    expect(() => run(worktree, 'merge', conflicting)).toThrow()
    expect(run(worktree, 'rev-parse', '--verify', 'MERGE_HEAD')).toBe(conflicting)
    const reset = await git.reset({ ...executable, status: 'failed' }, base, signal)
    expect(reset.targetCommit).toBe(base)
    expect(reset.remainingDirt.join('\n')).toContain('keep.txt')
    expect(() => run(worktree, 'rev-parse', '--verify', 'MERGE_HEAD')).toThrow()
    await expect(readFile(join(worktree, 'keep.txt'), 'utf8')).resolves.toBe('untracked\n')
  })

  it('accepts only the frozen base, exact commits, and explicit local branch refs for reset', async () => {
    const base = run(root, 'rev-parse', 'HEAD')
    const worktree = join(home, 'dag', 'worktrees', 'v1', 'session', 'g1', 'reset-targets')
    const prepared = await git.prepare(
      root,
      snapshot('reset-targets'),
      'dsh/dag/session/g1/reset-targets',
      worktree,
      base,
      [],
      signal,
    )
    const failed = snapshot('reset-targets', {
      status: 'failed',
      branch: prepared.branch,
      worktree,
      frozenWaveBase: base,
      preparedHead: prepared.head,
    })

    for (const target of ['main', 'HEAD', 'origin/main', 'refs/remotes/origin/main', '@{upstream}']) {
      await expect(git.reset(failed, target, signal)).rejects.toThrow(/reset target|remote refs/)
    }
    await expect(git.reset(failed, 'refs/heads/main', signal)).resolves.toMatchObject({ targetCommit: base })
    await expect(git.reset(failed, base, signal)).resolves.toMatchObject({ targetCommit: base })
  })

  it('rejects dirty, uncommitted, merging, and dependency-incomplete completion evidence', async () => {
    await writeFile(join(root, 'conflict.txt'), 'base\n')
    run(root, 'add', 'conflict.txt')
    run(root, 'commit', '-m', 'completion evidence base')
    const base = run(root, 'rev-parse', 'HEAD')
    const worktree = join(home, 'dag', 'worktrees', 'v1', 'session', 'g1', 'completion-evidence')
    const node = snapshot('completion-evidence')
    const prepared = await git.prepare(
      root,
      node,
      'dsh/dag/session/g1/completion-evidence',
      worktree,
      base,
      [],
      signal,
    )
    const executable = snapshot('completion-evidence', {
      status: 'in_progress',
      branch: prepared.branch,
      worktree,
      frozenWaveBase: base,
      preparedHead: prepared.head,
    })

    await expect(git.validateCompletion(executable, signal)).rejects.toThrow(/commit after the frozen wave base/)
    await writeFile(join(worktree, 'owned.txt'), 'dirty\n')
    await expect(git.validateCompletion(executable, signal)).rejects.toThrow(/not clean/)
    run(worktree, 'reset', '--hard', base)

    const missing = await dependency('missing-ancestor', { 'dep.txt': 'dependency\n' })
    await writeFile(join(worktree, 'owned.txt'), 'local completion\n')
    run(worktree, 'add', 'owned.txt')
    run(worktree, 'commit', '-m', 'local completion')
    await expect(git.validateCompletion(snapshot('completion-evidence', {
      ...executable,
      deps: [DagNodeId('dependency')],
      dependencyCommits: [missing],
    }), signal)).rejects.toThrow(/is not an ancestor/)

    const conflicting = await dependency('active-merge', { 'owned.txt': 'dependency completion\n' })
    expect(() => run(worktree, 'merge', conflicting)).toThrow()
    await expect(git.validateCompletion(executable, signal)).rejects.toThrow(/active merge/)
  })

  it('refuses completion outside declared task files', async () => {
    const base = run(root, 'rev-parse', 'HEAD')
    const worktree = join(home, 'dag', 'worktrees', 'v1', 'session', 'g1', 'node-b')
    const node: DagNodeSnapshot = {
      id: DagNodeId('b'), content: 'Wrong file', brief: 'VALIDATION: test.\nACCEPTANCE: commit.', deps: [],
      kind: 'task', policy: 'delegate', files: ['owned.txt'], status: 'starting', generation: 1,
      bindingGeneration: 1, dependencyCommits: [], conflictedFiles: [], commands: [],
    }
    const prepared = await git.prepare(root, node, 'dsh/dag/session/g1/node-b', worktree, base, [], signal)
    await writeFile(join(worktree, 'outside.txt'), 'outside\n')
    run(worktree, 'add', 'outside.txt')
    run(worktree, 'commit', '-m', 'outside ownership')
    await expect(git.validateCompletion({
      ...node,
      status: 'in_progress',
      branch: prepared.branch,
      worktree,
      frozenWaveBase: base,
      preparedHead: prepared.head,
    }, signal)).rejects.toThrow(/outside its declaration/)
  })

  it('matches declared ownership for spaces and non-ASCII path bytes', async () => {
    const base = run(root, 'rev-parse', 'HEAD')
    const worktree = join(home, 'dag', 'worktrees', 'v1', 'session', 'g1', 'portable-path')
    const ownedPath = 'owned space-µ.txt'
    const node = snapshot('portable-path', { files: [ownedPath] })
    const prepared = await git.prepare(
      root,
      node,
      'dsh/dag/session/g1/portable-path',
      worktree,
      base,
      [],
      signal,
    )
    await writeFile(join(worktree, ownedPath), 'portable\n')
    run(worktree, 'add', ownedPath)
    run(worktree, 'commit', '-m', 'complete portable path')

    await expect(git.validateCompletion({
      ...node,
      status: 'in_progress',
      branch: prepared.branch,
      worktree,
      frozenWaveBase: base,
      preparedHead: prepared.head,
    }, signal)).resolves.toBe(run(worktree, 'rev-parse', 'HEAD'))
  })

  it('requires a reused clean worktree to descend from the new frozen wave commit', async () => {
    const oldBase = run(root, 'rev-parse', 'HEAD')
    const worktree = join(home, 'dag', 'worktrees', 'v1', 'session', 'g1', 'old-base')
    const branch = 'dsh/dag/session/g1/old-base'
    await git.prepare(root, snapshot('old-base'), branch, worktree, oldBase, [], signal)
    await writeFile(join(root, 'root-only.txt'), 'new root\n')
    run(root, 'add', 'root-only.txt')
    run(root, 'commit', '-m', 'advance root')
    const newBase = run(root, 'rev-parse', 'HEAD')

    await expect(git.prepare(root, snapshot('old-base', { frozenWaveBase: newBase }), branch, worktree, newBase, [], signal))
      .rejects.toThrow(/not based on frozen wave commit.*reset it first/)
  })

  it('verifies durable preparation before retry while preserving later child work', async () => {
    const base = run(root, 'rev-parse', 'HEAD')
    const dependencyCommit = await dependency('retry-evidence-dep', { 'dependency.txt': 'dependency\n' })
    const worktree = join(home, 'dag', 'worktrees', 'v1', 'session', 'g1', 'retry-evidence')
    const branch = 'dsh/dag/session/g1/retry-evidence'
    const node = snapshot('retry-evidence', {
      deps: [DagNodeId('dependency')],
      dependencyCommits: [dependencyCommit],
    })
    const prepared = await git.prepare(root, node, branch, worktree, base, [dependencyCommit], signal)
    const durable = snapshot('retry-evidence', {
      ...node,
      branch,
      worktree,
      frozenWaveBase: base,
      preparedHead: prepared.head,
    })

    await expect(git.verifyPrepared(root, durable, signal)).resolves.toBeUndefined()
    await writeFile(join(worktree, 'owned.txt'), 'uncommitted child work\n')
    await expect(git.verifyPrepared(root, durable, signal)).resolves.toBeUndefined()
    run(worktree, 'reset', '--hard', base)
    await expect(git.verifyPrepared(root, durable, signal)).rejects.toThrow(/does not retain prepared commit/)
  })

  it('merges an exact dependency fan-in and checks only child-owned commits', async () => {
    const base = run(root, 'rev-parse', 'HEAD')
    const first = await dependency('dep-a', { 'dep-a.txt': 'a\n' })
    const second = await dependency('dep-b', { 'dep-b.txt': 'b\n' })
    const worktree = join(home, 'dag', 'worktrees', 'v1', 'session', 'g1', 'fan-in')
    const node = snapshot('fan-in', {
      deps: [DagNodeId('a'), DagNodeId('b')],
      dependencyCommits: [first, second],
    })

    const prepared = await git.prepare(root, node, 'dsh/dag/session/g1/fan-in', worktree, base, [first, second], signal)

    expect(prepared.dependencyCommits).toEqual([first, second])
    expect(run(worktree, 'merge-base', '--is-ancestor', first, 'HEAD')).toBe('')
    expect(run(worktree, 'merge-base', '--is-ancestor', second, 'HEAD')).toBe('')
    await writeFile(join(worktree, 'owned.txt'), 'fan-in complete\n')
    run(worktree, 'add', 'owned.txt')
    run(worktree, 'commit', '-m', 'complete fan-in task')
    await expect(git.validateCompletion({
      ...node,
      status: 'in_progress',
      branch: prepared.branch,
      worktree,
      frozenWaveBase: base,
      preparedHead: prepared.head,
    }, signal)).resolves.toBe(run(worktree, 'rev-parse', 'HEAD'))
  })

  it('refuses a task ownership collision before it merges a dependency', async () => {
    const base = run(root, 'rev-parse', 'HEAD')
    const conflicting = await dependency('dep-owned', { 'owned.txt': 'dependency owns it\n' })
    const worktree = join(home, 'dag', 'worktrees', 'v1', 'session', 'g1', 'collision')

    await expect(git.prepare(
      root,
      snapshot('collision', { deps: [DagNodeId('dep')], dependencyCommits: [conflicting] }),
      'dsh/dag/session/g1/collision',
      worktree,
      base,
      [conflicting],
      signal,
    )).rejects.toThrow(/owns files changed by dependency/)
    expect(run(worktree, 'rev-parse', 'HEAD')).toBe(base)
    expect(() => run(worktree, 'rev-parse', '--verify', 'MERGE_HEAD')).toThrow()
  })

  it.each([
    ['ours', 'base\n', []],
    ['theirs', 'second\n', []],
    ['delegate', 'first\n', ['conflict.txt']],
  ] as const)('applies the %s integration policy without leaving an active merge', async (policy, expected, conflicts) => {
    await writeFile(join(root, 'conflict.txt'), 'base\n')
    run(root, 'add', 'conflict.txt')
    run(root, 'commit', '-m', 'conflict base')
    const base = run(root, 'rev-parse', 'HEAD')
    const first = await dependency(`${policy}-first`, { 'conflict.txt': 'first\n' })
    const second = await dependency(`${policy}-second`, { 'conflict.txt': 'second\n' })
    const worktree = join(home, 'dag', 'worktrees', 'v1', 'session', 'g1', `integration-${policy}`)
    const node = snapshot(`integration-${policy}`, {
      kind: 'integration',
      policy,
      files: [],
      deps: [DagNodeId('first'), DagNodeId('second')],
      dependencyCommits: [first, second],
    })

    const prepared = await git.prepare(root, node, `dsh/dag/session/g1/integration-${policy}`, worktree, base, [first, second], signal)

    expect(await readFile(join(worktree, 'conflict.txt'), 'utf8')).toBe(expected)
    expect(prepared.conflictedFiles).toEqual(conflicts)
    expect(() => run(worktree, 'rev-parse', '--verify', 'MERGE_HEAD')).toThrow()
    if (policy === 'delegate') {
      expect(run(worktree, 'merge-base', '--is-ancestor', first, 'HEAD')).toBe('')
      expect(() => run(worktree, 'merge-base', '--is-ancestor', second, 'HEAD')).toThrow()
    } else {
      expect(run(worktree, 'merge-base', '--is-ancestor', first, 'HEAD')).toBe('')
      expect(run(worktree, 'merge-base', '--is-ancestor', second, 'HEAD')).toBe('')
    }
  })

  it('stops delegated automatic integration at the first conflict', async () => {
    await writeFile(join(root, 'conflict.txt'), 'base\n')
    run(root, 'add', 'conflict.txt')
    run(root, 'commit', '-m', 'conflict base')
    const base = run(root, 'rev-parse', 'HEAD')
    const precursor = await dependency('delegate-precursor', { 'conflict.txt': 'precursor\n' })
    const conflicting = await dependency('delegate-conflicting', { 'conflict.txt': 'conflicting\n' })
    const later = await dependency('delegate-later', { 'later.txt': 'later\n' })
    const worktree = join(home, 'dag', 'worktrees', 'v1', 'session', 'g1', 'delegate-order')
    const node = snapshot('delegate-order', {
      kind: 'integration',
      policy: 'delegate',
      files: [],
      deps: [DagNodeId('precursor'), DagNodeId('conflicting'), DagNodeId('later')],
      dependencyCommits: [precursor, conflicting, later],
    })

    const prepared = await git.prepare(
      root,
      node,
      'dsh/dag/session/g1/delegate-order',
      worktree,
      base,
      [precursor, conflicting, later],
      signal,
    )

    expect(prepared.conflictedFiles).toEqual(['conflict.txt'])
    expect(run(worktree, 'merge-base', '--is-ancestor', precursor, 'HEAD')).toBe('')
    expect(() => run(worktree, 'merge-base', '--is-ancestor', conflicting, 'HEAD')).toThrow()
    expect(() => run(worktree, 'merge-base', '--is-ancestor', later, 'HEAD')).toThrow()
    expect(() => run(worktree, 'rev-parse', '--verify', 'MERGE_HEAD')).toThrow()
  })

  it('aborts an unfinished automatic merge before it retries preparation', async () => {
    await writeFile(join(root, 'conflict.txt'), 'base\n')
    run(root, 'add', 'conflict.txt')
    run(root, 'commit', '-m', 'retry base')
    const base = run(root, 'rev-parse', 'HEAD')
    const dependencyCommit = await dependency('retry-dependency', { 'conflict.txt': 'dependency\n' })
    const worktree = join(home, 'dag', 'worktrees', 'v1', 'session', 'g1', 'retry-merge')
    const branch = 'dsh/dag/session/g1/retry-merge'
    const initial = await git.prepare(root, snapshot('retry-merge'), branch, worktree, base, [], signal)
    await writeFile(join(worktree, 'conflict.txt'), 'local\n')
    run(worktree, 'add', 'conflict.txt')
    run(worktree, 'commit', '-m', 'local preparation')
    expect(() => run(worktree, 'merge', dependencyCommit)).toThrow()
    expect(run(worktree, 'rev-parse', '--verify', 'MERGE_HEAD')).toBe(dependencyCommit)

    const prepared = await git.prepare(root, snapshot('retry-merge', {
      kind: 'integration',
      policy: 'delegate',
      files: [],
      deps: [DagNodeId('dependency')],
      dependencyCommits: [dependencyCommit],
    }), branch, worktree, initial.head, [dependencyCommit], signal)

    expect(prepared.conflictedFiles).toEqual(['conflict.txt'])
    expect(() => run(worktree, 'rev-parse', '--verify', 'MERGE_HEAD')).toThrow()
  })

  it('rejects an existing worktree from another repository', async () => {
    const other = join(temporary, 'other')
    await mkdir(other, { recursive: true })
    run(other, 'init', '-b', 'main')
    run(other, 'config', 'user.email', 'dag@example.invalid')
    run(other, 'config', 'user.name', 'DAG Test')
    await writeFile(join(other, 'other.txt'), 'other\n')
    run(other, 'add', 'other.txt')
    run(other, 'commit', '-m', 'other base')

    await expect(git.prepare(
      root,
      snapshot('other-repository'),
      'dsh/dag/session/g1/other-repository',
      other,
      run(root, 'rev-parse', 'HEAD'),
      [],
      signal,
    )).rejects.toThrow(/different repository/)
  })

  it('creates independent node worktrees concurrently', async () => {
    const base = run(root, 'rev-parse', 'HEAD')
    const paths = ['parallel-a', 'parallel-b'].map(name => join(home, 'dag', 'worktrees', 'v1', 'session', 'g1', name))
    const prepared = await Promise.all(paths.map((worktree, index) => git.prepare(
      root,
      snapshot(`parallel-${index}`),
      `dsh/dag/session/g1/parallel-${index}`,
      worktree,
      base,
      [],
      signal,
    )))
    expect(new Set(prepared.map(row => row.worktree)).size).toBe(2)
  })

  it('propagates caller cancellation instead of treating it as a missing Git fact', async () => {
    const controller = new AbortController()
    const reason = new Error('cancel Git')
    controller.abort(reason)
    await expect(git.probeRoot(root, controller.signal)).rejects.toBe(reason)
  })
})
