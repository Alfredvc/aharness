/**
 * Atomic artifact writes — `@aharness/core` §4.8.
 *
 * `writeArtifact(runDir, relPath, content)` writes content to
 * `<runDir>/artifacts/<relPath>` atomically:
 *   1. Resolves the absolute target and verifies it stays under
 *      `<runDir>/artifacts/` (path-traversal guard).
 *   2. Ensures the parent directory exists (`mkdir -p`).
 *   3. Writes to a sibling temp file `<basename>.<rand>.tmp`.
 *   4. fsyncs the temp file to durable storage.
 *   5. `rename()`s the temp file over the final path (POSIX atomic).
 *
 * It also appends one entry to `<runDir>/events.jsonl` recording the
 * write — see `events.ts` for that surface; this module does the
 * append directly because `writeArtifact` is the only caller of the
 * `artifact` event kind.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { appendEventEntry } from './events.js';
import { getCurrentStateEnterTs, getTraceEmitter, incrementEventCount } from './trace.js';
import type { RunDir } from './types.js';

/**
 * Write `content` to `<runDir>/artifacts/<relPath>` atomically and
 * append one `artifact` entry to the run's event log.
 *
 * Returns `{ absolutePath }` so the caller can refer to the final
 * location (e.g. for prompt injection).
 *
 * Throws if `relPath` is absolute or escapes the artifacts dir.
 *
 * Crash window — best-effort durability. The file rename and the
 * `events.jsonl` append are not in a single atomic step. A process
 * kill (SIGKILL or hard crash) between `rename` and `appendEventEntry`
 * leaves the artifact on disk but unrecorded in the audit log. State
 * recovery is from `snapshot.json`, not from `events.jsonl`, so this
 * does not corrupt FSM advancement; if a user FSM needs strict
 * artifact↔log consistency, that is the user FSM's responsibility.
 */
export async function writeArtifact(
  runDir: RunDir,
  relPath: string,
  content: string | Uint8Array,
): Promise<{ absolutePath: string }> {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new TypeError('writeArtifact: relPath must be a non-empty string');
  }
  if (isAbsolute(relPath)) {
    throw new Error(`writeArtifact: relPath must be relative, got '${relPath}'`);
  }

  const artifactsRoot = resolve(runDir.artifactsDir);
  const target = resolve(artifactsRoot, relPath);
  // Containment check: `target` must equal `artifactsRoot` (impossible —
  // would mean an empty relPath after resolve, which we reject above) or
  // start with `artifactsRoot + sep`. The trailing-separator guard stops
  // a sibling like `<runDir>/artifactsX/...` from passing.
  const rootWithSep = artifactsRoot.endsWith(sep) ? artifactsRoot : artifactsRoot + sep;
  if (!target.startsWith(rootWithSep)) {
    throw new Error(
      `writeArtifact: relPath '${relPath}' escapes artifacts directory '${artifactsRoot}'`,
    );
  }

  const parent = dirname(target);
  await mkdir(parent, { recursive: true });

  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  const bytes = buf.byteLength;

  // Atomic write: write-to-temp, fsync, rename, parent-dir-fsync. The
  // temp filename uses `randomBytes` so concurrent writes to the same
  // target from two processes (different runs sharing a path) cannot
  // collide on the sentinel name.
  const tmpName = `${relPath.split(/[\\/]/).pop() ?? 'artifact'}.${randomBytes(6).toString('hex')}.tmp`;
  const tmp = join(parent, tmpName);
  await writeFile(tmp, buf);
  // fsync forces the bytes to durable storage before the rename. Without
  // it a crash between `writeFile` and `rename` could leave the final
  // path pointing at a zero-length or partial file.
  const handle = await open(tmp, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Capture the trace timestamp before the rename so the marker aligns
  // with when the write was initiated — matches how a Perfetto user would
  // expect the artifact event to land relative to the action that
  // triggered it.
  const tsForTrace = Date.now() * 1000;
  await rename(tmp, target);

  // POSIX: fsync the parent directory so the rename is durable on a
  // crash. Skipped on Windows, which does not expose directory fsync
  // through Node's fs API and where `rename` already commits the
  // metadata change.
  if (process.platform !== 'win32') {
    const dh = await open(parent, 'r');
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  }

  appendEventEntry(runDir, { kind: 'artifact', relPath, bytes });

  // Trace emission. The artifact event always fires when an emitter is
  // registered; the action→artifact flow (spec §4.8 #3) is conditional
  // on having an active leaf state — at boot or post-terminal there is
  // no causal action to point back to.
  const emitter = getTraceEmitter(runDir);
  if (emitter !== undefined) {
    emitter.artifact(relPath, tsForTrace, bytes);
    incrementEventCount(runDir);
    const stateEnterTs = getCurrentStateEnterTs(runDir);
    if (stateEnterTs !== null) {
      const flowId = `flow:artifact:${randomBytes(4).toString('hex')}`;
      emitter.flow({ tid: 1, ts: stateEnterTs }, { tid: 5, ts: tsForTrace }, flowId);
    }
  }

  return { absolutePath: target };
}
