/**
 * Zstandard frame vocabulary shared by the frame primitives and the two
 * interchangeable synchronous decoder implementations, so neither decoder has
 * to import the primitives module that instantiates it.
 *
 * @module dsh-session-persistence-jsonl/types
 */

/** Byte range occupied by one structurally complete Zstandard frame. */
export interface ZstdFrameRange {
  /** Inclusive frame start. */
  start: number
  /** Exclusive frame end. */
  end: number
}

/** Common lifecycle for interchangeable synchronous multi-frame decoders. */
export interface ZstdFrameDecoder {
  /**
   * Decode and checksum complete frames in source order. Each yielded buffer
   * remains valid only until the iterator advances to the next frame.
   * @param source - concatenated Zstandard frame bytes.
   * @param frames - structurally complete ranges within `source`.
   * @returns one plaintext buffer per frame.
   */
  decode(source: Buffer, frames: readonly ZstdFrameRange[]): Generator<Buffer, void, void>
  /** Release decoder-owned resources; repeated calls are harmless. */
  close(): void
}
