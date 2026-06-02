/**
 * Loader cache — `SPEC_SDK.md` §3.3 closing line.
 *
 * Keyed by content hash of the user's source tree (the file containing
 * `state({ exits: { … } })` calls plus its sibling `.ts` files in the
 * same source directory, recursively, excluding `node_modules`, `dist`,
 * and the cache directory itself) plus the absolute entry file path. The
 * absolute entry salt is required because the serialized sidecar includes
 * absolute skill-origin metadata; without it, identical source trees loaded
 * under one repoRoot could replay another tree's origins. On hit, the loader
 * skips esbuild bundling and `ts-json-schema-generator` extraction; it
 * dynamic-imports the cached `fsm.mjs` and recompiles ajv validators
 * from the `__sidecar` JSON-Schema blob the bundle re-exports.
 *
 * Compiled ajv validators are not serialised. Recompiling them with
 * `ajv.compile(schema)` per cache hit costs ~hundreds of microseconds for
 * the small payload schemas the example FSMs produce — well below the
 * spec's "milliseconds" target for a warm reload.
 *
 * Cache layout:
 *
 *   <repoRoot>/.aharness/cache/<hash>/
 *     fsm.mjs        # esbuild bundle of <file>.fsm.ts; re-exports
 *                    # `__sidecar` (a SerializedSidecar literal injected
 *                    # via esbuild's `banner` option at compile time).
 *
 * Hash semantics:
 *
 *   - Content-only (no mtime). git checkouts and pristine clones produce
 *     stable hashes across machines.
 *   - Recursive over the source directory the FSM file lives in, walking
 *     `.ts` and `.tsx` files. This captures the typical user layout
 *     (`src/index.fsm.ts` + `src/types.ts` + `src/render.ts`) without
 *     having to introspect the TypeScript program.
 *   - Skips `node_modules`, `dist`, `.aharness`, and any directory whose
 *     basename starts with `.` (so `.git`, `.idea`, etc. don't bloat the
 *     hash). The user can still place a project source file under a
 *     dot-directory; that's a deliberate trade-off for cache stability.
 *   - Salts the hash with the loader's own version marker so a future
 *     change to the schema/origin-extraction algorithm invalidates every cache
 *     without having to clear `.aharness/cache/` manually.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { JSONSchema7 } from 'json-schema';
import { canonicalJson } from '../internal/canonicalJson.js';
import type { AvailableSkillRef } from '../state/skills.js';
import type { SidecarIssue } from './sidecar.js';
import type { ArgFlagMeta } from './inputSchema.js';

/**
 * Bumped when the loader's serialisation shape changes.
 *
 * v5 (2026-06-02): adds required `skillOriginManifest` metadata to the
 *   serialized sidecar and salts direct-cache keys with the absolute FSM entry
 *   path so warm hits cannot replay another source tree's absolute origins.
 *
 * v4 (2026-05-09): merge `sidecar.json` into `fsm.mjs` as a re-exported
 *   `__sidecar` literal. The two-file split is gone; warm-cache hits
 *   read the schema blob off the imported module (no separate readFile +
 *   JSON.parse). v3 cache directories are orphaned by the version salt.
 *
 * v3 (2026-05-08): adds optional `inputSchema` + `inputFlags` fields for
 *   `arg<T>()` / `input` declarations on the root machine config. Phase 4's
 *   `aharness completion-server` bridge consumes these for shell completion.
 *
 *   The `inputFlags` value persists `{dynamic: true}` as a sentinel for
 *   `completion: {dynamic: <fn>}` — the function reference is not
 *   JSON-serialisable, so warm-cache hits cannot serve dynamic completion
 *   callbacks. Phase 4 re-imports the FSM source via `loadFsm`'s
 *   dynamic-import path to invoke the live callback.
 *
 * v2 (2026-04-29): top-level discriminated-union schemas now carry
 *   `type: "object"` so MCP's `inputSchema.type === "object"` contract holds.
 *   Pre-v2 caches encode the bare-`anyOf` shape MCP rejects.
 */
