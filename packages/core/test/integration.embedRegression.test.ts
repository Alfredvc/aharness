import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { createActor, type AnyStateMachine } from 'xstate';

import {
  EMBED_REGRESSION_CHILD_FSM_SOURCE,
  EMBED_REGRESSION_FSM_SOURCE,
  embedRegressionMachine,
} from '@aharness/test-support';
import { loadFsm } from '../src/loader/index.js';
import { verify } from '../src/verify/verify.js';

function expectEmbedRegressionCompletion(machine: AnyStateMachine) {
  const actor = createActor(machine);
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
}

describe('Phase 2d embed regression fixture', () => {
  it('loads, verifies, and runs the source export used by downstream integration tests', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'h-embed-regression-'));
    try {
      const fsmPath = join(repoRoot, 'embedRegression.fsm.ts');
      writeFileSync(
        join(repoRoot, 'embedRegressionChild.fsm.ts'),
        EMBED_REGRESSION_CHILD_FSM_SOURCE,
      );
      writeFileSync(fsmPath, EMBED_REGRESSION_FSM_SOURCE);
      const loaded = await loadFsm({ filePath: fsmPath, repoRoot, noCache: true });
      const report = verify(loaded.machine, loaded.sidecar, loaded.issues);

      expect(report.errors).toEqual([]);
      expectEmbedRegressionCompletion(loaded.machine);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('raises the child final id through the embed boundary and exposes child output', () => {
    expectEmbedRegressionCompletion(embedRegressionMachine);
  });
});
