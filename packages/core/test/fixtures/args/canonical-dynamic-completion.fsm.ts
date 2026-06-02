import { createFsm } from '@aharness/core';

interface Data {
  readonly arrow: string;
  readonly named: string;
  readonly identifier: string;
  readonly broken: string;
  readonly filePath: string;
  readonly directoryPath: string;
  readonly valuesHelper: string;
  readonly valuesObject: string;
  readonly objectDynamic: string;
}

const fsm = createFsm<Data>();

const dynamicFn = (partial: string) =>
  ['charlie', 'delta', 'echo'].filter((value) => value.startsWith(partial));

export default fsm.machine({
  id: 'canonical-dynamic-completion',
  input: {
    arrow: fsm.input.string({
      complete: (partial) =>
        ['alpha', 'beta', 'gamma'].filter((value) => value.startsWith(partial)),
    }),
    named: fsm.input.string({
      complete: function completion(partial) {
        return ['bravo', 'beta', 'zulu'].filter((value) => value.startsWith(partial));
      },
    }),
    identifier: fsm.input.string({ complete: dynamicFn }),
    broken: fsm.input.string({
      complete: () => {
        throw new Error('intentional canonical completion failure');
      },
    }),
    filePath: fsm.input.path({ complete: 'file' }),
    directoryPath: fsm.input.path({ complete: 'directory' }),
    valuesHelper: fsm.input.string({ complete: fsm.input.values(['one', 'two']) }),
    valuesObject: fsm.input.string({ complete: { values: ['red', 'blue'] } }),
    objectDynamic: fsm.input.string({ complete: { dynamic: dynamicFn } }),
  },
  data: ({ input }) => input,
  initial: 'go',
  states: {
    go: fsm.state({
      prompt: () => 'go',
      on: {
        submit: fsm.submit<{ ok: boolean }>({ to: 'done' }),
      },
    }),
    done: fsm.final({ outcome: 'success' }),
  },
});
