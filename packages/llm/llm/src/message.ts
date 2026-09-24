/** Message identity and immutable construction helpers. */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { MessageId, ToolCallId } from './brand.ts'
import type {
  AssistantMessage,
  ContentBlock,
  DeveloperMessage,
  Message,
  MessageRoleMap,
  ModelMessageSource,
  SystemMessage,
  ToolResultMessage,
  UserMessage,
} from './types.ts'

// The message vocabulary lives in `./types.ts` beside the content blocks it
// references; re-exported here so `@deepseek-ai/dsh-llm/message` keeps
// exporting it.
export type {
  AssistantMessage,
  AssistantProviderMetadata,
  ContextForm,
  ContextFormed,
  ContextSnapshotSection,
  DeveloperMessage,
  Message,
  MessageRoleMap,
  MessageSource,
  MessageSourceMap,
  ModelMessageSource,
  SystemMessage,
  SystemPromptMessageSource,
  ToolMessageSource,
  ToolResultMessage,
  UserMessage,
} from './types.ts'

/**
 * Bound for a `notice` summary. Producers commit the one-line account to the
 * durable log; its inputs — task labels, goal objectives, tool arguments —
 * are caller text with no length of their own.
 */
export const CONTEXT_SUMMARY_MAX_CHARS = 120

/**
 * Bound one `notice` summary to {@link CONTEXT_SUMMARY_MAX_CHARS}.
 * @param summary - the producer's one-line account, of any length.
 * @returns the account, ellipsized when it exceeds the bound.
 */
export function boundContextSummary(summary: string): string {
  return summary.length <= CONTEXT_SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`
}

type NewMessage = {
  [Role in keyof MessageRoleMap]: Omit<MessageRoleMap[Role], 'id'>
}[keyof MessageRoleMap]
type NewDeveloperMessage = Omit<DeveloperMessage, 'id' | 'role'>
type NewUserMessage = Omit<UserMessage, 'id' | 'role'>
type NewAssistantMessage = Omit<AssistantMessage, 'id' | 'role' | 'source'> & {
  readonly source: Omit<ModelMessageSource, 'kind'> & { readonly kind?: never }
}

/**
 * Detach and deep-freeze a message whose identity already exists.
 * @param message - complete message, including its stable identity.
 * @returns an immutable snapshot that preserves the identity.
 */
export function freezeMessage<T extends Message>(message: T): T {
  return deepFreeze(structuredClone(message))
}

/**
 * Create one identified message and freeze it before publication.
 * @param input - complete role, content, and source for a new message.
 * @returns an immutable message with a fresh stable identity.
 */
export function createMessage<T extends NewMessage>(
  input: T & { readonly id?: never },
): T & Pick<Message, 'id'> {
  return deepFreeze(structuredClone({
    ...input,
    id: brandString<MessageId>(randomUUID()),
  }))
}

/**
 * Create an identified, immutable developer message.
 * @param input - content and producer source for the new message.
 * @returns a detached developer message with a fresh identity.
 */
export function createDeveloperMessage<T extends NewDeveloperMessage>(
  input: T & { readonly id?: never; readonly role?: never },
): T & Pick<DeveloperMessage, 'id' | 'role'> {
  return createMessage({ ...input, role: 'developer' })
}

/**
 * Create one identified user-role message and freeze it before publication.
 * @param input - complete content and source for a new user message.
 * @returns an immutable user message with a fresh stable identity.
 */
export function createUserMessage<T extends NewUserMessage>(
  input: T & { readonly id?: never; readonly role?: never },
): T & Pick<UserMessage, 'id' | 'role'> {
  return createMessage({
    ...input,
    role: 'user',
  })
}

/**
 * Create one identified model-produced assistant message and freeze it before publication.
 * @param input - complete content plus the provider, model, and optional replay state for a new assistant message.
 * @returns an immutable assistant message with fixed role/source tags and a fresh stable identity.
 */
export function createAssistantMessage(
  input: NewAssistantMessage & { readonly id?: never; readonly role?: never },
): AssistantMessage {
  return createMessage({
    role: 'assistant',
    content: input.content,
    source: {
      kind: 'model',
      ...input.source,
    },
  })
}

/**
 * Create and freeze one identified system-role message holding a rendered
 * system prompt.
 * @param text - the complete rendered prompt; `''` records "no system prompt".
 * @returns an immutable system message with a fresh stable identity.
 */
export function createSystemMessage(text: string): SystemMessage {
  return createMessage({
    role: 'system',
    content: text.length === 0 ? [] : [{ type: 'text', text }],
    source: { kind: 'system-prompt' },
  })
}

/** Input whose acceptance creates one tool-result message. */
export interface ToolResultMessageInput {
  readonly callId: ToolCallId
  readonly content: readonly ContentBlock[]
  readonly isError: boolean
}

/**
 * Create and freeze one identified tool-result message.
 * @param input - call identity, raw result blocks, and outcome.
 * @returns an immutable tool-role message that answers the tool call.
 */
export function createToolResultMessage(input: ToolResultMessageInput): ToolResultMessage {
  return createMessage({
    role: 'tool',
    source: { kind: 'tool', callId: input.callId },
    toolCallId: input.callId,
    content: input.content,
    isError: input.isError,
  })
}
