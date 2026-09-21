/**
 * Continuation integration markers and host adapters outside the public
 * Service Definition and model-facing Agent messaging contract.
 * @module @deepseek-ai/dsh-subagent/internal
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type SubagentRuntime from './index.ts'
import type { SubagentDelivery } from './inbox.ts'
import { deliverSubagentPrompt } from './markers.ts'

export {
  adjacentAgentSendMessageTool,
  deliverSubagentPrompt,
  isAdjacentAgentSendMessageTool,
  markAdjacentAgentSendMessageTool,
} from './markers.ts'

/** Runtime face required by the host-only prompt adapters. */
export interface HostPromptDeliverer {
  [deliverSubagentPrompt](
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    source: MessageSource,
    signal: AbortSignal,
    delivery: SubagentDelivery,
  ): Promise<MessageId>
}

/**
 * Queue one host-protocol message without exposing another Service operation.
 * @param runtime - subagent runtime owning continuation residency.
 * @param parent - exact live direct parent authorizing delivery.
 * @param childId - durable direct-child session id.
 * @param content - host-authored content to deliver.
 * @param source - durable host-protocol source descriptor.
 * @param signal - caller cancellation before inbox acceptance.
 * @returns the accepted message's inbox id.
 */
export function queueHostSubagentPrompt(
  runtime: SubagentRuntime,
  parent: Agent,
  childId: SessionId,
  content: ContentBlock[],
  source: MessageSource,
  signal: AbortSignal,
): Promise<MessageId> {
  return (runtime as unknown as HostPromptDeliverer)[deliverSubagentPrompt](
    parent,
    childId,
    content,
    source,
    signal,
    'queue',
  )
}

/**
 * Steer one host-protocol message without exposing another Service operation.
 * @param runtime - subagent runtime owning continuation residency.
 * @param parent - exact live direct parent authorizing delivery.
 * @param childId - durable direct-child session id.
 * @param content - host-authored content to deliver.
 * @param source - durable host-protocol source descriptor.
 * @param signal - caller cancellation before inbox acceptance.
 * @returns the accepted message's inbox id.
 */
export function steerHostSubagentPrompt(
  runtime: SubagentRuntime,
  parent: Agent,
  childId: SessionId,
  content: ContentBlock[],
  source: MessageSource,
  signal: AbortSignal,
): Promise<MessageId> {
  return (runtime as unknown as HostPromptDeliverer)[deliverSubagentPrompt](
    parent,
    childId,
    content,
    source,
    signal,
    'steer',
  )
}
