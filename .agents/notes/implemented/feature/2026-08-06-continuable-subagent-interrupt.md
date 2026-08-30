# Agent Note: Continuable subagent current-turn interrupt

Status: implemented

English | [中文](2026-08-06-continuable-subagent-interrupt.zh.md)

## Problem

A running continuable subagent could not be stopped without destroying it. The continuation manager cancels child Agents only inside whole-Activation teardown (settlement, drain, scoped drain), `send_message`/`subagent.prompt` only add work, and the Web composer's Stop button was deliberately limited to ordinary sessions. A human watching a continuable child burn tokens on a wrong path had no lever short of killing the parent tree, and when the direct parent Agent was offline the child was entirely untouchable even though its Activation stayed live. One-shot runs have holder-owned disposal and task-kill; continuable children had no analogous current-turn control.

## Decision

`ctx.subagents.interrupt(targetSessionId, authority)` stops only the live target's current turn. The manager primitive authorizes synchronously and returns `void` without awaiting target quiescence. For an ordinary child it calls `Agent.cancel(cause, { keepInbox: true })`. For an owner-bound child it delegates the authorized request and a single-use stop closure to the registered owner controller, which can commit owner state before invoking the same cancellation. Nothing else changes in the generic lifecycle: no Activation disposal, no handle release, no descendant cascade, and no inbox clearing. Because `keepInbox` parks the unclaimed pending queue at idle, an interrupt never auto-starts the next queued follow-up; work already claimed into the interrupted turn belongs to that turn and is not requeued. Once the interrupted driver is idle, an explicit waking send resumes the preserved FIFO order. The [native DAG owner](../architecture/2026-08-29-event-sourced-native-dag-orchestrator.md) uses this delegation to commit `interrupted` before cancellation.

Authority is a closed two-variant union, deliberately wider than delivery authority because stopping a turn is idempotent and delivers no content:

- `{ kind: 'user', parentSessionId }` — a human presents the durable direct-parent address. The live target's `session.header.parentSession` must match; no live parent Agent, catalog read, or persistence access is involved, which is exactly what keeps a live child stoppable while its parent Agent is offline. Cancel cause `user`.
- `{ kind: 'ancestor', agent }` — an exact live ancestor Agent (direct parent or deeper). The caller must be the registry's current entry for its id (stale callers are rejected even for absent targets), must not be the target itself, and must appear in the Activation's materialization-time `ancestry` WeakSet. Cancel cause `parent`.

Targets are resolved only in the manager's process-local Activation map. An absent id — unknown, one-shot, or naturally settled — is an accepted no-op, which uniformly covers completion races and repeat requests without leaking durable-catalog information; a target whose disposal transaction is already open is likewise an accepted no-op after authorization. One-shot lifecycle (holder `dispose()`, task-kill) is untouched. `SubagentRuntime.interrupt()` treats a manager-less composition as an accepted no-op rather than `CONTINUATION_UNAVAILABLE`, because without a manager no manager-owned live Activation can exist.

The Host RPC `subagent.interrupt` takes the continuable `SubagentAddress` and returns `{ accepted: true }`. Its implementation calls only the core primitive with `user` authority — deliberately no `catalogChild()`, `listChildren()`, `sessionQuery`, or parent-registry lookup. A live target with a mismatched parent address maps to `subagent-unauthorized`; unexpected failures map to `internal` without leaking error text onto the wire.

## Alternatives considered

**Route human interrupts through `session.cancel`.** The generic session cancel requires an attached ordinary session and rejects subagent-owned sessions; widening it would entangle subagent authority rules with ordinary session routing. A subagent-domain RPC keeps the address-based authorization and the parent-offline guarantee explicit.

**Await target quiescence and return the turn outcome.** Cancellation is cooperative, so quiescence is unbounded; holding the RPC (and a `ChildLock` slot) open invites timeouts and convoying against delivery and disposal. Acceptance-of-signal is the only fact the caller needs, and races (natural completion, disposal) already settle idempotently.

**Reuse whole-Activation disposal for interrupt.** Disposal cancels without `keepInbox`, flushes, captures, and releases the handle — it destroys queued work and the child's residency. Interrupt is a control operation on one turn, not a lifecycle operation on the Activation.

**Extend `send_message`/`followup` authority to ancestors while at it.** Delivery injects content into a conversation and is not idempotent; its exact-direct-parent authority stays unchanged. Only interrupt gets the wider ancestor and address-based user authority.

**Auto-resume the parked queue after an interrupt.** Immediately starting queued follow-up B after aborting A would make the interrupt look ignored and steal the human's window to redirect the child. Parking until an explicit waking send keeps the stop observable and the FIFO order intact.

## Consequences

A human or ancestor can stop a runaway continuable turn without losing the child, its unclaimed queued work, or its running descendants; the cost is a deliberately weak generic postcondition (`accepted` means "signal issued", so a target may remain visibly `running` until it observes the signal) that clients must render honestly. An owner controller can add a stronger state postcondition before it invokes cancellation. The parked-queue rule means an interrupted child sits idle with retained work until a waking message arrives after the driver is idle.

The address-only RPC exposes one bit of live residency: an absent target is accepted while a live target under a mismatched parent returns `subagent-unauthorized`. The single-user local Host trust model accepts that observability; a future multi-principal Host must revisit both authority and response indistinguishability.

The Web surface keeps Send and Stop as independent actions for a running continuable child: the client `Session.cancel()` routes Stop through `subagent.interrupt` (one-shot addresses stay uncancellable, ordinary sessions keep their existing primary Send/Stop toggle through `session.cancel`), while Send continues to queue follow-ups. A running parent-offline continuable child keeps the default composer with input and Send disabled but Stop reachable, returning to the read-only takeover once it stops ([Web subagent conversations](2026-07-27-web-subagent-conversations.md) owns the surrounding catalog and composer contract).

The model-facing `interrupt_agent(agent_id)` tool in `dsh-tool-subagent-control` passes `exec.agent` as the `ancestor` authority and adds none of its own: the core primitive verifies live registry identity and recorded lineage before any owner delegation, so the tool can name a direct child or a deeper descendant with the same generic `agent_id` parameter — deliberately not `subagent_id`, which would imply direct children only. Discovery rides `list_agents({ scope: 'descendants' })` over `SubagentRuntime.listDescendants()` with verified `parentId` and `depth` per entry ([durable catalog note](2026-07-22-durable-subagent-catalog-and-list-agents.md) owns the listing contract); discovery is a hint, never authority. `send_message` and `steer_agent` keep exact-direct-parent authority — only interrupt is ancestor-wide.

## Testing

Core coverage in `packages/subagent/subagent/tests/continuation.spec.ts` proves the durable `turn/end` abort, parked-then-FIFO-resumed queue, untouched descendant, both authority kinds with their cancel causes, owner delegation after authorization, self/sibling/stale/non-ancestor rejection, absent/one-shot/disposal-race no-ops, and the unchanged `keepInbox` loop behavior. Host coverage in `packages/api/gateway/tests/` proves the RPC calls only the core primitive, the `subagent-unauthorized` and `internal` mappings, the wire schema's continuable-mode fence, and carrier round-trips. Client and assembled Web coverage pins the address-routed Stop action, parent-offline behavior, queued Send, the parked follow-up, and FIFO resume. Tool coverage proves direct and deep ancestor interrupts, authorization failures without touching the target, absent-target no-ops without cold resume, and the descendants listing; recorded request headers pin the schemas.