const CACHE_VERSION = 'v5';
/**
 * Installed-package cache key version.
 *
 * v3 (2026-06-02): adds required `skillOriginManifest` metadata to the
 *   serialized sidecar. The installed cache key already includes the full
 *   serialized sidecar, so origin declaration changes affect the hash.
 *
 * v2 (2026-05-29): adds a separate validated asset-file section so package
 *   asset content changes invalidate installed bundles without changing the
 *   direct-file cache key shape.
 *
 * v1 (2026-05-28): initial package-aware cache key from esbuild metafile
 *   source inputs plus package identity, host runtime identity, sidecar
 *   serialization, and lock fingerprint.
 */
const INSTALLED_CACHE_VERSION = 'v3';

const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', '.aharness']);

export interface CachePaths {
  readonly cacheRoot: string;
  readonly cacheDir: string;
  readonly hash: string;
  readonly modulePath: string;
}

export interface InstalledCacheKeyOptions {
  readonly packageName: string;
  readonly commandName: string;
  readonly entryFile: string;
  readonly packageRoot: string;
  readonly managedProjectRoot: string;
  readonly lockFingerprint: string;
  readonly aharnessCoreEntry: string;
  readonly aharnessCorePackageDir: string;
  readonly xstateEntry: string;
  readonly xstatePackageDir: string;
  readonly serializedSidecar: SerializedSidecar;
  readonly inputFiles: readonly string[];
  readonly assetFiles?: readonly string[];
}

export interface SkillOriginManifest {
  readonly rootSourceDir: string;
  readonly sourceDirPrefixes: readonly {
    readonly stateIdPrefix: string;
    readonly sourceDir: string;
  }[];
  readonly availableSkills: readonly {
    readonly sourceDir: string;
    readonly ref: AvailableSkillRef;
  }[];
}

/**
 * Shape of the `__sidecar` re-export injected into the compiled `fsm.mjs`
 * via esbuild's `banner` option (`compile.ts`). The bundle stringifies a
 * `SerializedSidecar` literal at compile time; the loader's warm path reads
 * it back off `mod.__sidecar` and rehydrates ajv validators from the embedded
 * JSON Schemas.
 */
export interface SerializedSidecar {
  /** Schemas keyed by `[stateId][exitName]` to mirror the runtime sidecar shape. */
  readonly schemas: Record<string, Record<string, JSONSchema7>>;
  readonly issues: readonly SidecarIssue[];
  /** Loader-only metadata used by later runtime slices to resolve native skill refs. */
  readonly skillOriginManifest: SkillOriginManifest;
  /**
   * Top-level JSON Schema for the FSM's `input` declaration. Present iff the
   * source file's default-export `aharness.machine(...)` declared `input: {...}`.
   * Empty `input: {}` is persisted as a non-empty schema with zero properties.
   */
  readonly inputSchema?: JSONSchema7;
  /**
   * Per-field `arg<T>(meta?)` metadata. Present iff `inputSchema` is present.
   * `completion: {dynamic: <fn>}` declarations persist as `{dynamic: true}` —
   * the live callback is not JSON-serialisable; Phase 4's `aharness __complete`
   * re-imports the source module to invoke it.
   */
  readonly inputFlags?: Record<string, ArgFlagMeta>;
}

/**
 * Compute a SHA-256 over every `.ts`/`.tsx` file under `sourceRoot`,
 * excluding the directories listed in `SKIP_DIR_NAMES`. The hash is
 * salted with `CACHE_VERSION` (so a loader update invalidates prior caches)
 * and the absolute entry file path (so absolute skill-origin metadata cannot
 * be shared across identical source trees at different locations).
 */
