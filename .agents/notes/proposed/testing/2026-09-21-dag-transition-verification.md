# Agent Note: Verifying every DAG transition leaves a valid state

Status: proposed

English | [中文](2026-09-21-dag-transition-verification.zh.md)

## Problem

The native DAG orchestrator ([the event-sourced orchestrator decision](../../implemented/architecture/2026-08-29-event-sourced-native-dag-orchestrator.md)) holds its whole state in one durable session event per accepted change: `dag/state` carries a complete `DagState` snapshot (`packages/dag/dag/src/types.ts:138-153`). Every accepted transition is one synchronous read-reduce-append in `DagService.mutate` (`packages/dag/dag/src/index.ts:838-865`), and recovery reads the state the `dag` session projection folded from the durable prefix and re-runs every non-settled mailbox command from it. The design is correct only if each accepted transition produces a state that satisfies the stream invariant, and today nothing in the shipped product checks that.

The question is what it would take to verify that every DAG transition leaves a valid state, across the three ways a transition can enter the system:

1. **The agent calls the model-facing tools** — `dag_write`, `dag_node_amend`, `dag_dispatch`, `dag_node_redispatch`, `dag_node_resume`, `dag_node_steer`, `dag_node_stop`, `dag_node_reset`, and, from a DAG-owned child, `dag_node_complete` and `dag_node_block`.
2. **The user intercedes** — Web Stop, `interrupt_agent`, and `subagent.interrupt` reach `DagService.ownerStop`; Web steering, `steer_agent`, and `subagent.steer` reach `DagService.redirect`; child turn end and activation settlement reach `turnSettled` and `settled`. A human-driven agent calling the same tools reaches the identical reducer commands.
3. **The process dies and comes back** — crash, power loss, or SIGKILL, including between two awaits inside one effect and between a state append and its fsync.

The three sources are not equally covered, and the difference is not the reducer. Tool calls and owner hooks converge on one transition set guarded by the reducer. What is unverified is the service layer around it, the seams where a durable decision and an external effect disagree, and the durability boundary itself. This note records the state model, what is checked today, the three defects that fall out of the analysis, the verification options with their real cost, and the order to build them in.

## Proposal

Verify the transition system where it runs, not in a second model of it. Concretely: mount the invariant that already exists, extend the executable model test with a refusal oracle, add property-based sequence testing with the `fast-check` dependency the repository already has, and build a crash-injection suite over the real JSONL append path that includes the three defects below as predicted failures.

Ordered by value per unit of work; steps 1-3 are cheap and land first, and step 4 is the one that finds new defects.

1. **Mount the invariant in an opt-in diagnostic composition (half a day).** Add `@deepseek-ai/dsh-dag/invariant` to a test-only `cordis.yml`, boot it through the Loader, and drive one full node lifecycle. Do not change `dsh-base`.
2. **Add a refusal oracle to the model test (one day).** For every state the breadth-first search dequeues, emit guard-mutated commands and assert either the exact `DagStateError.code` or an identity-returning no-op.
3. **Add property-based sequence testing and make the differential oracle honest (one to two days).** Generate command sequences that are not precondition-filtered, and assert that only `DagStateError` escapes, that every accepted state passes `validateDagState`, that the reference reducer agrees, and that replaying the accepted subsequence from `null` reproduces the state. In a separate commit, stop comparing `commandId` and `commandState` between the production and reference reducers, so an identity-format regression cannot pass by shared convention.
4. **Build the crash-injection suite (three to four days).** Layer 1 is in-process and deterministic: drive the real service against a real JSONL root, simulate the crash by disposing without a flush, by truncating the artifact at chosen byte offsets, and by aborting the two-step torn-tail repair between its steps; assert at every reopen that the fold satisfies `validateDagState` and that `reconcile` drives every non-settled mailbox command to a terminal state. Layer 2 generalizes the existing out-of-process SIGKILL fixture to a scripted DAG sequence killed on a byte-count trigger.
5. **Fix the defects the tests pin (three to four days).** Record the pre-merge HEAD durably before `git.prepare` runs, or derive it from the frozen wave base and the dependency-commit graph; add an explicit repair transition for an existing but unregistered worktree path; make the recovered torn tail and its truncation one durable step. Each fix is a design change and needs its own Agent Note.
6. **Close the exit-path gaps (one day).** Move `settlement.stop()` into a `finally`, decide what a throwing owner controller does to the child, and add the missing tests: a real Activation driving `DagService.ownerStop`, a throwing owner controller, and a child settlement racing a suspended redirect.

