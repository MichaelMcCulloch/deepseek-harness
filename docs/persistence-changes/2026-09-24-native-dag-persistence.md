---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-24-native-dag-persistence

English | [中文](2026-09-24-native-dag-persistence.zh.md)

## Summary

Adds the durable DAG state event, the DAG notice source kind, and two optional continuable-descriptor fields.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-native-dag-persistence
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "4cddb6c4710a48bc4016639dedc3324ce6338bbb8d2959c602f2671047a4006e"
    decision: same-version
  - root: "event:dag/state"
    previous: null
    after: "26b4cd8ea2bb75a88573a0b9ce528fa799964f726eb828a0c9bc825b7cd7762f"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "2d4867033090cebbffa44f2614c2008cb2d1136bed69923390fc9449e5110b82"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "f436874e46e458a1aa08c182025ce1f168514aa8d890fb7bc4c0100a3ecb5b0a"
    decision: same-version
  - root: "event:subagent/descriptor"
    previous: "2026-09-11-initial"
    after: "5812a50598170303bc355b38f2062ed1d3d087df657726bb8ee5a084fa9677d0"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "685f4a52ac629d750f96e6da76132eb4f65a96e4c593b37450ad584757a8920e"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

All four detected paths are additive. `dag/state` is a new ordinary event type carrying one complete immutable DAG snapshot; sessions without it are unaffected and readers that execute DAG work fold it through the `dag` projection. `dag-notice` is an attribution-only source kind: it declares the notice text, so a reader without the DAG service preserves the message and only skips the notice's own identification. `settlementDelivery` and `owner` are optional on the continuable descriptor: a descriptor written before them resolves to the `adaptive` delivery policy the writer already applies when a caller declares none, and to no owner binding, so an older record resumes with the same behavior it had when it was written.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/subagent/subagent packages/dag packages/session/session-persistence-jsonl: 1686 tests passed, 1 skipped. pnpm run verify-persistence-changes reports every detected path as same-version allowed, and pnpm run verify-persistence-catalog reports the catalog, schema inventory, and known-event-type source up to date.

<a id="dev-note"></a>
## Dev Note

None.
