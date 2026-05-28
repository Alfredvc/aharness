/**
 * Run identity — `@aharness/core` §4.2.
 *
 * Two helpers:
 *   - `deriveRunId(filePath)` — pure name builder for each foreground run.
 *   - `ensureRunDir(runId, repoRoot)` — creates `<repoRoot>/.aharness/runs/<runId>/`
 *      and its `artifacts/` subdir, returns a populated `RunDir`.
 *
 * runId shape: `<fsmHash6>-<rand6>` (13 chars). The fsm prefix is a
 * 6-hex sha256 of the FSM-file basename rather than the basename itself,
 * so run directories stay compact regardless of FSM filename length.
 * Submit routing uses a single `aharness_submit` dynamic tool whose payload
 * carries `{state, exit, data}`; the runId is filesystem identity only. The
 * rand6 suffix is `crypto.randomBytes(3).toString('hex')`: 24 bits, ~16M
 * values; birthday collisions are negligible at expected concurrency.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type { RunDir } from './types.js';

const FSM_SUFFIX = '.fsm.ts';
const RUNS_SUBDIR = '.aharness/runs';
const FSM_HASH_LEN = 6;
const RAND_SUFFIX_BYTES = 3;

/**
 * Strip the `.fsm.ts` suffix off a path's basename. The suffix is part of
 * the FSM-file convention; if the user names their file something else
 * we still take the basename, just without the suffix peeling.
 */
function fsmFileBaseName(filePath: string): string {
  const base = basename(filePath);
  return base.endsWith(FSM_SUFFIX) ? base.slice(0, -FSM_SUFFIX.length) : base;
}

/**
 * 6-hex sha256 of the FSM-file basename. Used as the runId's FSM-side
 * discriminator so two concurrent runs of different FSM files in the
 * same repo don't collide. 24 bits → ~16M values; collisions within
 * one repo are not a real concern.
 */
export function fsmHash6(fsmFilePath: string): string {
  const base = fsmFileBaseName(fsmFilePath);
  return createHash('sha256').update(base).digest('hex').slice(0, FSM_HASH_LEN);
}

/**
 * Build a fresh runId of shape `<fsmHash6>-<rand6>` (13 chars). The rand6
 * suffix is `crypto.randomBytes(3).toString('hex')` — ~16M values; birthday
 * collisions are negligible at expected concurrency.
 */
export function deriveRunId(fsmFilePath: string): string {
  return `${fsmHash6(fsmFilePath)}-${randomBytes(RAND_SUFFIX_BYTES).toString('hex')}`;
}

/**
 * Create `<repoRoot>/.aharness/runs/<runId>/{,artifacts/}` and return a
 * populated `RunDir`. Idempotent — re-creating an existing run dir
 * returns the same shape without erroring.
 */
export function ensureRunDir(runId: string, repoRoot: string): RunDir {
  const root = resolve(repoRoot, RUNS_SUBDIR, runId);
  const artifactsDir = join(root, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  return {
    runId,
    root,
    snapshotPath: join(root, 'snapshot.json'),
    eventsPath: join(root, 'events.jsonl'),
    artifactsDir,
  };
}
