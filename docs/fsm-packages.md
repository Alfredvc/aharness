# FSM Packages

Reusable FSM packages are npm packages that aharness can install, verify, run,
and compose from other FSM packages. Use this guide when publishing workflows
for a team or ecosystem. For one-off local workflows, a normal `.fsm.ts` file is
usually enough.

## Expected Shape

Keep package contents ordinary and source-first:

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

The `fsms/` directory owns aharness workflow source. Bundled skills, prompts,
and helper modules live alongside it and are referenced from FSM source.

Create a new package scaffold with:

```bash
aharness init --dir my-workflows
```

The scaffold starts with a runnable hello-world FSM under `fsms/`, a short
`.fsm.js` export, and matching aharness command metadata. Rename or extend that
sample for your package.

By default, `init` installs dependencies. Use `--pm <npm|pnpm|yarn|bun>` to
choose the package manager, or `--no-install` to skip dependency installation.

```bash
cd my-workflows
<your-pm> verify
<your-pm> start
```

## Package Metadata

Declare package commands in `package.json` with package-root-relative `.fsm.ts`
entries:

```json
{
  "name": "@scope/tools",
  "version": "1.0.0",
  "type": "module",
  "files": ["fsms", "skills", "prompts", "README.md", "LICENSE"],
  "dependencies": {
    "@aharness/core": "^0.1.0"
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

The `aharness.package.commands` block makes an FSM runnable after
`aharness install`. The `exports` block makes the same FSM importable by other
FSM packages.

Use the short export form:

```json
"./build.fsm.js": "./fsms/build.fsm.ts"
```

Consumers then import the stable public subpath:

```ts
import buildWorkflow from '@scope/tools/build.fsm.js';
```

Do not publish deep FSM import paths as the documented API. Keep the package's
public composition surface short and intentional.

## FSM Module Exports

Export the machine as both a named `machine` and the default export. If other
FSM packages are expected to embed it, export the public input and output types
that consumers need.

```ts
import { createFsm } from '@aharness/core';

interface Data {
  project: string;
}

const fsm = createFsm<Data>();

export const machine = fsm.machine({
  id: 'build',
  input: {
    project: fsm.input.path({ description: 'Project directory', complete: 'directory' }),
  },
  data: ({ input }) => ({ project: input.project }),
  initial: 'done',
  states: {
    done: fsm.final({ outcome: 'success' }),
  },
});

export type BuildMachine = typeof machine;
export type BuildInput = NonNullable<BuildMachine['__inputType']>;
export type BuildFinals = NonNullable<BuildMachine['__finalsType']>;

export default machine;
```

Keep internal workflow data and payload types private unless consumers need
them to embed the FSM safely.

## Composition

Composition uses normal TypeScript imports and `fsm.embed(...)`. It does not use
installed command metadata as an API.

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

The parent projection must satisfy the child input declaration. The `on` map
must cover the child final ids exactly.

## Skills And Assets

FSM source declares bundled skill availability. Use top-level `availableSkills`
for package-owned skill roots, and state `skills` for the skills selected in a
specific active state.

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

Installable packages can read package-owned files with package-relative asset
helpers:

```ts
import { aharness } from '@aharness/core';

const reviewPrompt = aharness.getAssetText('prompts/review.md');
const templateUrl = aharness.getAssetUrl('prompts/review.md');
```

Asset paths must be string-literal package-relative paths. Dependency package
modules read their own package assets.

## Install And Run

Users install package commands through aharness:

```bash
aharness install @scope/tools
aharness list
aharness verify @scope/tools/build
aharness run @scope/tools/build --project ./app
```

Bare command names work only when exactly one installed package provides that
command. Package-only names are not FSM targets for `run`, `verify`, or
`visualize`.

Re-run `aharness install <same-source>` to refresh a package after a new npm
version, Git ref, tarball, or local snapshot is available. Remove a package by
package identity:

```bash
aharness uninstall @scope/tools
```

## Trust Boundary

`aharness install <source>` delegates package materialization to npm inside the
aharness managed npm project. Installs may run npm lifecycle scripts, so install
only packages from sources the owner trusts.

After npm materializes the package, aharness validates command metadata,
package-relative asset calls, bundled skill declarations, loader behavior, and
every declared command FSM before writing trusted command records. Unverified
commands are not runnable.
