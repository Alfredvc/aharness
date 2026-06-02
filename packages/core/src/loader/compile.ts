/**
 * Compile a `<file>.fsm.ts` to an ESM bundle and dynamic-import it.
 *
 * The aharness user does not install `@aharness/core` or `xstate` into
 * a local `node_modules` — they install the aharness CLI globally and write
 * `<file>.fsm.ts` in any directory. The bundled `.mjs` therefore cannot
 * leave bare specifier imports (`import 'xstate'`) — node would walk up
 * from `<userCwd>/.aharness/cache/<hash>/` and find nothing.
 *
 * The compile step rewrites bare specifiers to absolute paths (resolved
 * inside the aharness install via `getInstallPaths`) and marks them
 * external. The bundle's emitted imports look like
 *   import { setup } from "/abs/path/aharness/node_modules/xstate/dist/xstate.cjs.mjs";
 * which Node ESM accepts directly — no further resolution required at
 * load time. The user's local files (`./types`, `./render`) bundle in
 * the normal way.
 *
 * The bundle additionally re-exports a `__sidecar` literal (schemas, issues,
 * input metadata, and loader skill-origin metadata) injected via esbuild's
 * `banner` option. Warm-cache hits read it back off the imported module instead
 * of going through a separate `sidecar.json` file — see `cache.ts` history.
 *
 * This deviates from `SPEC_SDK.md` §6.2 step 1's `bundle: false`. The
 * spec line was written assuming a single-file FSM in a node project;
 * the example FSM splits across four `.ts` files, and the user's
 * project may not be a node project at all. Bundling local imports while
 * externalising aharness/xstate is the only consistent shape.
 */

import { promises as fs } from 'node:fs';
import { build, type Loader, type Metafile, type PartialMessage, type Plugin } from 'esbuild';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AnyStateMachine } from 'xstate';
import { getInstallPaths, type InstallPaths } from './installPath.js';
import { isSerializedSidecar, type SerializedSidecar } from './cache.js';
import {
  transformInstalledAssetCalls,
  type InstalledAssetDiagnostic,
  type InstalledAssetRecord,
} from './assets.js';
import { isPathInsideOrEqual } from '../internal/packagePaths.js';

const BARE_SPECIFIER_RE = /^(@aharness\/core|xstate)(\/.*)?$/;

export interface CompileResult {
  readonly outPath: string;
}

export interface InstalledBundleResult {
  readonly contents: Uint8Array;
  readonly inputFiles: readonly string[];
  readonly assetFiles: readonly string[];
}

/**
 * Bundle `entryFile` into `outPath`. Externalises `xstate` and
 * `@aharness/core` (including subpaths) by rewriting them to absolute
 * file paths in the aharness install. Injects `serializedSidecar` as a
 * top-of-file `export const __sidecar = …;` literal so warm-cache reads
 * pick it up directly off the imported module. Throws on esbuild errors.
 *
 * `serializedSidecar` is JSON-serialisable by construction: schemas and
 * issues are JSON-Schema/structured-record shapes, and any `arg<T>()`
 * default values are already constrained to the JSON-safe subset by the
 * static type system. U+2028 / U+2029 in user-supplied description strings
 * are valid inside ES2019+ string literals, which Node 20 (the bundle's
 * target) supports — no manual escape pass needed.
 */
export async function compileFsm(
  entryFile: string,
  outPath: string,
  serializedSidecar: SerializedSidecar,
): Promise<CompileResult> {
  const installPaths = await getInstallPaths();

  await build({
    entryPoints: [entryFile],
    outfile: outPath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    logLevel: 'silent',
    banner: {
      js: `export const __sidecar = ${JSON.stringify(serializedSidecar)};`,
    },
    plugins: [externalisePlugin(installPaths)],
  });
  return { outPath };
}

