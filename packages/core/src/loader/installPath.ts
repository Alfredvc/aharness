/**
 * Resolve the on-disk location of `@aharness/core` and `xstate` from
 * the harness install — not from the user's project.
 *
 * Background: a harness user installs the CLI globally (`npm i -g
 * @aharness/core`) or via a single-binary distribution. They write
 * `<file>.fsm.ts` somewhere on their disk; their project may not be a
 * Node project at all (could be a Python repo, a docs folder, anywhere).
 * Bare specifier imports in the user's FSM (`import { state } from
 * '@aharness/core'`, `import { setup } from 'xstate'`) cannot be
 * resolved from the user's directory — there's no `node_modules` there.
 *
 * The loader resolves those specifiers from the harness install instead.
 * `import.meta.resolve` (stable in Node 20+) walks node_modules upward
 * from this module's location; since this module ships inside the harness
 * package, the resolution lands on harness's bundled `xstate` and on
 * `@aharness/core` itself (which IS this package, found via its
 * package metadata).
 *
 * Two consumers use these paths:
 *   - the esbuild compile step (`./compile.ts`) rewrites bundle imports to
 *     the resolved file URLs so the produced `.mjs` runs without a
 *     node_modules walk;
 *   - the schema-extraction step (`./sidecar.ts`) constructs a TypeScript
 *     program with explicit `paths` mappings so `ts-json-schema-generator`
 *     can resolve type references through the type declaration files
 *     under `node_modules/{xstate,@aharness/core}/`.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';

export interface InstallPaths {
  /** Absolute path to `node_modules/xstate/<entry>.{js,mjs,cjs}` for esbuild. */
  readonly xstateEntry: string;
  /** Absolute path to the directory holding xstate's `package.json`. */
  readonly xstatePackageDir: string;
  /** Absolute path to `@aharness/core`'s authoring-barrel entry. */
  readonly harnessCoreSdkEntry: string;
  /** Absolute path to the directory holding `@aharness/core`'s `package.json`. */
  readonly harnessCoreSdkPackageDir: string;
}

let cached: InstallPaths | null = null;

/**
 * Resolve `xstate` and `@aharness/core` from this module's location.
 * Cached after the first call — paths don't change for the lifetime of the
 * process.
 *
 * Throws if either package cannot be resolved. That indicates a broken
 * harness install (a published `@aharness/core` shipped without
 * bundling its deps); the runtime can't continue without knowing where to
 * point bundle imports.
 */
export async function getInstallPaths(): Promise<InstallPaths> {
  if (cached) return cached;

  const xstateEntryUrl = import.meta.resolve('xstate');
  const harnessCoreSdkEntryUrl = await resolveHarnessCoreSdk();

  const xstateEntry = fileURLToPath(xstateEntryUrl);
  const harnessCoreSdkEntry = fileURLToPath(harnessCoreSdkEntryUrl);
  const xstatePackageDir = await findPackageDir(xstateEntry);
  const harnessCoreSdkPackageDir = await findPackageDir(harnessCoreSdkEntry);

  cached = {
    xstateEntry,
    xstatePackageDir,
    harnessCoreSdkEntry,
    harnessCoreSdkPackageDir,
  };
  return cached;
}

/**
 * Resolve `@aharness/core`'s authoring-barrel entry. Falls back to
 * walking upward for workspace layouts where `import.meta.resolve` fails
 * (pnpm intra-package quirks — Node refuses to import a package from
 * within its own `node_modules` tree in some pnpm layouts).
 */
async function resolveHarnessCoreSdk(): Promise<string> {
  try {
    return import.meta.resolve('@aharness/core');
  } catch {
    // Fall through to package-walk.
  }
  const here = fileURLToPath(import.meta.url);
  let dir = path.dirname(here);
  // Cap the ancestor walk; pathological symlink loops or unexpected
  // filesystem layouts must not spin forever.
  const MAX_ANCESTOR_DEPTH = 64;
  for (let i = 0; i < MAX_ANCESTOR_DEPTH; i++) {
    // Try the sibling-package shape first: `<workspace>/packages/core`.
    const sibling = path.join(dir, 'packages', 'core', 'package.json');
    try {
      const raw = await fs.readFile(sibling, 'utf8');
      const pkg = JSON.parse(raw) as { name?: string; main?: string; module?: string };
      if (pkg.name === '@aharness/core') {
        const entry = pkg.module ?? pkg.main ?? 'dist/index.js';
        return pathToFileURL(path.resolve(path.dirname(sibling), entry)).href;
      }
    } catch {
      /* not the workspace root — keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `getInstallPaths: could not locate @aharness/core package.json walking up from ${here}`,
      );
    }
    dir = parent;
  }
  throw new Error(
    `getInstallPaths: exceeded ${String(MAX_ANCESTOR_DEPTH)} ancestor directories without finding @aharness/core (starting from ${here})`,
  );
}

/** Walk up from a file path until we find the directory containing `package.json`. */
async function findPackageDir(entryFile: string): Promise<string> {
  let dir = path.dirname(entryFile);
  // Cap the ancestor walk; see `resolveHarnessCoreSdk` for rationale.
  const MAX_ANCESTOR_DEPTH = 64;
  for (let i = 0; i < MAX_ANCESTOR_DEPTH; i++) {
    try {
      await fs.access(path.join(dir, 'package.json'));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) {
        throw new Error(`findPackageDir: no package.json found walking up from ${entryFile}`);
      }
      dir = parent;
    }
  }
  throw new Error(
    `findPackageDir: exceeded ${MAX_ANCESTOR_DEPTH} ancestor directories without finding package.json (starting from ${entryFile})`,
  );
}

/** Reset the cache. Tests only. */
export function _resetInstallPathsCache(): void {
  cached = null;
}
