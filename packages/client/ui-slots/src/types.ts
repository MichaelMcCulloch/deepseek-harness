/**
 * Slot-registry declarations shared by the entry module (`./index.ts`) and the
 * renderer contract (`./renderer.ts`): slot data context, entry declarations,
 * registration records, and the standard Session area seat. Types only;
 * `SlotMap` and the standard-kit declaration-merge points stay in the entry
 * module, where consumer `declare module` augmentation merges with them.
 * @module @deepseek-ai/dsh-client-ui-slots/src/types
 */

import type { ReactNode } from 'react'
import type { StoreDecl } from '@deepseek-ai/dsh-client-store'

/**
 * Translate a dictionary key with optional `{name}` template params.
 * `K` narrows the accepted keys to the owning namespace's dictionary union
 * (plus the shared common vocabulary where composed).
 */
export type Translate<K extends string = string> =
  (key: K, params?: Record<string, unknown>) => string

/** Slot cardinality: single occupant, ordered list, key-dispatched, or selector-routed chain. */
export type SlotKind = 'single' | 'list' | 'keyed' | 'chain'

/** Slot data context: global, current-session-optional, or strict session-bound. */
export type SlotScope = 'root' | 'session-maybe' | 'session'

/**
 * One SlotMap entry: kind/scope axes plus the optional owner-supplied props
 * share (`owner` is what the parent passes at its renderSlot call site; the
 * framework standard kit and the registrant's injected share never enter this
 * table — full component props compose at the component as the four-share
 * intersection, see {@link ComposedProps}).
 */
export interface SlotEntryDef {
  kind: SlotKind
  scope: SlotScope
  owner?: object
  /**
   * Optional keyed-entry prop table. A keyed registration contributes one
   * literal key and receives the corresponding prop share; ordinary owner
   * props remain common to every key.
   */
  keyProps?: Record<string, object>
  /**
   * Optional opaque context carried by one renderSlot occurrence. Only
   * function-valued members of the slot-level injected hooks compartment
   * receive it; the slot machinery never interprets the value.
   */
  hookContext?: unknown
  /**
   * Optional Slot-level inject face supplied by the parent registration's
   * child declaration. Every registered entry receives its bound component
   * face; child registrants do not own or replace this common capability.
   */
  inject?: object
}

/**
 * Runtime dispatch spec for one slot, recorded from a register call's
 * `children` value. The literal is compile-time checked against the SlotMap
 * entry (`SlotSpec<SlotMap[P]>` in {@link ChildrenDecl}), so kind, scope, and
 * any common inject face are declared at one point and validate each other.
 */
export type SlotSpec<E extends SlotEntryDef> = {
  kind: E['kind']
  scope: E['scope']
} & ('inject' extends keyof E
  ? E extends { inject: infer Injected extends object }
    ? { inject: Injected }
    : { inject?: object }
  : { inject?: never })

/**
 * A list-entry display label: a plain string, or a thunk re-evaluated per
 * read so registration-time text (nav rows, tabs) follows the active locale
 * without re-registration. Owners resolve through {@link resolveSlotLabel}.
 */
export type SlotLabel = string | (() => string)

/**
 * One stored registration, as recorded by the core and read by the render
 * machinery (type-erased at this boundary; the registration contract already proved
 * the shares against the component).
 */
export interface StoredEntry {
  component: unknown
  options: { key?: string; id?: string; order?: number; label?: SlotLabel; priority?: number }
  /** Chain routing selector (type-erased like `inject`; present exactly on chain-slot entries). */
  select?: ((owner: never) => unknown) | undefined
  /** Registrant business face; positional params derive from the declaration (sessionId?, actions?). */
  inject?: ((...args: never[]) => Record<string, unknown>) | undefined
  /** Child-slot declaration table (declaration + authorization + runtime spec in one). */
  children?: Readonly<Record<string, SlotSpec<SlotEntryDef>>> | undefined
  /** Declared store seat (instance resolution and lifecycle live with the host machinery). */
  store?: StoreDecl | undefined
  /** Declared dictionary namespace (the render machinery synthesizes the `t` seat from it). */
  locale?: string | undefined
  /** Diagnostics label of who registered. */
  registrant?: string | undefined
}

/** Props of the standard-kit SessionProvider seat. */
export interface SessionAreaProps {
  /** No-session body (also covers a current id whose session cannot be resolved). */
  empty?: (() => ReactNode) | undefined
  /** Session body; the framework remounts it per session identity. */
  children: ReactNode
}
