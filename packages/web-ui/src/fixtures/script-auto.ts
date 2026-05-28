// Fully autonomous demo: probe → attempt (self-loops while tests fail) → done.
// No owner input, no approvals. Every scene auto-advances once its frames
// have drained. The `attempt` state is visited three times — the third pass
// goes green and ships.

import type { Scene } from './script.js';
import {
  enter,
  modelMsg,
  submitFrame,
  syntheticOrientation,
  toolCall,
  toolResult,
  turnDone,
} from './helpers.js';

const ROOT = 'autonomous_repair';
const P = (leaf: string) => `${ROOT}.${leaf}`;

const TARGET_FILE = 'packages/payments/src/refund.ts';
const FAIL_OUTPUT_V1 =
  "FAIL packages/payments/src/refund.test.ts\n  refund() rounds to currency precision\n    TypeError: Cannot read properties of undefined (reading 'precision')\n  4 passed, 1 failed in 1.6s";
const FAIL_OUTPUT_V2 =
  'FAIL packages/payments/src/refund.test.ts\n  refund() handles negative amount\n    AssertionError: expected -0 to be 0\n  4 passed, 1 failed in 1.4s';
const PASS_OUTPUT = 'PASS packages/payments/src/refund.test.ts\n  5 passed in 1.3s';

