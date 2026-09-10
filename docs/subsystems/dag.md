# Native DAG orchestration

English | [中文](dag.zh.md)

The native DAG subsystem runs a declared dependency graph through continuable subagents and local Git worktrees. [`@deepseek-ai/dsh-dag`](../../packages/dag/dag) owns durable state, command effects, recovery, notices, and Git checks. [`@deepseek-ai/dsh-tool-dag`](../../packages/dag/tool-dag) supplies the dispatcher and child tools. The browser package shows a read-only board.

## Durable state

The dispatcher session log is the only source of DAG state. Each accepted change appends one complete immutable `dag/state` snapshot with format version `1`. The `dag` session projection is `null` before the first write. It then contains the revision, topological node rows, status counts, ready nodes, and open waves. The browser projection does not contain absolute worktree paths.

Each snapshot contains a monotonic revision, graph generation, operation counter, complete node board, topological order, ready-node list, status counts, waves, active command ids, operation receipts, and notices. Each node also stores its generation, durable child session id, branch, worktree, frozen wave base, exact dependency commits, current operation, settlement, and completed commit.

The production reducer is pure. An independent reference reducer supports bounded model tests. A service call reads the current revision, reduces the command, and appends one snapshot without an asynchronous wait. An optional `if_revision` value gives compare-and-set behavior. A stale value, a nested append, or a reentrant append fails with `dag-revision-conflict`.

## Node lifecycle

New nodes start as `pending`. The main path is `pending` to `starting`, then `in_progress`, then `completed`, `blocked`, `failed`, or `interrupted`. A blocked or interrupted node resumes through `starting`. A failed node returns to `pending` only through redispatch. Completion is terminal.

Stop first commits `interrupted`, then cancels the active effect or child turn. Steering keeps an active node `in_progress`; steering a blocked or interrupted node moves it through `starting`. A child turn that ends without `dag_node_complete` or `dag_node_block` fails unless a recorded stop or steering replacement caused the end.

Dispatch, redispatch, resume, steer, stop, and reset increment the node generation when they make old work invalid. An effect result must match the durable binding generation, node generation, command id, and operation id. A stale result does not change state.

## Commands and effects

Each node owns a durable FIFO mailbox. A command has a deterministic id and moves from `accepted` to `running` to `settled`. One process-local pump runs the mailbox for each node. The pump flag is only scheduler state; no state lock remains held during an asynchronous operation.

After a state append, the service schedules session flushes, Git work, child materialization, message delivery, and lifecycle publication as cancellable effects. A `dag/committed` Cordis event follows each accepted change and carries the dispatcher session, revision, graph generation, cause, and immutable snapshot.

On session reopen, the service folds the newest snapshot and restarts accepted or running commands. Deterministic child ids and message ids make child creation and message delivery safe to repeat. Each retry checks current Git and child-session evidence before it makes a change.

## Notices and waiting

Node failure, block, interruption, wave settlement, and completion outside an open wave create durable notices. Notice ids include the dispatcher session namespace, graph generation, node generation or wave id, and notice kind. Delivery uses `Agent.inject`; it does not steer or wake the dispatcher.

Recovery checks pending inbox messages and claimed inbox session events for each notice id. It injects a notice only when no matching record exists. `dag_wait` returns at once when a later delivered notice exists. Otherwise, it registers one cancellable waiter for the dispatcher session. The service injects and logs the notice before it resolves that waiter.

## Owner-controlled subagents

A DAG child is a continuable subagent with an absolute worktree `cwd`, durable JSON owner metadata, and generic settlement delivery set to `none`. The subagent service still performs authorization. After authorization, the effect-scoped DAG owner controller handles stop, redirect, and turn settlement.

`Agent.steer` stays non-interrupting. `Agent.redirect` cancels the active turn while it keeps the inbox, inserts replacement work before queued ordinary turns, and wakes the agent. The service delivers a node prompt through `SubagentRuntime.followup()`, falling back to `SubagentRuntime.startContinuable()` when the child is not yet resumable, and replaces active work through `SubagentRuntime.redirect()`; every delivery carries a deterministic message id. The `steer_agent` model tool and the `subagent.steer` Remote operation use the same replacement behavior.

