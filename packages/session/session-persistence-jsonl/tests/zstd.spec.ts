import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { SessionSeq, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  generationLogPath, logPath, repairReplacementPath, scanLog, sessionDir, toHeaderLine, type JsonlCompression,
} from '../src/format.ts'
import {
  compressZstdFrame, createZstdFrameDecoder, decompressZstdFrame, decompressZstdPrefix, scanZstdFrames,
  type ZstdFrameDecoder,
} from '../src/zstd.ts'
import { NodePrivateZstdFrameDecoder } from '../src/zstd-private-decoder.ts'
import { PublicZstdFrameDecoder } from '../src/zstd-public-decoder.ts'
import {
  runPersistenceContract, meta, oneTurnLog, releasedV1OneTurnLog,
} from '../../session-persistence/tests/contract.ts'

const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
const roots: string[] = []
const contexts: Context[] = []

interface ZstdReaderInternals {
  readZstdPrefix(buffer: Buffer, signal?: AbortSignal): Promise<{ events: SessionEvent[] }>
}

type HeaderRead = (
  this: FileHandle,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number | null,
) => Promise<{ bytesRead: number; buffer: Buffer }>

async function freshRoot(prefix = 'dsh-jsonl-zstd-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function mount(root: string, compression?: JsonlCompression): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, {
    root,
    ...(compression === undefined ? {} : { compression }),
  })
  return ctx
}

/** Create + append + close: persist one whole log through the write handle. */
async function writeLog(persistence: SessionPersistence, m: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
  const handle = await persistence.create(m)
  try {
    await handle.append(events)
  } finally {
    await handle.close()
  }
}

/** Open a read handle, read the whole log, and close. */
async function readAll(persistence: SessionPersistence, id: SessionId): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }> {
  const handle = await persistence.open(id, 'read')
  try {
    return { meta: handle.header, events: (await handle.read()).events }
  } finally {
    await handle.close()
  }
}

/** Append one contiguous batch through a temporary write handle. */
async function appendBatch(persistence: SessionPersistence, id: SessionId, events: readonly SessionEvent[]): Promise<void> {
  const handle = await persistence.open(id, 'write')
  try {
    await handle.append(events)
  } finally {
    await handle.close()
  }
}

async function decodeCompleteFrames(buffer: Buffer): Promise<Buffer> {
  const { frames, tornStart } = scanZstdFrames(buffer)
  expect(tornStart).toBeUndefined()
  const plaintext: Buffer[] = []
  for (const frame of frames) {
    plaintext.push(await decompressZstdFrame(buffer.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(plaintext)
}

function releasedV0Header(header: SessionHeader): Record<string, unknown> {
  return {
    type: 'session',
    version: 0,
    id: header.id,
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    delegationDepth: header.delegationDepth ?? 0,
  }
}

/** Truncate one compressed frame so a scan reports it torn and the recovered plaintext satisfies `accepts`. */
async function tornFrame(plaintext: string, accepts: (decoded: string) => boolean = () => true): Promise<Buffer> {
  const frame = await compressZstdFrame(plaintext)
  const candidateEnds = [
    frame.length - 1,
    frame.length - 4,
    ...[0.9, 0.75, 0.6, 0.5, 0.4, 0.25].map(ratio => Math.floor(frame.length * ratio)),
  ]
  for (const end of candidateEnds) {
    const candidate = frame.subarray(0, end)
    if (scanZstdFrames(candidate).tornStart !== 0) continue
    try {
      const decoded = (await decompressZstdPrefix(candidate)).toString('utf8')
      if (accepts(decoded)) return candidate
    } catch {
      // Some early cuts precede the first decodable block; keep searching for
      // a cut that exercises partial-plaintext recovery.
    }
  }
  throw new Error('test fixture could not produce the requested torn Zstandard frame')
}

function deterministicNoise(length: number): string {
  let state = 0x12345678
  let output = ''
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    output += String.fromCharCode(33 + (state % 90))
  }
  return output
}

function emptyStructuralFrame(descriptor: number): Buffer {
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const dictionaryBytes = [0, 1, 2, 4][descriptor & 0x03]!
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  const variableHeader = Buffer.alloc((singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes)
  const lastEmptyRawBlock = Buffer.from([1, 0, 0])
  const checksum = (descriptor & 0x04) === 0 ? Buffer.alloc(0) : Buffer.alloc(4)
  return Buffer.concat([MAGIC, Buffer.from([descriptor]), variableHeader, lastEmptyRawBlock, checksum])
}

/**
 * Append one EOF-torn final frame whose complete JSONL records are
 * `[turn/start, step/start]` and whose half-written third record never decodes
 * to an event.
 * @param path - the Zstandard generation log to append the torn tail to.
 * @param turn - the turn number both complete records carry.
 * @returns the two complete records the torn frame yields to a reader.
 */
async function appendTornSecondTurnStart(path: string, turn = 2): Promise<SessionEvent[]> {
  const complete: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(6), time: 7, data: { turn } },
    { type: 'step/start', seq: SessionSeq(7), time: 8, data: { turn, step: 1 } },
  ]
  const partial = JSON.stringify({
    type: 'assistant/chunk',
    seq: 8,
    time: 9,
    data: { turn, step: 1, chunk: { type: 'text-delta', index: 0, text: deterministicNoise(300_000) } },
  })
  await appendFile(path, await tornFrame(
    [...complete.map(event => JSON.stringify(event)), partial].join('\n'),
    decoded => (decoded.match(/\n/g) ?? []).length >= 2 && !decoded.endsWith('\n'),
  ))
  return complete
}

/** The two events continuing a session whose torn tail recovered seqs 6 and 7. */
function secondTurnClosers(): SessionEvent[] {
  return [
    { type: 'step/end', seq: SessionSeq(8), time: 10, data: { turn: 2, step: 1 } },
    { type: 'turn/end', seq: SessionSeq(9), time: 11, data: { turn: 2, reason: { kind: 'interrupted' } } },
  ]
}

/** The two events continuing a session whose torn tail recovered no record. */
function secondTurn(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(6), time: 9, data: { turn: 2 } },
    { type: 'turn/end', seq: SessionSeq(7), time: 10, data: { turn: 2, reason: { kind: 'completed' } } },
  ]
}

