import { describe, expect, it } from 'vitest';

import { aharness } from '../src/state/machine.js';
import { exit, state, terminal } from '../src/state/exits.js';
import { verify } from '../src/verify/verify.js';

const stubSidecar = (stateId: string, exitName: string) => ({
  [stateId]: {
    [exitName]: {
      jsonSchema: { type: 'object' as const },
      validate: (input: unknown) => ({ ok: true as const, data: input }),
    },
  },
});

/**
 * Build a machine whose state `s` carries an arbitrary `meta.aharness` literal.
 * Goes through `aharness.machine` so the verifier invariant holds; bypasses
 * `state()` runtime guards.
 */
function machineWithRawAharnessMeta(rawMeta: Record<string, unknown>) {
  return aharness.machine({
    id: 'm',
    initial: 's',
    states: {
      s: {
        meta: { aharness: rawMeta },
      },
      done: terminal('success'),
    },
  });
}

describe('verifier — state-hooks-must-be-functions', () => {
  it('rejects a non-function handler attached via direct meta construction', () => {
    const m = machineWithRawAharnessMeta({
      kind: 'stateful',
      open: false,
      entryPrompt: 'p',
      exits: { go: { kind: 'submit', payload: { __aharnessPayloadMarker: true }, to: 'done' } },
      hooks: {
        preToolUse: [{ matcher: '^Bash$', handler: 'not a function' }],
      },
    });
    const issues = verify(m, stubSidecar('s', 'go')).errors;
    expect(issues.some((i) => i.check === 'state-hooks-must-be-functions')).toBe(true);
  });

  it('rejects a non-array hooks.preToolUse value', () => {
    const m = machineWithRawAharnessMeta({
      kind: 'stateful',
      open: false,
      entryPrompt: 'p',
      exits: { go: { kind: 'submit', payload: { __aharnessPayloadMarker: true }, to: 'done' } },
      hooks: { preToolUse: 'not an array' },
    });
    const issues = verify(m, stubSidecar('s', 'go')).errors;
    expect(
      issues.some(
        (i) =>
          i.check === 'state-hooks-must-be-functions' &&
          i.message.includes('hooks.preToolUse must be an array'),
      ),
    ).toBe(true);
  });

  it('rejects a non-function permissionRequest handler attached via direct meta construction', () => {
    const m = machineWithRawAharnessMeta({
      kind: 'stateful',
      open: false,
      entryPrompt: 'p',
      exits: { go: { kind: 'submit', payload: { __aharnessPayloadMarker: true }, to: 'done' } },
      hooks: {
        permissionRequest: [{ matcher: '^Bash$', handler: 'not a function' }],
      },
    });
    const issues = verify(m, stubSidecar('s', 'go')).errors;
    expect(issues.some((i) => i.check === 'state-hooks-must-be-functions')).toBe(true);
  });

  it('rejects a non-array hooks.permissionRequest value', () => {
    const m = machineWithRawAharnessMeta({
      kind: 'stateful',
      open: false,
      entryPrompt: 'p',
      exits: { go: { kind: 'submit', payload: { __aharnessPayloadMarker: true }, to: 'done' } },
      hooks: { permissionRequest: 'not an array' },
    });
    const issues = verify(m, stubSidecar('s', 'go')).errors;
    expect(
      issues.some(
        (i) =>
          i.check === 'state-hooks-must-be-functions' &&
          i.message.includes('hooks.permissionRequest must be an array'),
      ),
    ).toBe(true);
  });
});

describe('verifier — hook-kind-not-yet-supported', () => {
  it('accepts hooks.permissionRequest and keeps future reserved kinds closed', () => {
    const m = aharness.machine({
      id: 'm',
      initial: 's',
      states: {
        s: state({
          entryPrompt: 'p',
          exits: { go: exit<{ x: number }>({ to: 'done' }) },
          hooks: {
            permissionRequest: [{ matcher: '^Bash$', handler: () => 'delegate' }],
          },
        }),
        done: terminal('success'),
      },
    });
    const issues = verify(m, stubSidecar('s', 'go')).errors;
    expect(issues.map((i) => i.check)).not.toContain('hook-kind-not-yet-supported');
  });

  it('rejects a state declaring hooks.sessionStart (programmatic bypass of state())', () => {
    const m = machineWithRawAharnessMeta({
      kind: 'stateful',
      open: false,
      entryPrompt: 'p',
      exits: { go: { kind: 'submit', payload: { __aharnessPayloadMarker: true }, to: 'done' } },
      hooks: { sessionStart: [{ matcher: '.*', handler: () => undefined }] },
    });
    const issues = verify(m, stubSidecar('s', 'go')).errors;
    expect(issues.some((i) => i.check === 'hook-kind-not-yet-supported')).toBe(true);
  });
});

describe('verifier — hook-matcher-not-supported-on-kind', () => {
  it('rejects a userPromptSubmit entry with a non-empty matcher', () => {
    const m = machineWithRawAharnessMeta({
      kind: 'stateful',
      open: false,
      entryPrompt: 'p',
      exits: { go: { kind: 'submit', payload: { __aharnessPayloadMarker: true }, to: 'done' } },
      hooks: {
        userPromptSubmit: [{ matcher: 'foo', handler: () => undefined }],
      },
    });
    const issues = verify(m, stubSidecar('s', 'go')).errors;
    expect(issues.some((i) => i.check === 'hook-matcher-not-supported-on-kind')).toBe(true);
  });
});

