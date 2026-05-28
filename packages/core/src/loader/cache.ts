/**
 * Loader cache — `SPEC_SDK.md` §3.3 closing line.
 *
 * Keyed by content hash of the user's source tree (the file containing
 * `state({ exits: { … } })` calls plus its sibling `.ts` files in the
 * same source directory, recursively, excluding `node_modules`, `dist`,
 * and the cache directory itself) plus the entry file's basename. The
 * entry-basename salt is required because two FSMs in the same directory
 * (e.g. `parent.fsm.ts` and `child-spec.fsm.ts`) share a tree-content
 * hash; without the salt the second `loadFsm` would hit the first's
 * cache entry and return the wrong compiled machine. On hit, the loader
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
 *   <repoRoot>/.harness/cache/<hash>/
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
 *   - Skips `node_modules`, `dist`, `.harness`, and any directory whose
 *     basename starts with `.` (so `.git`, `.idea`, etc. don't bloat the
 *     hash). The user can still place a project source file under a
 *     dot-directory; that's a deliberate trade-off for cache stability.
 *   - Salts the hash with the loader's own version marker so a future
 *     change to the schema-extraction algorithm invalidates every cache
 *     without having to clear `.harness/cache/` manually.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { JSONSchema7 } from 'json-schema';
import type { SidecarIssue } from './sidecar.js';
import type { ArgFlagMeta } from './inputSchema.js';

/**
 * Bumped when the loader's serialisation shape changes.
 *
 * v4 (2026-05-09): merge `sidecar.json` into `fsm.mjs` as a re-exported
 *   `__sidecar` literal. The two-file split is gone; warm-cache hits
 *   read the schema blob off the imported module (no separate readFile +
 *   JSON.parse). v3 cache directories are orphaned by the version salt.
 *
 * v3 (2026-05-08): adds optional `inputSchema` + `inputFlags` fields for
 *   `arg<T>()` / `input` declarations on the root machine config. Phase 4's
 *   `harness __complete` consumes these for shell completion.
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
const CACHE_VERSION = 'v4';

const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', '.harness']);

export interface CachePaths {
  readonly cacheRoot: string;
  readonly cacheDir: string;
  readonly hash: string;
  readonly modulePath: string;
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
  /**
   * Top-level JSON Schema for the FSM's `input` declaration. Present iff the
   * source file's default-export `harness.machine(...)` declared `input: {...}`.
   * Empty `input: {}` is persisted as a non-empty schema with zero properties.
   */
  readonly inputSchema?: JSONSchema7;
  /**
   * Per-field `arg<T>(meta?)` metadata. Present iff `inputSchema` is present.
   * `completion: {dynamic: <fn>}` declarations persist as `{dynamic: true}` —
   * the live callback is not JSON-serialisable; Phase 4's `harness __complete`
   * re-imports the source module to invoke it.
   */
  readonly inputFlags?: Record<string, ArgFlagMeta>;
}

/**
 * Compute a SHA-256 over every `.ts`/`.tsx` file under `sourceRoot`,
 * excluding the directories listed in `SKIP_DIR_NAMES`. The hash is
 * salted with `CACHE_VERSION` (so a loader update invalidates prior
 * caches) and the entry file's basename (so two FSMs in the same
 * directory get distinct cache entries).
 */
export async function hashSourceTree(sourceRoot: string, entryFile: string): Promise<string> {
  const files: string[] = [];
  await collectFiles(sourceRoot, files);
  files.sort();

  const hasher = createHash('sha256');
  hasher.update(`harness-loader-cache:${CACHE_VERSION}\n`);
  hasher.update(`E:${path.basename(entryFile)}\n`);
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
  const cacheRoot = path.join(repoRoot, '.harness', 'cache');
  const cacheDir = path.join(cacheRoot, hash);
  return {
    cacheRoot,
    cacheDir,
    hash,
    modulePath: path.join(cacheDir, 'fsm.mjs'),
  };
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
  if (!('schemas' in obj) || !('issues' in obj)) return false;
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