`fast-check@^4.8.0` is already a root devDependency (`package.json:222`), so step 3 adds no dependency. A new spec file runs by being placed at `packages/dag/dag/tests/model-property.spec.ts` or `packages/dag/dag/tests/crash-recovery.spec.ts`: the root vitest `include` is `packages/*/*/tests/**/*.spec.{ts,tsx}` (`vitest.config.ts:123-128`), so `pnpm run test` and the `test:coverage` gate in `ci-primary` collect it with no registration. An out-of-process suite is an `.e2e.ts` (`vitest.e2e.config.ts:45`, run by `pnpm run test:e2e`) so it stays opt-in. A crash-recovery suite that must gate `ci-primary` on its own gets a named gate in `scripts/run-gates.ts`, beside the existing coverage gate.

## The state model and what is checked

`dag/state` is declared by module augmentation and joins the known session-event vocabulary; it does not carry `ignorable: true`, so a build that does not know the event refuses the log rather than misreading the snapshot. The event has one reader, the `dag` session projection unit (`packages/dag/dag/src/index.ts:299-309`), whose fold replaces its state with each `dag/state` value; that unit is also the service's own read path, so no code scans a log for the newest snapshot and every service read is one `stateOf` lookup. `DagService.mutate` (`index.ts:838-865`) reads that state, calls `reduceDagState` (`packages/dag/dag/src/reducer.ts:432`), returns unchanged when the reducer returns the same object (`index.ts:841`), and otherwise appends the new snapshot (`index.ts:845`) inside one synchronous block with no `await`.

Some node fields are authoritative and some are derived. `counts`, `readyNodeIds`, and `activeCommandIds` are recomputed by `completeState` on every accepted command. `settlement`, `currentOperationId`, and `dependencyCommits` are derivable from other fields but are stored, and the invariant treats them as authoritative, checking only format and monotonicity.

Four layers check things today, and they do not cover the same ground:

- **Reducer preconditions.** `reduceDagState` throws `DagStateError` with a stable `code` for a command that is illegal in the current state. These are guards — "this command is legal" — not postconditions about the result.
- **Declaration validation.** `validateDagDeclaration` (`packages/dag/dag/src/validation.ts:73-142`) enforces non-empty ids and content, `VALIDATION:`/`ACCEPTANCE:` in every brief, dependency existence and acyclicity, declared-file ownership, and path normalization. The service calls it from `write` and `amend`; the reducer does not call it, and `reduceDagState` is exported.
- **The stream invariant.** `validateDagState(previous, state)` (`packages/dag/dag/src/invariant.ts:78-376`) is roughly eighty checks over the step from one snapshot to the next: revision and graph-generation arithmetic, legal status edges, generation and binding-generation deltas, mailbox history that cannot be shortened or rewritten, `completedCommit` immutability, dependency commits matching the declared dependency list, at most one active command per node, the active command's fence agreeing with the node, topology and dependency-order consistency, re-derived counts and ready sets, receipt sequence, notice immutability, and wave identity.
- **Service assertions.** `assertLive`, `assertRevision` with its reentrancy guard, `requireCurrentCommand`, `assertBinding`, and `assertCurrentChildTurn` fence every entry point and every effect result.

Two facts about that coverage matter more than the check count:

