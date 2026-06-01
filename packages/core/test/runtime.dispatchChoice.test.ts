import { describe, expect, it } from 'vitest';

import { createFsm } from '@aharness/core';

import { ActorHost } from '../src/runtime/actorHost.js';
import {
  activeChoiceData,
  commitOwnerChoice,
  validateOwnerChoiceReply,
} from '../src/runtime/dispatchChoice.js';

function makeChoiceHost() {
  const fsm = createFsm<{ topic: string }>();
  const machine = fsm.machine({
    id: 'm',
    data: () => ({ topic: 'runtime' }),
    initial: 'pick',
    states: {
      pick: fsm.choice({
        question: (data) => `Pick for ${data.topic}`,
        options: [
          { label: 'Again', to: 'pick' },
          { label: 'Done', to: 'done' },
        ],
      }),
      done: fsm.final({ outcome: 'success' }),
    },
  });
  const host = new ActorHost(machine, undefined);
  host.start();
  return host;
}

describe('runtime owner-choice dispatch helpers', () => {
  it('returns active choice data with resolved question, labels, and visit count', () => {
    const host = makeChoiceHost();
    expect(activeChoiceData(host)).toEqual({
      ok: true,
      state: 'pick',
      visitCount: 1,
      question: 'Pick for runtime',
      labels: ['Again', 'Done'],
    });
  });

  it('validates state, visit count, and exact labels before commit', () => {
    const host = makeChoiceHost();
    expect(
      validateOwnerChoiceReply(host, { state: 'other', visitCount: 1, label: 'Done' }),
    ).toEqual({ ok: false, status: 409, error: 'owner-choice-state-mismatch' });
    expect(validateOwnerChoiceReply(host, { state: 'pick', visitCount: 2, label: 'Done' })).toEqual(
      { ok: false, status: 409, error: 'owner-choice-visit-mismatch' },
    );
    expect(validateOwnerChoiceReply(host, { state: 'pick', visitCount: 1, label: 'done' })).toEqual(
      { ok: false, status: 400, error: 'invalid-owner-choice-label' },
    );
    expect(validateOwnerChoiceReply(host, { state: 'pick', visitCount: 1, label: 'Done' })).toEqual(
      { ok: true, state: 'pick', label: 'Done' },
    );
  });

  it('commits valid choices and makes duplicate old-visit replies stale', async () => {
    const host = makeChoiceHost();
    const first = validateOwnerChoiceReply(host, { state: 'pick', visitCount: 1, label: 'Again' });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected valid choice');
    await expect(commitOwnerChoice(host, first)).resolves.toEqual(
      expect.objectContaining({ ok: true, from: 'pick', to: 'pick' }),
    );
    expect(activeChoiceData(host)).toEqual(
      expect.objectContaining({ ok: true, state: 'pick', visitCount: 2 }),
    );
    expect(
      validateOwnerChoiceReply(host, { state: 'pick', visitCount: 1, label: 'Again' }),
    ).toEqual({ ok: false, status: 409, error: 'owner-choice-visit-mismatch' });
  });

  it('surfaces dynamic question failures without placeholder text', () => {
    const fsm = createFsm();
    const machine = fsm.machine({
      id: 'm',
      initial: 'pick',
      states: {
        pick: fsm.choice({
          question: () => {
            throw new Error('question exploded');
          },
          options: [{ label: 'Done', to: 'done' }],
        }),
        done: fsm.final({ outcome: 'success' }),
      },
    });
    const host = new ActorHost(machine, undefined);
    host.start();
    expect(activeChoiceData(host)).toEqual({ ok: false, error: 'question exploded' });
    expect(validateOwnerChoiceReply(host, { state: 'pick', visitCount: 1, label: 'Done' })).toEqual(
      {
        ok: false,
        status: 500,
        error: 'owner-choice-question-error',
        message: 'question exploded',
      },
    );
  });
});
