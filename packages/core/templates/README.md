# __PROJECT_NAME__

An aharness FSM scaffolded by `aharness init`.

## Run

```bash
<your-pm> install      # already done if you used `aharness init` without --no-install
<your-pm> verify       # static check the FSM (reachability, schemas, etc.)
<your-pm> start        # run the sample FSM with `aharness run ./fsms/hello.fsm.ts`
```

## FSM Composition

Other FSM packages can depend on this package and compose the exported FSM
module directly.

```ts
import hello, {
  machine as helloMachine,
  type HelloFinals,
  type HelloInput,
  type HelloMachine,
  type HelloOutput,
} from '__PROJECT_NAME__/hello.fsm.js';
```

The default export and named `machine` export are the same FSM. The public type
aliases cover the child machine, its expected input, its final-state output map,
and the successful `done` output.

## Edit

- `fsms/hello.fsm.ts` — the FSM definition. Add states, exits, payloads.
- `package.json` — exposes the sample as `./hello.fsm.js` for composition and
  as the `hello` installed command.
- See the aharness docs and example FSMs at `<aharness-repo-url>`.

## Develop

```bash
<your-pm> typecheck    # tsc --noEmit
<your-pm> lint         # oxlint
<your-pm> format       # prettier --write .
```