- **`validateDagState` runs only in `vitest`.** `invariant.spec.ts` and `invariant-edge.spec.ts` exercise it directly, and `model.spec.ts` calls it on every accepted step, but the package publishes it as `./invariant` and `packages/bundle/base/cordis.patch.yml:305` mounts `@deepseek-ai/dsh-dag` with no companion; `packages/bundle/sdk-minimal/cordis.patch.yml:109-119` is the only composition that lists invariant companions, and it lists session, agent, scope, and agent-loop, not dag. `dsh-base` omits runtime diagnostics deliberately (`packages/runtime-diagnostics/invariants/README.md`), so the fix is an opt-in composition, not a change to the shipped default.
- **Eight relations are merely intended, with no check anywhere.** A node's `waveId` is never cross-referenced against `state.waves`; wave slot membership is never compared with node status; `settlement` is compared with `status` only for `completed`; `branch`, `worktree`, `childSessionId`, `waveId`, `frozenWaveBase`, `dependencyCommits`, `preparedFrom`, and `preparedHead` are not checked for immutability across snapshots; `notice.nodeId` and `notice.waveId` are not checked against known nodes and waves; wave slot order is checked as a set; the `cause` string passed to `mutate` is neither durable nor validated; and no code asserts that the last durable snapshot is an ancestor-by-revision of the revision the service acknowledged. The first two are maintained by construction in `settleWaves`, so they are missing checks rather than known bugs.

Nothing in the invariant reads Git, the filesystem, a child session, or an inbox. Every claim about those lives in the service and its tests.

## The three transition sources

### Agent tool calls

The eleven dispatcher tools and the three child-scoped tools resolve their agent, pass it to a service method, and return after the append. Two dispatcher tool calls cannot interleave inside `mutate`, because a tool `execute` runs to completion synchronously through it. `if_revision` is advisory compare-and-set, not required for correctness.

Three assumptions hold this path up. `reduceDagState` trusts its caller for declaration validity, so an in-process caller holding the service can reach the reducer without `validateDagDeclaration`. The dispatcher tool set is denied to a DAG-owned child by `tools.restrict` in the tool layer (`packages/dag/tool-dag/src/child.ts:19`), not by the service, so another in-process caller bypasses it. And a child's `dag_node_complete` is trusted about why it is complete; the Git check in `DagGit.validateCompletion` is the only backstop, and the first defect below weakens it.

### User intercession

Authorization happens upstream in the subagent service: an ancestor must be the exact live agent, and a `user` authority must name the child's parent session. `DagService` re-checks liveness and the durable binding but not authority, which is correct because it only receives an authorized request. The same reducer commands are reached, with the reason string as the only difference.

Two failure paths in that seam leave the durable node and the child turn disagreeing. `ContinuableActivationRegistry.interrupt` returns immediately when the target session is not resident (`packages/subagent/subagent/src/continuation-activation.ts:348`), before the owner branch, so a user Stop of a non-resident child performs no DAG transition while the durable node stays `starting` or `in_progress`. And the owner-controller call has no `try`/`catch` (`continuation-activation.ts:375-380`): if `DagService.ownerStop` throws, `request.stop()` never runs and the child turn keeps running against a node the user believes they stopped. `turnSettled` and `settled` have the mirror problem — they are called from session-observer paths that log and continue, so a DAG append failure inside them is invisible and the node stays `in_progress` with an active command until another transition or a reopen moves it.

`redirect` is the only asynchronous owner hook. While it is suspended on the persistence flush that precedes admitting the replacement message, the child's turn can end and `turnSettled` can run, because neither the lock the redirect holds nor the settlement observer serializes them. The reachable outcomes are legal states — either the stale branch returns without mutating, or the node fails and the steer reports a fence error — so this is a liveness gap in an unmodeled interleaving, not a validity gap.

### Process death and reopen

`Session.append` is in-memory: it pushes into the session log before dispatching `session/event` (`packages/core/session/src/index.ts:756-759`), and its own documentation states the hot path never blocks on I/O. Durability is a separate awaited step. The JSONL backend buffers live events and drains them on a 200 ms timer or on `session/flush` (`packages/session/session-persistence-jsonl/src/storage.ts:36`), and a landed batch is all-or-nothing: `appendLines` writes then fsyncs, and a write or sync failure truncates back to the pre-append size and re-fsyncs before rethrowing.

Every external effect runs after its command is durable: `pump` appends `command-running` and flushes (`packages/dag/dag/src/index.ts:917-927`), `prepareAndStart` flushes after `git-prepared` (`index.ts:1105`), `ensureWave` flushes after `wave-probed` (`index.ts:1176`), and `deliverOwnerRedirect` flushes before admitting the replacement (`packages/dag/dag/src/index.ts:715`). `ctx.sessions.flush` returns whether at least one durability listener participated (`packages/core/session/src/index.ts:1205-1235`), and it is a real barrier because the agent loop's stored session holds a JSONL write handle; that is a property of the agent loop, not of `flush`.

