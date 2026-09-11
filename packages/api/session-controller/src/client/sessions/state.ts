/**
 * Client Session store vocabulary: the list-state row, arrival phase, catalog
 * projection, and logical binding shared by the sessions service (which
 * produces them) and the outward sessions contract (which reads them).
 */
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress, SubagentCatalog } from '@deepseek-ai/dsh-subagent/client'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionJob as JobView } from '../../types.ts'
import type { SessionEventSource } from '../contract/events.ts'
import type { SessionFace } from '../contract/session.ts'
import type { AgentContext } from '../scope.ts'

/** Session list row projected from the host list RPC plus live stream increments. */
export interface SessionSummary {
  id: SessionId
  /** Latest durable log-backed title, absent until the host projects one. */
  title?: string
  /** Human-facing label: durable title, project basename, then session id. */
  displayTitle: string
  cwd?: string
  parentId?: SessionId
  /** Coarse durable origin for navigation filtering; not a continuation capability. */
  origin?: 'subagent'
  running: boolean
  /** Finished while not selected and not yet opened — the sidebar's green "done" reminder. Absent = false. */
  completed?: boolean
  /**
   * Empty-log bit (host summary derivation mirror). New Session reuses a blank
   * one targeting the same workspace. Filtering stays with the consumer: the
   * store carries every row, while the Workspace browser shows only the
   * selected blank entry.
   */
  blank: boolean
  updatedAt: number
  /** Current host-computed projection values retained by the object layer. */
  projectionValues?: Readonly<Partial<SessionProjectionMap>>
}

/**
 * List arrival lifecycle, orthogonal to the pull-activity `state` axis:
 * `pending` (no successful pull yet — an empty items array means "nothing
 * arrived", not "nothing exists") → `ready` (at least one pull landed).
 * Monotone: `ready` never steps back — later pull failures and reconnect
 * re-pulls ride the `state`/`error` axis, which is where failure is modeled
 * (no `error` phase here; that would duplicate `state`).
 */
export type SessionListPhase = 'pending' | 'ready'

/** One parent-addressed durable catalog projected through the sessions snapshot. */
export type SubagentCatalogSnapshot = Omit<SubagentCatalog, 'parentAvailable'> & {
  /** Absent until the first successful catalog read. */
  readonly parentAvailable?: boolean
  state: 'loading' | 'ready' | 'error'
  error: RemoteFailure | null
}

/**
 * Session list store shape. `current` rides the same snapshot (arbitrated:
 * the single useSessions standard hook reads list and selection together —
 * sidebar highlighting and current-session consumers share one fact source).
 */
export interface SessionListState {
  /** Host-list order; addressed breadcrumb-only rows are excluded. */
  ids: SessionId[]
  /** Host rows plus the current addressed subagent route used by navigation. */
  byId: Record<SessionId, SessionSummary>
  current: SessionId | undefined
  /** Arrival lifecycle projected 1:1 from the manager snapshot (see SessionListPhase): empty-with-ready means "truly no sessions". */
  phase: SessionListPhase
  /** Direct durable catalogs keyed by their selected parent address. */
  subagentsByParent: Readonly<Record<SessionId, SubagentCatalogSnapshot>>
  /**
   * Background jobs each session can see, mirrored last-wins from Session
   * Controller's control baseline and `jobs` frames. A missing key is an empty
   * set, so consumers read absence rather than a sentinel.
   */
  jobsBySession: Readonly<Record<SessionId, readonly JobView[]>>
  /** Current session's catalog-derived address, absent on ordinary navigation. */
  currentAddress: SubagentAddress | undefined
}

/** Identity-stable logical binding for one materialized Client Session. */
export interface SessionBinding {
  readonly sessionId: SessionId
  /** The outward session face only — feature code never sees the concrete class. */
  readonly session: SessionFace
  /** Contiguous event window reserved for Conversation assembly. */
  readonly eventSource: SessionEventSource
  readonly ctx: AgentContext
}