export async function buildInstalledFsmBundle(opts: {
  readonly entryFile: string;
  readonly serializedSidecar: SerializedSidecar;
  readonly packageRoot: string;
  readonly managedProjectRoot: string;
}): Promise<InstalledBundleResult> {
  const installPaths = await getInstallPaths();
  const packageRoot = path.resolve(opts.packageRoot);
  const managedProjectRoot = path.resolve(opts.managedProjectRoot);
  const assets: InstalledAssetRecord[] = [];
  const result = await build({
    entryPoints: [path.resolve(opts.entryFile)],
    outfile: path.join(managedProjectRoot, '.aharness', 'cache', 'installed', '__build', 'fsm.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    logLevel: 'silent',
    absWorkingDir: packageRoot,
    nodePaths: [path.join(managedProjectRoot, 'node_modules')],
    write: false,
    metafile: true,
    banner: {
      js: `export const __sidecar = ${JSON.stringify(opts.serializedSidecar)};`,
    },
    plugins: [
      installedAssetPlugin({ managedProjectRoot, assets }),
      externalisePlugin(installPaths),
    ],
  });

  const outputFile = result.outputFiles?.[0];
  if (!outputFile) {
    throw new Error('buildInstalledFsmBundle: esbuild returned no output file');
  }
  if (!result.metafile) {
    throw new Error('buildInstalledFsmBundle: esbuild returned no metafile');
  }

  return {
    contents: outputFile.contents,
    inputFiles: inputFilesFromMetafile(result.metafile, packageRoot),
    assetFiles: Array.from(new Set(assets.map((asset) => path.resolve(asset.resolvedFile)))).sort(),
  };
}

function inputFilesFromMetafile(metafile: Metafile, absWorkingDir: string): readonly string[] {
  const files: string[] = [];
  for (const inputPath of Object.keys(metafile.inputs)) {
    if (inputPath.startsWith('<')) continue;
    files.push(
      path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(absWorkingDir, inputPath),
    );
  }
  return Array.from(new Set(files)).sort();
}

function externalisePlugin(installPaths: InstallPaths): Plugin {
  return {
    name: 'aharness-externalise-runtime',
    setup(build) {
      build.onResolve({ filter: BARE_SPECIFIER_RE }, (args) => {
        const match = BARE_SPECIFIER_RE.exec(args.path);
        if (!match) return null;
        const pkg = match[1];
        const subPath = match[2];
        // FSM source files must not reach into the runtime-only surface
        // surface (transports, JSON-RPC client, app-server spawn, FSM
        // loader, protocol types). The split is structural per
        // `@aharness/core`'s `exports` map; this is the bundler-side
        // gate that surfaces the violation as a clear error instead of a
        // downstream `__require` shim failure.
        if (pkg === '@aharness/core' && subPath) {
          return {
            errors: [
              {
                text: `FSM source must not import '${args.path}'. The '@aharness/core/runtime' surface is daemon-only; FSMs import authoring primitives from '@aharness/core' (root) only.`,
              },
            ],
          };
        }
        if (subPath) {
          // Only `xstate/*` reaches here — `@aharness/core/<sub>` is
          // rejected above (the only sanctioned sub-path is `/runtime`,
          // which is daemon-only and not for FSM source).
          // Strip the leading slash before joining so `subPath = '/hooks'`
          // becomes `<root>/hooks`. We don't append `.js` — node ESM will
          // honour the package's `exports` map for sub-path imports if
          // the resolved file URL is given as an absolute file path.
          return { path: path.join(installPaths.xstatePackageDir, subPath), external: true };
        }
        // Bare package specifier — use the entry resolved via
        // `import.meta.resolve` (honours `exports`/`main`).
        const entry =
          pkg === 'xstate' ? installPaths.xstateEntry : installPaths.aharnessCoreSdkEntry;
        return { path: entry, external: true };
      });
    },
  };
}

function installedAssetPlugin(opts: {
  readonly managedProjectRoot: string;
  readonly assets: InstalledAssetRecord[];
}): Plugin {
  const nodeModulesRoot = path.join(path.resolve(opts.managedProjectRoot), 'node_modules');
  const realNodeModulesRoot = fs.realpath(nodeModulesRoot);
  return {
    name: 'aharness-installed-assets',
    setup(build) {
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
        if (args.namespace !== 'file') return null;
        const sourceFile = path.resolve(args.path);
        const realSourceFile = await fs.realpath(sourceFile);
        const resolvedRealNodeModulesRoot = await realNodeModulesRoot;
        if (!isPathInsideOrEqual(resolvedRealNodeModulesRoot, realSourceFile)) return null;
        const managedSourceFile = path.join(
          nodeModulesRoot,
          path.relative(resolvedRealNodeModulesRoot, realSourceFile),
        );

        const sourceText = await fs.readFile(sourceFile, 'utf8');
        const transformed = await transformInstalledAssetCalls({
          sourceFile: managedSourceFile,
          sourceText,
          managedProjectRoot: opts.managedProjectRoot,
        });

        if (transformed.diagnostics.length > 0) {
          return { errors: transformed.diagnostics.map(diagnosticToMessage) };
        }
        if (!transformed.changed) return null;

        opts.assets.push(...transformed.assets);
        return {
          contents: transformed.contents,
          loader: loaderForPath(sourceFile),
          resolveDir: path.dirname(sourceFile),
        };
      });
    },
  };
}