Because each snapshot is complete and revisions are contiguous, any durable prefix of the accepted revision sequence is itself a valid DAG state. That is the property that makes crash recovery tractable, and it holds exactly when each accepted transition satisfies `validateDagState`. On reopen, the constructor schedules `reconcile`, which schedules the pump and delivers notices; the pump takes the oldest non-settled mailbox row per node and replays the whole effect from the beginning, re-reading Git and child state instead of trusting recorded facts. Replay is idempotent because every identifier is deterministic: command ids, child session ids, `MessageId(`${command.id}-message`)`, and notice ids.

Two assumptions in this layer are unverified. The repaired tail is not re-derived: nothing asserts that the state folded from a repaired log equals the state a pre-crash reopen had already served. And the child session log and the dispatcher session log are two files with no cross-file atomicity; reconciliation is expected to repair any disagreement.

## What the existing model harness covers

`packages/dag/dag/src/reference-reducer.ts` is a small independent model of the externally visible scheduler state: revision, graph generation, operation counter, and per node id, dependencies, status, generation, binding generation, operation id, command id and state, and completion commit. `referenceReduceDagState` re-implements the transition relation without calling production code, and `abstractDagState` projects a production `DagState` into that vocabulary. Independence is partial: the reference reproduces the production id formats literally, and `abstractDagState` copies the production command id, so those fields are compared as shared conventions rather than independently derived values. The comparison is strong on status, generation, and operation semantics and weak on identity.

`packages/dag/dag/tests/model.spec.ts:466-522` is a breadth-first explicit-state search over a fixed six-node graph with parallel roots, fan-out, fan-in, an integration node, and a tail. It merges states by a semantic key, caps the exploration at 25 000 semantic states, and allows one injected fault per explored history plus one resume or steer per node. After every accepted step it runs the full `validateDagState` (`:493`) and the differential comparison against the reference (`:494`); before every dequeued state it re-reduces the whole history from `null` and compares, and it perturbs the last command's binding generation on every node and requires the identical object back. Liveness assertions require every node to reach `completed`, the action labels to cover 18 named actions, more than 1 000 visited states, and more stale-callback probes than visited states.

What the search cannot reach:

1. **Refusals.** The action generator only emits commands it has already decided are legal, so an illegal command the reducer silently accepts is unreachable, and every refusal is covered by a hand-written case.
2. **The service layer.** It drives `reduceDagState` directly and never runs `mutate`, `assertRevision`, the reentrancy guard, effect cancellation, `pump`, `reconcile`, or any owner hook.
3. **Durability.** Nothing touches the session log, an fsync boundary, or a torn record; the restart assertion is a pure reducer replay.
4. **Git.** Effect evidence is synthesized from the node's own binding, so `startEvidenceMatches` is only exercised on the agreeing branch and every real Git rule is invisible.
5. **Child and inbox facts.** Message dedup, notice dedup, child-turn assertion, and the owner seam are not modeled.
6. **Merged states.** The semantic key omits `preparedFrom`, `dependencyCommits`, `conflictedFiles`, `completedCommit`, the receipt log, the notice table, the settlement summary, and the topological order, so two states differing only in those fields are explored as one.
7. **Multiple faults.** With a fault budget of one, no state reachable only after two effect failures is visited.

A green run is evidence about `reduceDagState` and nothing else.

## Defects found

### The `preparedFrom` window defeats the no-op completion guard

`DagGit.prepare` captures `currentHead` at `packages/dag/dag/src/git.ts:135`, before the dependency merge loop at `:157`, and returns it as `preparedFrom` at `:178`. `prepareAndStart` re-runs `prepare` — never `verifyPrepared` — whenever the durable node has no `preparedHead` (`packages/dag/dag/src/index.ts:1073`), and the `git-prepared` append that records the result happens later (`index.ts:1087`, flush at `:1105`).

A crash anywhere in that window makes the retry record the wrong discriminator:

