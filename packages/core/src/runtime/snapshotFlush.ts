/**
 * Atomic snapshot flush — tmp + fsync + rename.
 *
 * The single write path @aharness/core's daemon uses for `<runDir>/snapshot.json`.
 * Flat `(path, snapshot)` signature so callers that already hold a
 * concrete path don't have to thread a `RunDir`.
 *
 * Synchronous on purpose — the daemon wants the bytes durable on disk
 * before it acknowledges the operation. One `fsync` per flush.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Write `JSON.stringify(snapshot)` to `path` atomically. Steps:
 *
 *   1. `mkdir -p` the parent directory (no-op if already present).
 *   2. Write the JSON bytes to a sibling tmp file
 *      (`<path>.<rand>.tmp`).
 *   3. `fsync` the tmp file's data so a power loss after the rename
 *      cannot leave a zero-byte file.
 *   4. `rename(tmp, path)` — atomic on POSIX same-filesystem renames.
 *
 * The random suffix keeps concurrent writers from clobbering each
 * other's tmp files; @aharness/core's daemon model is one daemon per run,
 * so contention here is rare, but the pattern matches CC sdk's
 * `writeArtifact` / `writeSnapshotAtomic` for consistency.
 */
export function flushSnapshot(path: string, snapshot: unknown): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot));
  const fd = openSync(tmp, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
