---
description: "The native DAG package group: durable orchestration, local Git execution, dispatcher tools, and owner-scoped child tools."
kind: "package-group"
---

# dag/ — native dependency-graph orchestration

English | [中文](README.zh.md)

## Summary

The `dag/` group lets one dispatcher session declare a dependency graph, start ready nodes in parallel, and coordinate continuable child agents in isolated local Git worktrees. The session log stores the complete graph state. Background effects perform Git and child work after each accepted state change. This group does not replace the todo list or the generic subagent manager.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`dag/`](dag/README.md) | Owns durable state, revision checks, effect recovery, notices, child ownership, and local Git worktrees |
| [`tool-dag/`](tool-dag/README.md) | Gives dispatchers the DAG command set and gives owner-bound children the status, complete, and block tools |

-----

<a id="related-documentation"></a>
## Related documentation

- [DAG subsystem](../../docs/subsystems/dag.md) — state, lifecycle, service API, effects, notices, and Git rules.
- [Subagent subsystem](../../docs/subsystems/subagent.md) — continuable children, redirect, settlement delivery, and owner controllers.
- [Client UI DAG](../client/ui-dag/README.md) — the read-only Web board.

<a id="dev-note"></a>
## Dev Note

None.
