# Agent Note: Event-sourced native DAG orchestration

Status: implemented

English | [中文](2026-08-29-event-sourced-native-dag-orchestrator.zh.md)

## Problem

Dependency-ordered agent work needs one durable account of graph declaration, node lifecycle, concurrent starts, restart recovery, local Git isolation, and completion evidence. A model-only plan cannot be that account: tool-call history does not prove that an asynchronous effect ran, and a process-local promise chain cannot reconstruct accepted work after a session reopens.

The generic subagent manager owns child authorization and continuation, but it does not own a dependency graph, per-node Git worktrees, wave settlement, or graph-specific notices. Replacing it with a graph scheduler would duplicate authorization, cold-resume, and non-DAG continuation behavior. Remote repository automation is also outside this scheduler's task: graph correctness must not depend on a remote, provider CLI, push, issue, or merge-request API.

## Decision

### Complete state snapshots are the durable authority

`@deepseek-ai/dsh-dag` stores one complete immutable version-1 state value in each `dag/state` event on the dispatcher session. A snapshot contains the revision, graph generation, operation counter, complete node board, topological order, ready list, status counts, waves, durable command mailboxes, operation receipts, and notices. The session log is the only durable authority; the `dag` projection is `null` before the first state and then derives a browser-safe current view.

The production reducer and an independent reference reducer are pure. A service command reads the current revision, reduces synchronously, and appends one complete snapshot without an `await`. An optional `if_revision` enforces compare-and-set. A stale revision, nested append, or competing reentrant commit returns `dag-revision-conflict`; it does not wait for a state lock. The typed `dag/state` event joins the known session-event vocabulary without changing the structural session format, so a build that does not know it refuses the event instead of misreading the snapshot.

Node lifecycle is `pending → starting → in_progress → completed | blocked | failed | interrupted`. Blocked and interrupted nodes resume through starting, failed nodes return to pending only through redispatch, and completed is terminal. Stop commits interrupted before it cancels an effect or child. Every operation that invalidates earlier work advances the node generation. Each effect result must match the binding generation, node generation, and operation id, so stale callbacks have no state effect.

### Durable mailboxes own asynchronous work

Each node snapshot contains a FIFO mailbox whose commands are accepted, running, or settled. One process-local pump per node performs Git work, child materialization, message delivery, persistence flushes, and lifecycle publication after the state append. The pump flag is scheduling state only; no state lock remains held across an `await`.

Session-start reconciliation examines accepted and running commands and checks local Git and child-session evidence before retry. Child ids, message ids, command ids, and notice ids are deterministic, so repeated materialization and delivery are idempotent. A non-blocking `dag/committed` Cordis event publishes the dispatcher session, revision, graph generation, cause, and immutable snapshot after each accepted append.

Notices record node failure, blocking, interruption, completion outside an open wave, and wave settlement. Delivery uses `Agent.inject` only. Reconciliation checks both pending inbox entries and claimed inbox session events before reinjection. `dag_wait` returns an already-actionable later notice or installs one cancellable waiter for the dispatcher session. Notice injection and logging occur before waiter resolution.

### Local Git provides execution evidence

All Git operations use the subprocess capability with exact argument arrays and no shell. A dispatch wave first commits starting intent, then performs one porcelain-v2 probe that requires a clean tracked and untracked root, a symbolic local branch, and a valid local HEAD. The service creates the wave only after that probe succeeds and freezes its root branch and HEAD once.

Node branches and worktrees live under `<DSH_HOME>/dag/worktrees/v1/` and start at the frozen wave HEAD. Dependencies merge in declaration order by exact recorded completion commit, never by branch tip. Task completion requires the expected symbolic branch, no active merge, a clean worktree, a new HEAD, every recorded dependency commit as an ancestor, and declared-file ownership. Integration nodes apply `ours`, `theirs`, or delegated conflict resolution. Reset accepts only the frozen base, an exact commit id, or an explicit local `refs/heads/*` ref; it preserves untracked files. Runtime code does not inspect remotes, fetch, push, or create remote work items.

### The subagent service keeps authorization

