/** Authenticated raw-byte upload route registered on the Connection fetch registry. */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { FileUploadValue } from './types.ts'

/** Host upload service face this route consumes, so it imports no service module. */
interface FileUploadStreamingService {
  /**
   * Persist raw chunks for one Session without aggregating the upload.
   * @param request - Session identity, ordered bytes, cancellation, and optional display name.
   * @returns the staged receipt and durable file reference.
   */
  uploadStream(request: {
    readonly sessionId: SessionId
    readonly data: AsyncIterable<Uint8Array>
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<FileUploadValue>
}

type FileUploadHttpResult =
  | { readonly ok: true; readonly value: FileUploadValue }
  | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string; readonly details: object }
  }

/**
 * Handle one authenticated raw-byte upload.
 * @param service - Host upload service receiving streamed bytes.
 * @param request - authenticated HTTP request from Connection.
 * @returns JSON result using HTTP status 200 after request validation.
 */
export async function handleFileUploadHttp(
  service: FileUploadStreamingService,
  request: Request,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } })
  }
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/octet-stream') {
    return new Response('content type must be application/octet-stream', { status: 415 })
  }
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId')
  if (sessionId === null || sessionId === '') {
    return new Response('sessionId is required', { status: 400 })
  }
  const name = url.searchParams.get('name') ?? undefined
  let result: FileUploadHttpResult
  try {
    result = {
      ok: true,
      value: await service.uploadStream({
        sessionId: brandString<SessionId>(sessionId),
        data: requestBodyChunks(request.body),
        signal: request.signal,
        ...(name === undefined ? {} : { name }),
      }),
    }
  } catch (error) {
    const failure = remoteErrorOf(error)
    result = {
      ok: false,
      error: failure !== undefined
        ? { code: failure.code, message: failure.message, details: failure.details }
        : {
          code: 'gateway/internal',
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
    }
  }
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

async function* requestBodyChunks(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (body === null) return
  const reader = body.getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      yield chunk.value
    }
  } finally {
    reader.releaseLock()
  }
}
