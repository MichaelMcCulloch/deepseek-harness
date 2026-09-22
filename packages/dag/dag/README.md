---
description: "The durable native DAG service for users and maintainers who configure, operate, or debug dependency-ordered local agent work."
kind: "package-reference"
---

# @deepseek-ai/dsh-dag

English | [中文](README.zh.md)

## Summary

`dsh-dag` is the native dependency-graph scheduler for DeepSeek Harness. One dispatcher session owns a complete immutable `dag/state` snapshot after each accepted change. The service validates dependency order, commits state with a compare-and-set revision, and then runs cancellable Git, child-session, mailbox, notice, and persistence effects. Each node uses a continuable child in a dedicated local branch and worktree. The service uses local Git only and never reads remotes, pushes, or creates issues or merge requests.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package in the host plane when one agent must coordinate dependency-ordered work across isolated local Git worktrees. Mount `@deepseek-ai/dsh-tool-dag` in the agent composition for model controls, and mount `@deepseek-ai/dsh-client-ui-dag` in the Web bundle for the read-only board.

### Configuration

```yaml
- name: '@deepseek-ai/dsh-dag'
  config:
    gitExecutable: git
    commandDeadlineMs: 120000
    terminationGraceMs: 5000
    outputLimitBytes: 8388608
    subagentProvider: spawn
```

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | normal `DSH_HOME` resolution | Base for `dag/worktrees/v1`; a blank value uses the shared home-path resolver |
| `gitExecutable` | `git` | Executable resolved in the subprocess execution world |
| `commandDeadlineMs` | `120000` | Deadline for each Git process |
| `terminationGraceMs` | `5000` | Grace from termination request to forced kill |
| `outputLimitBytes` | `8388608` | Maximum collected bytes for each Git stream |
| `subagentProvider` | `spawn` | Continuable in-process provider for DAG children |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-dag) is the complete field reference.

### Node lifecycle

New nodes start as `pending`. Dispatch moves a ready node through `starting` to `in_progress`. The child reports `completed` or `blocked`; effect or child failure records `failed`; stop records `interrupted` before cancellation. Blocked, interrupted, and failed nodes resume or are steered through `starting`; a failed node also returns to `pending` through redispatch. A completed node is terminal.

A wrong declaration is corrected in place, so fixing one row never costs the rows that depend on it. `dag_write` re-sends the complete graph and amends every existing row whose declared fields changed; it also removes an omitted node from each surviving dependent's dependency list instead of requiring that dependent to be dropped, and reports both as amended and rewired rows. `dag_node_amend` changes one node's declared fields without re-sending the graph. Neither path changes an active node's declaration or the dependencies of a node that already recorded local Git preparation. Declared file ownership is exclusive along every dependency edge, and the rule is checked against the graph a request would store: an amendment may keep or narrow a violating edge the graph already carries, but never widen it or add one, so a graph that predates the rule stays repairable one node at a time. Both results report what remains as `dependency-file-overlap` conflict rows.

Every dispatch, redispatch, resume, steer, stop, or reset operation increments the node generation when it invalidates earlier work. Effect callbacks must match the node binding generation, node generation, and operation id. A stale callback cannot change state.

### Local Git execution

A dispatch wave first records its intent, then checks one porcelain-v2 root status. The root must be clean, on a symbolic local branch, and at a valid local HEAD. The wave freezes that branch and commit once. Node branches and worktrees start at the frozen commit under `<DSH_HOME>/dag/worktrees/v1/`; dependency commits merge in declared order by exact recorded commit id.

Task-node completion requires a clean worktree, the expected branch, no active merge, and every dependency commit as an ancestor, plus either a HEAD different from the frozen base or a worktree that already carried commits when preparation started. Preparation records the pre-merge HEAD, so re-arming a node onto its own delivered work can complete with no new commit. The service enforces declared file ownership before it accepts completion, and rejects at declaration time a task node whose declared files a transitive dependency also declares. Integration nodes use `ours`, `theirs`, or `delegate`; delegate mode records exact commits and conflicts for manual resolution. Reset accepts the frozen base, an exact commit, or an explicit local `refs/heads/*` ref. It preserves untracked files.

