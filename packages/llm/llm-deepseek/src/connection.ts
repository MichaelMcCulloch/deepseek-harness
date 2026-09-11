/**
 * DeepSeek connection facts and the advertised catalog entries they carry.
 * Types only: adapter dispatch, request-image pricing, and the plugin's
 * option resolution all read this vocabulary, so it lives beside neither of
 * them.
 *
 * @module dsh-llm-deepseek/connection
 */

import type { ModelModality, ResolvedRetryPolicy, SystemPromptUpdate } from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { RequestDefaults } from './serialize.ts'
import type { DeepSeekFilePolicy } from './file-store.ts'

/** One optional model entry advertised by the direct-fetch adapter. */
export interface DeepSeekCatalogModel {
  /** Wire model id accepted by the configured endpoint. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
  /** Known combined request/response context capacity; omitted when deployment metadata is unavailable. */
  contextWindow?: number
  /** Per-request output cap for this model; omission falls back to the profile's {@link DeepSeekConnectionOptions.maxTokens}. */
  maxTokens?: number
  /** Accepted request modalities; omission is text-only. */
  inputModalities?: ModelModality[]
  /** Total-pixel budget for one deterministic request preview, or the 512-by-512 `low` preset. */
  imagePixelBudget?: number | 'low'
  /** Encoded-byte target for one deterministic request preview; the smallest quality-ladder output is used when no quality fits. */
  imageMaxBytes?: number
  /**
   * `'in-history'` declares that the endpoint reads the latest `system`
   * message at any position of the conversation as the complete effective
   * system prompt; omission means only a leading system message is read.
   */
  systemPromptUpdate?: SystemPromptUpdate
}

/**
 * Validated connection facts for one operation. The plugin's
 * `resolveAdapterOptions` is the one explicit resolve step producing this
 * shape; the adapter trusts it and re-reads it per operation, which is what
 * makes a configuration change reach the next request without re-registration.
 */
export interface DeepSeekConnectionOptions {
  /** Endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /**
   * Credential reference of this same resolution, resolved per request.
   * Travelling with the endpoint is the point: a request can never pair one
   * generation's URL with another generation's secret. Configuration carries
   * only this name — a literal key is not a configuration value.
   */
  apiKeyEnv: CredentialRef
  /** Request defaults applied to every call (thinking mode, effort). */
  defaults: RequestDefaults
  /** Default per-request output cap; explicit request values win. */
  maxTokens: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly DeepSeekCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Maximum accumulated file-referenced image bytes in one request. */
  maxRequestFilesBytes: number
  /** Maximum accumulated base64 image payload after Files API fallback. */
  maxInlineRequestImageBytes: number
  /** Maximum number of represented images in one request. */
  maxImagesPerRequest: number
  /** Raw-byte removal step after the file-reference bound is exceeded. */
  imageOffloadByteQuantum: number
  /** Base64-byte removal step after the inline fallback bound is exceeded. */
  inlineImageOffloadByteQuantum: number
  /** Image-count removal step after the count bound is exceeded. */
  imageOffloadCountQuantum: number
  /** Maximum duration of one request-image Files API resolution. */
  filesApiTimeoutMs: number
  /** Upload expiry, refresh, and quota-recovery policy. */
  filePolicy: DeepSeekFilePolicy
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}
