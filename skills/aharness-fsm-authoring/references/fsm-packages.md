# Creating FSM Packages

Use this reference when creating, reviewing, or diagnosing installable aharness
FSM packages. Ordinary one-file local FSMs do not need package metadata.

## Package Shape

Reusable FSM packages are normal npm-shaped packages with explicit aharness
command metadata in `package.json`:

```json
{
  "name": "@scope/tools",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@aharness/core": "^0.1.0"
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

Rules:

- Each command entry must be a package-root-relative `.fsm.ts` file.
- Command descriptions should be concise and user-facing.
- Package commands are run through `aharness run`; package-specific binaries are not part of installed package execution.
- Stable command identity is `<package-name>/<command-name>`, such as `@scope/tools/build`.
- Bare command names work only when exactly one installed package provides that command.
- Command names such as `list`, `verify`, `help`, and `version` are valid below `aharness run`.

Author-owned package contents usually look like:

```text
package/
|-- package.json
|-- fsms/
|   `-- build.fsm.ts
|-- skills/
|   `-- reviewing-code/
|       `-- SKILL.md
|-- prompts/
|   `-- report.md
`-- assets/
    `-- template.txt
```

Keep package metadata focused on commands. Bundled skill discovery is declared
in FSM source, not package metadata.

## Skills In Packages

FSM source remains the source of truth for bundled skill availability.

Use top-level `availableSkills` for package-owned skill roots that should be
discoverable during the run:

```ts
export default fsm.machine({
  id: 'packaged-workflow',
  availableSkills: [fsm.skill.dir('../skills'), fsm.skill.path('../support/review/SKILL.md')],
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

Rules:

- `availableSkills` accepts `fsm.skill.path(...)` and `fsm.skill.dir(...)`.
- State `skills` accepts `fsm.skill(name)` and `fsm.skill.path(...)`.
- Do not put `fsm.skill.dir(...)` in state `skills`.
- Do not put name-form `fsm.skill(...)` in top-level `availableSkills`.
- `availableSkills` does not select a skill for the active state; state `skills` does.
- Imported child FSMs carry their own transitive availability declarations.

Do not invent package-level skill root metadata. Package skill roots belong in
FSM source so direct verification and installed verification see the same
workflow contract.

## Package Assets

Installable packages can reference package-contained files through the
`aharness` namespace:

```ts
import { aharness, createFsm } from '@aharness/core';

const promptTemplate = aharness.getAssetText('prompts/report.md');
const templateUrl = aharness.getAssetUrl('assets/template.txt');
```

Use these helpers when the FSM or helper modules need package-owned prompts,
templates, or other files after installation.

Rules:

- Asset paths must be string-literal package-relative paths.
- Paths are resolved relative to the npm package containing the source module that made the call.
- Dependency package modules read their own package assets, not the root command package's assets.
- Dynamic paths, absolute paths, parent-directory escapes, missing files, directories, symlinks, and realpath escapes are rejected for installable packages.
- `getAssetText(relativePath, encoding?)` reads text synchronously and defaults to UTF-8.
- `getAssetUrl(relativePath)` returns a `file://` `URL`.
- Direct-file FSM loading does not add package-relative asset semantics; these helpers are for package-aware loading.

## Install And Run

Install packages through aharness:

```bash
aharness install @scope/tools
aharness install workflow-package@latest
aharness install github:owner/workflows
aharness install git+https://github.com/owner/workflows.git
aharness install ../workflows
aharness install ./workflows-1.0.0.tgz
```

Then inspect and run:

```bash
aharness list
aharness verify build
aharness verify @scope/tools/build
aharness run build --project ./app
```

Remove a package by package identity, not by command name:

```bash
aharness uninstall @scope/tools
```

Re-run `aharness install <same-source>` to refresh a package after a new npm
version, Git ref, tarball, or local snapshot is available.

## Trust And Verification

`aharness install <source>` delegates package materialization to npm inside the
aharness managed npm project. The source may be any package spec npm accepts.
Installs may run npm lifecycle scripts, so install only packages from sources
the owner trusts.

After npm materializes the package, aharness validates package command
metadata, package-relative asset calls, loader behavior, bundled skill
declarations, and every declared FSM before writing trusted command records. If
validation fails after npm mutates managed files, unverified commands are not
indexed or runnable.

Installed package identity is the installed package's own `package.json` name.
For npm aliases, the alias remains the npm dependency key used for uninstall,
but aharness command identity and collision checks use the installed package
name.

Installed `run` and installed `verify` recompute the current managed npm
project lock fingerprint before loading a package command. If the managed tree
no longer matches the verified install record, reinstall the same source or
uninstall the package before replacing it.

`commands.json` is derived from trusted install records. If it is missing,
malformed, or stale, aharness can regenerate it from a valid `installs.json`
after checking lock fingerprints. A malformed `installs.json` is a hard
trust-boundary failure because there is no trusted source of truth to
regenerate from.
