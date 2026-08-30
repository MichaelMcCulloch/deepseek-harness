/** Native DAG id constructors and deterministic identifier helpers. */

import { createHash } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  DagCommandId as DagCommandIdType,
  DagNodeId as DagNodeIdType,
  DagNoticeId as DagNoticeIdType,
  DagOperationId as DagOperationIdType,
  DagWaveId as DagWaveIdType,
} from './types.ts'

/**
 * Brand a raw node identifier.
 * @param value - Validated node identifier.
 * @returns Branded node identifier.
 */
export const DagNodeId = (value: string): DagNodeIdType => value as DagNodeIdType
/**
 * Brand a raw operation identifier.
 * @param value - Deterministic operation identifier.
 * @returns Branded operation identifier.
 */
export const DagOperationId = (value: string): DagOperationIdType => value as DagOperationIdType
/**
 * Brand a raw command identifier.
 * @param value - Deterministic command identifier.
 * @returns Branded command identifier.
 */
export const DagCommandId = (value: string): DagCommandIdType => value as DagCommandIdType
/**
 * Brand a raw wave identifier.
 * @param value - Deterministic wave identifier.
 * @returns Branded wave identifier.
 */
export const DagWaveId = (value: string): DagWaveIdType => value as DagWaveIdType
/**
 * Brand a raw notice identifier.
 * @param value - Deterministic notice identifier.
 * @returns Branded notice identifier.
 */
export const DagNoticeId = (value: string): DagNoticeIdType => value as DagNoticeIdType

/**
 * Return a stable lower-case digest prefix.
 * @param value - Text to hash.
 * @returns First 12 hexadecimal SHA-256 characters.
 */
export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

/**
 * Return a safe non-empty path and ref component.
 * @param value - Node identifier or label.
 * @returns Lower-case portable component.
 */
export function dagSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'node'
}

/**
 * Return the stable session segment used by DAG refs and paths.
 * @param sessionId - Dispatcher session identifier.
 * @returns Stable dispatcher hash.
 */
export function dispatcherHash(sessionId: SessionId): string {
  return shortHash(sessionId)
}