### Immediate commands and waiting

A mutation reduces synchronously and appends one complete snapshot before it starts asynchronous work. Optional `if_revision` fields reject stale callers with `dag-revision-conflict`; a reentrant append also fails instead of waiting. Each accepted mutation returns its new revision and operation id.

Each node has a durable FIFO mailbox and one process-local effect pump. Reopen reconciliation examines accepted and running commands, local Git facts, and child-session evidence before retry. Deterministic child, message, command, and notice ids make retries idempotent. `dag_wait` injects and logs an actionable notice before it resolves; only one waiter can exist for one dispatcher session.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Durable state and replay

The dispatcher log is the only durable authority. Every `dag/state` event contains the complete version-1 snapshot: revisions, graph generation, operation counter, node board, topological order, ready list, status counts, waves, commands, receipts, and notices. The `dag` session projection holds that complete state — `null` before the first event — and the registry advances it with each committed event, so the service reads state through `stateOf` without scanning the log. Its wire value is a browser-safe view without absolute worktree paths.

The production reducer and the independent reference reducer are pure. Tests compare them across bounded command, effect, stale-callback, and restart histories. The service publishes a non-blocking `dag/committed` Cordis event after each accepted append so other plugins can observe the immutable result.

### Owner-controlled children

DAG children carry durable JSON owner metadata, an absolute worktree `cwd`, and `settlementDelivery: none`. The subagent service keeps authorization. After authorization, its owner-controller registry sends stop, redirect, and child settlement to this service. Generic continuable children still use the existing continuation lock and adaptive settlement behavior.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, state commits, effect pumps, recovery, notices, waiters, child ownership, projection |
| [`src/reducer.ts`](src/reducer.ts) | Production state reducer and projection |
| [`src/reference-reducer.ts`](src/reference-reducer.ts) | Independent reference reducer for model tests |
| [`src/validation.ts`](src/validation.ts) | Full-graph declaration validation and advisory overlap rows |
| [`src/git.ts`](src/git.ts) | Exact-argument local Git operations through the subprocess service |
| [`src/types.ts`](src/types.ts) | Durable, service, event, and browser-safe types |
| [`src/invariant.ts`](src/invariant.ts) | Independent durable-log checks |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DAG subsystem](../../../docs/subsystems/dag.md) — service API, state rows, lifecycle, recovery, and Git rules.
- [Subagent subsystem](../../../docs/subsystems/subagent.md) — continuable child controls and owner delegation.
- [DAG tool package](../tool-dag/README.md) — dispatcher and child model tools.
- [Generated persistence catalog](../../../docs/persistence-catalog.md) — the `dag/state` event entry.

-----

<a id="model-experience"></a>
## Model Experience

### State notices

#### What the model sees

This service does not register tools or prompt text. It can inject a durable notice when a node fails, blocks, is interrupted, completes outside an open wave, or when a wave settles. The tool package controls the model command set.

#### Token effect

Each delivered notice adds one short inbox message. Full `dag/state` snapshots and the `dag` browser projection do not enter model input by themselves.

#### KV Cache effect

A new notice extends the request history. State-only commits do not change model input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One live process per session** — the revision check protects reentrant commands in one process; multi-process mutation of one session is unsupported.
- **No old-format migration** — `dag-todo` state, sidecars, aliases, and remote-provider data are not read.
- **Local Git only** — runtime code does not fetch, inspect remotes, push, or create remote work items.
- **Artifacts remain** — branches, worktrees, child sessions, and untracked files are never removed automatically.
- **Completion is Git evidence, not review** — the service proves branch and commit facts but does not prove semantic correctness.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
