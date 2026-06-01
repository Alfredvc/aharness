/**
 * Loader entry point — `loadFsm(filePath, repoRoot)`.
 *
 * Wires AST schema extraction (`./sidecar`), esbuild compilation (`./compile`),
 * dynamic import, and the content-hash cache (`./cache`) into a single async
 * function called by the `aharness <file>.fsm.ts` command (§6.2 step 1).
 *
 * The result is consumed by:
 *   - the verifier (`verify(machine, sidecar, issues)`);
 *   - the submit-tool builder (`buildSubmitTools(machine, sidecar, runId)`);
 *   - the submit dispatcher (validates payloads via `sidecar[stateId].validate`).
 *
 * Cache semantics: hash all `.ts`/`.tsx` files under `dirname(filePath)`
 * (recursive, skipping `node_modules`/`dist`/`.aharness`/dot-dirs) plus a
 * loader-version salt and the entry file's basename. The entry-basename
 * salt keeps two FSMs in the same directory (e.g. `parent.fsm.ts` +
 * `child-spec.fsm.ts`) from colliding on the same cache entry. On hit,
 * dynamic-import the cached `fsm.mjs`; the bundle re-exports a `__sidecar`
 * literal (injected by `compileFsm`'s esbuild banner) which the loader
 * reads back to recompile ajv validators. On miss, run the extractor +
 * esbuild bundler. `noCache: true` skips the read side; the write side
 * always runs so subsequent loads warm up.
 *
 * Cache location is `<repoRoot>/.aharness/cache/<hash>/`. `repoRoot` is the
 * user's project root (where their `package.json` and `node_modules` sit).
 * The bundled `fsm.mjs` keeps `xstate` and `@aharness/core` as runtime
 * externals; node's upward `node_modules` resolution from the cache
 * directory walks back to `<repoRoot>/node_modules/` and finds them.
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { Ajv } from 'ajv';
import type { JSONSchema7 } from 'json-schema';
import type { AnyStateMachine } from 'xstate';
import type { SchemaSidecar, SidecarValidateResult, ValidationError } from '../types.js';
import {
  cachePathsFor,
  ensureCacheDir,
  hashInstalledBundleInputs,
  hashSourceTree,
  installedCachePathsFor,
  moduleExists,
  type SerializedSidecar,
} from './cache.js';
import { buildInstalledFsmBundle, compileFsm, importFsmModule } from './compile.js';
import { getInstallPaths } from './installPath.js';
import { extractSchemaSidecar, type SidecarIssue } from './sidecar.js';
import type { ArgFlagMeta } from './inputSchema.js';

export interface LoadFsmOptions {
  /** Absolute or relative path to the user's `<file>.fsm.ts`. */
  readonly filePath: string;
  /** Project root — where `.aharness/cache/` and `node_modules/` live. */
  readonly repoRoot: string;
  /** When `true`, skip the cache read side (for tests / debug). */
  readonly noCache?: boolean;
}

export interface LoadInstalledFsmOptions {
  readonly entryFile: string;
  readonly packageName: string;
  readonly commandName: string;
  readonly packageRoot: string;
  readonly managedProjectRoot: string;
  readonly storeRoot: string;
  readonly lockFingerprint: string;
  readonly noCache?: boolean;
}

export interface LoadFsmResult {
  readonly machine: AnyStateMachine;
  readonly sidecar: SchemaSidecar;
  /** Absolute path of the compiled `.mjs` bundle. */
  readonly modulePath: string;
  /** Recoverable issues surfaced by the extractor (verifier should re-emit). */
  readonly issues: readonly SidecarIssue[];
  /** `true` if the result came from a cache hit. */
  readonly cacheHit: boolean;
  /** The content-hash that keys the cache directory. */
  readonly hash: string;
  /**
   * Top-level JSON Schema for the FSM's `input` declaration. Present iff the
   * source file's default-export `aharness.machine(...)` declared `input: {...}`.
   * Consumed by the CLI argv parser (Task 14) and `aharness __complete` (Phase 4).
   */
  readonly inputSchema?: JSONSchema7;
  /**
   * Per-field `arg<T>(meta?)` metadata. Present alongside `inputSchema`.
   * `completion: {dynamic: <fn>}` declarations are reduced to `{dynamic: true}`
   * — the live callback is not JSON-serialisable. Phase 4's `aharness __complete`
   * re-imports the FSM source to obtain the live callback when the user presses
   * Tab on a dynamic flag value.
   */
  readonly inputFlags?: Record<string, ArgFlagMeta>;
}

