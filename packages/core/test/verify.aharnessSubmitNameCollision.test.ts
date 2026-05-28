/**
 * Verifier check: `aharness-submit-name-collision`.
 *
 * Rejects an FSM that declares a state id equal to the reserved framework
 * tool name (`SUBMIT_TOOL_NAME` from `protocol/submitTool.ts`, i.e.
 * `'aharness_submit'`). The dynamic-tool dispatcher resolves model tool
 * calls against that name; allowing a state to shadow it would create
 * ambiguous routing.
 *
 * Note: codex `qualify_tools` hash-suffix collisions caused by user MCP
 * config are runtime concerns covered by the boot-time qualified-tool-name
 * guard, not a static FSM property — see the file header in
 * `src/verify/verify.ts`.
 */
import { describe, it, expect } from 'vitest';
import { aharness, state, exit, terminal } from '../src/index.js';

import { verify } from '../src/verify/index.js';

describe('verifier: aharness-submit-name-collision', () => {
  it('rejects an FSM with a state id "aharness_submit"', () => {
    const m = aharness.machine({
      id: 'M',
      initial: 'aharness_submit',
      states: {
        aharness_submit: state({
          entryPrompt: 'x',
          exits: { done: exit({ to: 'end' }) },
        }),
        end: terminal('success'),
      },
    });
    const result = verify(m, {
      aharness_submit: {
        done: { jsonSchema: {}, validate: (x) => ({ ok: true as const, data: x }) },
      },
    });
    expect(result.issues.some((i) => i.check === 'aharness-submit-name-collision')).toBe(true);
  });

  it('accepts an FSM with a non-colliding state id', () => {
    const m = aharness.machine({
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
    expect(result.issues.find((i) => i.check === 'aharness-submit-name-collision')).toBeUndefined();
  });
});
