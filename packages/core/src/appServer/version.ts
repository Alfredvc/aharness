/**
 * `codex --version` output parser and minimum-version gate.
 *
 * The pinned minimum is read from
 * `packages/core/scripts/codex-version-min.txt`. That file holds one of
 * two formats:
 *
 *   1. **Semver** — e.g. `0.42.0` or `1.2.3-pre.1`. The gate compares the
 *      installed `codex --version` output against the pinned semver and
 *      rejects older codex installs.
 *
 *   2. **Git pin** — `git-<7+ hex>`. This legacy format is retained for
 *      source-checkout pins. Against a git-pin the gate cannot do a semver
 *      comparison; it accepts any reachable codex install and emits a
 *      warning message that the doctor command (Task 38) surfaces to the
 *      user.
 *
 * Both formats are handled here behind a single `checkCodexVersion` entry.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The pinned minimum codex version, read from
 * `packages/core/scripts/codex-version-min.txt`. Either a semver
 * (`0.42.0`) or a git-pin (`git-127434cd8b96`).
 */
export const MIN_CODEX_VERSION = readFileSync(
  join(here, '..', '..', 'scripts', 'codex-version-min.txt'),
  'utf8',
).trim();

const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?/;
const GIT_PIN_RE = /^git-[0-9a-f]{7,}$/;

/**
 * Extracts the first semver-shaped substring from `codex --version` stdout.
 * Returns `null` when no semver is present.
 *
 * Examples (cited in tests):
 *   - `codex 0.42.0\n`              → `0.42.0`
 *   - `codex-cli 0.42.1 (abc1234)`  → `0.42.1`
 *   - `garbage`                     → `null`
 */
export function parseCodexVersion(stdout: string): string | null {
  const m = stdout.match(SEMVER_RE);
  return m ? m[0] : null;
}

/**
 * Numeric semver comparison over the major/minor/patch triple. Pre-release
 * suffixes are ignored (the parser strips them; this comparator only sees
 * the triple).
 *
 * Returns negative, zero, or positive (sort-comparator convention).
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((s) => parseInt(s, 10));
  const pb = b.split('.').map((s) => parseInt(s, 10));
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
  }
  return 0;
}

/**
 * Returns `true` when `s` is a git-pin literal (`git-<7+ hex>`).
 */
export function isGitPin(s: string): boolean {
  return GIT_PIN_RE.test(s);
}

export interface VersionGateResult {
  readonly ok: boolean;
  readonly found: string | null;
  readonly required: string;
  readonly message?: string;
}

/**
 * Runs `codex --version` via the injected spawner and compares the parsed
 * version against `required` (defaulting to `MIN_CODEX_VERSION`).
 *
 * Branches:
 *   - `required` is a git-pin → cannot semver-compare; returns `ok: true`
 *     with a warning `message` so callers (e.g. doctor) can surface it.
 *     Still rejects unreachable codex / unparseable output.
 *   - `required` is a semver  → strict numeric comparison.
 *
 * The spawn shape is intentionally narrow so tests can inject pure
 * fixtures without touching the real `node:child_process` surface.
 */
export async function checkCodexVersion(
  spawn: (cmd: string, args: ReadonlyArray<string>) => Promise<{ stdout: string; status: number }>,
  required: string = MIN_CODEX_VERSION,
): Promise<VersionGateResult> {
  let out: { stdout: string; status: number };
  try {
    out = await spawn('codex', ['--version']);
  } catch {
    return { ok: false, found: null, required, message: '`codex` not on PATH' };
  }
  if (out.status !== 0) {
    return { ok: false, found: null, required, message: '`codex --version` exited non-zero' };
  }
  const found = parseCodexVersion(out.stdout);
  if (!found) {
    return { ok: false, found: null, required, message: 'unrecognized codex version output' };
  }
  if (isGitPin(required)) {
    return {
      ok: true,
      found,
      required,
      message: `min is a git-pin (${required}); cannot semver-compare against codex ${found}`,
    };
  }
  if (compareSemver(found, required) < 0) {
    return { ok: false, found, required, message: `codex ${found} < required ${required}` };
  }
  return { ok: true, found, required };
}
