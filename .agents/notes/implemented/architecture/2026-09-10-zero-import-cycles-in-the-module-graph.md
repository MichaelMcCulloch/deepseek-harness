# Agent Note: zero import cycles in the module graph

Status: implemented

English | [中文](2026-09-10-zero-import-cycles-in-the-module-graph.zh.md)

## Problem

`cyclecheck` reported 27 import cycles across `packages/` and `vendor/`. Each couples two modules in both directions: one names a type or value the other declares, and that other names something back. TypeScript erases type-only imports, so most were harmless at runtime, but the checker deliberately counts them — a type cycle still ties two modules' declarations together — and a value cycle makes evaluation order depend on partially-initialized bindings.

## Decision

The graph holds zero cycles. Each is broken by moving a declaration so the dependency runs one way, then re-exporting it from where it used to live, which leaves every public export's name and type unchanged.

Most were a module importing a type from its own package's `index.ts` barrel while the barrel imported values back from it. The type now comes from the module that declares it, or from a types-only leaf — an existing sibling such as `types.ts`, or a new one — that `index.ts` re-exports. A few had to move a class or a symbol cluster instead: the client session store vocabulary, `SessionPreparation` into the module that declares `Session`, the subagent process-stable markers into `markers.ts`, and the wire-admission implementation into the barrel that owns `AttachmentStore`.

Two clusters could not be split at all. In `vendor/cordis` the eight core modules — `Context`, `EventsService`, `Fiber`, `LoggerService`, `ReflectService`, `RegistryService`, `Service`, and `utils` — each name `Context` in public signatures while `Context` value-imports and constructs all of them; in `vendor/loader` the recursive entry core (`Entry`, `EntryOptions`, `EntryGroup`, `EntryTree`, `Loader`, `isolate`) has the same shape. No edge can be removed without changing a public signature or module evaluation order, so each coalesces its recursive core into one module and keeps the other paths as explicit-name re-export facades. Both divergences are logged in [`vendor/README.md`](../../../../vendor/README.md) as items 20 and 21, and a future upstream sync re-applies the relocation rather than only the local patch list.

## Alternatives considered

**Convert the type imports to `import type`.** Rejected: the checker counts type-only imports, so the edge survives the change. Most of these cycles already used `import type`.

**Narrow ports for the Cordis services.** A leaf port plus declaration merging would remove the cycle without merging files, but public positions (`Hook.ctx`, `LoggerService.ctx`, `Fiber.ctx`, `Plugin.*`, `getTraceable`) would name the port instead of the concrete `Context`. That is a real narrowing for consumers, whereas coalescing was verified with the compiler API to preserve every export's declared type exactly.

**Record the cycles in a `--baseline` ratchet.** Rejected: it accepts the cycles rather than removing them. The tool's baseline is an adoption path for a legacy repository, not a design position.

**Rewrite the source to suit the parser.** Rejected. The checker drops every outgoing edge of a file it cannot parse, and 59 files here fail to parse (`export type * from`, `out T` variance, `accessor` as a member name, multi-call-signature type literals). Rewriting `export type *` as `export *` made 374 edges visible and revealed two further cycles, but it also converts type-only re-exports into runtime re-exports. The parser gap is reported to the tool rather than worked around in this repository.

## Consequences

Barrels are aggregation points again: `index.ts` imports names from leaves and re-exports them, and no module reaches back into the barrel it belongs to.

Declarations gained new homes, including types-only leaves in several packages and one coalesced kernel in each vendored framework package. `vendor/cordis/src/context.ts` is necessarily the file the checker cannot parse, because `Service<out T = never>` and the `ReflectService.accessor(...)` class method cannot be respelled without a type change — but its only remaining imports are npm packages, so that blind spot hides no relative edge.

A deep path into a coalesced kernel now exports that cluster's names as well as its own; no name was lost or retyped anywhere, and each package barrel is unchanged.

Cycles found by reading the import graph rather than by the checker are fixed the same way. Two surfaced when `export type *` was temporarily rewritten to `export *` (`client/file-upload`, `subagent/subagent`), and three more when the checker gained edge recovery from files it cannot parse (`client/ui-slots`, `core/tools`, `typert/protocol`). Both sets were real; each new release of the checker has so far found more, so "zero cycles" is a statement about a given checker version, not a property that can be assumed stable.

## Testing

`cyclecheck . --lang typescript` reports no cycles. `pnpm run typecheck` passes on the full tree.

Each workstream ran the suites covering the packages whose module boundaries moved: `core/{scope,session,tools,agent}`, `llm`, `llm-deepseek`, `subagent/subagent` (693 tests), `subprocess-local`, `mcp-client`, `sandbox`, `session-persistence-jsonl`, `session-telemetry`, `attachment`, `client/file-upload`, and the GUI client suites. The two coalesced kernels are covered by `packages/core/{scope,session,agent}` (1,037 tests), `packages/boot/app-boot` (141), `packages/host/directory-picker-auto`, `packages/preset/agent-presets` (186, which subclasses `EntryTree`), and `scripts/cordis-core-api.spec.ts`.

## Related

[Event-sourced native DAG orchestrator](2026-08-29-event-sourced-native-dag-orchestrator.md) is unrelated in subject; this note owns the module-graph decision by itself.
