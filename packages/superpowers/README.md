# @aharness/superpowers

`@aharness/superpowers` packages the Superpowers workflow as aharness FSM commands.

This package exposes two installed commands: `brainstorming` and `writing-plans`.
Run them through the global `aharness run` surface after installation.

## Usage

```sh
aharness install @aharness/superpowers
aharness list
aharness verify @aharness/superpowers
aharness run brainstorming --topic "Feature idea" --spec-path docs/specs/feature-design.md
aharness run @aharness/superpowers/writing-plans --spec-path docs/specs/feature.md --plan-path docs/plans/feature.md
```

During package development, verify from this directory:

```sh
pnpm exec aharness verify fsms/brainstorming.fsm.ts
pnpm exec aharness verify fsms/writing-plans.fsm.ts
```

## Commands

Commands are declared in `package.json` under
`aharness.package.commands.<command>.entry` and run through the global
`aharness run` surface after installation. The package does not publish a
package-specific command binary.

### `brainstorming`

Explores an idea into an approved written design spec before planning.

Inputs:

- `--topic <string>`: idea, feature, or behavior to explore before implementation.
- `--spec-path <string>`: target written design spec path. Defaults to `./docs/specs/implementation-design.md`.

Output:

- `specPath`: the approved written design spec path.

The FSM keeps the design conversation open, then enforces design approval, written spec self-review, and owner spec approval as typed gates.

### `writing-plans`

Writes and reviews a bounded implementation plan before execution.

Inputs:

- `--spec-path <string>`: approved spec or requirements document to plan from.
- `--plan-path <string>`: target implementation plan path. Defaults to `./docs/plans/implementation-plan.md`.

Output:

- `planPath`: the accepted implementation plan path.
- `executionMode`: either `subagent-driven` or `inline`.

The FSM enforces plan authoring, broad-spec owner decision, plan quality review, owner plan review, and execution-mode choice as typed gates.

## Bundled Skills

Skill assets are copied under `skills/superpowers/` and referenced from package FSMs by path.

The top-level `SKILL.md` files are short compatibility maps for users who know the original Superpowers skills. They explain which Harness command to run and how familiar skill phases map to FSM states.

State-specific guidance lives under each skill's `guides/` directory. Direct command FSMs under `fsms/` reference those guides by path, for example `../skills/superpowers/writing-plans/guides/plan-authoring.md`.

This package intentionally keeps workflow control in the FSM: states, typed exits, owner gates, retries, outputs, and failure paths are not delegated to skill prose. Guides describe how to work inside a state.