describe('verifier — hook-matcher-invalid-regex', () => {
  it('rejects a malformed regex matcher via direct meta construction', () => {
    const m = machineWithRawAharnessMeta({
      kind: 'stateful',
      open: false,
      entryPrompt: 'p',
      exits: { go: { kind: 'submit', payload: { __aharnessPayloadMarker: true }, to: 'done' } },
      hooks: {
        preToolUse: [{ matcher: '(?P<name>invalid)', handler: () => undefined }],
      },
    });
    const issues = verify(m, stubSidecar('s', 'go')).errors;
    expect(issues.some((i) => i.check === 'hook-matcher-invalid-regex')).toBe(true);
    expect(issues.map((i) => i.check as string)).not.toContain(
      'hook-matcher-must-not-match-reserved-tools',
    );
  });

  it('rejects a malformed permissionRequest matcher via direct meta construction', () => {
    const m = machineWithRawAharnessMeta({
      kind: 'stateful',
      open: false,
      entryPrompt: 'p',
      exits: { go: { kind: 'submit', payload: { __aharnessPayloadMarker: true }, to: 'done' } },
      hooks: {
        permissionRequest: [{ matcher: '(?P<name>invalid)', handler: () => undefined }],
      },
    });
    const issues = verify(m, stubSidecar('s', 'go')).errors;
    expect(issues.some((i) => i.check === 'hook-matcher-invalid-regex')).toBe(true);
  });
});

describe('state() — permissionRequest runtime guards', () => {
  it('accepts supported permissionRequest entries', () => {
    expect(() =>
      state({
        entryPrompt: 'p',
        exits: { go: exit<{ x: number }>({ to: 'done' }) },
        hooks: {
          permissionRequest: [{ matcher: '^Bash$', handler: () => 'delegate' }],
        },
      }),
    ).not.toThrow();
  });

  it('requires permissionRequest matchers to be non-empty valid regex strings', () => {
    expect(() =>
      state({
        entryPrompt: 'p',
        exits: { go: exit<{ x: number }>({ to: 'done' }) },
        hooks: {
          permissionRequest: [{ matcher: '', handler: () => 'delegate' }],
        },
      }),
    ).toThrow(/matcher must be a non-empty string/);

    expect(() =>
      state({
        entryPrompt: 'p',
        exits: { go: exit<{ x: number }>({ to: 'done' }) },
        hooks: {
          permissionRequest: [{ matcher: '(?P<name>invalid)', handler: () => 'delegate' }],
        },
      }),
    ).toThrow(/not a valid regex/);
  });
});

describe('verifier — retired reserved hook-tool check', () => {
  it.each([
    ['legacy MCP-looking matcher', 'mcp__aharness_fsm__.*'],
    ['wildcard matcher', '.*'],
    ['submit suffix matcher', 'submit$'],
    ['bare submit matcher', 'submit'],
    ['ordinary tool matcher', '^Bash$'],
  ])('accepts a valid %s', (_label, matcher) => {
    const m = aharness.machine({
      id: 'm',
      initial: 's',
      states: {
        s: state({
          entryPrompt: 'p',
          exits: { go: exit<{ x: number }>({ to: 'done' }) },
          hooks: {
            preToolUse: [{ matcher, handler: () => undefined }],
          },
        }),
        done: terminal('success'),
      },
    });
    const issues = verify(m, stubSidecar('s', 'go')).errors;
    expect(issues.map((i) => i.check)).not.toContain('hook-matcher-invalid-regex');
    expect(issues.map((i) => i.check as string)).not.toContain(
      'hook-matcher-must-not-match-reserved-tools',
    );
  });
});

describe('verifier — hooks-only-on-stateful-states', () => {
  it('rejects hooks on a passive meta', () => {
    const m = machineWithRawAharnessMeta({
      kind: 'passive',
      hooks: { preToolUse: [{ matcher: '^Bash$', handler: () => undefined }] },
    });
    const issues = verify(m, {}).errors;
    expect(issues.some((i) => i.check === 'hooks-only-on-stateful-states')).toBe(true);
  });

  it('rejects hooks on a terminal meta', () => {
    // Construct a one-state machine where the state is terminal but carries
    // hooks. Authors writing through `terminal('...')` cannot do this — the
    // helper does not accept a hooks field — so we go raw via `aharness.machine`.
    const m = aharness.machine({
      id: 'm',
      initial: 'done',
      states: {
        done: {
          type: 'final',
          meta: {
            aharness: {
              kind: 'terminal',
              outcome: 'success',
              hooks: { preToolUse: [{ matcher: '^Bash$', handler: () => undefined }] },
            },
          },
        },
      },
    });
    const issues = verify(m, {}).errors;
    expect(issues.some((i) => i.check === 'hooks-only-on-stateful-states')).toBe(true);
  });
});
