import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';

import { EMBED_REGRESSION_FSM_SOURCE, embedRegressionMachine } from '@aharness/test-support';

describe('Phase 2d embed regression fixture', () => {
  it('is exported as source for downstream integration tests', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'h-embed-regression-'));
    try {
      const fsmPath = join(repoRoot, 'embedRegression.fsm.ts');
      writeFileSync(fsmPath, EMBED_REGRESSION_FSM_SOURCE);
      expect(EMBED_REGRESSION_FSM_SOURCE).toContain('embed(');
      expect(EMBED_REGRESSION_FSM_SOURCE).toContain('childReachedFinal');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('raises the child final id through the embed boundary and exposes child output', () => {
    const actor = createActor(embedRegressionMachine);
    actor.start();
    expect(actor.getSnapshot().value).toEqual({ child: 'work' });

    actor.send({ type: 'SUBMIT__child.work__ship', payload: {} });

    const snapshot = actor.getSnapshot();
    expect(snapshot.status).toBe('done');
    expect(snapshot.value).toBe('done');
    expect((snapshot.context as { childOutput?: unknown }).childOutput).toEqual({
      childReachedFinal: true,
      payload: {},
    });
  });
});
