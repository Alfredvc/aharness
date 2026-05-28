# @aharness/superpowers

`@aharness/superpowers` packages the Superpowers workflow as aharness FSM commands.

Slice 1 exposes two commands: `brainstorming` and `writing-plans`. Execution commands, helper FSMs, and the end-to-end `flow` command are not exposed yet.

## Usage

```sh
ah-superpowers list
ah-superpowers help brainstorming
ah-superpowers help writing-plans
ah-superpowers verify
ah-superpowers brainstorming --topic "Feature idea" --spec-path docs/specs/feature-design.md
ah-superpowers writing-plans --spec-path docs/specs/feature.md --plan-path docs/plans/feature.md
```

During package development, verify from this directory:

```sh
pnpm run package:verify
```

## Commands

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

Skill assets are copied under `skills/superpowers/` and referenced from package FSMs by path. Direct command FSMs under `fsms/` use paths like `../skills/superpowers/writing-plans/SKILL.md`.

Copied vendored skill content should stay unmodified in place. Package-specific adaptation belongs in FSM prompts, shared helpers, or this README.
