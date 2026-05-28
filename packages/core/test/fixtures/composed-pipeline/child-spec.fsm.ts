import { aharness, state, exit, final, arg } from '@aharness/core';

interface ChildCtx {
  readonly topic: string;
}
interface Decision {
  readonly accepted: boolean;
}

export default aharness.machine({
  id: 'spec',
  input: {
    topic: arg<string>({ description: 'Topic to spec' }),
  },
  context: ({ input }) => ({
    topic: input.topic,
  }),
  initial: 'compose',
  states: {
    compose: state<ChildCtx>({
      entryPrompt: (ctx) =>
        `Compose a 1-paragraph spec for the topic: ${ctx.topic}. ` +
        `Submit with accepted=true once the spec is satisfactory; accepted=false to abort.`,
      exits: {
        decide: exit<Decision>({
          when: [
            { guard: ({ event }) => event.payload.accepted === true, to: 'shipped' },
            { to: 'failed' },
          ],
        }),
      },
    }),
    shipped: final({
      outcome: 'success',
      output: ({ context }: { context: ChildCtx }) => ({ topic: context.topic }),
    }),
    failed: final({ outcome: 'failure' }),
  },
});