/** The bytes the append path encodes for one batch, as a repaired log stores them. */
async function encodedBatch(events: readonly SessionEvent[]): Promise<Buffer> {
  return compressZstdFrame(events.map(event => JSON.stringify(event)).join('\n') + '\n')
}

/** Open a write handle over a torn artifact and abandon it after one rejected append. */
async function appendAfterCrash(
  ctx: Context,
  id: SessionId,
  batch: readonly SessionEvent[],
  crash: Error,
): Promise<void> {
  const service = ctx.sessionPersistence as unknown as { persistBatch: () => Promise<void> }
  vi.spyOn(service, 'persistBatch').mockRejectedValueOnce(crash)
  const handle = await ctx.sessionPersistence.open(id, 'write')
  await expect(handle.append(batch)).rejects.toBe(crash)
  await handle.close()
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

runPersistenceContract('jsonl-zstd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-zstd-contract-'))
  const instance = async (): Promise<{ persistence: SessionPersistence; dispose: () => Promise<void> }> => {
    const ctx = new Context()
    const fiber = await ctx.plugin(JsonlSessionPersistence, { root })
    return {
      persistence: ctx.sessionPersistence,
      dispose: async () => { await fiber.dispose() },
    }
  }
  const primary = await instance()
  return {
    persistence: primary.persistence,
    dispose: async () => {
      await primary.dispose()
      await rm(root, { recursive: true, force: true })
    },
    reopen: instance,
    // A torn final frame: the batch's append never resolved, so the whole
    // frame is an uncommitted crash fragment for the write path to truncate.
    corruptTail: async (id, cwd) => {
      const line = JSON.stringify({
        type: 'assistant/chunk',
        seq: SessionSeq(8),
        time: 9,
        data: { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: deterministicNoise(300_000) } },
      }) + '\n'
      const partial = await tornFrame(line, decoded => !decoded.includes('\n'))
      await appendFile(logPath(root, cwd, id, 'zstd'), partial)
    },
  }
})

