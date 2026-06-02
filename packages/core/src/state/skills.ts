/**
 * Skill primitive — author surface for declaring Codex skills that aharness
 * can make discoverable for a run or select for a state turn.
 *
 * Three author ref shapes:
 *   - **Name-form** — `skill('spec-review')`. Valid only for state-level
 *     `skills`; Codex's startup skill catalog preflight is authoritative for
 *     resolving it to exactly one enabled skill.
 *   - **Path-form** — `skill({ path: './foo/SKILL.md' })`. Relative paths resolve
 *     against the FSM file's directory (loader threads it to the daemon);
 *     absolute paths used as-is. No fallback search.
 *   - **Dir-form** — `fsm.skill.dir('./skills')`. Valid only in top-level
 *     machine `availableSkills`, not in state-level `skills`.
 *
 * `optional: true` lets startup preflight warn and skip a missing state skill
 * instead of failing the run.
 *
 * `__aharnessSkillRef: true` is an opaque sentinel the rest of the framework
 * uses to validate that an entry on a state's `skills:` array came from this
 * factory. Authors never set it directly.
 *
 * State skill selection runs once per live parent thread and selected skill
 * items are deduped by resolved path. A `clearOnEntry` fresh thread starts with
 * empty model context, so the dedupe set is reset for that replacement thread.
 */

/** Stable key derived from the resolved source — `name:<n>`, `path:<absPath>`, or `dir:<absPath>`. */
export type SkillKey = string;

export interface SkillRefName {
  readonly __aharnessSkillRef: true;
  readonly source: 'name';
  readonly name: string;
  readonly optional: boolean;
}

export interface SkillRefPath {
  readonly __aharnessSkillRef: true;
  readonly source: 'path';
  readonly path: string;
  readonly optional: boolean;
}

export interface SkillRefDir {
  readonly __aharnessSkillRef: true;
  readonly source: 'dir';
  readonly path: string;
}

export type SkillRef = SkillRefName | SkillRefPath;
export type AvailableSkillRef = SkillRefPath | SkillRefDir;

export interface SkillOptions {
  readonly optional?: boolean;
}

export interface SkillByPath {
  readonly path: string;
}

export interface SkillByDir {
  readonly dir: string;
}

/**
 * Skill name shape: lowercase letters, digits, and hyphens. Matches codex's
 * own skill-name convention. Validated at machine-construction time; the
 * verifier check `skill-name-shape` re-checks at static verify time.
 */
const NAME_SHAPE = /^[a-z][a-z0-9-]*$/;

export function skill(name: string, opts?: SkillOptions): SkillRefName;
export function skill(opts: SkillByPath & SkillOptions): SkillRefPath;
export function skill(arg: string | (SkillByPath & SkillOptions), opts?: SkillOptions): SkillRef {
  if (typeof arg === 'string') {
    if (arg.length === 0) {
      throw new TypeError('skill(): name must be a non-empty string');
    }
    if (!NAME_SHAPE.test(arg)) {
      throw new TypeError(
        `skill(): name '${arg}' must match ${NAME_SHAPE} (lowercase, digits, hyphens; starting with a letter)`,
      );
    }
    return {
      __aharnessSkillRef: true,
      source: 'name',
      name: arg,
      optional: opts?.optional === true,
    };
  }
  if (arg === null || typeof arg !== 'object') {
    throw new TypeError('skill(): argument must be a string name or an options object');
  }
  if (typeof arg.path !== 'string' || arg.path.length === 0) {
    throw new TypeError('skill(): path must be a non-empty string');
  }
  return {
    __aharnessSkillRef: true,
    source: 'path',
    path: arg.path,
    optional: arg.optional === true,
  };
}

export function skillDir(path: string): SkillRefDir {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('skill.dir(): path must be a non-empty string');
  }
  return {
    __aharnessSkillRef: true,
    source: 'dir',
    path,
  };
}

/** Type-guard for state-selectable refs (verifier, runtime catalog preflight). */
export function isSkillRef(v: unknown): v is SkillRef {
  if (!isAnySkillRef(v)) return false;
  if (v.source === 'name') {
    return typeof v.name === 'string' && v.name.length > 0 && typeof v.optional === 'boolean';
  }
  if (v.source === 'path') {
    return typeof v.path === 'string' && v.path.length > 0 && typeof v.optional === 'boolean';
  }
  return false;
}

export function isAvailableSkillRef(v: unknown): v is AvailableSkillRef {
  if (!isAnySkillRef(v)) return false;
  if (v.source === 'path') {
    return typeof v.path === 'string' && v.path.length > 0 && typeof v.optional === 'boolean';
  }
  if (v.source === 'dir') {
    return typeof v.path === 'string' && v.path.length > 0;
  }
  return false;
}

export function isAnySkillRef(v: unknown): v is SkillRefName | SkillRefPath | SkillRefDir {
  return (
    v !== null &&
    typeof v === 'object' &&
    (v as { __aharnessSkillRef?: unknown }).__aharnessSkillRef === true &&
    ((v as { source?: unknown }).source === 'name' ||
      (v as { source?: unknown }).source === 'path' ||
      (v as { source?: unknown }).source === 'dir')
  );
}

/** Stable identifier for once-per-run dedupe tracking. */
export function skillKey(ref: SkillRef): SkillKey {
  return ref.source === 'name' ? `name:${ref.name}` : `path:${ref.path}`;
}

export function availableSkillKey(ref: AvailableSkillRef): SkillKey {
  return `${ref.source}:${ref.path}`;
}