1. Node `n` depends on `d`, completed at commit `C`; the wave base is `B`. `prepare` creates the worktree at `B`, records `preparedFrom = B`, merges `C`, and produces merge commit `M`.
2. The process dies after the merge and before the `git-prepared` append.
3. On reopen the durable node is `starting` with `preparedHead === undefined`, so the pump calls `prepare` again on the worktree that already contains `M`. `currentHead` is now `M`, `M` descends from `B`, so the ancestry guard at `git.ts:136-140` passes, the merge is a no-op, and the function returns `preparedFrom = M`, `head = M`.
4. `git-prepared` stores `preparedFrom === preparedHead === M`.
5. A completion that commits nothing now passes the no-op guard at `git.ts:253-256`, because `head === preparedHead` while `preparedFrom` no longer equals `frozenWaveBase`. The changed-file check at `:257-261` looks at `preparedHead...head` and is empty, so it passes too.

The node is recorded `completed` with `completedCommit = M`, a commit containing only the dependency's work; dependents then merge `M` as this node's contribution. The failure is silent: no error, no notice, and `validateDagState` cannot see it because it only format-checks `preparedFrom`. Any process restart in that window reaches it, including an ordinary session reopen. The root cause is that the discriminator "did the worktree already carry commits before preparation?" is observed at preparation time and destroyed by the retry; a fix must record the pre-merge HEAD somewhere the crash cannot erase, or derive it from the frozen wave base and the dependency-commit graph.

**Repaired.** Preparation now records its two phases through one `git-prepared` command. `DagGit.inspectPreparation` creates or verifies the worktree and returns the pre-merge HEAD without merging; `DagGit.mergeDependencies` performs the merges and is a no-op per already-merged commit. `prepareAndStart` appends the pre-merge HEAD as both `preparedFrom` and `preparedHead` and flushes before it merges, then appends the merged head. The reducer accepts a second phase only while `preparedHead === preparedFrom` and never rewrites `preparedFrom`, so the crash window is closed rather than narrowed: the retry resumes the merge phase instead of re-observing a merged worktree. `packages/dag/dag/tests/git.spec.ts` pins the guard against the crashed facts, the re-merge no-op, and the re-inspection that the service must not perform.

### The torn-tail repair has a crash window that drops recovered events

The default persistence path is checksummed Zstandard frames, one per durable append batch. An EOF-truncated final frame is detected by the frame scan, its complete event lines are recovered, and the repair took two durable steps in `persistContiguous` (`packages/session/session-persistence-jsonl/src/storage.ts`): it truncated and fsynced the torn bytes, and only then wrote the recovered tail back.

A crash between those two steps loses the recovered events permanently. A read had already served them, the handle a resume opened carries them into the in-memory log, and the DAG folds them and may run effects from them; the next reopen sees only the truncated prefix. The window is reachable only when the first write after a torn-tail read is interrupted, and the existing tests cover a failed rewrite with retry, not a crash inside the window.

The damage to the DAG is bounded, because every effect is keyed by a deterministic id and re-derived from the surviving snapshot: the residue is an orphan worktree or child session for a command that no longer exists, not an invalid state. That argument is informal and belongs in a test, which is why option 4 includes the window explicitly.

**Repaired.** The repair is now one durable step. `replaceTornTail` (`packages/session/session-persistence-jsonl/src/index.ts`) encodes the artifact's complete prefix, the complete records recovered from its torn tail, and the pending batch into a synced replacement file beside the log, renames that file over the log, and fsyncs the directory — on Windows the same publication is `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`. The rename is the commit point, so a crash at any point leaves either the torn artifact or the repaired one; `persistContiguous` reaches the storage seam once through `persistBatch`'s repair argument, and the separate `truncateTornTail` step no longer exists. Successful repairs keep the on-disk bytes the two-step protocol produced — the same prefix bytes followed by one encoded frame per batch — and a leftover replacement file is invisible to generation discovery and cleared by the next write open. `packages/session/session-persistence-jsonl/tests/zstd.spec.ts` pins the window: after the interrupted repair, reopening must still serve the records the earlier read served, and a reopened writer must complete the repair with each event stored exactly once. The [durability decision](../../implemented/bug-fix/2026-09-21-atomic-torn-tail-replacement.md) owns the design.

