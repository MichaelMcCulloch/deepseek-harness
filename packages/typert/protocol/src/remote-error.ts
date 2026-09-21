/** The Remote failure vocabulary, its class, and the discriminated failure union shared by owners, the Gateway, and consumers. */

/**
 * Merge-extensible Remote failure vocabulary: this package declares the
 * universal carrier codes once; the Gateway merges its infrastructure codes
 * and every owner merges its domain codes next to the throwing code.
 */
export interface RemoteErrorDetailsMap {
  /** Owner-side business validation refused the request; `issues` carries codec output when one produced it. */
  'gateway/bad-request': { readonly issues?: readonly object[] }
  /** The call was cancelled by the carrier signal or the backend. */
  'gateway/cancelled': {}
  /** Carrier, dispatch, or unclassified Host failure. */
  'gateway/internal': {}
}

/** Every declared Remote failure code. */
export type RemoteErrorCode = keyof RemoteErrorDetailsMap

/**
 * One Remote call failure: a real Error carrying its stable code and typed
 * details. Owners throw it at the failure point; the Host Gateway encodes it
 * onto the wire unchanged; the Client face rebuilds an instance for the
 * `RemoteResult` error branch, so `throw result.error` keeps throw semantics.
 * Discrimination is always by `code`, never by instanceof.
 */
export class RemoteError<Code extends RemoteErrorCode = RemoteErrorCode> extends Error {
  /** Structural marker: cross-realm/bundle identification never uses instanceof. */
  readonly isDSHRemoteError: true = true

  /**
   * @param code - stable failure code declared in {@link RemoteErrorDetailsMap}.
   * @param message - human diagnostic carried across the wire.
   * @param details - structured payload typed by the code.
   * @param options - standard Error options (`cause` survives in-process only).
   */
  constructor(
    readonly code: Code,
    message: string,
    readonly details: RemoteErrorDetailsMap[Code],
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RemoteError'
  }
}

/**
 * One Remote call's failure: the code-discriminated union of RemoteError
 * instances, so a `code` branch narrows `details` with no cast.
 */
export type RemoteFailure = {
  [Code in RemoteErrorCode]: RemoteError<Code>
}[RemoteErrorCode]

/**
 * Structurally identify a RemoteError thrown across module or realm copies of
 * this class. Mechanism-internal: the Gateway and test assertions use it;
 * business code receives typed failures and never needs it.
 * @param value - a caught value.
 * @returns the failure when the marker matches, otherwise undefined.
 */
export function remoteErrorOf(value: unknown): RemoteFailure | undefined {
  // Structural, not instanceof: an Error thrown in another realm (iframe, VM)
  // fails instanceof Error here, so the marker plus the code field is the test.
  if (typeof value === 'object' && value !== null
    && (value as { isDSHRemoteError?: unknown }).isDSHRemoteError === true
    && typeof (value as { code?: unknown }).code === 'string') {
    return value as unknown as RemoteFailure
  }
  return undefined
}