export class RetiredOwnerDecisionSurfaceError extends Error {
  readonly issues: readonly SidecarIssue[];

  constructor(issues: readonly SidecarIssue[]) {
    super('FSM uses retired owner-decision authoring surfaces');
    this.name = 'RetiredOwnerDecisionSurfaceError';
    this.issues = issues;
  }
}

function retiredOwnerDecisionIssues(issues: readonly SidecarIssue[]): readonly SidecarIssue[] {
  return issues.filter((issue) => issue.code === 'retired-owner-decision');
}

export async function loadFsm(opts: LoadFsmOptions): Promise<LoadFsmResult> {
  const filePath = path.resolve(opts.filePath);
  const sourceRoot = path.dirname(filePath);
  const hash = await hashSourceTree(sourceRoot, filePath);
  const paths = cachePathsFor(opts.repoRoot, hash);

  if (!opts.noCache && (await moduleExists(paths))) {
    // Warm path: dynamic-import the cached bundle and pick up the embedded
    // `__sidecar` blob. A missing/malformed `__sidecar` (corrupted cache,
    // stray pre-banner bundle) collapses to a cache miss via the `null`
    // branch below; we fall through to the cold path which rewrites the
    // bundle with a fresh banner.
    const imported = await importFsmModule(paths.modulePath);
    if (imported.rawSidecar) {
      const cached = imported.rawSidecar;
      const sidecar = rehydrateSidecar(cached);
      return {
        machine: imported.machine,
        sidecar,
        modulePath: paths.modulePath,
        issues: cached.issues,
        cacheHit: true,
        hash,
        ...(cached.inputSchema
          ? { inputSchema: cached.inputSchema, inputFlags: cached.inputFlags ?? {} }
          : {}),
      };
    }
  }

  const extraction = await extractSchemaSidecar({ filePath });
  const retiredIssues = retiredOwnerDecisionIssues(extraction.issues);
  if (retiredIssues.length > 0) {
    throw new RetiredOwnerDecisionSurfaceError(retiredIssues);
  }
  await ensureCacheDir(paths);
  const serialized: SerializedSidecar = {
    schemas: schemasOnly(extraction.sidecar),
    issues: extraction.issues,
    ...(extraction.inputSchema
      ? { inputSchema: extraction.inputSchema, inputFlags: extraction.inputFlags ?? {} }
      : {}),
  };
  await compileFsm(filePath, paths.modulePath, serialized);
  const imported = await importFsmModule(paths.modulePath);
  return {
    machine: imported.machine,
    sidecar: extraction.sidecar,
    modulePath: paths.modulePath,
    issues: extraction.issues,
    cacheHit: false,
    hash,
    ...(extraction.inputSchema
      ? { inputSchema: extraction.inputSchema, inputFlags: extraction.inputFlags ?? {} }
      : {}),
  };
}

export async function loadInstalledFsm(opts: LoadInstalledFsmOptions): Promise<LoadFsmResult> {
  const normalized = normalizeInstalledFsmOptions(opts);
  const { entryFile, packageRoot, managedProjectRoot } = normalized;

  const extraction = await extractSchemaSidecar({
    filePath: entryFile,
    packageResolution: { packageRoot, managedProjectRoot },
  });
  const retiredIssues = retiredOwnerDecisionIssues(extraction.issues);
  if (retiredIssues.length > 0) {
    throw new RetiredOwnerDecisionSurfaceError(retiredIssues);
  }
  const serialized = serializeExtraction(extraction);
  const bundle = await buildInstalledFsmBundle({
    entryFile,
    serializedSidecar: serialized,
    packageRoot,
    managedProjectRoot,
  });
  const installPaths = await getInstallPaths();
  const hash = await hashInstalledBundleInputs({
    packageName: opts.packageName,
    commandName: opts.commandName,
    entryFile,
    packageRoot,
    managedProjectRoot,
    lockFingerprint: opts.lockFingerprint,
    aharnessCoreEntry: installPaths.aharnessCoreSdkEntry,
    aharnessCorePackageDir: installPaths.aharnessCoreSdkPackageDir,
    xstateEntry: installPaths.xstateEntry,
    xstatePackageDir: installPaths.xstatePackageDir,
    serializedSidecar: serialized,
    inputFiles: bundle.inputFiles,
    assetFiles: bundle.assetFiles,
  });
  const paths = installedCachePathsFor(managedProjectRoot, hash);

  if (!opts.noCache && (await moduleExists(paths))) {
    const imported = await importFsmModule(paths.modulePath);
    if (imported.rawSidecar) {
      const cached = imported.rawSidecar;
      return {
        machine: imported.machine,
        sidecar: rehydrateSidecar(cached),
        modulePath: paths.modulePath,
        issues: cached.issues,
        cacheHit: true,
        hash,
        ...(cached.inputSchema
          ? { inputSchema: cached.inputSchema, inputFlags: cached.inputFlags ?? {} }
          : {}),
      };
    }
  }

  await ensureCacheDir(paths);
  await fs.writeFile(paths.modulePath, bundle.contents);
  const imported = await importFsmModule(paths.modulePath);
  return {
    machine: imported.machine,
    sidecar: extraction.sidecar,
    modulePath: paths.modulePath,
    issues: extraction.issues,
    cacheHit: false,
    hash,
    ...(extraction.inputSchema
      ? { inputSchema: extraction.inputSchema, inputFlags: extraction.inputFlags ?? {} }
      : {}),
  };
}

