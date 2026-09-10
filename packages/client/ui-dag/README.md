---
description: "The read-only Web DAG dock for users and maintainers who need a compact view of durable dependency work."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-dag

English | [中文](README.zh.md)

## Summary

This package adds a read-only DAG dock to the Web conversation composer. It is hidden while the `dag` projection is `null`. After the first `dag_write`, it shows non-zero status counts, the ready-node count, and an expandable topological node list. It has order `15`, after Todo and Goal and before Queue. It provides no dispatch, stop, steer, or mutation control.

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

Mount the host package in the Web bundle and include its client module in the browser graph. The package needs the session projection and conversation dock services. It registers English and Simplified Chinese copy through the locale service.

The dock reads only `useProjection('dag')`. Absolute worktree paths are absent from this wire view. Reload reconstructs the same board from the latest durable `dag/state` event.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The host export has no runtime state. The client export registers locale dictionaries and one `conversation.input.dock` slot entry. `DagBoard` is a pure presentation component, and `DagDock` only reads the projection hook.

| File | Role |
|---|---|
| [`src/client/DagDock.tsx`](src/client/DagDock.tsx) | Projection adapter and read-only board component |
| [`src/client/locales.ts`](src/client/locales.ts) | Typed English and Simplified Chinese dictionaries |
| [`src/client/DagDock.module.css`](src/client/DagDock.module.css) | Dock, count, and node-list layout |
| — | No runtime invariant companion is published; the host DAG package owns and validates every projected state value this package renders. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DAG service](../../dag/dag/README.md) — durable state and browser projection.
- [DAG subsystem](../../../docs/subsystems/dag.md) — projection fields and lifecycle.
- [Client package map](../README.md) — adjacent Web UI packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser-only read-only projection registers no model prompt, tool, message, or context.

#### KV Cache effect

None; the package does not change model requests or history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Read-only view** — users cannot mutate a node from this dock.
- **Compact facts only** — the dock omits notices, commands, operation receipts, child sessions, commits, and worktree paths.
- **Current state only** — it does not present a revision timeline or past graph generations.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
