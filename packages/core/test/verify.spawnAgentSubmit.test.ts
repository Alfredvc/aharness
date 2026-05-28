import { describe, expect, it } from 'vitest';
import { aharness, state, terminal, exit } from '@aharness/core';
import type { SchemaSidecar } from '@aharness/core';

import { verify } from '../src/verify/verify.js';

interface APayload {
  x: number;
}

describe('verify: no-submit-in-spawn-agent-reachable-states', () => {
  it('rejects an FSM with a submit exit AND a spawn_agent reference in author code', () => {
    // The detection signal MVP: any author-fn that mentions "spawn_agent"
    // by name in its body (per spec §7.1 conservative analysis).
    const m = aharness.machine({
      id: 'm',
      initial: 'a',
      context: () => ({}),
      states: {
        a: state({
          exits: { go: exit<APayload>({ to: 't' }) },
          entryPrompt: () => 'spawn_agent will be called by some author code',
        }),
        t: terminal('success'),
      },
    });
    const sc: SchemaSidecar = {
      a: { go: { jsonSchema: {}, validate: (x) => ({ ok: true, data: x }) } },
    };
    const r = verify(m, sc);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.check === 'no-submit-in-spawn-agent-reachable-states')).toBe(
      true,
    );
  });

  it('passes an FSM that has no spawn_agent references', () => {
    const m = aharness.machine({
      id: 'm',
      initial: 'a',
      context: () => ({}),
      states: {
        a: state({
          exits: { go: exit<APayload>({ to: 't' }) },
          entryPrompt: 'plain text',
        }),
        t: terminal('success'),
      },
    });
    const sc: SchemaSidecar = {
      a: { go: { jsonSchema: {}, validate: (x) => ({ ok: true, data: x }) } },
    };
    const r = verify(m, sc);
    expect(r.issues.some((i) => i.check === 'no-submit-in-spawn-agent-reachable-states')).toBe(
      false,
    );
  });
});
