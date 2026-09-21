/** Local-only Git effects for native DAG node worktrees. */

import { mkdir, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { DagNodeSnapshot } from './types.ts'

/** Validated Git execution settings. */
export interface DagGitConfig {
  readonly dshHome: string
  readonly gitExecutable: string
  readonly commandDeadlineMs: number
  readonly terminationGraceMs: number
  readonly outputLimitBytes: number
}

/** Result of one Git process. */
interface GitResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Non-empty argument vector for one Git operation. */
type GitArgs = readonly [string, ...string[]]

/** Frozen root facts for one dispatch wave. */
export interface DagRootProbe {
  readonly branch: string
  readonly head: string
}

/** Prepared local node worktree facts. */
export interface DagPreparedWorktree {
  readonly branch: string
  readonly worktree: string
  readonly dependencyCommits: readonly string[]
  readonly conflictedFiles: readonly string[]
  /** Worktree HEAD observed before the dependency merges. */
  readonly preparedFrom: string
  readonly head: string
}

/** Reset result that reports untracked or other remaining dirt. */
export interface DagResetResult {
  readonly targetCommit: string
  readonly remainingDirt: readonly string[]
}

/** Git command failure with bounded output. */
export class DagGitError extends Error {
  constructor(message: string, public readonly args: readonly string[]) {
    super(message)
    this.name = 'DagGitError'
  }
}

/** Execute local Git through the subprocess capability. */
export class DagGit {
  private executable: Promise<string> | undefined

  constructor(private readonly ctx: Context, private readonly config: DagGitConfig) {}

  /**
   * Require one clean symbolic local root using one porcelain-v2 probe.
   * @param root - Root worktree directory.
   * @param signal - Cancellation for the Git process.
   * @returns Frozen local branch and HEAD.
   */
  async probeRoot(root: string, signal: AbortSignal): Promise<DagRootProbe> {
    const result = await this.run(root, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal', '-z'], signal)
    const records = result.stdout.split('\0').filter(Boolean)
    let branch: string | undefined
    let head: string | undefined
    const dirt: string[] = []
    for (const record of records) {
      if (record.startsWith('# branch.head ')) branch = record.slice('# branch.head '.length)
      else if (record.startsWith('# branch.oid ')) head = record.slice('# branch.oid '.length)
      else if (!record.startsWith('# ')) dirt.push(record)
    }
    if (branch === undefined || branch === '(detached)') throw new DagGitError('DAG dispatch requires a symbolic local root branch', ['status'])
    if (head === undefined || head === '(initial)') throw new DagGitError('DAG dispatch requires a valid local HEAD', ['status'])
    if (dirt.length > 0) throw new DagGitError('DAG dispatch requires a clean root worktree, including untracked files', ['status'])
    return { branch, head }
  }

  /**
   * Create or verify one worktree and merge exact dependency commits.
   * @param root - Clean root worktree directory.
   * @param node - Node whose integration rules apply.
   * @param branch - Expected local node branch.
   * @param worktree - Absolute node worktree directory.
   * @param base - Frozen wave HEAD.
   * @param dependencyCommits - Exact dependency commits in declaration order.
   * @param signal - Cancellation for all Git processes.
   * @returns Prepared worktree facts.
   */
  async prepare(
    root: string,
    node: DagNodeSnapshot,
    branch: string,
    worktree: string,
    base: string,
    dependencyCommits: readonly string[],
    signal: AbortSignal,
  ): Promise<DagPreparedWorktree> {
    await mkdir(dirname(worktree), { recursive: true })
    const pathExists = await stat(worktree).then(entry => entry.isDirectory(), (error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
      throw error
    })
    const registered = pathExists ? await this.tryRun(worktree, ['rev-parse', '--show-toplevel'], signal) : undefined
    if (pathExists) {
      if (registered === undefined || await realpath(registered.stdout.trim()) !== await realpath(worktree)) {
        throw new DagGitError(`existing worktree path is not a registered Git worktree root: ${worktree}`, ['rev-parse'])
      }
      const rootCommon = (await this.run(root, ['rev-parse', '--git-common-dir'], signal)).stdout.trim()
      const worktreeCommon = (await this.run(worktree, ['rev-parse', '--git-common-dir'], signal)).stdout.trim()
      if (await realpath(resolve(root, rootCommon)) !== await realpath(resolve(worktree, worktreeCommon))) {
        throw new DagGitError(`existing worktree belongs to a different repository: ${worktree}`, ['rev-parse'])
      }
    }
    if (!pathExists) {
      const branchExists = await this.tryRun(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], signal)
      await this.run(root, branchExists === undefined
        ? ['worktree', 'add', '-b', branch, worktree, base]
        : ['worktree', 'add', worktree, branch], signal)
    }
    const actualBranch = (await this.run(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal)).stdout.trim()
    if (actualBranch !== branch) throw new DagGitError(`worktree branch ${JSON.stringify(actualBranch)} does not match ${JSON.stringify(branch)}`, ['symbolic-ref'])
    const activeMerge = await this.tryRun(worktree, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], signal)
    if (activeMerge !== undefined) await this.run(worktree, ['merge', '--abort'], signal)
    const dirt = records((await this.run(worktree, ['status', '--porcelain=v2', '--untracked-files=normal', '-z'], signal)).stdout)
    if (dirt.length > 0) throw new DagGitError(`worktree has changes that require an explicit reset: ${dirt.join(', ')}`, ['status'])
    const currentHead = (await this.run(worktree, ['rev-parse', 'HEAD'], signal)).stdout.trim()
    if (currentHead !== base) {
      const basedOnWave = await this.tryRun(worktree, ['merge-base', '--is-ancestor', base, currentHead], signal)
      if (basedOnWave === undefined) {
        throw new DagGitError(`worktree HEAD ${currentHead} is not based on frozen wave commit ${base}; reset it first`, ['merge-base'])
      }
    }

    if (node.kind === 'task' && node.files.length > 0) {
      for (const commit of dependencyCommits) {
        const changed = records((await this.run(worktree, ['diff', '--name-only', '-z', `${base}...${commit}`], signal)).stdout)
        const overlap = changed.filter(path => node.files.includes(path))
        if (overlap.length > 0) {
          throw new DagGitError(
            `node ${JSON.stringify(node.id)} owns files changed by dependency ${commit}: ${overlap.join(', ')}; amend the node's declared files or dependencies before dispatching it again`,
            ['diff'],
          )
        }
      }
    }

    const conflictedFiles: string[] = []
    for (const commit of dependencyCommits) {
      const args = mergeArgs(node.kind, node.policy, commit)
      try {
        await this.run(worktree, args, signal)
      } catch (error) {
        if (node.kind !== 'integration' || node.policy !== 'delegate') throw error
        const mergeHead = await this.tryRun(worktree, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], signal)
        const conflicts = await this.tryRun(worktree, ['diff', '--name-only', '--diff-filter=U', '-z'], signal)
        const files = records(conflicts?.stdout ?? '')
        if (mergeHead !== undefined) await this.run(worktree, ['merge', '--abort'], signal)
        if (!(error instanceof DagGitError) || !/\bCONFLICT\b/u.test(error.message) || files.length === 0) throw error
        conflictedFiles.push(...files)
        break
      }
    }
    const head = (await this.run(worktree, ['rev-parse', 'HEAD'], signal)).stdout.trim()
    return {
      branch,
      worktree,
      dependencyCommits: [...dependencyCommits],
      conflictedFiles: [...new Set(conflictedFiles)],
      preparedFrom: currentHead,
      head,
    }
  }

  /**
   * Verify durable preparation facts before a mailbox retry delivers child work.
   * The worktree can contain later child commits or uncommitted child work, but
   * it must remain on the recorded branch and descend from the recorded
   * prepared commit in the dispatcher's repository.
   * @param root - Dispatcher root worktree directory.
   * @param node - Node with durable preparation facts.
   * @param signal - Cancellation for all Git processes.
   */
  async verifyPrepared(root: string, node: DagNodeSnapshot, signal: AbortSignal): Promise<void> {
    if (node.worktree === undefined || node.branch === undefined
      || node.frozenWaveBase === undefined || node.preparedHead === undefined) {
      throw new DagGitError('node lacks durable prepared worktree facts', ['rev-parse'])
    }
    const pathExists = await stat(node.worktree).then(entry => entry.isDirectory(), (error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
      throw error
    })
    if (!pathExists) throw new DagGitError(`prepared worktree is missing: ${node.worktree}`, ['rev-parse'])
    const registered = await this.tryRun(node.worktree, ['rev-parse', '--show-toplevel'], signal)
    if (registered === undefined || await realpath(registered.stdout.trim()) !== await realpath(node.worktree)) {
      throw new DagGitError(`prepared path is not a registered Git worktree root: ${node.worktree}`, ['rev-parse'])
    }
    const rootCommon = (await this.run(root, ['rev-parse', '--git-common-dir'], signal)).stdout.trim()
    const worktreeCommon = (await this.run(node.worktree, ['rev-parse', '--git-common-dir'], signal)).stdout.trim()
    if (await realpath(resolve(root, rootCommon)) !== await realpath(resolve(node.worktree, worktreeCommon))) {
      throw new DagGitError(`prepared worktree belongs to a different repository: ${node.worktree}`, ['rev-parse'])
    }
    const branch = (await this.run(node.worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal)).stdout.trim()
    if (branch !== node.branch) {
      throw new DagGitError(`prepared worktree branch ${JSON.stringify(branch)} does not match ${JSON.stringify(node.branch)}`, ['symbolic-ref'])
    }
    const prepared = (await this.run(node.worktree, ['rev-parse', '--verify', `${node.preparedHead}^{commit}`], signal)).stdout.trim()
    if (prepared !== node.preparedHead) throw new DagGitError('recorded prepared commit does not resolve exactly', ['rev-parse'])
    const basedOnWave = await this.tryRun(node.worktree, ['merge-base', '--is-ancestor', node.frozenWaveBase, prepared], signal)
    if (basedOnWave === undefined) throw new DagGitError('recorded prepared commit does not descend from the frozen wave base', ['merge-base'])
    const head = (await this.run(node.worktree, ['rev-parse', 'HEAD'], signal)).stdout.trim()
    const retainsPreparation = await this.tryRun(node.worktree, ['merge-base', '--is-ancestor', prepared, head], signal)
    if (retainsPreparation === undefined) {
      throw new DagGitError(`worktree HEAD ${head} does not retain prepared commit ${prepared}`, ['merge-base'])
    }
  }

  /**
   * Require all local evidence for one completed node.
   *
   * A task node whose worktree already carried commits before dependency
   * preparation may complete without a new commit: preparation is then a no-op
   * over work that already exists, and requiring another commit would make
   * re-arming a node onto its own delivered commit impossible.
   * @param node - Node with frozen Git facts.
   * @param signal - Cancellation for all Git processes.
   * @returns Exact validated completion HEAD.
   */
  async validateCompletion(node: DagNodeSnapshot, signal: AbortSignal): Promise<string> {
    if (node.worktree === undefined || node.branch === undefined || node.frozenWaveBase === undefined || node.preparedHead === undefined) {
      throw new DagGitError('node lacks frozen local Git execution facts', ['rev-parse'])
    }
    const branch = (await this.run(node.worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal)).stdout.trim()
    if (branch !== node.branch) throw new DagGitError(`completion is on ${JSON.stringify(branch)}, expected ${JSON.stringify(node.branch)}`, ['symbolic-ref'])
    const merge = await this.tryRun(node.worktree, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], signal)
    if (merge !== undefined) throw new DagGitError('completion worktree has an active merge', ['rev-parse'])
    const status = records((await this.run(node.worktree, ['status', '--porcelain=v2', '--untracked-files=normal', '-z'], signal)).stdout)
    if (status.length > 0) throw new DagGitError('completion worktree is not clean', ['status'])
    const head = (await this.run(node.worktree, ['rev-parse', 'HEAD'], signal)).stdout.trim()
    if (head === node.frozenWaveBase) throw new DagGitError('completion requires a commit after the frozen wave base', ['rev-parse'])
    for (const commit of node.dependencyCommits) {
      const ancestor = await this.tryRun(node.worktree, ['merge-base', '--is-ancestor', commit, head], signal)
      if (ancestor === undefined) throw new DagGitError(`dependency commit ${commit} is not an ancestor of completion ${head}`, ['merge-base'])
    }
    if (node.kind === 'task') {
      if (head === node.preparedHead && (node.preparedFrom ?? node.frozenWaveBase) === node.frozenWaveBase) {
        throw new DagGitError('task completion requires a commit after dependency preparation', ['rev-parse'])
      }
      if (node.files.length > 0) {
        const changed = records((await this.run(node.worktree, ['diff', '--name-only', '-z', `${node.preparedHead}...${head}`], signal)).stdout)
        const outside = changed.filter(path => !node.files.includes(path))
        if (outside.length > 0) throw new DagGitError(`node changed files outside its declaration: ${outside.join(', ')}`, ['diff'])
      }
    }
    return head
  }

  /**
   * Abort an active merge and reset tracked state to one allowed local target.
   * @param node - Pending or failed node with a worktree.
   * @param target - Frozen base, exact commit, or local branch ref.
   * @param signal - Cancellation for all Git processes.
   * @returns Resolved target commit and remaining worktree dirt.
   */
  async reset(node: DagNodeSnapshot, target: string, signal: AbortSignal): Promise<DagResetResult> {
    if (node.worktree === undefined || node.frozenWaveBase === undefined) throw new DagGitError('node has no worktree to reset', ['reset'])
    if (target.startsWith('refs/remotes/') || target.includes('@{upstream}') || target.startsWith('origin/')) {
      throw new DagGitError('DAG reset rejects remote refs', ['reset'])
    }
    const allowed = target === node.frozenWaveBase || /^[0-9a-fA-F]{40,64}$/.test(target) || /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(target)
    if (!allowed) throw new DagGitError('DAG reset target must be the frozen base, an exact commit, or refs/heads/*', ['reset'])
    const merge = await this.tryRun(node.worktree, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], signal)
    if (merge !== undefined) await this.run(node.worktree, ['merge', '--abort'], signal)
    const commit = (await this.run(node.worktree, ['rev-parse', '--verify', `${target}^{commit}`], signal)).stdout.trim()
    await this.run(node.worktree, ['reset', '--hard', commit], signal)
    const dirt = records((await this.run(node.worktree, ['status', '--porcelain=v2', '--untracked-files=normal', '-z'], signal)).stdout)
    return { targetCommit: commit, remainingDirt: dirt }
  }

  /** Run one exact argument array and require exit code zero. */
  private async run(cwd: string, args: GitArgs, signal: AbortSignal): Promise<GitResult> {
    const result = await this.execute(cwd, args, signal)
    if (result.exitCode !== 0) {
      const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n') || `exit ${String(result.exitCode)}`
      throw new DagGitError(`git ${args[0]} failed: ${detail}`, args)
    }
    return result
  }

  /** Run one exact argument array and preserve a normal non-zero exit for probes. */
  private async execute(cwd: string, args: GitArgs, signal: AbortSignal): Promise<GitResult> {
    signal.throwIfAborted()
    const executable = await (this.executable ??= this.ctx.subprocess.resolveExecutable(this.config.gitExecutable))
    signal.throwIfAborted()
    const deadline = AbortSignal.timeout(this.config.commandDeadlineMs)
    const commandSignal = AbortSignal.any([signal, deadline])
    const handle = this.ctx.subprocess.spawn({
      argv: [executable, ...args],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.config.outputLimitBytes },
        stderr: { maxBytes: this.config.outputLimitBytes },
      },
      graceMs: this.config.terminationGraceMs,
      signal: commandSignal,
    })
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    if (stdout?.lossy === true || stderr?.lossy === true) throw new DagGitError(`git ${args[0]} exceeded the output limit`, args)
    signal.throwIfAborted()
    if (deadline.aborted) throw new DagGitError(`git ${args[0]} exceeded the ${this.config.commandDeadlineMs}ms deadline`, args)
    if (outcome.exitCode === null) throw new DagGitError(`git ${args[0]} terminated by ${outcome.signal ?? 'an unknown signal'}`, args)
    return { stdout: stdout?.text ?? '', stderr: stderr?.text ?? '', exitCode: outcome.exitCode }
  }

  /** Run one probe and map a non-zero exit to absence. */
  private async tryRun(cwd: string, args: GitArgs, signal: AbortSignal): Promise<GitResult | undefined> {
    const result = await this.execute(cwd, args, signal)
    return result.exitCode === 0 ? result : undefined
  }
}

/** Split NUL-delimited Git output without changing path bytes. */
function records(value: string): string[] {
  return value.split('\0').filter(record => record.length > 0)
}

/** Select the exact deterministic local merge policy. */
function mergeArgs(kind: DagNodeSnapshot['kind'], policy: DagNodeSnapshot['policy'], commit: string): GitArgs {
  if (kind !== 'integration' || policy === 'delegate') return ['merge', '--no-edit', commit]
  if (policy === 'ours') return ['merge', '--no-edit', '-s', 'ours', commit]
  return ['merge', '--no-edit', '-X', 'theirs', commit]
}

/**
 * Build the configured worktree root for one dispatcher generation.
 * @param dshHome - Resolved DSH home directory.
 * @param sessionHash - Stable dispatcher hash.
 * @param graphGeneration - Current graph generation.
 * @returns Absolute generation worktree root.
 */
export function dagWorktreeRoot(dshHome: string, sessionHash: string, graphGeneration: number): string {
  return join(dshHome, 'dag', 'worktrees', 'v1', sessionHash, `g${graphGeneration}`)
}
