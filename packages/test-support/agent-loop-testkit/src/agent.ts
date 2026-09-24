import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, AgentStatus, Inbox } from '@deepseek-ai/dsh-agent'
import { Session, type SessionId } from '@deepseek-ai/dsh-session'
import { unsupportedInbox } from './inbox.ts'

/** Identity and members a structural Agent stub reports. */
export interface LiveAgentStubOptions {
  /** Session-backed identity the stub reports. */
  readonly id: SessionId
  /** Session the stub reports; defaults to an empty Session for `id`. */
  readonly session?: Session
  /** Pending-input surface the stub reports; defaults to {@link unsupportedInbox}. */
  readonly inbox?: Inbox
  /** Provider route the stub reports. */
  readonly options?: AgentOptions
  /** Lifecycle state the stub reports. */
  readonly status?: AgentStatus
  /** Context the stub reports as its Agent scope; defaults to a detached empty context. */
  readonly ctx?: Context
}

/**
 * Create a complete live-Agent stub for tests whose subject reads agent
 * identity, session, or pending input. The stub is registered nowhere, so live
 * lookups fail exactly as they do for a retired Agent; its delivery and
 * cancellation methods do nothing, and its maintenance runner settles without
 * touching a driver.
 * @param options - identity and the members the test subject reads.
 * @returns an Agent with every live member present.
 */
export function liveAgentStub(options: LiveAgentStubOptions): Agent {
  return {
    id: options.id,
    options: options.options ?? {},
    session: options.session ?? Session.create(options.id),
    inbox: options.inbox ?? unsupportedInbox(),
    status: options.status ?? 'idle',
    ctx: options.ctx ?? new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    redirect: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}
