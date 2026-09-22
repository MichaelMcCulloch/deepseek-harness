# Agent Note: One durable step for the torn-tail repair

Status: implemented

English | [中文](2026-09-21-atomic-torn-tail-replacement.zh.md)

## Problem

The JSONL backend serves a torn final Zstandard frame by recovering its complete JSONL records: the frame scan reports the tail's starting byte, and the reader returns every complete record the partial frame already carried. The write handle then has to make that logical log physical, and it did so in two durable steps in `persistContiguous` (`packages/session/session-persistence-jsonl/src/storage.ts`): truncate the torn bytes and fsync, then append the recovered records.

A crash between the two steps destroyed events a read had already served. The records were in the in-memory log of the process that read them, the DAG folded them and ran effects keyed from them, and the next reopen saw only the truncated prefix — a shorter log than a completed read had observed, which the resumed writer then refused: `packages/session/session-persistence-jsonl/tests/zstd.spec.ts` reproduces a reopen serving seqs 0..5 instead of the served 0..7, and a writer that continues at seq 8 rejected with `append seq mismatch for "repair-crash-continue": expected 6 at index 0, got 8`.

The window was wider than the crash it named. `truncateTornTail` destroyed the recovered records before its own fsync resolved, so a failing fsync on the truncation also lost them, and the append path had no state left to tell the retry what to restore. The [DAG transition verification proposal](../../proposed/testing/2026-09-21-dag-transition-verification.md) recorded the defect and the two candidate designs; this note records the one that shipped.

## Decision

The repair and the batch that follows it publish as **one durable replacement of the log file**, and the rename that publishes it is the commit point.

`JsonlHandleStorage.persistBatch` takes the pending repair as an argument. With one, `JsonlSessionPersistence.replaceTornTail` (`packages/session/session-persistence-jsonl/src/index.ts`) encodes the artifact's complete prefix bytes, the complete records recovered from its torn tail, and the arriving batch with the same per-batch encoder the append path uses, writes them into a synced replacement file beside the log, renames that file over the log, and fsyncs the containing directory on POSIX. Windows publishes through `replaceFileWin32`, added to `src/win32.ts` as `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`: the replacement semantic the repair needs, with the write-through completion this package's new-file publish already relies on. `truncateTornTail`, the private `repair`, and the two-step sequence are gone; `persistContiguous` clears the repair state only after its one storage call resolves, so a rejection retries the whole repair.

### What each failure leaves behind

The replacement file is written and fsynced before anything touches the log, and the rename is atomic, so every failure before the rename leaves the torn artifact byte-identical to what the read found and leaves a retry able to re-encode the same replacement. Failures of the initial `open(..., 'wx')`, the write, or the temp fsync remove the unpublished replacement.

A directory fsync that fails **after** the rename is reported through the logger and does not reject the append. Rejecting would be worse than the unconfirmed namespace change: the caller retries the batch, the retained repair re-encodes the recovered records and that batch on top of the file that already holds them, and the log ends up with every one of those events stored twice — corruption instead of the narrower durability window. The replacement's own bytes are already fsynced, so the residual exposure is a power loss between the rename and the directory fsync, which reverts the directory entry to the torn artifact rather than losing anything.

### Which write paths carry a repair

A repair is primed in exactly one place: the write open of a session whose stored log has a torn tail. That open reads an existing artifact, so `isMaterialized` is always true whenever a repair is pending, and the repair path never materializes a session — `create` and a read open carry no repair, `persistHeader` writes no events, and a `persistBatch` without a repair takes the same append or materialize path as before and stores the same bytes. The repair branch ignores `isMaterialized` rather than branching on an unreachable combination, and a repair against a missing artifact fails at the prefix read instead of silently creating one.

### The replacement file

The replacement path is the generation log path plus `.repair.tmp` (`repairReplacementPath` in `src/format.ts`). The suffix keeps it outside `parseGenerationLogFilename`, so generation discovery, listing, and the opposite-encoding check never read it as an artifact — a crash residue is invisible to every reader. The name is fixed rather than random because the session's cross-process write lock is held for the whole repair: there can be at most one residue per generation, a later repair overwrites it, and a write open clears it immediately after taking the lock, before any append can publish from that path. Creation uses `wx`, so a residue is never followed through a symlink and no unrelated writer can be clobbered.

## Consequences

The on-disk result of a successful repair is byte-identical to what the two-step protocol produced — the same prefix bytes followed by one encoded frame per batch — which `zstd.spec.ts` asserts against the encoder's own output, including the raw-line encoding, whose torn tails recover no record and therefore encode only the batch frame. A log that never tears still takes `appendLines` unchanged.

A repair now reads the artifact's prefix instead of truncating in place, so the first write after a torn read costs one full read plus one full rewrite of a file that the read path already loads whole. Repairs are crash residue, and the alternative — overwriting the torn suffix in place — cannot survive a crash mid-write.

The declaration surface shrank: `truncateTornTail` left the provider-local storage interface and the service, and the two correlated optional handle-state fields became one `TornTailRepair` value, making a truncation point without its recovered records unrepresentable.

Coverage: `zstd.spec.ts` pins the crash window (the interrupted repair must leave the events a read served recoverable, and a reopened writer must complete the repair with each event stored exactly once), the unpublished-replacement cleanup, the published-replacement directory-fsync warning, and the residue. `win32.spec.ts` pins `replaceFileWin32`'s flags and error mapping. The pre-existing durability, torn-tail, and rewrite-retry specs pass unchanged, and the package keeps per-file 100% coverage.

## Alternatives considered

**A repair sidecar the next open re-applies.** The other design the proposal recorded: write the recovered records to a sidecar and let the next open apply it before truncating. It adds a second durable artifact whose publication needs its own atomic protocol, makes read opens participants in the repair, and leaves a state where the sidecar and the log disagree about which is authoritative. Replacing the log in one rename keeps the repair invisible to readers and leaves no second source of truth.

**Publish through `link()` plus `unlink()`, as first materialization does.** The materialization protocol deliberately cannot clobber an existing path, and the repair always replaces one — the log exists, that is why there is a torn tail. `link()` would fail with `EEXIST` exactly when the repair is needed.

**Rewrite the torn suffix in place.** Writing the new frames from the torn frame's start keeps the file's inode and needs no second file, but a crash mid-write leaves a partial frame whose leading bytes are not a frame boundary, and truncating the file first reintroduces the destructive step this decision removes.

**Stop recovering records from a torn frame, so a truncation has nothing to lose.** Serving only whole frames would make the two-step repair safe by construction, at the price of discarding events the crashed process had already emitted and flushed into the partial frame — every complete record of the tail would be dropped, and resume would see a shorter log than the completed read that preceded the crash. That regression in served history is larger than the protocol it avoids.

**Copy with `fs.copyFile`, then append.** Same bytes, one more full pass over the artifact, and no property the single temp-write-then-rename does not already provide.

**Reject the append when the post-rename directory fsync fails.** The caller would retry the batch, and the retained repair would store the recovered records and that batch a second time; an unconfirmed directory entry is the smaller exposure.

**A random replacement filename, matching `writeSyncedTempFile`.** Random names cannot be addressed for cleanup, so residues would accumulate unremoved until someone scanned session directories for them; the fixed name is safe because the repair runs under the session's write lock and the write open clears the residue first.

## Related

- [DAG transition verification](../../proposed/testing/2026-09-21-dag-transition-verification.md) records the defect this closes, its crash-injection option, and the other two transition defects.
- [Zstandard JSONL session logs](../architecture/2026-07-19-zstandard-jsonl-session-logs.md) owns the frame format and the append/rollback boundary this repair publishes through.