## Local Git execution

The service runs Git only through `ctx.subprocess`, with an exact argument array and no shell. It does not read remotes, call GitLab tools, push a branch, create an issue, or create a merge request. Worktrees are stored below `<DSH_HOME>/dag/worktrees/v1/`; branches use the `dsh/dag/` namespace.

Before a dispatch wave opens, one porcelain-v2 probe requires a clean root worktree, a symbolic local branch, and a valid local HEAD. The wave freezes that branch and commit. Each node worktree starts at the frozen commit. Dependency merges use exact recorded completion commits in declared order, never branch tips.

Task completion requires the expected branch, no active merge, a clean worktree, a new HEAD, and every recorded dependency commit as an ancestor. The service records that exact HEAD. Task nodes must keep changes inside their declared files. Integration nodes use the declared `ours`, `theirs`, or `delegate` policy. Delegate mode records the exact commits and conflicts, aborts the automatic conflicted merge, and assigns manual integration to the child.

Reset is available only for pending or failed nodes. It accepts the frozen wave base, an exact commit id, or an explicit local `refs/heads/*` ref. It rejects remote refs and ambiguous names. It aborts an active merge, hard-resets tracked state, keeps untracked files, and reports remaining dirt. The service does not delete old branches, worktrees, or child sessions.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdag--dagservice"></a>

### `ctx.dag` — `DagService`

Native DAG service backed only by complete session-log state values.

