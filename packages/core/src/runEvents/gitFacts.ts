import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  GitDiffRecordedRunEventAppendInput,
  GitFactUnavailableReason,
  GitSnapshotPhase,
  GitSnapshotRecordedRunEventAppendInput,
} from './types.js';

export interface GitFactExecOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeout: number;
}

export interface GitFactExecResult {
  readonly stdout: string | Buffer;
}

export type GitFactExec = (
  file: string,
  args: ReadonlyArray<string>,
  options: GitFactExecOptions,
) => Promise<GitFactExecResult>;

export type GitFactSyncExec = (
  file: string,
  args: ReadonlyArray<string>,
  options: GitFactExecOptions,
) => string | Buffer;

const DEFAULT_TIMEOUT_MS = 1_000;
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const execFilePromise = promisify(execFile);

function gitExecOptions(cwd: string, timeoutMs: number): GitFactExecOptions {
  return {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: timeoutMs,
  };
}

function normalizeOutput(output: string | Buffer): string {
  return Buffer.isBuffer(output) ? output.toString('utf8') : output;
}

function normalizeExecError(error: unknown): GitFactUnavailableReason {
  if (typeof error === 'object' && error !== null) {
    const maybeError = error as {
      readonly code?: unknown;
      readonly signal?: unknown;
      readonly killed?: unknown;
    };
    if (maybeError.code === 'ENOENT') return 'git-unavailable';
    if (maybeError.signal === 'SIGTERM' || maybeError.killed === true) return 'timeout';
  }
  return 'probe-failed';
}

function normalizeHead(value: string): string | null {
  const head = value.trim().toLowerCase();
  return OBJECT_ID_RE.test(head) ? head : null;
}

function unavailableSnapshot(
  phase: GitSnapshotPhase,
  reason: GitFactUnavailableReason,
): GitSnapshotRecordedRunEventAppendInput {
  return {
    type: 'git.snapshot.recorded',
    data: { phase, status: 'unavailable', reason },
  };
}

function unavailableDiff(reason: GitFactUnavailableReason): GitDiffRecordedRunEventAppendInput {
  return {
    type: 'git.diff.recorded',
    data: { status: 'unavailable', reason },
  };
}

async function defaultExec(
  file: string,
  args: ReadonlyArray<string>,
  options: GitFactExecOptions,
): Promise<GitFactExecResult> {
  const result = await execFilePromise(file, [...args], options);
  return { stdout: result.stdout };
}

function defaultSyncExec(
  file: string,
  args: ReadonlyArray<string>,
  options: GitFactExecOptions,
): string | Buffer {
  return execFileSync(file, [...args], options);
}

async function assertInsideWorkTree(
  cwd: string,
  exec: GitFactExec,
  timeoutMs: number,
): Promise<GitFactUnavailableReason | null> {
  try {
    const result = await exec(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      gitExecOptions(cwd, timeoutMs),
    );
    return normalizeOutput(result.stdout).trim() === 'true' ? null : 'not-a-git-repository';
  } catch (error) {
    const reason = normalizeExecError(error);
    return reason === 'probe-failed' ? 'not-a-git-repository' : reason;
  }
}

function assertInsideWorkTreeSync(
  cwd: string,
  exec: GitFactSyncExec,
  timeoutMs: number,
): GitFactUnavailableReason | null {
  try {
    const stdout = exec(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      gitExecOptions(cwd, timeoutMs),
    );
    return normalizeOutput(stdout).trim() === 'true' ? null : 'not-a-git-repository';
  } catch (error) {
    const reason = normalizeExecError(error);
    return reason === 'probe-failed' ? 'not-a-git-repository' : reason;
  }
}

function parseNumstat(stdout: string):
  | {
      readonly ok: true;
      readonly filesChanged: number;
      readonly linesAdded: number;
      readonly linesDeleted: number;
    }
  | { readonly ok: false } {
  let filesChanged = 0;
  let linesAdded = 0;
  let linesDeleted = 0;
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (rawLine.trim() === '') continue;
    const columns = rawLine.split('\t');
    if (columns.length < 3) return { ok: false };
    const added = columns[0];
    const deleted = columns[1];
    if (added === undefined || deleted === undefined) return { ok: false };
    if (added === '-' && deleted === '-') {
      filesChanged += 1;
      continue;
    }
    if (!/^\d+$/.test(added) || !/^\d+$/.test(deleted)) return { ok: false };
    filesChanged += 1;
    linesAdded += Number(added);
    linesDeleted += Number(deleted);
  }
  return { ok: true, filesChanged, linesAdded, linesDeleted };
}

function snapshotPayloadHead(snapshot: GitSnapshotRecordedRunEventAppendInput): string | null {
  return snapshot.data.status === 'available' ? snapshot.data.head : null;
}

