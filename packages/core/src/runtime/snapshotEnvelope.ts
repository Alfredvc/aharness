/**
 * Headless snapshot envelope reader/writer. Spec §4.4, §5.8.
 *
 * Schema: {
 *   xstate,
 *   harnessSubmitToolName: "harness_submit",
 *   threadId
 * }
 *
 * Cutover-detection:
 *   - File missing ⇒ {kind: 'absent'} (fresh boot path; caller decides).
 *   - File present, harnessSubmitToolName absent ⇒ legacy MCP-era;
 *     {kind: 'incompatible', reason}. Caller exits 2.
 *   - File present, harnessSubmitToolName !== 'harness_submit' ⇒ incompatible.
 *   - Otherwise ⇒ {kind: 'ok', envelope}.
 *
 * Fresh-clear runtime state is intentionally not persisted: each CLI
 * invocation is a foreground-only run, and thread replacement is live-only.
 */
import { existsSync, readFileSync } from 'node:fs';

import { flushSnapshot } from './snapshotFlush.js';

const HARNESS_SUBMIT_TOOL_NAME = 'harness_submit' as const;

function describeEnvelopeField(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export interface Phase1Envelope {
  readonly xstate: unknown;
  readonly harnessSubmitToolName: typeof HARNESS_SUBMIT_TOOL_NAME;
  readonly threadId: string;
}

export interface HeadlessSnapshotEnvelope {
  readonly xstate: unknown;
  readonly harnessSubmitToolName: typeof HARNESS_SUBMIT_TOOL_NAME;
  readonly threadId: string;
}

export type CutoverDetectionResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly envelope: HeadlessSnapshotEnvelope }
  | { readonly kind: 'incompatible'; readonly reason: string };

export function loadHeadlessSnapshotEnvelope(path: string): CutoverDetectionResult {
  if (!existsSync(path)) return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return {
      kind: 'incompatible',
      reason: `snapshot.json is not valid JSON: ${(e as Error).message}`,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'incompatible', reason: 'snapshot.json is not an object envelope' };
  }
  const env = parsed as {
    harnessSubmitToolName?: unknown;
    threadId?: unknown;
    xstate?: unknown;
  };
  if (env.harnessSubmitToolName === undefined) {
    return {
      kind: 'incompatible',
      reason:
        'snapshot from incompatible build (harnessSubmitToolName=MISSING); terminate run cleanly before upgrading',
    };
  }
  if (env.harnessSubmitToolName !== HARNESS_SUBMIT_TOOL_NAME) {
    return {
      kind: 'incompatible',
      reason: `snapshot from incompatible build (harnessSubmitToolName=${describeEnvelopeField(
        env.harnessSubmitToolName,
      )}); terminate run cleanly before upgrading`,
    };
  }
  if (typeof env.threadId !== 'string') {
    return { kind: 'incompatible', reason: 'snapshot envelope missing threadId' };
  }
  return {
    kind: 'ok',
    envelope: {
      xstate: env.xstate,
      harnessSubmitToolName: HARNESS_SUBMIT_TOOL_NAME,
      threadId: env.threadId,
    },
  };
}

export function flushHeadlessSnapshotEnvelope(path: string, env: HeadlessSnapshotEnvelope): void {
  flushSnapshot(path, {
    xstate: env.xstate,
    harnessSubmitToolName: env.harnessSubmitToolName,
    threadId: env.threadId,
  });
}

/** @deprecated Use loadHeadlessSnapshotEnvelope. */
export function loadPhase1Envelope(path: string): CutoverDetectionResult {
  return loadHeadlessSnapshotEnvelope(path);
}

/** @deprecated Use flushHeadlessSnapshotEnvelope. */
export function flushPhase1Envelope(path: string, env: Phase1Envelope): void {
  flushHeadlessSnapshotEnvelope(path, env);
}