### An interrupted `git worktree add` strands a node id

If the process dies while `git worktree add` is running (`packages/dag/dag/src/git.ts:123-127`), the directory can exist without being a registered worktree. Every later `prepare` for that node throws at `git.ts:113-115`, including a redispatch-and-dispatch cycle, because `dispatch` clears `preparedHead` (`packages/dag/dag/src/reducer.ts:535-545`) and `prepareAndStart` therefore calls `prepare` again on the same path.

No transition repairs that node id in place. `reset` cannot: `DagGit.reset` runs `git rev-parse` inside the unregistered directory and fails (`git.ts:273-286`), and `dag_node_reset` is legal only from `pending` or `failed` anyway. The escape is a `write` that drops the failed node — allowed, because the removal refusal covers only active nodes (`reducer.ts:447-448`) — followed by a later `write` that re-declares it: the worktree path embeds `graphGeneration` (`packages/dag/dag/src/index.ts:533`), so the new generation gets a fresh directory. Re-declaring under a new node id avoids rewiring dependents but abandons the id. This gap fails loudly and produces no invalid state, so it ranks below the first defect; what it needs is an explicit repair transition for an existing but unregistered path, not a silent fix inside `prepare`.

**Repaired.** That repair transition is `reset`. `DagGit.reset` now classifies the path first, and when the directory exists without a Git registration it prunes the stale registration, removes the residue, and adds the worktree again at the resolved target — so the documented `stop`, `redispatch`, `reset`, `dispatch` sequence repairs the node id in place. Removal is bounded to `<DSH_HOME>/dag/worktrees/v1/`, so a path the dispatcher did not create is refused rather than deleted. `packages/dag/dag/tests/git.spec.ts` covers the repair and the refusal.

## Verification options

**Bounded explicit-state search over the reducer (`packages/dag/dag/tests/model.spec.ts`).** Proves, for every explored state and every generated action, that the reducer refuses or produces a state satisfying `validateDagState`, agrees with the reference, and replays identically. Because it executes the real reducer, a counterexample is a real counterexample. It cannot prove anything outside the explored set: refusals, the service layer, durability, Git, child sessions, and every state merged by the semantic key. Cost is already paid; extending it with a refusal oracle and a wider key is a small, bounded change, and the state cap turns blow-up into a loud failure.

**Property-based differential testing with `fast-check`.** Proves nothing absolutely — it searches — but it searches a different space from the hand-written action enumerator, so it reaches refusal paths, repeated operations, and long histories the search budget excludes, and shrinking turns failures into minimal command sequences. It cannot prove absence, and it shares the differential oracle's blind spots. Cost: one to two days for the suite, plus a separate small commit to stop comparing production-derived command ids.

**Crash-injection testing over the real append path.** Proves, for each injected kill point, that reopening yields a log whose `dag/state` fold satisfies the invariant at every step and that reconciliation drives every non-settled mailbox command to a terminal state; it also measures which windows lose an acknowledged revision, which is currently undocumented. It cannot prove the points it cannot land on, and making it deterministic is the hard part. The machinery exists: the service suite already builds a real JSONL root and reopens through `ctx.agents.resume`, the persistence suites own the format-level crash semantics, and a two-process fixture already SIGKILLs a lock holder. Cost: one day for the in-process layer, two to three days plus ongoing flake risk for the out-of-process layer.

**Runtime invariant strengthening.** Proves nothing about the design. It converts silent corruption into a loud, attributed failure in any composition that runs it, and it is the only option that produces evidence from real sessions. It cannot fire on a state that is never produced and does not roll back a state it rejects. Three tiers, cheapest first: mount the companion in an opt-in diagnostic composition with a real-composition test; call `validateDagState` from `mutate` behind a config flag; and add always-on cheap assertions for the two derivation identities a reducer bug would break first. The third tier is O(nodes × commands) per event and needs measurement before it ships.

**A machine-checked specification (TLA+, Alloy, or Quint).** For the reducer it would prove inductiveness for all reachable states, including those the JS search merges or never generates. It cannot prove that the TypeScript implements the specification, the repository has no such toolchain and no gate to run one in, and the reducer is small with a strong executable oracle. For the append protocol the case is genuinely stronger, because "the process died between these two instructions" is not a state a JS model can be in — but the highest-value artefact there is still the crash-injection suite, which exercises the real code. If a specification is ever written, write it for the commit protocol and only after the crash suite exists to serve as conformance evidence.