describe('Zstandard frame structure', () => {
  it('scans concatenated checksummed frames and honors a frame limit', async () => {
    const first = await compressZstdFrame('header\n')
    const second = await compressZstdFrame('event\n')
    const stream = Buffer.concat([first, second])
    expect(scanZstdFrames(Buffer.alloc(0))).toEqual({ frames: [] })
    expect(scanZstdFrames(stream)).toEqual({
      frames: [{ start: 0, end: first.length }, { start: first.length, end: stream.length }],
    })
    expect(scanZstdFrames(stream, 1)).toEqual({ frames: [{ start: 0, end: first.length }] })
    expect(first[4]! & 0x04).toBe(0x04)
    expect(second[4]! & 0x04).toBe(0x04)
    expect((await decompressZstdFrame(first)).toString()).toBe('header\n')
    const decoder = createZstdFrameDecoder()
    try {
      const plaintext = Array.from(decoder.decode(stream, scanZstdFrames(stream).frames), chunk => Buffer.from(chunk))
      expect(Buffer.concat(plaintext).toString()).toBe('header\nevent\n')
    } finally {
      decoder.close()
    }
  })

  it('keeps the public and Node-private synchronous decoders interchangeable', async () => {
    const frames = [await compressZstdFrame('first\n'), await compressZstdFrame('second\n')]
    const stream = Buffer.concat(frames)
    const ranges = scanZstdFrames(stream).frames
    const privateDecoder = NodePrivateZstdFrameDecoder.create()
    expect(privateDecoder).toBeDefined()

    for (const decoder of [new PublicZstdFrameDecoder(), privateDecoder!]) {
      try {
        const plaintext = Array.from(decoder.decode(stream, ranges), chunk => Buffer.from(chunk))
        expect(plaintext).toHaveLength(2)
        expect(Buffer.concat(plaintext).toString()).toBe('first\nsecond\n')
      } finally {
        decoder.close()
      }
    }
  })

  it('falls back to the public decoder when the private Node contract is unavailable', () => {
    vi.spyOn(NodePrivateZstdFrameDecoder, 'create').mockReturnValue(undefined)
    const decoder = createZstdFrameDecoder()
    expect(decoder).toBeInstanceOf(PublicZstdFrameDecoder)
    decoder.close()
  })

  it('enforces decoder lifecycle and checksum errors through both implementations', async () => {
    const frame = await compressZstdFrame('frame\n')
    const range = [{ start: 0, end: frame.length }]
    const corrupt = Buffer.from(frame)
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 0xFF
    const factories: Array<() => ZstdFrameDecoder> = [
      () => new PublicZstdFrameDecoder(),
      () => NodePrivateZstdFrameDecoder.create()!,
    ]

    for (const create of factories) {
      const interrupted = create()
      const iterator = interrupted.decode(frame, range)
      expect(iterator.next().value?.toString()).toBe('frame\n')
      iterator.return()
      expect(() => Array.from(interrupted.decode(frame, range))).toThrow(/already started/)
      interrupted.close()

      const closed = create()
      closed.close()
      closed.close()
      expect(() => Array.from(closed.decode(frame, range))).toThrow(/closed/)

      const invalid = create()
      expect(() => Array.from(invalid.decode(corrupt, range))).toThrow(/frame at byte 0 failed validation/)
    }
  })

  it('assembles private-decoder output at and beyond its reusable chunk boundary', async () => {
    for (const length of [8, 9]) {
      const plaintext = Buffer.alloc(length, 0x61)
      const frame = await compressZstdFrame(plaintext)
      const decoder = NodePrivateZstdFrameDecoder.create()!
      ;(decoder as unknown as { output: Buffer }).output = Buffer.allocUnsafe(8)
      const [decoded] = Array.from(
        decoder.decode(frame, [{ start: 0, end: frame.length }]),
        chunk => Buffer.from(chunk),
      )
      expect(decoded).toEqual(plaintext)
    }
  })

  it('normalizes private decoder stream failures', async () => {
    interface PrivateDecoderInternals {
      stream: {
        [key: symbol]: unknown
        emit(event: string, error: Error): boolean
      }
      errorKey: symbol
    }
    const frame = await compressZstdFrame('frame\n')
    const range = [{ start: 0, end: frame.length }]

    const emitted = NodePrivateZstdFrameDecoder.create()!
    const emittedInternals = emitted as unknown as PrivateDecoderInternals
    const first = new Error('first emitted decoder failure')
    emittedInternals.stream.emit('error', first)
    emittedInternals.stream.emit('error', new Error('later emitted decoder failure'))
    try {
      Array.from(emitted.decode(frame, range))
      throw new Error('expected emitted decoder failure')
    } catch (error) {
      expect((error as Error).cause).toBe(first)
    }

    for (const internalFailure of [new Error('internal decoder failure'), 'not an Error']) {
      const decoder = NodePrivateZstdFrameDecoder.create()!
      const internals = decoder as unknown as PrivateDecoderInternals
      internals.stream[internals.errorKey] = internalFailure
      try {
        Array.from(decoder.decode(frame, range))
        throw new Error('expected internal decoder failure')
      } catch (error) {
        const cause = (error as Error).cause
        if (internalFailure instanceof Error) {
          expect(cause).toBe(internalFailure)
        } else {
          expect(cause).toMatchObject({ message: 'Zstandard decoder exposed a non-Error internal failure' })
        }
      }
    }
  })

  it('distinguishes incomplete frame regions from invalid complete structure', () => {
    expect(scanZstdFrames(MAGIC.subarray(0, 2))).toEqual({ frames: [], tornStart: 0 })
    expect(scanZstdFrames(MAGIC)).toEqual({ frames: [], tornStart: 0 })
    expect(() => scanZstdFrames(Buffer.alloc(4))).toThrow(/invalid frame magic/)
    expect(() => scanZstdFrames(Buffer.concat([MAGIC, Buffer.from([0x08])]))).toThrow(/reserved frame-header bit/)

    // Non-single-segment descriptor with no window descriptor.
    expect(scanZstdFrames(Buffer.concat([MAGIC, Buffer.from([0x00])]))).toEqual({ frames: [], tornStart: 0 })
    // Single-segment header followed by only two bytes of the three-byte block header.
    expect(scanZstdFrames(Buffer.concat([MAGIC, Buffer.from([0x20, 0x00, 0x01, 0x00])]))).toEqual({
      frames: [],
      tornStart: 0,
    })

    const rawFiveBytes = Buffer.from([(5 << 3) | 1, 0, 0])
    expect(scanZstdFrames(Buffer.concat([
      MAGIC,
      Buffer.from([0x20, 0x00]),
      rawFiveBytes,
      Buffer.from([0x01, 0x02]),
    ]))).toEqual({ frames: [], tornStart: 0 })

    const reservedBlock = Buffer.concat([
      MAGIC,
      Buffer.from([0x20, 0x00, 0x07, 0x00, 0x00]),
    ])
    expect(() => scanZstdFrames(reservedBlock)).toThrow(/reserved block type/)
  })

  it('covers standard header variants, RLE blocks, multiple blocks, and checksums', () => {
    for (const descriptor of [0x00, 0x21, 0x42, 0x83, 0xE3]) {
      const frame = emptyStructuralFrame(descriptor)
      expect(scanZstdFrames(frame)).toEqual({ frames: [{ start: 0, end: frame.length }] })
    }

    const rle = Buffer.concat([
      MAGIC,
      Buffer.from([0x20, 0x01]),
      Buffer.from([(1 << 3) | (1 << 1) | 1, 0, 0]),
      Buffer.from([0x41]),
    ])
    expect(scanZstdFrames(rle)).toEqual({ frames: [{ start: 0, end: rle.length }] })

    const twoBlocks = Buffer.concat([
      MAGIC,
      Buffer.from([0x20, 0x00]),
      Buffer.from([0, 0, 0]),
      Buffer.from([1, 0, 0]),
    ])
    expect(scanZstdFrames(twoBlocks)).toEqual({ frames: [{ start: 0, end: twoBlocks.length }] })

    const checksummed = emptyStructuralFrame(0x24)
    expect(scanZstdFrames(checksummed.subarray(0, -1))).toEqual({ frames: [], tornStart: 0 })
    expect(scanZstdFrames(checksummed)).toEqual({ frames: [{ start: 0, end: checksummed.length }] })
  })
})

