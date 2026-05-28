/**
 * Verifier check: `harness-submit-name-collision`.
 *
 * Rejects an FSM that declares a state id equal to the reserved framework
 * tool name (`SUBMIT_TOOL_NAME` from `protocol/submitTool.ts`, i.e.
 * `'harness_submit'`). The dynamic-tool dispatcher resolves model tool
 * calls against that name; allowing a state to shadow it would create
 * ambiguous routing.
 *
 * Note: codex `qualify_tools` hash-suffix collisions caused by user MCP
 * config are runtime concerns covered by the boot-time qualified-tool-name
 * guard, not a static FSM property — see the file header in
 * `src/verify/verify.ts`.
 */
import { describe, it, expect } from 'vitest';
import { harness, state, exit, terminal } from '../src/index.js';

import { verify } from '../src/verify/index.js';

describe('verifier: harness-submit-name-collision', () => {
  it('rejects an FSM with a state id "harness_submit"', () => {
    const m = harness.machine({
      id: 'M',
      initial: 'harness_submit',
      states: {
        harness_submit: state({
          entryPrompt: 'x',
          exits: { done: exit({ to: 'end' }) },
        }),
        end: terminal('success'),
      },
    });
    const result = verify(m, {
      harness_submit: {
        done: { jsonSchema: {}, validate: (x) => ({ ok: true as const, data: x }) },
      },
    });
    expect(result.issues.some((i) => i.check === 'harness-submit-name-collision')).toBe(true);
  });

  it('accepts an FSM with a non-colliding state id', () => {
    const m = harness.machine({
      id: 'M',
      initial: 'idle',
      states: {
        idle: state({
          entryPrompt: 'x',
          exits: { done: exit({ to: 'end' }) },
        }),
        end: terminal('success'),
      },
    });
    const result = verify(m, {
      idle: {
        done: { jsonSchema: {}, validate: (x) => ({ ok: true as const, data: x }) },
      },
    });
    expect(result.issues.find((i) => i.check === 'harness-submit-name-collision')).toBeUndefined();
  });
});
