/**
 * Effect-scoped owner control for continuable children. Authorization remains
 * in the subagent service; a controller receives only an already-authorized
 * live target and closures for the normal Agent operation.
 * @module @deepseek-ai/dsh-subagent/owner-controller
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SubagentInterruptAuthority,
  SubagentOwnerBinding,
  SubagentResult,
} from './types.ts'

/** Authorized stop request for one owner-bound live child. */
export interface SubagentOwnerStopRequest {
  readonly binding: SubagentOwnerBinding
  readonly child: Agent
  readonly authority: SubagentInterruptAuthority
  /** Apply the normal inbox-preserving cancellation after owner state commits. */
  readonly stop: () => void
}

/** Authorized redirect request for one owner-bound live child. */
export interface SubagentOwnerRedirectRequest {
  readonly binding: SubagentOwnerBinding
  readonly child: Agent
  readonly message: UserMessage
  /** Apply the normal replacement-turn operation after owner state commits. */
  readonly redirect: (replacement?: UserMessage) => void
}

/** Terminal facts captured from one owner-bound child activation. */
export interface SubagentOwnerSettlement {
  readonly binding: SubagentOwnerBinding
  readonly childId: SessionId
  readonly parentSessionId: SessionId
  readonly stopReason: SubagentResult['stopReason']
  /** Stable identity of the last ordinary turn admitted by this activation. */
  readonly messageId?: MessageId
  readonly output?: ContentBlock[]
  readonly error?: string
}

/** Terminal facts for one ordinary turn of an owner-bound child. */
export interface SubagentOwnerTurnSettlement {
  readonly binding: SubagentOwnerBinding
  /** Exact live child whose turn just ended. */
  readonly child: Agent
  readonly parentSessionId: SessionId
  readonly turn: number
  readonly stopReason: SubagentResult['stopReason']
  /** Stable identity of the ordinary message claimed by this turn. */
  readonly messageId: MessageId
  readonly error?: string
  /** Cancel the ended activity and discard queued input after owner state commits. */
  readonly stop: () => void
}

/** Controller for one durable owner namespace. Redirect admission can be asynchronous. */
export interface SubagentOwnerController {
  /**
   * Commit owner stop state, then invoke `request.stop()` when accepted.
   * @param request - authorized live-child stop operation.
   */
  stop(request: SubagentOwnerStopRequest): void
  /**
   * Commit owner steering state, then invoke `request.redirect()` when accepted.
   * @param request - authorized live-child replacement operation.
   * @returns optional asynchronous owner admission through its persistence barrier.
   */
  redirect(request: SubagentOwnerRedirectRequest): void | Promise<void>
  /**
   * Observe each ordinary child turn before the loop can start queued work.
   * @param settlement - captured turn facts and a queue-discarding stop operation.
   */
  turnSettled(settlement: SubagentOwnerTurnSettlement): void
  /**
   * Observe activation settlement when its last admitted message did not reach a turn end.
   * @param settlement - captured terminal facts.
   */
  settled(settlement: SubagentOwnerSettlement): void
}
