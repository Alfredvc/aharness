import { expectTypeOf, it } from 'vitest';
import { createFsm, type ChoiceMeta } from '../src/index.js';

interface Data {
  readonly name: string;
}

const fsm = createFsm<Data>();

const choice = fsm.choice({
  question: (data) => {
    expectTypeOf(data).toEqualTypeOf<Readonly<Data>>();
    // @ts-expect-error choice question data is readonly
    data.name = 'mutated';
    return data.name;
  },
  options: [{ label: 'Continue', to: 'next' }],
});

expectTypeOf(choice.meta.aharness).toMatchTypeOf<ChoiceMeta>();

if (false) {
  // @ts-expect-error choice requires at least one option
  fsm.choice({ question: 'Pick', options: [] });

  // @ts-expect-error canonical ask has been retired
  fsm.state({
    prompt: 'Pick',
    ask: 'Continue?',
    on: {
      submit: fsm.submit<{ ok: boolean }>({ to: 'next' }),
    },
  });

  // @ts-expect-error fsm.await has been retired
  fsm.await({ ask: 'Continue?', to: 'next' });

  // @ts-expect-error generated owner-choice events are reserved under normal inference
  fsm.withEvents({ OWNER_CHOICE__pick: fsm.event<{ label: string }>() });

  fsm.state({
    prompt: 'Submit',
    on: {
      submit: fsm.submit<{ ok: boolean }>({ to: 'next' }),
    },
  });

  fsm.withEvents({ custom: fsm.event<{ ok: boolean }>() }).state({
    prompt: 'Custom event',
    on: {
      custom: { to: 'next' },
      permissionRequest: { return: () => 'delegate' },
    },
  });
}

it('type-only choice assertions compile', () => {
  expectTypeOf(choice.meta.aharness).toMatchTypeOf<ChoiceMeta>();
});