describe('JsonlSessionPersistence: default Zstandard encoding', () => {
  it('materializes an explicitly durable empty session as one header frame', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const m = meta('empty-zstd', '/work')
    const handle = await ctx.sessionPersistence.create(m)
    await handle.flush()
    await handle.close()

    const buffer = await readFile(logPath(root, '/work', m.id, 'zstd'))
    expect(scanZstdFrames(buffer).frames).toHaveLength(1)
    expect((await decodeCompleteFrames(buffer)).toString()).toBe(`${JSON.stringify(toHeaderLine(m))}\n`)
    await expect(readAll(ctx.sessionPersistence, m.id)).resolves.toMatchObject({ events: [] })
  })

  it('writes .jsonl.zstd by default with one header frame and one first-batch frame', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('default-zstd', '/work')
    await writeLog(ctx.sessionPersistence, header, oneTurnLog())

    const path = logPath(root, header.cwd, header.id, 'zstd')
    const buffer = await readFile(path)
    expect(buffer.subarray(0, 4)).toEqual(MAGIC)
    await expect(stat(logPath(root, header.cwd, header.id, 'none'))).rejects.toThrow()

    const scan = scanZstdFrames(buffer)
    expect(scan.frames).toHaveLength(2)
    const plaintext = await decodeCompleteFrames(buffer)
    expect(plaintext.toString()).toBe([
      JSON.stringify(toHeaderLine(header)),
      ...oneTurnLog().map(e => JSON.stringify(e)),
      '',
    ].join('\n'))
    expect((await readAll(ctx.sessionPersistence, header.id)).events).toEqual(oneTurnLog())
  })

  it('serves a migrated compressed v0 read without publishing a successor', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('zstd-v0-read', '/work')
    const sourcePath = generationLogPath(root, header.cwd, header.id, 0, 'zstd')
    const currentPath = logPath(root, header.cwd, header.id, 'zstd')
    const [turn, user, step, ...tail] = releasedV1OneTurnLog()
    // Synthetic historical input opens its step before any surface so V3 can reserve the system head.
    const historical = [turn!, step!, user!, ...tail].map((event, seq) => ({
      ...event, seq: SessionSeq(seq), time: seq < 3 ? seq + 1 : event.time,
    }))
    const source = Buffer.concat([
      await compressZstdFrame(`${JSON.stringify(releasedV0Header(header))}\n`),
      await compressZstdFrame(`${historical.map(event => JSON.stringify(event)).join('\n')}\n`),
    ])
    await mkdir(sessionDir(root, header.cwd, header.id), { recursive: true })
    await writeFile(sourcePath, source)

    await expect(readAll(ctx.sessionPersistence, header.id)).resolves.toEqual({
      meta: { ...header, delegationDepth: 0 },
      events: [
        historical[0],
        historical[1],
        {
          type: 'system/message', seq: 2, time: 2, surfaceOp: 'append',
          data: {
            turn: 1, step: 1,
            message: {
              id: 'v2-to-v3-system-fc06c3f7720f3bc94ea7a2b7fadde6a5b100c6ab6ca342d2222bd017184a0b67',
              role: 'system', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, content: [],
            },
          },
        },
        { ...historical[2], seq: 3 },
        ...oneTurnLog().slice(3).map(event => ({ ...event, seq: event.seq + 1 })),
      ],
    })
    expect(await readFile(sourcePath)).toEqual(source)
    await expect(readFile(currentPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })


  it('a read rejects a present zstd artifact that carries no frame', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('raw-zero-frame', '/work')
    await writeLog(ctx.sessionPersistence, header, oneTurnLog())
    // The path still exists, so zero frames is corruption rather than absence.
    await writeFile(logPath(root, '/work', header.id, 'zstd'), Buffer.alloc(0))
    await expect(readAll(ctx.sessionPersistence, header.id)).rejects.toThrow()
  })

  it('resolves the default when a programmatic wrapper bypasses Loader schema normalization', async () => {
    const root = await freshRoot()
    const ctx = new Context()
    contexts.push(ctx)
    let backend!: JsonlSessionPersistence
    await ctx.plugin((inner: Context) => {
      backend = new JsonlSessionPersistence(inner, { root })
    })
    const header = meta('direct-default')
    const path = logPath(root, header.cwd, header.id, 'zstd')

    const events = oneTurnLog()
    await writeLog(backend, header, events)

    const plaintext = (await decodeCompleteFrames(await readFile(path))).toString()
    const recordTypes = plaintext.trimEnd().split('\n')
      .map(line => (JSON.parse(line) as { type: string }).type)
    expect(recordTypes).not.toContain('text-chunks')
    const assistant = plaintext.trimEnd().split('\n')
      .map(line => JSON.parse(line) as { type: string; data?: { stream?: Array<{ type: string }> } })
      .find(record => record.type === 'assistant/message')
    expect(assistant?.data?.stream?.some(record => record.type === 'text-chunks')).toBe(true)
    expect((await readAll(backend, header.id)).events).toEqual(events)
  })

  it('appends one frame per durable batch without rewriting prior bytes', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('append-frame')
    const handle = await ctx.sessionPersistence.create(header)
    await handle.append(oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')
    const before = await readFile(path)
    const secondTurn: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(6), time: 7, data: { turn: 2 } },
      { type: 'turn/end', seq: SessionSeq(7), time: 8, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    await handle.append(secondTurn)
    await handle.close()

    const after = await readFile(path)
    expect(after.subarray(0, before.length)).toEqual(before)
    expect(scanZstdFrames(after).frames).toHaveLength(3)
    expect((await readAll(ctx.sessionPersistence, header.id)).events).toEqual([...oneTurnLog(), ...secondTurn])
  })

  it('lists from a multi-chunk header frame without decoding a corrupt event frame', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('large-header', `/work/${'x'.repeat(24_000)}`)
    await writeLog(ctx.sessionPersistence, header, oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')
    const buffer = Buffer.from(await readFile(path))
    const eventFrame = scanZstdFrames(buffer).frames[1]!
    buffer[eventFrame.end - 1] = buffer[eventFrame.end - 1]! ^ 0xFF
    await writeFile(path, buffer)

    expect((await ctx.sessionPersistence.list()).map(item => item.header.id)).toEqual([header.id])
    await expect(readAll(ctx.sessionPersistence, header.id)).rejects.toThrow(/frame at byte .* failed validation/)
  })

  it('stops multi-frame inspection when cancellation arrives at a slice deadline', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('cancel-zstd-frames')
    const headerFrame = await compressZstdFrame(`${JSON.stringify(toHeaderLine(header))}\n`)
    const eventFrame = await compressZstdFrame(`${JSON.stringify(oneTurnLog()[0])}\n`)
    const laterFrame = await compressZstdFrame(`${JSON.stringify(oneTurnLog()[1])}\n`)
    const stream = Buffer.concat([headerFrame, eventFrame, laterFrame])
    const controller = new AbortController()
    const reason = new Error('cancel after Zstandard decode starts')
    const reader = ctx.sessionPersistence as unknown as ZstdReaderInternals
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(501)
    const pending = reader.readZstdPrefix(stream, controller.signal)
    queueMicrotask(() => { controller.abort(reason) })

    await expect(pending).rejects.toBe(reason)
  })

  it('continues decoding every frame after a slice deadline yields', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('yield-zstd-frames')
    const events = oneTurnLog().slice(0, 2)
    const headerFrame = await compressZstdFrame(`${JSON.stringify(toHeaderLine(header))}\n`)
    const eventFrames = await Promise.all(events.map(async event => (
      compressZstdFrame(`${JSON.stringify(event)}\n`)
    )))
    const stream = Buffer.concat([headerFrame, ...eventFrames])
    const reader = ctx.sessionPersistence as unknown as ZstdReaderInternals
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(501)

    const prefix = await reader.readZstdPrefix(stream)

    expect(prefix.events).toEqual(events)
  })

  it.each(['none', 'zstd'] as const)(
    'observes cancellation after each async %s header read during listing',
    async (compression) => {
      const root = await freshRoot()
      const ctx = await mount(root, compression)
      const header = meta(`cancel-${compression}-header-read`, '/work')
      await writeLog(ctx.sessionPersistence, header, oneTurnLog())
      await ctx.sessionPersistence.list()
      const path = logPath(root, header.cwd, header.id, compression)
      const probe = await open(path, 'r')
      const prototype = Object.getPrototypeOf(probe) as { read: HeaderRead }
      const originalRead = prototype.read
      await probe.close()
      const controller = new AbortController()
      const reason = new Error(`cancel ${compression} header read`)
      const read = vi.spyOn(prototype, 'read').mockImplementation(async function (
        this: FileHandle,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null,
      ) {
        const result = await originalRead.call(this, buffer, offset, length, position)
        controller.abort(reason)
        return result
      })

      await expect(ctx.sessionPersistence.list({ signal: controller.signal })).rejects.toBe(reason)
      expect(read).toHaveBeenCalledTimes(1)
    },
  )

  it('recovers complete records from a torn final frame and rewrites them on the next append', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('recover-torn', '/proj')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await writeLog(ctx.sessionPersistence, header, oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')
    const committed = await readFile(path)
    const openTurn: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(6), time: 7, data: { turn: 2 } },
      { type: 'step/start', seq: SessionSeq(7), time: 8, data: { turn: 2, step: 1 } },
      {
        type: 'assistant/attempt',
        seq: SessionSeq(8),
        time: 9,
        data: {
          turn: 2,
          step: 1,
          stream: [{ type: 'text-chunks', time0: 9, index: 0, dt: [], texts: [deterministicNoise(300_000)] }],
        },
      },
    ]
    const plaintext = openTurn.map(e => JSON.stringify(e)).join('\n') + '\n'
    await appendFile(path, await tornFrame(plaintext, (decoded) => {
      const newlines = decoded.match(/\n/g)?.length ?? 0
      return newlines >= 2 && !decoded.endsWith('\n')
    }))

    // Complete JSONL records already flushed into the torn frame are real
    // emitted events: reads recover them, while the half-written chunk stays
    // invisible and the file keeps its bytes until the write path repairs it.
    const loaded = await readAll(ctx.sessionPersistence, header.id)
    expect(loaded.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(loaded.events[6]).toEqual(openTurn[0])
    expect(loaded.events[7]).toEqual(openTurn[1])

    // The first append truncates the torn bytes and rewrites the recovered
    // records durably before the new batch, continuing at their next-seq.
    const closers: SessionEvent[] = [
      { type: 'step/end', seq: SessionSeq(8), time: 10, data: { turn: 2, step: 1 } },
      { type: 'turn/end', seq: SessionSeq(9), time: 11, data: { turn: 2, reason: { kind: 'interrupted' } } },
    ]
    await appendBatch(ctx.sessionPersistence, header.id, closers)
    expect(warn).toHaveBeenCalledWith('session-persistence-jsonl: session "recover-torn" recovered from a torn tail; incomplete tail bytes were discarded')

    const repaired = await readFile(path)
    expect(repaired.subarray(0, committed.length)).toEqual(committed)
    expect(scanZstdFrames(repaired).tornStart).toBeUndefined()
    expect(scanLog(await decodeCompleteFrames(repaired)).events)
      .toEqual([...oneTurnLog(), openTurn[0]!, openTurn[1]!, ...closers])
  })

  it('retries the torn-tail rewrite when its first durable write fails', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('retry-torn-rewrite', '/proj')
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await writeLog(ctx.sessionPersistence, header, oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')
    const recovered: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(6), time: 7, data: { turn: 2 } },
      { type: 'step/start', seq: SessionSeq(7), time: 8, data: { turn: 2, step: 1 } },
      {
        type: 'assistant/attempt',
        seq: SessionSeq(8),
        time: 9,
        data: {
          turn: 2,
          step: 1,
          stream: [{ type: 'text-chunks', time0: 9, index: 0, dt: [], texts: [deterministicNoise(300_000)] }],
        },
      },
    ]
    await appendFile(path, await tornFrame(recovered.map(e => JSON.stringify(e)).join('\n') + '\n', (decoded) => {
      const newlines = decoded.match(/\n/g)?.length ?? 0
      return newlines >= 2 && !decoded.endsWith('\n')
    }))

    const handle = await ctx.sessionPersistence.open(header.id, 'write')
    try {
      const failure = new Error('rewrite refused')
      const service = ctx.sessionPersistence as unknown as { persistBatch: () => Promise<void> }
      vi.spyOn(service, 'persistBatch').mockRejectedValueOnce(failure)
      const closers: SessionEvent[] = [
        { type: 'step/end', seq: SessionSeq(8), time: 10, data: { turn: 2, step: 1 } },
        { type: 'turn/end', seq: SessionSeq(9), time: 11, data: { turn: 2, reason: { kind: 'interrupted' } } },
      ]
      // The rewrite of the recovered records fails first; the retained repair
      // state makes the retried append rewrite them exactly once.
      await expect(handle.append(closers)).rejects.toBe(failure)
      await handle.append(closers)
    } finally {
      await handle.close()
    }

    const repaired = await readFile(path)
    expect(scanZstdFrames(repaired).tornStart).toBeUndefined()
    expect(scanLog(await decodeCompleteFrames(repaired)).events.map(e => e.seq))
      .toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('a crash inside the torn-tail repair cannot drop the records a read served', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('repair-crash-window', '/proj')
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await writeLog(ctx.sessionPersistence, header, oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')
    const committed = await readFile(path)
    const recovered = await appendTornSecondTurnStart(path)

    // A read handle serves the complete records the torn frame already carried.
    const served = await readAll(ctx.sessionPersistence, header.id)
    expect(served.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(served.events.slice(6)).toEqual(recovered)

    // The process dies with the repair unfinished: the durable step that owns
    // it rejects, and the handle is abandoned without another flush.
    await appendAfterCrash(ctx, header.id, secondTurnClosers(), new Error('simulated crash inside the torn-tail repair'))

    // Reopening serves every event the earlier read served. A repair split into
    // a truncation and a rewrite has already destroyed them here; one durable
    // replacement only ever publishes both parts together.
    const reopened = await mount(root)
    const reloaded = await readAll(reopened.sessionPersistence, header.id)
    expect(reloaded.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(reloaded.events.slice(6)).toEqual(recovered)
    expect((await readFile(path)).subarray(0, committed.length)).toEqual(committed)
  })

  it('a writer reopened after that crash completes the repair exactly once', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('repair-crash-continue', '/proj')
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await writeLog(ctx.sessionPersistence, header, oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')
    const committed = await readFile(path)
    const recovered = await appendTornSecondTurnStart(path)
    await appendAfterCrash(ctx, header.id, secondTurnClosers(), new Error('simulated crash inside the torn-tail repair'))

    const reopened = await mount(root)
    await appendBatch(reopened.sessionPersistence, header.id, secondTurnClosers())

    // One frame for the recovered records and one for the batch, after the
    // committed prefix byte for byte: the artifact the truncate-then-append
    // protocol produced, with each event stored exactly once.
    const repaired = await readFile(path)
    expect(repaired).toEqual(Buffer.concat([
      committed,
      await encodedBatch(recovered),
      await encodedBatch(secondTurnClosers()),
    ]))
    expect(scanLog(await decodeCompleteFrames(repaired)).events)
      .toEqual([...oneTurnLog(), ...recovered, ...secondTurnClosers()])
  })

  it('keeps the torn artifact and no replacement residue when the replacement never publishes', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('repair-unpublished', '/proj')
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await writeLog(ctx.sessionPersistence, header, oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')
    await appendTornSecondTurnStart(path)
    const withTornTail = await readFile(path)

    const handle = await ctx.sessionPersistence.open(header.id, 'write')
    try {
      const probe = await open(path, 'r')
      const prototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> }
      await probe.close()
      const realSync = prototype.sync
      let failed = false
      const spy = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: unknown) {
        if (!failed) { failed = true; throw new Error('simulated replacement fsync failure') }
        return realSync.call(this)
      })
      await expect(handle.append(secondTurnClosers())).rejects.toThrow(/simulated replacement fsync failure/)
      spy.mockRestore()

      // Nothing published: the torn artifact keeps its bytes and the synced
      // replacement that was never renamed is gone, so a retry starts from the
      // state this attempt found.
      expect(await readFile(path)).toEqual(withTornTail)
      expect(await readdir(dirname(path))).not.toContain(basename(repairReplacementPath(path)))
    } finally {
      await handle.close()
    }
  })

  it('keeps a published replacement when its directory entry cannot be synced', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('repair-dir-sync', '/proj')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await writeLog(ctx.sessionPersistence, header, oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')
    const committed = await readFile(path)
    const recovered = await appendTornSecondTurnStart(path)

    const handle = await ctx.sessionPersistence.open(header.id, 'write')
    try {
      const probe = await open(path, 'r')
      const prototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> }
      await probe.close()
      const realSync = prototype.sync
      let syncs = 0
      const spy = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: unknown) {
        syncs += 1
        // The replacement file syncs first, the directory that publishes it by
        // rename syncs second.
        if (syncs === 2) throw new Error('simulated directory fsync failure')
        return realSync.call(this)
      })
      await handle.append(secondTurnClosers())
      spy.mockRestore()
    } finally {
      await handle.close()
    }

    // The rename already published the replacement, so an unconfirmed directory
    // entry is reported instead of rejected: a rejected repair is retried, and
    // re-encoding it would store the recovered records and the batch twice.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('directory entry could not be synced'))
    expect(await readFile(path)).toEqual(Buffer.concat([
      committed,
      await encodedBatch(recovered),
      await encodedBatch(secondTurnClosers()),
    ]))
  })

  it('clears a replacement residue and repairs a torn frame that recovered no record', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('repair-residue', '/proj')
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await writeLog(ctx.sessionPersistence, header, oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')
    const committed = await readFile(path)
    // A frame torn before it produced plaintext recovers no record, and the
    // residue is what a crash inside an earlier replacement left behind.
    await appendFile(path, MAGIC.subarray(0, 2))
    const residue = repairReplacementPath(path)
    await writeFile(residue, 'abandoned replacement')

    // Discovery selects generations by filename, so listing sees one session.
    expect((await ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id)).toEqual([header.id])

    // The write open holds the session's lock and clears the residue before any
    // append publishes from that path.
    const handle = await ctx.sessionPersistence.open(header.id, 'write')
    try {
      expect(await readdir(dirname(path))).not.toContain(basename(residue))
      await handle.append(secondTurn())
    } finally {
      await handle.close()
    }

    const repaired = await readFile(path)
    expect(repaired).toEqual(Buffer.concat([committed, await encodedBatch(secondTurn())]))
    expect(scanLog(await decodeCompleteFrames(repaired)).events.map(event => event.seq))
      .toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('drops a frame torn in its header before it has produced plaintext', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('partial-magic')
    await writeLog(ctx.sessionPersistence, header, oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')
    const committed = await readFile(path)
    await appendFile(path, MAGIC.subarray(0, 2))

    expect((await readAll(ctx.sessionPersistence, header.id)).events).toEqual(oneTurnLog())
    // Reads never repair: the torn bytes stay until a write-path append.
    expect(await readFile(path)).toEqual(Buffer.concat([committed, MAGIC.subarray(0, 2)]))
  })

  it('recovers a final frame torn at its checksum byte in full', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('partial-checksum')
    await writeLog(ctx.sessionPersistence, header, oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')
    const committed = await readFile(path)
    const secondTurn: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(6), time: 7, data: { turn: 2 } },
      { type: 'turn/end', seq: SessionSeq(7), time: 8, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    const frame = await compressZstdFrame(secondTurn.map(e => JSON.stringify(e)).join('\n') + '\n')
    await appendFile(path, frame.subarray(0, -1))

    // One missing checksum byte leaves the frame structurally torn, but its
    // complete records decode in full: reads recover them, and the next
    // append rewrites them as a complete checksummed frame.
    const loaded = await readAll(ctx.sessionPersistence, header.id)
    expect(loaded.events).toEqual([...oneTurnLog(), ...secondTurn])
    const thirdTurn: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(8), time: 9, data: { turn: 3 } },
      { type: 'turn/end', seq: SessionSeq(9), time: 10, data: { turn: 3, reason: { kind: 'completed' } } },
    ]
    await appendBatch(ctx.sessionPersistence, header.id, thirdTurn)
    const repaired = await readFile(path)
    expect(repaired.subarray(0, committed.length)).toEqual(committed)
    expect(scanZstdFrames(repaired).tornStart).toBeUndefined()
    expect(scanLog(await decodeCompleteFrames(repaired)).events).toEqual([...oneTurnLog(), ...secondTurn, ...thirdTurn])
  })

  it('rejects a complete frame containing a torn JSONL record', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('complete-bad-jsonl')
    await writeLog(ctx.sessionPersistence, header, oneTurnLog())
    await appendFile(
      logPath(root, header.cwd, header.id, 'zstd'),
      await compressZstdFrame('{"type":"turn/start"'),
    )
    await expect(readAll(ctx.sessionPersistence, header.id)).rejects.toThrow(/complete frame contains a torn JSONL record/)
  })

  it('rolls back a checksummed append frame when fsync fails', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    const header = meta('zstd-fsync-rollback')
    const handle = await ctx.sessionPersistence.create(header)
    await handle.append(oneTurnLog())
    const path = logPath(root, header.cwd, header.id, 'zstd')
    const before = await readFile(path)

    const probe = await open(path, 'r')
    const prototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> }
    await probe.close()
    const realSync = prototype.sync
    let failed = false
    const spy = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
      if (!failed) {
        failed = true
        throw new Error('simulated Zstandard fsync failure')
      }
      return realSync.call(this)
    })
    const secondTurn: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(6), time: 7, data: { turn: 2 } },
      { type: 'turn/end', seq: SessionSeq(7), time: 8, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    await expect(handle.append(secondTurn)).rejects.toThrow(/simulated Zstandard fsync failure/)
    expect(await readFile(path)).toEqual(before)
    spy.mockRestore()
    await handle.append(secondTurn)
    await handle.close()
    expect((await readAll(ctx.sessionPersistence, header.id)).events).toEqual([...oneTurnLog(), ...secondTurn])
  })

  it('skips empty, incomplete, and non-header compressed artifacts while rejecting malformed header frames', async () => {
    const root = await freshRoot()
    for (const [id, content] of [
      ['empty', Buffer.alloc(0)],
      ['partial', MAGIC],
      ['not-header', await compressZstdFrame('{"type":"turn/start"}\n')],
    ] as const) {
      const sessionId = SessionId(id)
      await mkdir(sessionDir(root, undefined, sessionId), { recursive: true })
      await writeFile(logPath(root, undefined, sessionId, 'zstd'), content)
    }
    const ctx = await mount(root)
    expect(await ctx.sessionPersistence.list()).toEqual([])

    const twoLinesId = SessionId('two-lines')
    await mkdir(sessionDir(root, undefined, twoLinesId), { recursive: true })
    await writeFile(logPath(root, undefined, twoLinesId, 'zstd'), await compressZstdFrame([
      JSON.stringify(toHeaderLine(meta('two-lines'))),
      JSON.stringify({ type: 'turn/start' }),
      '',
    ].join('\n')))
    await expect(ctx.sessionPersistence.list()).rejects.toThrow(/first frame is not exactly one header line/)
    await expect(ctx.sessionPersistence.open(twoLinesId, 'read'))
      .rejects.toThrow(/first frame is not exactly one header line/)
  })

  it('rejects missing, empty, and checksum-corrupt header frames on targeted reads', async () => {
    const root = await freshRoot()
    for (const id of ['partial-only', 'empty-header', 'bad-checksum']) {
      await mkdir(sessionDir(root, undefined, SessionId(id)), { recursive: true })
    }
    await writeFile(logPath(root, undefined, SessionId('partial-only'), 'zstd'), MAGIC)
    await writeFile(logPath(root, undefined, SessionId('empty-header'), 'zstd'), await compressZstdFrame(''))
    const corruptHeader = Buffer.from(await compressZstdFrame(`${JSON.stringify(toHeaderLine(meta('bad-checksum')))}\n`))
    corruptHeader[corruptHeader.length - 1] = corruptHeader[corruptHeader.length - 1]! ^ 0xFF
    await writeFile(logPath(root, undefined, SessionId('bad-checksum'), 'zstd'), corruptHeader)
    const ctx = await mount(root)

    await expect(ctx.sessionPersistence.open(SessionId('partial-only'), 'read'))
      .rejects.toThrow(/empty or header-less Zstandard session log/)
    await expect(ctx.sessionPersistence.open(SessionId('empty-header'), 'read'))
      .rejects.toThrow(/first frame is not exactly one header line/)
    await expect(ctx.sessionPersistence.list()).rejects.toThrow(/header frame failed validation/)
  })
})

