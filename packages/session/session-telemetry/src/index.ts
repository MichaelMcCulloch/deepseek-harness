/**
 * SessionTelemetryBackend Service Definition for the DeepSeek Harness.
 *
 * This package owns the CAPTURE side of session-event reporting — the complete
 * one-record-per-event ledger mirror, what records carry, when
 * they are captured (adoption, the per-append firehose, lifecycle
 * forwarding), live versus on-demand canonical-log capture, and the HMR
 * cursor. Everything downstream of
 * {@link SessionTelemetryBackend.emit} — batching, retry, queueing, and loss policy — is the
 * reporting SDK's territory and is deliberately not modelled here. The
 * design and its trade-offs are pinned in
 * .agents/notes/implemented/feature/2026-07-23-session-telemetry-otel-revival.md.
 *
 * @module @deepseek-ai/dsh-session-telemetry
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionTelemetryRecord, SessionTelemetrySink } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionTelemetry: SessionTelemetryBackend
  }

  interface Events {
    /**
     * Transform one outbound record before it reaches the backend. This
     * waterfall is the Service Definition's redaction extension point. It ships NO rules
     * of its own: the
     * innermost `next()` passes the record through unchanged, and with no
     * listener mounted records reach the backend as captured, so exported
     * data is exactly as clean as the rules a deployment mounts. Listeners
     * stack by transforming `next()`'s return value; returning without
     * `next()` replaces everything beneath. Dispatched synchronously on the
     * capture hot path inside the coordinator's containment: a throwing
     * listener withholds that one record (fail-closed) and never reaches the
     * agent loop. Live capture dispatches at append time; on-demand capture
     * dispatches while reading the canonical log. Redaction applies to the
     * exported copy only; the canonical session log is never rewritten.
     * @param record - the candidate record, already the coordinator's own deep
     *   copy; listeners return a (possibly new) record and must not mutate it.
     * @mode waterfall
     */
    'session-telemetry/record'(record: SessionTelemetryRecord, next: () => SessionTelemetryRecord): SessionTelemetryRecord
  }
}

/**
 * Deployment-selected session-sharing mode, not confirmation of SDK delivery.
 */
export type SessionTelemetrySharingStatus = 'full' | 'feedback-only' | 'disabled'

/**
 * Loadable form of the backend contract: one implementation per context —
 * the cordis `Service` registration under the `telemetry` key throws on a
 * duplicate, cordis' standard behavior. A backend composes a
 * {@link SessionTelemetryCoordinator} in its constructor to install the capture side.
 */
export abstract class SessionTelemetryBackend extends Service implements SessionTelemetrySink {
  constructor(ctx: Context) {
    super(ctx, 'sessionTelemetry')
  }

  /**
   * Deployment-selected sharing mode, independent of SDK delivery.
   */
  abstract readonly sharing: SessionTelemetrySharingStatus

  /**
   * See {@link SessionTelemetrySink.emit} — that declaration is the contract's one home.
   * @param record - the logical record to report; owned by the backend after the call.
   */
  abstract emit(record: SessionTelemetryRecord): void

  /** See {@link SessionTelemetrySink.flush}. */
  flush?(): void

  /**
   * See {@link SessionTelemetrySink.shutdown}.
   * @returns resolves when the backend's pipeline has quiesced.
   */
  abstract shutdown(): Promise<void>
}

export { SessionTelemetryCoordinator, type SessionTelemetryCapture, type SessionTelemetryCaptureOptions } from './coordinator.ts'
export type { SessionTelemetryRecord, SessionTelemetrySeverity, SessionTelemetrySink } from './types.ts'
