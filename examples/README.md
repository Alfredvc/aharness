# Harness Examples

Start with the coding smoke demo, then use the mechanism demos as focused
references for individual FSM primitives.

## Recommended Path

1. [`coding-smoke.fsm.ts`](coding-smoke.fsm.ts) shows a real coding workflow:
   plan, owner approval, implementation, tests, repair on failure, and final
   report over a tiny fixture.
2. [`DEMOS.md`](DEMOS.md) catalogs the smaller mechanism demos: await exits,
   approval hooks, composition, skills, branching, and final artifacts.

## Run The Coding Smoke Demo

```bash
pnpm run build
node packages/core/dist/cli/main.js verify examples/coding-smoke.fsm.ts
node packages/core/dist/cli/main.js examples/coding-smoke.fsm.ts
```

The fixture is under [`coding-smoke/fixture`](coding-smoke/fixture). It is
deliberately small so the demo proves process control without requiring a long
run.

## Run A Mechanism Demo

```bash
aharness examples/<name>.fsm.ts
```

See [`DEMOS.md`](DEMOS.md) for the walkthrough catalog.
