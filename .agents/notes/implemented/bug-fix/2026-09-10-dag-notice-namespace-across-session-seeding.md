# Agent Note: DAG notice namespace across session seeding

Status: implemented

English | [中文](2026-09-10-dag-notice-namespace-across-session-seeding.zh.md)

## Problem

Every accepted DAG change appends one complete `dag/state` snapshot carrying a `noticeNamespace`, and notice ids are built from that value together with the graph generation and the node generation or wave id. Deterministic notice ids are what let reconciliation compare pending inbox entries and claimed inbox session events before it reinjects a notice, so delivery stays idempotent across a session reopen.

The service stamped each write with the live dispatcher agent id, and the reducer requires that value to equal the namespace already folded into state. A session seeded from another session inherits that session's `dag/state` snapshots, whose namespace is the origin session id, while the live agent id is the new session id. Every later `dag_write` failed with `dag-invalid-notice-namespace`, so an inherited graph accepted no new nodes and no amendment for the rest of that session. Reads kept succeeding, which made the graph look live while every write was refused.

## Decision

`DagService.write` resolves the namespace from the folded state and falls back to the live agent id only before the first declaration:

```ts
noticeNamespace: this.state(agent)?.noticeNamespace ?? agent.id,
```

The first declaration establishes the namespace; every later write, whether it runs in the declaring session or in a session seeded from it, keeps that value. The reducer's stability rule is unchanged — a state value never changes namespace after its first write — so notice ids stay stable and inherited delivery records stay matchable.

## Alternatives considered

**Stamp each write with the live agent id and let the reducer adopt it.** Rejected. Adopting a new namespace mid-graph would leave notices already recorded in state carrying ids built from the old namespace while later notices used the new one. The stability rule exists to prevent exactly that split, and the two id spaces would no longer be comparable for deduplication.

**Derive the namespace from the session's fork origin rather than from state.** Rejected as redundant. In a seeded session the folded namespace *is* the origin session id, so reading it from state produces the same value with one less dependency, and it also covers a session whose origin is no longer resolvable.

**Relax the reducer to accept any non-empty namespace.** Rejected. The check is what keeps notice ids deterministic across a reopen; accepting arbitrary values would let a caller restamp a live graph and silently break the idempotent reinjection that recovery depends on.

## Consequences

A graph declared before a session seed stays amendable afterwards, and its notice ids remain identical to the ones its inherited snapshots already reference, so reconciliation does not reinject notices the origin session already delivered.

The trade-off is that two sessions seeded from one origin derive notice ids from the same namespace. Ids stay unique within a graph, and deduplication is per session against its own inbox, so the shared namespace is not observable as a collision.

The first declaration in a fresh session still takes that session's id, so a graph declared after the seed owns its own namespace.

## Testing

`service.spec.ts` pins both branches: a first declaration fixes the namespace to the dispatcher session id, and a session holding an inherited snapshot with a foreign namespace keeps that namespace when it amends the graph at the next revision. The second test fails with `dag-invalid-notice-namespace` before this change and passes after it.

## Related

[Event-sourced native DAG orchestrator](../architecture/2026-08-29-event-sourced-native-dag-orchestrator.md) owns the durable-state and notice design this fix repairs.