describe('JsonlSessionPersistence: encoding selection', () => {
  it('rejects roots owned by the opposite encoding in both directions', async () => {
    const rawRoot = await freshRoot('dsh-jsonl-raw-mismatch-')
    const raw = await mount(rawRoot, 'none')
    await writeLog(raw.sessionPersistence, meta('raw-log'), oneTurnLog())
    const defaultBackend = await mount(rawRoot)
    await expect(defaultBackend.sessionPersistence.list()).rejects.toThrow(/configured for compression "zstd"/)

    const zstdRoot = await freshRoot('dsh-jsonl-zstd-mismatch-')
    const zstd = await mount(zstdRoot)
    await writeLog(zstd.sessionPersistence, meta('zstd-log'), oneTurnLog())
    const rawBackend = await mount(zstdRoot, 'none')
    await expect(rawBackend.sessionPersistence.list()).rejects.toThrow(/configured for compression "none"/)
  })

  it('rechecks targeted artifacts and listing after an initially empty root', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    expect(await ctx.sessionPersistence.list()).toEqual([])

    const loadHeader = meta('late-raw-load', '/late')
    await mkdir(sessionDir(root, loadHeader.cwd, loadHeader.id), { recursive: true })
    await writeFile(logPath(root, loadHeader.cwd, loadHeader.id, 'none'), [
      JSON.stringify(toHeaderLine(loadHeader)),
      ...oneTurnLog().map(e => JSON.stringify(e)),
      '',
    ].join('\n'))
    await expect(ctx.sessionPersistence.open(loadHeader.id, 'read')).rejects.toThrow(/uses \.jsonl/)
    await expect(ctx.sessionPersistence.open(loadHeader.id, 'write')).rejects.toThrow(/uses \.jsonl/)
    await expect(ctx.sessionPersistence.list()).rejects.toThrow(/uses \.jsonl/)
  })

  it('refuses materialization when an opposite artifact appears after create', async () => {
    const root = await freshRoot()
    const ctx = await mount(root)
    await ctx.sessionPersistence.list()
    const header = meta('late-raw-materialize', '/late')
    const handle = await ctx.sessionPersistence.create(header)
    await mkdir(sessionDir(root, header.cwd, header.id), { recursive: true })
    await writeFile(logPath(root, header.cwd, header.id, 'none'), [
      JSON.stringify(toHeaderLine(header)),
      ...oneTurnLog().map(e => JSON.stringify(e)),
      '',
    ].join('\n'))
    await expect(handle.append(oneTurnLog())).rejects.toThrow(/uses \.jsonl/)
    await handle.close()
    expect((await readdir(sessionDir(root, header.cwd, header.id))).some(name => name.endsWith('.jsonl.zstd'))).toBe(false)
  })
})
