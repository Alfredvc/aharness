# __PROJECT_NAME__

An aharness FSM scaffolded by `aharness init`.

## Run

```bash
<your-pm> install      # already done if you used `aharness init` without --no-install
<your-pm> verify       # static check the FSM (reachability, schemas, etc.)
<your-pm> start        # run the codex trio with `aharness run ./hello.fsm.ts`
```

## Edit

- `hello.fsm.ts` — the FSM definition. Add states, exits, payloads.
- See the aharness docs and example FSMs at `<aharness-repo-url>`.

## Develop

```bash
<your-pm> typecheck    # tsc --noEmit
<your-pm> lint         # oxlint
<your-pm> format       # prettier --write .
```
