---
description: "Dispatcher and owner-bound child tools for users and maintainers who operate the native durable DAG."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-dag

English | [中文](README.zh.md)

## Summary

`dsh-tool-dag` gives a dispatcher the native DAG command set and gives each DAG-owned child only the controls for its own work. Mutating tools commit durable intent and return an acceptance revision and operation id without waiting for Git or child effects. The dispatcher prompt requires `dag_wait` instead of status polling. Child tools derive dispatcher, node, and child identities from durable owner metadata; model input cannot select those identities.

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

Mount the main export in dispatcher compositions and mount the `/child` export in the host composition that creates continuable children. The shipped base, `standard`, `ptc`, and Cordis agent compositions include these roles.

### Dispatcher tools

| Tool | Purpose |
|---|---|
| `dag_write` | Declare or amend the complete graph |
| `dag_dispatch` | Start dependency-ready pending nodes |
| `dag_wait` | Wait for an injected actionable notice after a revision |
| `dag_status` | Read the complete safe board once |
| `dag_node_inspect` | Read one node and its execution facts |
| `dag_node_redispatch` | Return a failed node to pending |
| `dag_node_resume` | Resume a blocked or interrupted node |
| `dag_node_steer` | Cancel and replace node work |
| `dag_node_stop` | Record interrupted, then cancel node work |
| `dag_node_reset` | Reset tracked work to an allowed local target |

`dag_write` sends the complete node list. New nodes can declare only `pending`. Existing rows repeat their immutable definition and exact live status. Each brief must contain `VALIDATION:` and `ACCEPTANCE:` sections. Validation rejects duplicate ids, cycles, missing or self dependencies, unsafe paths, invalid integration policies, and removal of active nodes. File and contract-pin overlap rows are advisory.

### Child tools

A DAG child sees scoped `dag_status`, `dag_node_complete`, and `dag_node_block`. It sees topology, dependency status, and its own execution facts, but it cannot control another node. A successful turn must end with complete or block. A normal child turn that ends without either report becomes failed after settlement.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The dispatcher plugin registers the public tools and one model prompt section. The child plugin uses the continuable setup registry only when owner metadata names the DAG controller. It denies dispatcher controls in that child scope, registers the three child tools, and adds the child completion rule. Every tool uses generic rendering and returns no clickable file location.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Dispatcher schemas, execution, rendering, status, and child tool factories |
| [`src/child.ts`](src/child.ts) | Owner-scoped child setup, restrictions, and prompt text |
| — | No runtime invariant companion is published; every tool is an effect-scoped registration over the DAG service, which owns and validates all durable state. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DAG service](../dag/README.md) — durable state, effects, Git, recovery, and notices.
- [DAG subsystem](../../../docs/subsystems/dag.md) — generated service API and lifecycle reference.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-dag) — exact model schemas.

-----

<a id="model-experience"></a>
## Model Experience

### Dispatcher and child tools

#### What the model sees

A dispatcher sees the ten public tools and a short rule to use `dag_wait` after dispatch. A DAG child sees only its scoped status, complete, and block tools plus the rule that stop cancels work and steer cancels and replaces work.

#### Token effect

Tool schemas add a fixed request cost. `dag_status` and inspect results grow with graph or node state. Accepted mutation results are small and fixed in form.

#### KV Cache effect

The prompt and tool definitions are prefix-stable while the composition and child scope do not change. Tool calls and results append to history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No synchronous completion** — acceptance means durable intent was committed; effects can still fail later.
- **No cross-node controls for children** — only the dispatcher can control the board.
- **No status polling workflow** — callers must use `dag_wait` after dispatch; repeated `dag_status` calls are not a scheduler.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
