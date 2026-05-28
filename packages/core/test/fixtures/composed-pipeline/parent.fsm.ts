import { assign } from 'xstate';
import { harness, state, exit, final, embed, arg } from '@aharness/core';
import child from './child-spec.fsm.js';

interface ParentCtx {
  readonly topic: string;
  readonly shippedTopic?: string;
}
interface GoPayload {
  readonly ready: boolean;
}

export default harness.machine({
  id: 'pipeline',
  input: {
    topic: arg<string>({ description: 'Project topic' }),
  },
  context: ({ input }) => ({
    topic: input.topic,
  }),
  initial: 'router',
  states: {
    router: state<ParentCtx>({
      entryPrompt: (ctx) =>
        `Pipeline for topic: ${ctx.topic}. ` +
        `Submit ready=true when you want to enter the spec phase, ready=false to stay here.`,
      exits: {
        go: exit<GoPayload>({
          when: [
            { guard: ({ event }) => event.payload.ready === true, to: 'spec' },
            { to: 'router' },
          ],
        }),
      },
    }),
    spec: embed<typeof child, ParentCtx>(child, {
      input: ({ context }) => ({ topic: context.topic }),
      on: {
        shipped: {
          target: 'done',
          actions: assign({
            shippedTopic: ({ event }) => event.output.topic,
          }),
        },
        failed: { target: 'router' },
      },
    }),
    done: final({ outcome: 'success' }),
  },
});