export async function hashSourceTree(sourceRoot: string, entryFile: string): Promise<string> {
  const files: string[] = [];
  await collectFiles(sourceRoot, files);
  files.sort();

  const hasher = createHash('sha256');
  hasher.update(`aharness-loader-cache:${CACHE_VERSION}\n`);
  hasher.update(`E:${path.resolve(entryFile)}\n`);
  for (const file of files) {
    const rel = path.relative(sourceRoot, file);
    const buf = await fs.readFile(file);
    hasher.update(`F:${rel}:${buf.byteLength}\n`);
    hasher.update(buf);
    hasher.update('\n');
  }
  return hasher.digest('hex');
}

async function collectFiles(dir: string, out: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
}

export function cachePathsFor(repoRoot: string, hash: string): CachePaths {
  const cacheRoot = path.join(repoRoot, '.aharness', 'cache');
  const cacheDir = path.join(cacheRoot, hash);
  return {
    cacheRoot,
    cacheDir,
    hash,
    modulePath: path.join(cacheDir, 'fsm.mjs'),
  };
}

export function installedCachePathsFor(managedProjectRoot: string, hash: string): CachePaths {
  const cacheRoot = path.join(managedProjectRoot, '.aharness', 'cache', 'installed');
  const cacheDir = path.join(cacheRoot, hash);
  return {
    cacheRoot,
    cacheDir,
    hash,
    modulePath: path.join(cacheDir, 'fsm.mjs'),
  };
}

export async function hashInstalledBundleInputs(opts: InstalledCacheKeyOptions): Promise<string> {
  const managedProjectRoot = path.resolve(opts.managedProjectRoot);
  const packageRoot = path.resolve(opts.packageRoot);
  const entryFile = path.resolve(opts.entryFile);
  const inputFiles = Array.from(new Set(opts.inputFiles.map((file) => path.resolve(file)))).sort();
  const inputFileSet = new Set(inputFiles);
  const assetFiles = Array.from(new Set((opts.assetFiles ?? []).map((file) => path.resolve(file))))
    .filter((file) => !inputFileSet.has(file))
    .sort();

  const hasher = createHash('sha256');
  const aharnessCoreVersion = await readPackageVersion(opts.aharnessCorePackageDir);
  const xstateVersion = await readPackageVersion(opts.xstatePackageDir);
  hasher.update(`aharness-installed-loader-cache:${INSTALLED_CACHE_VERSION}\n`);
  hasher.update(
    canonicalJson({
      packageName: opts.packageName,
      commandName: opts.commandName,
      entry: relativeOrAbsolute(packageRoot, entryFile),
      packageRoot: relativeOrAbsolute(managedProjectRoot, packageRoot),
      lockFingerprint: opts.lockFingerprint,
      aharnessCoreEntry: path.resolve(opts.aharnessCoreEntry),
      aharnessCorePackageDir: path.resolve(opts.aharnessCorePackageDir),
      aharnessCoreVersion,
      xstateEntry: path.resolve(opts.xstateEntry),
      xstatePackageDir: path.resolve(opts.xstatePackageDir),
      xstateVersion,
      serializedSidecar: opts.serializedSidecar,
    }),
  );
  hasher.update('\n');

  for (const file of inputFiles) {
    const buf = await fs.readFile(file);
    hasher.update(`F:${relativeOrAbsolute(managedProjectRoot, file)}:${buf.byteLength}\n`);
    hasher.update(buf);
    hasher.update('\n');
  }
  hasher.update('A:assets\n');
  for (const file of assetFiles) {
    const buf = await fs.readFile(file);
    hasher.update(`A:${relativeOrAbsolute(managedProjectRoot, file)}:${buf.byteLength}\n`);
    hasher.update(buf);
    hasher.update('\n');
  }

  return hasher.digest('hex');
}