Continuable child creation accepts an absolute `cwd`, durable JSON owner metadata, and `settlementDelivery: adaptive | quiet | none`. Generic children retain the [continuable lifecycle](../feature/2026-07-28-continuable-subagent-conversations.md) and [adaptive settlement behavior](../feature/2026-08-06-manager-owned-subagent-settlement-delivery.md). DAG children use their worktree as `cwd`, carry a versioned DAG owner record, and select `none`, because graph notices are owned by the dispatcher state.

An effect-scoped owner-controller registry remains inside the subagent service. After the service applies the [generic control authorization](../feature/2026-08-06-continuable-subagent-interrupt.md), stop, redirect, and child-turn settlement for a DAG-owned child delegate to `DagService`. `Agent.redirect` cancels the active turn while preserving inbox state, places one replacement ordinary turn before queued ordinary turns, and wakes the agent. `Agent.steer` remains the non-interrupting next-step operation. Web Stop, `interrupt_agent`, and `dag_node_stop` reach one DAG stop transition; Web steering, `steer_agent`, and `dag_node_steer` reach one DAG steer transition.

The dispatcher receives the complete safe board and ten command tools. An owner-bound child receives only its topology, dependency status, execution facts, and complete or block tools. Mutating tools return command acceptance, revision, and operation id without waiting for effects. The dispatcher prompt requires `dag_wait` rather than status polling. The read-only Web dock shows counts and topological rows after the first declaration and exposes no absolute worktree path.

## Testing

The reducer model enumerates a bounded graph with parallel roots, fan-out, fan-in, integration, and tail nodes across commands, effect outcomes, stale callbacks, restart points, redispatch, resume, steer, and stop. It compares production and reference replay and checks dependency admission, legal transitions, single active operations, stale-result fencing, single notice and wave settlement, interrupted stop results, Git-gated completion, DAG settlement isolation, and notice-before-wait ordering.

Barrier tests cover competing command pairs and restart histories. Real local repositories with no remote cover dirty and detached roots, concurrent worktree creation, exact dependency fan-in, file ownership, all integration policies, conflicts, reset, cancellation, stale effects, and clean completion at a new HEAD. Subagent, projection, tool, composition, locale, Web, generated-catalog, and recorded-session tests cover the remaining integration paths.

## Alternatives considered

**Store graph state in a sidecar database or one event per field change.** Rejected. A second store creates recovery ordering between the session and graph data. Fine-grained events make replay depend on a larger transition vocabulary and make a torn command harder to inspect. Complete snapshots give each accepted revision one self-contained authority.

**Hold a mutex or promise-chain lock across asynchronous effects.** Rejected. Tool commands must return after durable acceptance, and a lock held through Git or child work prevents immediate stop and steer commands. Synchronous reduction plus generation fences serializes state without making external effects part of the commit.

**Replace the generic continuable subagent manager.** Rejected. Authorization, cold resume, one-shot children, and ordinary continuable settlement remain generic concerns. The owner-controller extension adds only the controls and metadata required by a DAG child.

**Use generic settlement follow-up or steering for DAG children.** Rejected. Generic delivery can wake or redirect the dispatcher independently of graph state and can duplicate restart delivery. `settlementDelivery: none` plus durable DAG notices gives one idempotent path.

**Use branch tips or remote merge requests as dependency evidence.** Rejected. A branch can move after completion, and remote state is not required for local scheduling. Exact recorded commits make dependency input immutable and testable in a repository with no remote.

## Consequences

A dispatcher can accept graph commands while earlier effects run, recover those effects after a session reopens, and ignore every late result whose generation fence is stale. The full current state is visible in one session event, while the browser receives a smaller projection and the model receives state only through explicit tools and durable notices.

DAG work creates persistent local branches, worktrees, and child sessions. The service never removes them automatically, so cleanup remains an explicit operator action. Completion proves local Git facts and declared ownership, not semantic correctness. Graph mutation runs through a live dispatcher Agent in one harness process, and a second writer of that session log is refused by the [session write lease](../feature/2026-08-31-cross-process-session-write-lease.md) rather than sharing the graph.

The todo feature remains independent, and generic one-shot and continuable subagents keep their existing behavior.
