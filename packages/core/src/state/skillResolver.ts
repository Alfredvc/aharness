/**
 * Skill resolver — turns author-declared `SkillRef`s into absolute
 * `SKILL.md` paths plus a stable dedupe key.
 *
 * Two ref shapes:
 *   - **Name-form** — search codex's skill roots in order:
 *       1. `<repoRoot>/.agents/skills/<name>/SKILL.md`
 *       2. `~/.agents/skills/<name>/SKILL.md`
 *       3. `$CODEX_HOME/skills/<name>/SKILL.md`  (default `~/.codex/skills/<name>/SKILL.md`)
 *     First hit wins. No fallback to bundled paths — bundling is a
 *     path-form concern.
 *   - **Path-form** — relative paths resolve against `fsmFileDir`,
 *     absolute paths used as-is. No search.
 *
 * Resolution is deterministic given `(ref, fsmFileDir, repoRoot, env)`.
 * Used by both the verifier (static check) and the daemon (runtime
 * inject). `existsSync` is the only filesystem dependency; `homedir`
 * and `process.env.CODEX_HOME` are read at the call site.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { SkillRef } from './skills.js';

export interface SkillResolverEnv {
  /** Directory containing the FSM file. Used as the base for relative path-form refs. */
  readonly fsmFileDir: string;
  /** Repo root (typically the CLI cwd). Used for the `<repoRoot>/.agents/skills/...` search root. */
  readonly repoRoot: string;
  /** Override `os.homedir()` (test seam). */
  readonly homeDir?: string;
  /** Override `process.env.CODEX_HOME` (test seam). */
  readonly codexHome?: string | undefined;
  /** Override `existsSync` (test seam). */
  readonly fileExists?: (absPath: string) => boolean;
}

export interface ResolvedSkill {
  readonly kind: 'resolved';
  readonly absPath: string;
  readonly key: string;
  readonly displayName: string;
  readonly optional: boolean;
}

export interface UnresolvedSkill {
  readonly kind: 'unresolved';
  readonly key: string;
  readonly displayName: string;
  readonly optional: boolean;
  /** Absolute paths searched (in order) — surfaced in the error/warning message. */
  readonly searched: ReadonlyArray<string>;
}

export type SkillResolution = ResolvedSkill | UnresolvedSkill;

export function resolveSkill(ref: SkillRef, env: SkillResolverEnv): SkillResolution {
  const fileExists = env.fileExists ?? existsSync;
  const home = env.homeDir ?? homedir();
  const codexHome = env.codexHome ?? process.env['CODEX_HOME'] ?? resolve(home, '.codex');

  if (ref.source === 'name') {
    const key = `name:${ref.name}`;
    const candidates = [
      resolve(env.repoRoot, '.agents', 'skills', ref.name, 'SKILL.md'),
      resolve(home, '.agents', 'skills', ref.name, 'SKILL.md'),
      resolve(codexHome, 'skills', ref.name, 'SKILL.md'),
    ];
    for (const c of candidates) {
      if (fileExists(c)) {
        return {
          kind: 'resolved',
          absPath: c,
          key,
          displayName: ref.name,
          optional: ref.optional,
        };
      }
    }
    return {
      kind: 'unresolved',
      key,
      displayName: ref.name,
      optional: ref.optional,
      searched: candidates,
    };
  }

  // Path-form
  const absPath = isAbsolute(ref.path) ? ref.path : resolve(env.fsmFileDir, ref.path);
  const key = `path:${absPath}`;
  if (fileExists(absPath)) {
    return {
      kind: 'resolved',
      absPath,
      key,
      displayName: ref.path,
      optional: ref.optional,
    };
  }
  return {
    kind: 'unresolved',
    key,
    displayName: ref.path,
    optional: ref.optional,
    searched: [absPath],
  };
}