function diagnosticToMessage(diagnostic: InstalledAssetDiagnostic): PartialMessage {
  return {
    text: diagnostic.message,
    location: {
      file: diagnostic.sourceFile,
      namespace: 'file',
      line: diagnostic.line,
      column: diagnostic.column,
      length: diagnostic.length,
      lineText: diagnostic.lineText,
      suggestion: '',
    },
    detail: undefined,
  };
}

function loaderForPath(filePath: string): Loader {
  if (filePath.endsWith('.tsx')) return 'tsx';
  if (filePath.endsWith('.jsx')) return 'jsx';
  if (filePath.endsWith('.ts') || filePath.endsWith('.mts') || filePath.endsWith('.cts')) {
    return 'ts';
  }
  return 'js';
}

export interface ImportedFsmModule {
  readonly machine: AnyStateMachine;
  /**
   * The `__sidecar` literal re-exported by the bundle's banner — present
   * for any cache entry written by `compileFsm` at v4 or later. `null`
   * when the bundle does not expose `__sidecar` (manually-built bundles,
   * pre-v4 caches surviving via stray `modulePath` collisions) or when
   * the export is structurally invalid; `loadFsm` treats `null` as a
   * cache miss and falls back to a full rebuild.
   */
  readonly rawSidecar: SerializedSidecar | null;
}

/**
 * Dynamic-import a previously compiled bundle and return the FSM machine
 * plus the embedded `__sidecar` blob (when present and well-formed).
 *
 * Accepts either a `default` export or a named `machine` export for the
 * machine itself.
 */
export async function importFsmModule(modulePath: string): Promise<ImportedFsmModule> {
  const url = pathToFileURL(modulePath).href;
  const mod = (await import(url)) as {
    default?: unknown;
    machine?: unknown;
    __sidecar?: unknown;
  };
  const candidate = mod.default ?? mod.machine;
  if (candidate === undefined || candidate === null) {
    throw new Error(
      `importFsmModule: '${modulePath}' has neither a default nor a 'machine' named export`,
    );
  }
  // Structural smoke check before casting. XState v5 `StateMachine` instances
  // expose `id` (string), `config` (object), `transition` (function),
  // `implementations` (object), and `root` (object) — see
  // `packages/sdk/node_modules/xstate/dist/declarations/src/StateMachine.d.ts`.
  // A bundle that exported, say, the machine's setup builder instead would
  // crash deep inside the runtime; failing here points the FSM author at the
  // wrong export. We probe `implementations` and `root` (not just the first
  // three keys) so a plain config-shaped object can't masquerade as a machine.
  if (!isStateMachineLike(candidate)) {
    throw new Error(
      `importFsmModule: '${modulePath}' export is not an XState v5 StateMachine ` +
        `(missing 'id'/'config'/'transition'/'implementations'/'root'). ` +
        `Did you export a setup builder instead of '.createMachine(...)'?`,
    );
  }
  const rawSidecar = isSerializedSidecar(mod.__sidecar) ? mod.__sidecar : null;
  return { machine: candidate as AnyStateMachine, rawSidecar };
}

function isStateMachineLike(candidate: unknown): boolean {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const c = candidate as Record<string, unknown>;
  return (
    typeof c['id'] === 'string' &&
    typeof c['config'] === 'object' &&
    c['config'] !== null &&
    typeof c['transition'] === 'function' &&
    typeof c['implementations'] === 'object' &&
    c['implementations'] !== null &&
    typeof c['root'] === 'object' &&
    c['root'] !== null
  );
}