## Recommendation

Steps 1-3 and 6 are the cheap, bounded work; step 4 finds new defects, and step 5 is what the defects require.

1. **Mount the invariant where it can run (half a day).** An opt-in diagnostic composition plus a real-composition test that boots it through the Loader and drives one node lifecycle converts eighty already-written checks from test-only into a live detector. Leave `dsh-base` alone.
2. **Add the refusal oracle to the model test (one day).** For every dequeued state, emit guard-mutated commands and assert the exact `DagStateError.code` or the identity no-op. The nineteen `DagStateError` codes the reducer can throw are covered one hand-written case at a time today.
3. **Add property-based sequence testing and fix the oracle (one to two days).** Generate arbitrary command sequences, assert only `DagStateError` escapes, every accepted state passes the invariant, the reference agrees, and replay from `null` is deterministic. Separately, stop comparing `commandId` and `commandState` in `abstractDagState`.
4. **Build the crash-injection suite (three to four days).** Layer 1 in-process and deterministic, gated in `ci-primary`; layer 2 out-of-process SIGKILL as an opt-in gate. Do not re-test the JSONL format. The single highest-value test is the regression test for the `preparedFrom` window: kill between the dependency merge and the `git-prepared` append, then assert a no-op completion is still refused. It should fail today. Add the interrupted-worktree case, the torn-tail repair window, and the notice-injection window next.
5. **Fix the defects (three to four days).** Record the pre-merge HEAD durably before `git.prepare`, add an explicit worktree-repair transition, and make the torn-tail repair one durable step, each with its own Agent Note.
6. **Close the exit-path gaps (one day).** Move `settlement.stop()` into a `finally`, decide and document what a throwing owner controller does to the child, and add the missing tests for a real Activation driving `ownerStop`, a throwing owner controller, and a settlement racing a suspended redirect.
7. **Migrate the DAG's remaining synchronous Session reads (one to two days).** The complete `DagState` now lives on the `dag` session projection and the service reads it through `stateOf`, so `latestState` and its twelve call sites are gone. Six production reads still walk event history under the deferred-migration waiver. `dispatcherFor` (`index.ts:1476-1486`) and the child turn boundary in `assertCurrentChildTurn` (`index.ts:1502-1528`) read the child session's `subagent/descriptor`, turn boundary, and message ids, which the `dag` unit never folds. `messageRecorded` and `noticeRecorded` (`packages/dag/dag/src/runtime.ts:177-198`) test whether a deterministic message id is already logged, in a child session or in the dispatcher's own. The invariant's install-time seed (`packages/dag/dag/src/invariant.ts:393-398`) folds the raw stream, and must: it validates the durable events rather than the state the service read from them. `SubagentContinuationManager.recordsMessage` (`packages/subagent/subagent/src/continuation-activation.ts:677`) belongs to the subagent package. Each remaining read needs the child descriptor, the recorded message identities, or the current turn's message set as maintained state, which is its own durable-state and projection design change rather than a mechanical replacement.

Explicitly not doing:

- Not writing a TLA+, Alloy, or Quint specification of the reducer.
- Not building a general-purpose model checker or a state-space abstraction layer.
- Not adding an fsync per append; the 200 ms batch plus a flush barrier before every external effect is the right trade-off, and the acknowledged-but-not-yet-durable window is a documentation problem.
- Not enabling `validateDagState` unconditionally in `mutate`.
- Not treating the model test's green result as evidence about the service.
- Not re-testing the JSONL format in DAG tests; the persistence suites own it.

## Alternatives considered

**Write a TLA+/Alloy/Quint specification of the reducer.** Rejected as theatre. The state space is small, the reducer is executable, the existing search explores more than a thousand semantic states with the real code and an eighty-check oracle, and a specification would be a second artefact with no conformance harness and no gate to run it in. The one property JS-level exploration cannot establish — that a reader folding the durable log sees a linearizable prefix — belongs to the commit protocol, and a crash-injection suite is its conformance evidence.

