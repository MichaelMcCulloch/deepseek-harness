import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutputRead,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { DagGit } from '../src/git.ts'
import { DagNodeId } from '../src/ids.ts'
import type { DagNodeSnapshot } from '../src/types.ts'

interface StubOutput {
  readonly text?: string
  readonly lossy?: boolean
}

interface StubProcess {
  readonly stdout?: StubOutput
  readonly stderr?: StubOutput
  readonly exitCode?: number | null
  readonly signal?: NodeJS.Signals | null
  readonly delayMs?: number
  readonly error?: Error
}

class StubSubprocess extends SubprocessRuntime {
  readonly specs: SubprocessSpawnSpec[] = []
  resolveCalls = 0

  constructor(ctx: Context, private readonly results: StubProcess[]) {
    super(ctx)
  }

  async resolveExecutable(): Promise<string> {
    this.resolveCalls++
    return '/stub/git'
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    const result = this.results.shift()
    if (result === undefined) throw new Error(`unexpected stub Git command: ${spec.argv.join(' ')}`)
    const done = result.error === undefined
      ? new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        setTimeout(() => {
          resolve({
            exitCode: result.exitCode === undefined ? 0 : result.exitCode,
            signal: result.signal === undefined ? null : result.signal,
          })
        }, result.delayMs ?? 0)
      })
      : Promise.reject(result.error)
    const reader = (output: StubOutput | undefined) => output === undefined
      ? undefined
      : {
        readFrom: (): SubprocessOutputRead => ({
          text: output.text ?? '',
          nextOffset: output.text?.length ?? 0,
          lossy: output.lossy ?? false,
        }),
      }
    const stdout = reader(result.stdout)
    const stderr = reader(result.stderr)
    return {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: {
        ...stdout === undefined ? {} : { stdout },
        ...stderr === undefined ? {} : { stderr },
      },
      done,
      terminate() {},
      waitForExit: () => Promise.resolve(true),
    }
  }

  spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    throw new Error('terminal spawning is outside this Git test')
  }
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function stubGit(results: StubProcess[], deadline = 100): { git: DagGit; subprocess: StubSubprocess } {
  const ctx = new Context()
  contexts.push(ctx)
  const subprocess = new StubSubprocess(ctx, results)
  const git = new DagGit(ctx, {
    dshHome: '/dsh',
    gitExecutable: 'git',
    commandDeadlineMs: deadline,
    terminationGraceMs: 10,
    outputLimitBytes: 1024,
  })
  return { git, subprocess }
}

const signal = new AbortController().signal

describe('DAG Git process failures', () => {
  it.each([
    { stdout: { text: 'tail', lossy: true }, stderr: { text: '', lossy: false } },
    { stdout: { text: '', lossy: false }, stderr: { text: 'tail', lossy: true } },
  ] satisfies StubProcess[])('rejects lossy collected output', async (result) => {
    const { git } = stubGit([result])
    await expect(git.probeRoot('/repo', signal)).rejects.toThrow(/exceeded the output limit/)
  })

  it('distinguishes command deadlines from process signals', async () => {
    const deadline = stubGit([{ delayMs: 10 }], 1)
    await expect(deadline.git.probeRoot('/repo', signal)).rejects.toThrow(/exceeded the 1ms deadline/)

    const signalled = stubGit([
      { exitCode: null, signal: 'SIGTERM' },
      { exitCode: null, signal: null },
    ])
    await expect(signalled.git.probeRoot('/repo', signal)).rejects.toThrow(/terminated by SIGTERM/)
    await expect(signalled.git.probeRoot('/repo', signal)).rejects.toThrow(/terminated by an unknown signal/)
  })

  it('bounds non-zero diagnostics and supports absent collected streams', async () => {
    const diagnostics = stubGit([
      { exitCode: 2, stdout: { text: 'out\n' }, stderr: { text: 'err\n' } },
      { exitCode: 3 },
      { stderr: { text: '', lossy: false } },
    ])
    await expect(diagnostics.git.probeRoot('/repo', signal)).rejects.toThrow('git status failed: err\nout')
    await expect(diagnostics.git.probeRoot('/repo', signal)).rejects.toThrow('git status failed: exit 3')
    await expect(diagnostics.git.probeRoot('/repo', signal)).rejects.toThrow(/symbolic local root branch/)
    expect(diagnostics.subprocess.resolveCalls).toBe(1)
    expect(diagnostics.subprocess.specs[0]).toMatchObject({
      argv: ['/stub/git', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal', '-z'],
      cwd: '/repo',
      graceMs: 10,
    })
  })
})

describe('delegated merge failure classification', () => {
  const base = '1'.repeat(40)
  const branch = 'dsh/dag/test/delegate'
  const node = (id: string, kind: DagNodeSnapshot['kind'] = 'integration'): DagNodeSnapshot => ({
    id: DagNodeId(id),
    content: 'Integrate dependency',
    brief: 'VALIDATION: test.\nACCEPTANCE: commit.',
    deps: [DagNodeId('dependency')],
    kind,
    policy: 'delegate',
    files: [],
    status: 'starting',
    generation: 1,
    bindingGeneration: 1,
    dependencyCommits: ['dependency'],
    conflictedFiles: [],
    commands: [],
  })
  const setup = (): StubProcess[] => [
    { exitCode: 1 },
    {},
    { stdout: { text: `${branch}\n` } },
    { exitCode: 1 },
    { stdout: { text: '' } },
    { stdout: { text: `${base}\n` } },
  ]

  async function prepare(results: StubProcess[], candidate = node('delegate')): Promise<void> {
    const temporary = await mkdtemp(join(tmpdir(), 'dsh-dag-git-process-'))
    try {
      const { git } = stubGit(results)
      await git.prepare('/repo', candidate, branch, join(temporary, 'worktree'), base, ['dependency'], signal)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }

  it('requires conflict evidence for a delegated merge failure', async () => {
    await expect(prepare([
      ...setup(),
      { exitCode: 1, stderr: { text: 'CONFLICT merge failed' } },
      { exitCode: 1 },
      { exitCode: 1 },
    ])).rejects.toThrow(/CONFLICT merge failed/)
  })

  it('preserves non-Git and non-conflict merge failures', async () => {
    const spawnFailure = new Error('spawn failed')
    await expect(prepare([
      ...setup(),
      { error: spawnFailure },
      { exitCode: 1 },
      { stdout: { text: 'conflict.txt\0' } },
    ])).rejects.toBe(spawnFailure)

    await expect(prepare([
      ...setup(),
      { exitCode: 1, stderr: { text: 'merge rejected' } },
      { exitCode: 1 },
      { stdout: { text: 'conflict.txt\0' } },
    ])).rejects.toThrow(/merge rejected/)
  })

  it('does not enter delegated conflict inspection for task nodes', async () => {
    await expect(prepare([
      ...setup(),
      { exitCode: 1, stderr: { text: 'CONFLICT task merge' } },
    ], node('task', 'task'))).rejects.toThrow(/CONFLICT task merge/)
  })
})
