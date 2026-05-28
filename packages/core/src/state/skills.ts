/**
 * Skill primitive — author surface for declaring SKILL.md bodies that the
 * framework injects into the per-state orientation nudge on entry.
 *
 * Two ref shapes:
 *   - **Name-form** — `skill('spec-review')`. Resolved against codex's
 *     skill roots in this order: `<repoRoot>/.agents/skills/<name>/SKILL.md`,
 *     `~/.agents/skills/<name>/SKILL.md`, `$CODEX_HOME/skills/<name>/SKILL.md`.
 *     If none exists, verifier errors (or skips silently when `optional`).
 *   - **Path-form** — `skill({ path: './foo.md' })`. Relative paths resolve
 *     against the FSM file's directory (loader threads it to the daemon);
 *     absolute paths used as-is. No fallback search.
 *
 * `optional: true` downgrades a missing-resolution from error to warning at
 * verify time and from inject-failure to silent-skip at runtime.
 *
 * `__aharnessSkillRef: true` is an opaque sentinel the rest of the framework
 * uses to validate that an entry on a state's `skills:` array came from this
 * factory. Authors never set it directly.
 *
 * Injection runs once per `(run, key)` — same skill referenced from multiple
 * states injects on the first entry and is skipped thereafter (the model
 * already has it in context). A `clearOnEntry` fresh thread starts with
 * empty model context, so runtime injection state is scoped to the live
 * parent thread.
 */

/** Stable key derived from the resolved source — `name:<n>` or `path:<absPath>`. */
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

export type SkillRef = SkillRefName | SkillRefPath;

export interface SkillOptions {
  readonly optional?: boolean;
}

export interface SkillByPath {
  readonly path: string;
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

/** Type-guard for runtime checks (verifier, daemon). */
export function isSkillRef(v: unknown): v is SkillRef {
  return (
    v !== null &&
    typeof v === 'object' &&
    (v as { __aharnessSkillRef?: unknown }).__aharnessSkillRef === true
  );
}

/** Stable identifier for once-per-run dedupe tracking. */
export function skillKey(ref: SkillRef): SkillKey {
  return ref.source === 'name' ? `name:${ref.name}` : `path:${ref.path}`;
}
