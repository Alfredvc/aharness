# Creating FSM Packages

Use this reference when creating, reviewing, or diagnosing installable aharness
FSM packages. Ordinary one-file local FSMs do not need package metadata.

## Expected Shape

Reusable FSM packages are npm packages that can be installed as aharness
commands and imported by other FSM packages.

```text
package/
|-- package.json
|-- fsms/
|   `-- build.fsm.ts
|-- skills/
|   `-- reviewing-code/
|       `-- SKILL.md
|-- prompts/
|   `-- review.md
`-- README.md
```

Package metadata should expose two surfaces:

- `aharness.package.commands` for `aharness install` / `aharness run`.
- `exports` for TypeScript composition with `fsm.embed(...)`.

Start new packages with `aharness init --dir <path>`. The scaffold includes a
hello-world FSM under `fsms/`, a short `.fsm.js` export, and matching command
metadata. Rename or extend the sample for the target workflow.

`init` installs dependencies by default. Use `--pm <npm|pnpm|yarn|bun>` to
choose the package manager, or `--no-install` to skip installation. After
scaffolding, use `<your-pm> verify` and `<your-pm> start` from the package
directory.

Use the short FSM export form only:

```json
{
  "name": "@scope/tools",
  "version": "1.0.0",
  "type": "module",
  "files": ["fsms", "skills", "prompts", "README.md", "LICENSE"],
  "dependencies": {
    "@aharness/core": "^0.1.2"
  },
  "exports": {
    "./build.fsm.js": "./fsms/build.fsm.ts"
  },
  "aharness": {
    "package": {
      "commands": {
        "build": {
          "entry": "fsms/build.fsm.ts",
          "description": "Build project artifacts"
        }
      }
    }
  }
}
```

Do not document deep FSM imports as the public API. Consumers should import the
short package subpath:

```ts
import buildWorkflow from '@scope/tools/build.fsm.js';
```

## FSM Module Exports

Export the machine as named `machine` and as the default export. If consumers
will embed the FSM, export public input/final/output types they need.

```ts
export const machine = fsm.machine({
  id: 'build',
  // ...
});

export type BuildMachine = typeof machine;
export type BuildInput = NonNullable<BuildMachine['__inputType']>;
export type BuildFinals = NonNullable<BuildMachine['__finalsType']>;

export default machine;
```

Keep internal workflow data and payload types private unless they are part of
the embedding contract.

## Composition

Composition uses normal package imports and `fsm.embed(...)`. Installed command
metadata is not a composition API.

```ts
import { createFsm } from '@aharness/core';
import buildWorkflow, { type BuildInput } from '@scope/tools/build.fsm.js';

interface Data {
  project: string;
}

const fsm = createFsm<Data>();

export default fsm.machine({
  id: 'wrapper',
  data: (): Data => ({ project: './app' }),
  initial: 'build',
  states: {
    build: fsm.embed(buildWorkflow, {
      input: (data): BuildInput => ({ project: data.project }),
      on: {
        done: { to: 'done' },
      },
    }),
    done: fsm.final({ outcome: 'success' }),
  },
});
```

The parent input projection must satisfy the child input declaration. The `on`
map must cover the child final ids exactly.

## Skills And Assets

FSM source remains the source of truth for bundled skill availability.

Use top-level `availableSkills` for package-owned skill roots. Use state
`skills` for skills selected in a specific active state.

```ts
export default fsm.machine({
  id: 'review',
  availableSkills: [fsm.skill.dir('../skills')],
  initial: 'review',
  states: {
    review: fsm.state({
      skills: [fsm.skill.path('../skills/reviewing-code/SKILL.md')],
      prompt: 'Review the change and submit findings.',
      on: {
        reviewed: fsm.submit<{ findings: string }>({ to: 'done' }),
      },
    }),
    done: fsm.final({ outcome: 'success' }),
  },
});
```

Use package asset helpers for package-owned files:

```ts
import { aharness } from '@aharness/core';

const reviewPrompt = aharness.getAssetText('prompts/review.md');
const templateUrl = aharness.getAssetUrl('prompts/review.md');
```

Asset paths must be string-literal package-relative paths. Dependency package
modules read their own package assets.

## Install And Run

Install packages through aharness:

```bash
aharness install @scope/tools
aharness list
aharness verify @scope/tools/build
aharness run @scope/tools/build --project ./app
```

Bare command names work only when exactly one installed package provides that
command. Package-only names are not FSM targets.

Re-run `aharness install <same-source>` to refresh a package after a new npm
version, Git ref, tarball, or local snapshot is available. Remove packages by
package identity:

```bash
aharness uninstall @scope/tools
```

## Trust And Verification

`aharness install <source>` delegates package materialization to npm inside the
aharness managed npm project. Installs may run npm lifecycle scripts, so install
only packages from sources the owner trusts.

After npm materializes the package, aharness validates command metadata,
package-relative asset calls, bundled skill declarations, loader behavior, and
every declared command FSM before writing trusted command records. Unverified
commands are not runnable.