export async function createGitSnapshotRecordedEvent(options: {
  readonly cwd: string;
  readonly phase: GitSnapshotPhase;
  readonly exec?: GitFactExec;
  readonly timeoutMs?: number;
}): Promise<GitSnapshotRecordedRunEventAppendInput> {
  const exec = options.exec ?? defaultExec;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const workTreeReason = await assertInsideWorkTree(options.cwd, exec, timeoutMs);
  if (workTreeReason !== null) return unavailableSnapshot(options.phase, workTreeReason);

  try {
    const result = await exec('git', ['rev-parse', 'HEAD'], gitExecOptions(options.cwd, timeoutMs));
    const head = normalizeHead(normalizeOutput(result.stdout));
    if (head === null) return unavailableSnapshot(options.phase, 'head-unavailable');
    return {
      type: 'git.snapshot.recorded',
      data: { phase: options.phase, status: 'available', head },
    };
  } catch (error) {
    const reason = normalizeExecError(error);
    return unavailableSnapshot(
      options.phase,
      reason === 'probe-failed' ? 'head-unavailable' : reason,
    );
  }
}

export function createGitSnapshotRecordedEventSync(options: {
  readonly cwd: string;
  readonly phase: GitSnapshotPhase;
  readonly exec?: GitFactSyncExec;
  readonly timeoutMs?: number;
}): GitSnapshotRecordedRunEventAppendInput {
  const exec = options.exec ?? defaultSyncExec;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const workTreeReason = assertInsideWorkTreeSync(options.cwd, exec, timeoutMs);
  if (workTreeReason !== null) return unavailableSnapshot(options.phase, workTreeReason);

  try {
    const stdout = exec('git', ['rev-parse', 'HEAD'], gitExecOptions(options.cwd, timeoutMs));
    const head = normalizeHead(normalizeOutput(stdout));
    if (head === null) return unavailableSnapshot(options.phase, 'head-unavailable');
    return {
      type: 'git.snapshot.recorded',
      data: { phase: options.phase, status: 'available', head },
    };
  } catch (error) {
    const reason = normalizeExecError(error);
    return unavailableSnapshot(
      options.phase,
      reason === 'probe-failed' ? 'head-unavailable' : reason,
    );
  }
}

export async function createGitDiffRecordedEvent(options: {
  readonly cwd: string;
  readonly from: GitSnapshotRecordedRunEventAppendInput;
  readonly to: GitSnapshotRecordedRunEventAppendInput;
  readonly exec?: GitFactExec;
  readonly timeoutMs?: number;
}): Promise<GitDiffRecordedRunEventAppendInput> {
  const from = snapshotPayloadHead(options.from);
  const to = snapshotPayloadHead(options.to);
  if (from === null || to === null) return unavailableDiff('object-unavailable');
  if (from === to) {
    return {
      type: 'git.diff.recorded',
      data: { status: 'available', from, to, filesChanged: 0, linesAdded: 0, linesDeleted: 0 },
    };
  }

  const exec = options.exec ?? defaultExec;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const result = await exec(
      'git',
      ['diff', '--numstat', '--find-renames', '--find-copies', from, to],
      gitExecOptions(options.cwd, timeoutMs),
    );
    const parsed = parseNumstat(normalizeOutput(result.stdout));
    if (!parsed.ok) return unavailableDiff('diff-unavailable');
    return {
      type: 'git.diff.recorded',
      data: {
        status: 'available',
        from,
        to,
        filesChanged: parsed.filesChanged,
        linesAdded: parsed.linesAdded,
        linesDeleted: parsed.linesDeleted,
      },
    };
  } catch (error) {
    const reason = normalizeExecError(error);
    return unavailableDiff(reason === 'probe-failed' ? 'object-unavailable' : reason);
  }
}

export function createGitDiffRecordedEventSync(options: {
  readonly cwd: string;
  readonly from: GitSnapshotRecordedRunEventAppendInput;
  readonly to: GitSnapshotRecordedRunEventAppendInput;
  readonly exec?: GitFactSyncExec;
  readonly timeoutMs?: number;
}): GitDiffRecordedRunEventAppendInput {
  const from = snapshotPayloadHead(options.from);
  const to = snapshotPayloadHead(options.to);
  if (from === null || to === null) return unavailableDiff('object-unavailable');
  if (from === to) {
    return {
      type: 'git.diff.recorded',
      data: { status: 'available', from, to, filesChanged: 0, linesAdded: 0, linesDeleted: 0 },
    };
  }

  const exec = options.exec ?? defaultSyncExec;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const stdout = exec(
      'git',
      ['diff', '--numstat', '--find-renames', '--find-copies', from, to],
      gitExecOptions(options.cwd, timeoutMs),
    );
    const parsed = parseNumstat(normalizeOutput(stdout));
    if (!parsed.ok) return unavailableDiff('diff-unavailable');
    return {
      type: 'git.diff.recorded',
      data: {
        status: 'available',
        from,
        to,
        filesChanged: parsed.filesChanged,
        linesAdded: parsed.linesAdded,
        linesDeleted: parsed.linesDeleted,
      },
    };
  } catch (error) {
    const reason = normalizeExecError(error);
    return unavailableDiff(reason === 'probe-failed' ? 'object-unavailable' : reason);
  }
}