```ts cordis-catalog
/**
 * Return the latest durable state for one dispatcher.
 * @param agent - Live dispatcher agent.
 * @returns Latest state, or null before the first write.
 */
state(agent: Agent): DagState | null

/**
 * Return the complete dispatcher board.
 * @param agent - Live dispatcher agent.
 * @returns Safe board projection, or null before the first write.
 */
status(agent: Agent): DagProjection | null

/**
 * Return one node card, including dispatcher-only local execution facts.
 * @param agent - Live dispatcher agent.
 * @param nodeId - Node to inspect.
 * @returns Complete durable node card.
 */
inspect(agent: Agent, nodeId: DagNodeId): DagNodeSnapshot

/**
 * Return topology and execution facts for the exact owner-bound child.
 * @param child - Live DAG child agent.
 * @returns Topology and the child's safe node facts.
 */
statusFrom(child: Agent): { readonly revision: number readonly topology: readonly { readonly id: DagNodeId; readonly deps: readonly DagNodeId[]; readonly status: DagNodeSnapshot['status'] }[] readonly own: DagProjection['nodes'][number] }

/**
 * Replace the declaration after canonical validation.
 * @param agent - Live dispatcher agent.
 * @param request - Full node declaration and optional revision guard.
 * @returns Accepted write receipt, preserved artifacts, and advisory conflicts.
 */
write(agent: Agent, request: DagWriteRequest): DagWriteResult

/**
 * Start dependency-ready pending nodes without waiting for effects.
 * @param agent - Live dispatcher agent.
 * @param nodeIds - Pending nodes to start.
 * @param guard - Optional expected revision.
 * @returns Accepted command receipt.
 */
dispatch(agent: Agent, nodeIds: readonly DagNodeId[], guard: DagRevisionGuard = {}): DagCommandAccepted

/**
 * Re-enter a failed node with its durable child identity.
 * @param agent - Live dispatcher agent.
 * @param nodeId - Failed node to dispatch again.
 * @param guard - Optional expected revision.
 * @returns Accepted command receipt.
 */
redispatch(agent: Agent, nodeId: DagNodeId, guard: DagRevisionGuard = {}): DagCommandAccepted

/**
 * Resume a blocked or interrupted node.
 * @param agent - Live dispatcher agent.
 * @param nodeId - Suspended node to resume.
 * @param message - New work message for the child.
 * @param guard - Optional expected revision.
 * @returns Accepted command receipt.
 */
resume(agent: Agent, nodeId: DagNodeId, message: string, guard: DagRevisionGuard = {}): DagCommandAccepted

/**
 * Replace a node's active work, or restart a suspended node.
 * @param agent - Live dispatcher agent.
 * @param nodeId - Node to steer.
 * @param message - Replacement work message.
 * @param guard - Optional expected revision.
 * @returns Accepted command receipt.
 */
steer(agent: Agent, nodeId: DagNodeId, message: string, guard: DagRevisionGuard = {}): DagCommandAccepted

/**
 * Reset tracked worktree state to one allowed local target.
 * @param agent - Live dispatcher agent.
 * @param nodeId - Pending or failed node to reset.
 * @param target - Frozen base, exact commit, or local branch ref.
 * @param guard - Optional expected revision.
 * @returns Accepted command receipt.
 */
reset(agent: Agent, nodeId: DagNodeId, target: string, guard: DagRevisionGuard = {}): DagCommandAccepted

/**
 * Mark the calling DAG child blocked.
 * @param child - Live DAG child agent.
 * @param reason - Reason that work cannot continue.
 * @returns Accepted command receipt.
 */
blockFrom(child: Agent, reason: string): DagCommandAccepted

/**
 * Request completion validation for the calling DAG child.
 * @param child - Live DAG child agent.
 * @param summary - Result summary for the dispatcher.
 * @param artifacts - Optional JSON result records.
 * @returns Accepted command receipt.
 */
completeFrom(child: Agent, summary: string, artifacts: readonly JsonValue[] = []): DagCommandAccepted

/**
 * Wait for an injected actionable notice after one revision.
 * @param agent - Live dispatcher agent.
 * @param afterRevision - Last revision already handled by the caller.
 * @param signal - Cancellation signal for this wait.
 * @returns First available later notice and current safe board.
 */
wait(agent: Agent, afterRevision: number, signal: AbortSignal): Promise<DagWaitResult>

/**
 * Commit one authorized owner stop and then cancel the child turn.
 * @param request - Authorized owner stop request.
 */
stop(request: SubagentOwnerStopRequest): void

/**
 * Commit a dispatcher stop without waiting for cancellation.
 * @param agent - Live dispatcher agent.
 * @param nodeId - Active or blocked node to stop.
 * @param reason - Optional interruption reason.
 * @param guard - Optional expected revision.
 * @returns Accepted command receipt.
 */
stop(agent: Agent, nodeId: DagNodeId, reason?: string, guard?: DagRevisionGuard): DagCommandAccepted

/**
 * Commit one authorized redirect and then replace the child turn.
 * @param request - Authorized owner redirect request.
 */
redirect(request: SubagentOwnerRedirectRequest): Promise<void>

/**
 * Convert an unreported owner-child turn end to failure.
 * @param settlement - Authorized child turn settlement.
 */
settled(settlement: SubagentOwnerSettlement): void

/**
 * Fail one current child turn that ended without a final DAG report.
 * @param settlement - Authorized ordinary-turn settlement facts.
 */
turnSettled(settlement: SubagentOwnerTurnSettlement): void
```

Types: [Agent](core.md) · [SubagentOwnerRedirectRequest](subagent.md) · [SubagentOwnerSettlement](subagent.md) · [SubagentOwnerStopRequest](subagent.md) · [SubagentOwnerTurnSettlement](subagent.md)

Source: [`packages/dag/dag/src/index.ts`](../../packages/dag/dag/src/index.ts)

<a id="dag-events"></a>

### `dag/*` events

<a id="dagcommitted--emit"></a>

#### `dag/committed` — emit

A complete DAG state value was appended to the dispatcher session.

```ts cordis-catalog
/**
 * A complete DAG state value was appended to the dispatcher session.
 * @param payload.agent - exact live dispatcher Agent.
 * @param payload.committed - immutable committed state facts.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that dispatcher.
 * @mode emit
 */
'dag/committed'(this: import('@deepseek-ai/dsh-scope').Scoped<Agent>, payload: { readonly agent: Agent; readonly committed: DagCommitted }): void
```

Types: [Agent](core.md) · [Scoped](scope.md)

Source: [`packages/dag/dag/src/index.ts`](../../packages/dag/dag/src/index.ts)
<!-- END GENERATED cordis-surface -->