export const scenes: Scene[] = [
  // 0 — boot, enter probe, scan the target
  {
    id: 'boot',
    frames: [
      enter(P('probe'), 'boot', null, false, 1),
      ...modelMsg(
        'm-1',
        `Booting in \`probe\`. The refund test suite is red — I'll read the implementation and the test, identify the failure surface, then hand off to \`attempt\`.`,
      ),
      toolCall('fc-grep-1', 'bash', {
        command: `grep -nH "precision" ${TARGET_FILE}`,
        timeout_ms: 5000,
      }),
      toolResult(
        'fco-grep-1',
        'bash',
        `${TARGET_FILE}:18:  const precision = currency.precision;\n${TARGET_FILE}:24:  return round(amount, precision);`,
        true,
      ),
      toolCall('fc-read-1', 'read_file', { path: TARGET_FILE }),
      toolResult(
        'fco-read-1',
        'read_file',
        `// 26 lines · refund(amount, currency) — assumes currency.precision is non-null.\n// The failing test passes a stubbed currency without \`precision\`.`,
        true,
      ),
      ...modelMsg(
        'm-2',
        `Two candidate fixes: (a) default \`precision\` to 2 when missing, (b) reject undefined currency at the boundary. Trying (a) first — narrower blast radius.`,
      ),
    ],
    autoAdvance: { gapMs: 600 },
  },

  // 1 — probe → attempt v1 (default-precision patch, still fails)
  {
    id: 'attempt-1',
    frames: [
      submitFrame('sub-1', {
        state: 'probe',
        exit: 'analyzed',
        data: {
          target: TARGET_FILE,
          candidates: ['default-precision', 'reject-undefined-currency'],
        },
      }),
      turnDone('t-1'),
      enter(P('attempt'), 'submit', P('probe'), false, 1),
      syntheticOrientation('orient-1', P('attempt')),
      ...modelMsg('m-3', `Attempt 1 — defaulting \`precision\` to 2 inside \`refund()\`.`),
      toolCall('fc-patch-1', 'apply_patch', {
        file_path: TARGET_FILE,
        patch:
          '--- a/refund.ts\n+++ b/refund.ts\n@@\n-  const precision = currency.precision;\n+  const precision = currency.precision ?? 2;',
      }),
      toolResult(
        'fco-patch-1',
        'apply_patch',
        'Patch applied. 1 file changed, 1 insertion(+), 1 deletion(-).',
        true,
      ),
      toolCall('fc-bash-1', 'bash', {
        command: 'pnpm --filter payments test',
        timeout_ms: 60000,
      }),
      toolResult('fco-bash-1', 'bash', FAIL_OUTPUT_V1, false),
      ...modelMsg(
        'm-4',
        `Different failure now — the negative-amount case rounds to \`-0\`. The default fixed the precision lookup but the test surfaced a second bug. Retry with a sign-normalising fix.`,
      ),
    ],
    autoAdvance: { gapMs: 700 },
  },

  // 2 — attempt v1 → attempt v2 (self-loop on retry)
  {
    id: 'attempt-2',
    frames: [
      submitFrame('sub-2', {
        state: 'attempt',
        exit: 'retry',
        data: { attempt: 1, error: 'TypeError on precision (fixed); -0 assertion (new)' },
      }),
      turnDone('t-2'),
      enter(P('attempt'), 'submit', P('attempt'), false, 2),
      syntheticOrientation('orient-2', P('attempt')),
      ...modelMsg(
        'm-5',
        `Attempt 2 — normalising the sign so \`-0\` collapses to \`0\` before the rounding step.`,
      ),
      toolCall('fc-patch-2', 'apply_patch', {
        file_path: TARGET_FILE,
        patch:
          '--- a/refund.ts\n+++ b/refund.ts\n@@\n-  return round(amount, precision);\n+  return round(amount + 0, precision);',
      }),
      toolResult(
        'fco-patch-2',
        'apply_patch',
        'Patch applied. 1 file changed, 1 insertion(+), 1 deletion(-).',
        true,
      ),
      toolCall('fc-bash-2', 'bash', {
        command: 'pnpm --filter payments test',
        timeout_ms: 60000,
      }),
      toolResult('fco-bash-2', 'bash', FAIL_OUTPUT_V2, false),
      ...modelMsg(
        'm-6',
        `Still red — the \`+ 0\` trick doesn't survive the \`round()\` floor path. Switching to \`Math.abs\` early-return for the zero case.`,
      ),
    ],
    autoAdvance: { gapMs: 700 },
  },

  // 3 — attempt v2 → attempt v3 (third self-loop, this one will pass)
  {
    id: 'attempt-3',
    frames: [
      submitFrame('sub-3', {
        state: 'attempt',
        exit: 'retry',
        data: { attempt: 2, error: 'still -0 after round() floor' },
      }),
      turnDone('t-3'),
      enter(P('attempt'), 'submit', P('attempt'), false, 3),
      syntheticOrientation('orient-3', P('attempt')),
      ...modelMsg(
        'm-7',
        `Attempt 3 — guarding the rounding step with an absolute-zero early-return.`,
      ),
      toolCall('fc-patch-3', 'apply_patch', {
        file_path: TARGET_FILE,
        patch:
          '--- a/refund.ts\n+++ b/refund.ts\n@@\n-  return round(amount + 0, precision);\n+  if (Math.abs(amount) === 0) return 0;\n+  return round(amount, precision);',
      }),
      toolResult(
        'fco-patch-3',
        'apply_patch',
        'Patch applied. 1 file changed, 2 insertions(+), 1 deletion(-).',
        true,
      ),
      toolCall('fc-bash-3', 'bash', {
        command: 'pnpm --filter payments test',
        timeout_ms: 60000,
      }),
      toolResult('fco-bash-3', 'bash', PASS_OUTPUT, true),
      ...modelMsg('m-8', `Green. Shipping.`),
    ],
    autoAdvance: { gapMs: 700 },
  },

  // 4 — attempt v3 → done_success
  {
    id: 'ship',
    frames: [
      submitFrame('sub-4', {
        state: 'attempt',
        exit: 'passed',
        data: { attempt: 3, summary: 'precision-default + zero-guard' },
      }),
      turnDone('t-4'),
      enter(P('done_success'), 'submit', P('attempt'), false, 1, 'success'),
      ...modelMsg('m-9', `Run complete. Terminal: success.`),
    ],
  },
];