async function readPackageVersion(packageDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(packageDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

function relativeOrAbsolute(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  if (relative.length === 0) return '.';
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  return path.resolve(filePath);
}

/**
 * Structural type-guard for the `__sidecar` blob re-exported by the compiled
 * `fsm.mjs`. Mirrors the on-disk JSON validation that pre-v4 caches did when
 * reading `sidecar.json`. A failed guard returns `false`, signalling cache
 * miss so `loadFsm` falls back to a full rebuild rather than crashing later
 * in `rehydrateSidecar`. Cache corruption is recoverable; data loss is not.
 */
export function isSerializedSidecar(parsed: unknown): parsed is SerializedSidecar {
  if (!parsed || typeof parsed !== 'object') return false;
  const obj = parsed as Record<string, unknown>;
  if (!('schemas' in obj) || !('issues' in obj) || !('skillOriginManifest' in obj)) return false;
  const schemas = obj['schemas'];
  if (!schemas || typeof schemas !== 'object') return false;
  for (const exits of Object.values(schemas as Record<string, unknown>)) {
    if (!exits || typeof exits !== 'object') return false;
    for (const schema of Object.values(exits as Record<string, unknown>)) {
      if (!schema || typeof schema !== 'object') return false;
    }
  }
  const issues = obj['issues'];
  if (!Array.isArray(issues)) return false;
  for (const issue of issues) {
    if (!issue || typeof issue !== 'object') return false;
    const i = issue as Record<string, unknown>;
    if (typeof i['code'] !== 'string') return false;
    if (typeof i['message'] !== 'string') return false;
    if (typeof i['line'] !== 'number') return false;
    if (i['stateId'] !== null && typeof i['stateId'] !== 'string') return false;
    if (i['exitName'] !== null && typeof i['exitName'] !== 'string') return false;
  }
  if (!isSkillOriginManifest(obj['skillOriginManifest'])) return false;
  if ('inputSchema' in obj) {
    const inSchema = obj['inputSchema'];
    if (inSchema !== undefined && (!inSchema || typeof inSchema !== 'object')) return false;
  }
  if ('inputFlags' in obj) {
    const inFlags = obj['inputFlags'];
    if (inFlags !== undefined) {
      if (!inFlags || typeof inFlags !== 'object') return false;
      for (const v of Object.values(inFlags as Record<string, unknown>)) {
        if (!v || typeof v !== 'object') return false;
      }
    }
  }
  return true;
}

function isSkillOriginManifest(parsed: unknown): parsed is SkillOriginManifest {
  if (!parsed || typeof parsed !== 'object') return false;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['rootSourceDir'] !== 'string') return false;
  const prefixes = obj['sourceDirPrefixes'];
  if (!Array.isArray(prefixes)) return false;
  for (const prefix of prefixes) {
    if (!prefix || typeof prefix !== 'object') return false;
    const p = prefix as Record<string, unknown>;
    if (typeof p['stateIdPrefix'] !== 'string' || typeof p['sourceDir'] !== 'string') {
      return false;
    }
  }
  const availableSkills = obj['availableSkills'];
  if (!Array.isArray(availableSkills)) return false;
  for (const entry of availableSkills) {
    if (!entry || typeof entry !== 'object') return false;
    const e = entry as Record<string, unknown>;
    if (typeof e['sourceDir'] !== 'string') return false;
    if (!isSerializedAvailableSkillRef(e['ref'])) return false;
  }
  return true;
}

function isSerializedAvailableSkillRef(parsed: unknown): parsed is AvailableSkillRef {
  if (!parsed || typeof parsed !== 'object') return false;
  const obj = parsed as Record<string, unknown>;
  if (obj['__aharnessSkillRef'] !== true) return false;
  if (obj['source'] === 'path') {
    return typeof obj['path'] === 'string' && typeof obj['optional'] === 'boolean';
  }
  if (obj['source'] === 'dir') {
    return typeof obj['path'] === 'string';
  }
  return false;
}

export async function moduleExists(p: CachePaths): Promise<boolean> {
  try {
    const stat = await fs.stat(p.modulePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function ensureCacheDir(p: CachePaths): Promise<void> {
  await fs.mkdir(p.cacheDir, { recursive: true });
}
