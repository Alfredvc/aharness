/**
 * Skill resolver — turns path/dir refs into absolute filesystem locations for
 * static validation and availability roots.
 *
 * Name-form state refs are resolved by Codex's startup skill catalog preflight,
 * not by static filesystem lookup. Path-form refs resolve against `fsmFileDir`
 * when relative; dir-form refs do the same for top-level `availableSkills`.
 *
 * Resolution is deterministic given `(ref, fsmFileDir, repoRoot, env)`.
 * `resolveSkill` still accepts name-form refs for compatibility with older
 * validation paths, but new runtime selection uses the Codex catalog result.
 */
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { SkillRef, SkillRefDir } from './skills.js';

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
  /** Override directory existence checks (test seam). */
  readonly dirExists?: (absPath: string) => boolean;
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

export interface ResolvedSkillDir {
  readonly kind: 'resolved';
  readonly absPath: string;
  readonly key: string;
  readonly displayName: string;
}

export interface UnresolvedSkillDir {
  readonly kind: 'unresolved';
  readonly key: string;
  readonly displayName: string;
  readonly searched: ReadonlyArray<string>;
}

export type SkillDirResolution = ResolvedSkillDir | UnresolvedSkillDir;

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

export function resolveSkillDir(ref: SkillRefDir, env: SkillResolverEnv): SkillDirResolution {
  const dirExists = env.dirExists ?? ((absPath: string) => statSync(absPath).isDirectory());
  const absPath = isAbsolute(ref.path) ? ref.path : resolve(env.fsmFileDir, ref.path);
  const key = `dir:${absPath}`;
  try {
    if (dirExists(absPath)) {
      return {
        kind: 'resolved',
        absPath,
        key,
        displayName: ref.path,
      };
    }
  } catch {
    // Fall through to unresolved so diagnostics stay deterministic.
  }
  return {
    kind: 'unresolved',
    key,
    displayName: ref.path,
    searched: [absPath],
  };
}
