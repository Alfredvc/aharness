/**
 * Skill-injection helper used by both `onStateEntry` (entry-side composition)
 * and `dispatchSubmit` (submit-inline composition) to resolve a state's
 * `SkillRef[]`, dedupe against the run's already-injected set, read each
 * `SKILL.md` body, and produce the wrapped blocks the nudge composer
 * appends to the orientation message.
 *
 * Once-per-run dedupe — `alreadyInjected` is the `Set<string>` of stable
 * keys (`name:<n>` or `path:<absPath>`) that have already been injected
 * earlier in this run. Caller adds the returned `newKeys` to the set after
 * the nudge has actually been sent so a transient inject failure leaves
 * the keys flagged-not-yet-injected and the next entry can retry.
 *
 * `optional` refs that fail to resolve are silently skipped at runtime
 * (the verifier surfaces a warning at static-check time). Non-optional
 * refs that fail to resolve produce a warning block in the nudge so the
 * model sees a visible diagnostic rather than silently missing context.
 */
import { readFileSync } from 'node:fs';
import type { SkillRef } from '../state/skills.js';
import { resolveSkill, type SkillResolverEnv } from '../state/skillResolver.js';

export interface SkillBlock {
  /** `<skill name="…" path="…">…</skill>` ready-to-append text. */
  readonly text: string;
  /** Stable dedupe key. Caller adds these to the run's injected set on success. */
  readonly key: string;
}

export interface ResolveAndReadOpts {
  readonly skills: ReadonlyArray<SkillRef>;
  readonly alreadyInjected: ReadonlySet<string>;
  readonly env: SkillResolverEnv;
  /** Test seam — defaults to `fs.readFileSync(absPath, 'utf8')`. */
  readonly readFile?: (absPath: string) => string;
}

export interface ResolveAndReadResult {
  readonly blocks: ReadonlyArray<SkillBlock>;
  readonly newKeys: ReadonlyArray<string>;
}

export function resolveAndReadSkills(o: ResolveAndReadOpts): ResolveAndReadResult {
  const blocks: SkillBlock[] = [];
  const newKeys: string[] = [];
  const reader = o.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  for (const ref of o.skills) {
    const res = resolveSkill(ref, o.env);
    if (o.alreadyInjected.has(res.key)) continue;
    if (res.kind === 'unresolved') {
      if (res.optional) continue;
      blocks.push({
        text: warningBlock(res.displayName, res.searched),
        key: res.key,
      });
      newKeys.push(res.key);
      continue;
    }
    let body: string;
    try {
      body = reader(res.absPath);
    } catch (e) {
      blocks.push({
        text: warningBlock(res.displayName, [res.absPath], `read error: ${(e as Error).message}`),
        key: res.key,
      });
      newKeys.push(res.key);
      continue;
    }
    blocks.push({
      text: skillBlock(res.displayName, res.absPath, body),
      key: res.key,
    });
    newKeys.push(res.key);
  }
  return { blocks, newKeys };
}

function skillBlock(name: string, absPath: string, body: string): string {
  return `<skill name=${JSON.stringify(name)} path=${JSON.stringify(absPath)}>
${body.replace(/\n+$/, '')}
</skill>`;
}

function warningBlock(
  displayName: string,
  searched: ReadonlyArray<string>,
  detail?: string,
): string {
  const reason = detail ?? `not found in any of:\n  - ${searched.join('\n  - ')}`;
  return `<skill name=${JSON.stringify(displayName)} status="missing">
(harness: skill ${JSON.stringify(displayName)} ${reason})
</skill>`;
}