**Call `validateDagState` unconditionally from `mutate`.** Rejected. It costs O(nodes × commands) per accepted event, and `dsh-base` deliberately ships without runtime diagnostics. A config flag plus an opt-in composition gets the diagnostic value without paying for it in every session.

**Add an fsync per state append.** Rejected. It would close the acknowledged-but-not-yet-durable window, where a tool call returns an accepted revision that a crash before the next drain erases. That window violates no state invariant, because the durable prefix stays valid; the cost is a synchronous disk write on every transition, and the existing barriers already guarantee that no external effect runs before its command is durable.

**Re-test torn frames and fsync rollback inside the DAG suite.** Rejected. The persistence suites already cover the format, the rollback, and the repair retry, and duplicating them would test the same code twice. The DAG suite tests what the DAG folds, acts on, and re-derives from the repaired log.

**Model the service layer instead of testing it.** Rejected. The service's behavior is dominated by real async effects — Git, child sessions, persistence flushes — that a pure model would have to abstract into exactly the assumptions that need testing.

## Acceptance criteria

- An opt-in composition mounts `@deepseek-ai/dsh-dag/invariant`, and a real-composition test boots it through the Loader, drives one node from declaration to completion, and fails when a deliberate invariant violation is injected into the stream.
- `packages/dag/dag/tests/model.spec.ts` emits guard-mutated commands from every dequeued state and asserts the exact `DagStateError.code` or an identity-returning no-op, with no acceptance path left uncovered by either branch.
- `packages/dag/dag/tests/model-property.spec.ts` runs under `pnpm run test`, generates command sequences without precondition filtering, and asserts all four properties of the proposal; a failing run reproduces from a logged seed.
- `packages/dag/dag/tests/crash-recovery.spec.ts` passes with a real `JsonlSessionPersistence` root, asserts at every reopen that the `dag/state` fold satisfies `validateDagState` at each step, and asserts that `reconcile` leaves no non-settled mailbox command.
- The regression test for the `preparedFrom` window exists and fails on the current code: after a kill between the dependency merge and the `git-prepared` append, a no-op completion must still be refused by `DagGit.validateCompletion`.
- A test kills the process during `git worktree add` and asserts that a documented transition leaves the node dispatchable again.
- A test interrupts the torn-tail repair between truncation and rewrite and asserts that the recovered events are either durable after reopen or provably never acted on.
- `settlement.stop()` runs on every exit from `turnSettled`, and a throwing owner controller is covered by a test that states whether the child is cancelled.
- `abstractDagState` no longer compares production-derived command ids and states, and the differential assertions still pass.
- Every file:line claim in this note still resolves to the named code, or the note is corrected in the same change that moves it.

Three of these are now satisfied by shipped code rather than proposed: the `preparedFrom` regression test exists and passes against the two-phase record, the interrupted-`worktree add` case has both its repair transition and its test, and the torn-tail repair is one durable step with the crash test that pins it. The last one lives outside the DAG: it is a persistence durability decision, recorded in its own Agent Note.

## Risks

The crash-injection suite is the expensive part and the one most likely to be flaky. Layer 1 is deterministic by construction — dispose without flushing, truncate at a chosen offset, abort between two repair steps — but layer 2 depends on landing a SIGKILL inside a specific window and on subprocess timing, so it must stay opt-in and must own its temp roots, child processes, and teardown.

Turning on `validateDagState` in a live composition changes a silent corruption into a thrown error in whatever code path is appending. That is the point, but an invariant failure during a session makes the session fail, so the composition must be opt-in and the failure must be attributed and actionable.

The refusal oracle multiplies the model test's work by the number of guard mutations per state. The existing 25 000-state cap and 30-second timeout turn a blow-up into a loud failure, and the oracle may have to run over a bounded subset of dequeued states.

Fixing the `preparedFrom` window changes what is recorded durably about preparation, which is a durable-format decision with a migration question for sessions that already carry a `dag/state` snapshot. The fix needs its own Agent Note before it ships.

This note records three defects. All three are repaired: the `preparedFrom` window, the stranded-worktree gap, and the torn-tail repair window, which is now one durable step. The crash-injection suite of option 4 remains the proposal; the three regression tests it named exist.