function normalizeInstalledFsmOptions(opts: LoadInstalledFsmOptions): {
  readonly entryFile: string;
  readonly packageRoot: string;
  readonly managedProjectRoot: string;
  readonly storeRoot: string;
} {
  return {
    entryFile: normalizeRequiredPath('entryFile', opts.entryFile),
    packageRoot: normalizeRequiredPath('packageRoot', opts.packageRoot),
    managedProjectRoot: normalizeRequiredPath('managedProjectRoot', opts.managedProjectRoot),
    storeRoot: normalizeRequiredPath('storeRoot', opts.storeRoot),
  };
}

function normalizeRequiredPath(label: string, value: string): string {
  if (value.length === 0) {
    throw new Error(`loadInstalledFsm: ${label} must be a non-empty path`);
  }
  return path.resolve(value);
}

function serializeExtraction(extraction: {
  readonly sidecar: SchemaSidecar;
  readonly issues: readonly SidecarIssue[];
  readonly inputSchema?: JSONSchema7;
  readonly inputFlags?: Record<string, ArgFlagMeta>;
}): SerializedSidecar {
  return {
    schemas: schemasOnly(extraction.sidecar),
    issues: extraction.issues,
    ...(extraction.inputSchema
      ? { inputSchema: extraction.inputSchema, inputFlags: extraction.inputFlags ?? {} }
      : {}),
  };
}

function schemasOnly(sidecar: SchemaSidecar): Record<string, Record<string, JSONSchema7>> {
  const out: Record<string, Record<string, JSONSchema7>> = {};
  for (const stateId of Object.keys(sidecar)) {
    const exits = sidecar[stateId];
    if (!exits) continue;
    const slot: Record<string, JSONSchema7> = {};
    for (const exitName of Object.keys(exits)) {
      const entry = exits[exitName];
      if (entry) slot[exitName] = entry.jsonSchema;
    }
    if (Object.keys(slot).length > 0) out[stateId] = slot;
  }
  return out;
}

type ExitEntry = NonNullable<NonNullable<SchemaSidecar[string]>[string]>;

function rehydrateSidecar(serialized: SerializedSidecar): SchemaSidecar {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const out: Record<string, Record<string, ExitEntry>> = {};
  for (const stateId of Object.keys(serialized.schemas)) {
    const exits = serialized.schemas[stateId];
    if (!exits) continue;
    const slot: Record<string, ExitEntry> = {};
    for (const exitName of Object.keys(exits)) {
      const schema = exits[exitName];
      if (!schema) continue;
      const fn = ajv.compile(schema as object);
      slot[exitName] = {
        jsonSchema: schema,
        validate: (input: unknown): SidecarValidateResult => {
          if (fn(input)) return { ok: true, data: input };
          const errs: ValidationError[] = (fn.errors ?? []).map(
            (e): ValidationError => ({
              path: e.instancePath,
              message: e.message ?? 'invalid',
            }),
          );
          return { ok: false, errors: errs };
        },
      };
    }
    if (Object.keys(slot).length > 0) out[stateId] = slot;
  }
  return out;
}

export type { SidecarIssue, SerializedSidecar };
