# __PROJECT_NAME__

A harness FSM scaffolded by `aharness init`.

## Run

```bash
<your-pm> install      # already done if you used `aharness init` without --no-install
<your-pm> verify       # static check the FSM (reachability, schemas, etc.)
<your-pm> start        # boot the codex trio against hello.fsm.ts
```

## Edit

- `hello.fsm.ts` — the FSM definition. Add states, exits, payloads.
- See the harness docs and example FSMs at `<harness-repo-url>`.

## Develop

```bash
<your-pm> typecheck    # tsc --noEmit
<your-pm> lint         # oxlint
<your-pm> format       # prettier --write .
```
