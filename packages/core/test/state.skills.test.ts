/**
 * Tests for the `skill()` author surface, the static `resolveSkill`
 * resolver, and the runtime structured skill selection helper.
 *
 * Together these cover:
 *   - shape validation of the two ref forms (name / path)
 *   - dedupe key derivation
 *   - codex-roots resolution order for name-form
 *   - relative + absolute path-form resolution
 *   - once-per-live-thread structured skill dedupe behavior
 *   - optional misses (skipped silently)
 *   - required misses (internal preflight invariant error)
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exit, state } from '../src/state/exits.js';
import { createFsm } from '../src/state/createFsm.js';
import {
  availableSkillKey,
  isAvailableSkillRef,
  isSkillRef,
  skill,
  skillDir,
  skillKey,
  type SkillRef,
} from '../src/state/skills.js';
import { resolveSkill } from '../src/state/skillResolver.js';
import type { SkillOriginManifest } from '../src/loader/cache.js';
import { buildSkillCatalogPreflight, validateSkillCatalog } from '../src/runtime/skillCatalog.js';
import {
  createStateSkillInjectionService,
  selectStateSkillInput,
} from '../src/runtime/skillInjection.js';
import { aharness, terminal } from '../src/index.js';

describe('skill() factory', () => {
  it('builds a name-form ref with default optional=false', () => {
    const r = skill('spec-review');
    expect(isSkillRef(r)).toBe(true);
    expect(r.source).toBe('name');
    if (r.source !== 'name') throw new Error('unreachable');
    expect(r.name).toBe('spec-review');
    expect(r.optional).toBe(false);
  });

  it('honours optional flag on name form', () => {
    const r = skill('spec-review', { optional: true });
    expect(r.optional).toBe(true);
  });

  it('builds a path-form ref', () => {
    const r = skill({ path: './foo/SKILL.md' });
    expect(r.source).toBe('path');
    if (r.source !== 'path') throw new Error('unreachable');
    expect(r.path).toBe('./foo/SKILL.md');
    expect(r.optional).toBe(false);
  });

  it('honours optional flag on path form', () => {
    const r = skill({ path: './foo/SKILL.md', optional: true });
    expect(r.optional).toBe(true);
  });

  it('builds a dir-form ref for availableSkills', () => {
    const r = skillDir('./skills');
    expect(isSkillRef(r)).toBe(false);
    expect(isAvailableSkillRef(r)).toBe(true);
    expect(r.source).toBe('dir');
    expect(r.path).toBe('./skills');
  });

  it('builds a dir-form ref through createFsm().skill.dir', () => {
    const fsm = createFsm();
    const r = fsm.skill.dir('./skills');
    expect(r).toEqual(skillDir('./skills'));
  });

  it('rejects empty name', () => {
    expect(() => skill('')).toThrow(/non-empty/);
  });

  it('rejects malformed name (uppercase, underscore, leading digit)', () => {
    expect(() => skill('Spec')).toThrow(/lowercase/);
    expect(() => skill('spec_review')).toThrow(/lowercase/);
    expect(() => skill('1spec')).toThrow(/lowercase/);
  });

  it('rejects empty path', () => {
    expect(() => skill({ path: '' })).toThrow(/non-empty/);
  });

  it('rejects empty dir path', () => {
    expect(() => skillDir('')).toThrow(/non-empty/);
  });

  it('skillKey derives stable identifier per source', () => {
    expect(skillKey(skill('foo'))).toBe('name:foo');
    expect(skillKey(skill({ path: '/abs/SKILL.md' }))).toBe('path:/abs/SKILL.md');
    expect(availableSkillKey(skillDir('/abs/skills'))).toBe('dir:/abs/skills');
  });

  it('isSkillRef rejects plain objects', () => {
    expect(isSkillRef({ source: 'name', name: 'foo' })).toBe(false);
    expect(isSkillRef(null)).toBe(false);
    expect(isSkillRef(undefined)).toBe(false);
  });
});

describe('state skill construction validation', () => {
  it('rejects dir refs in state-level skills', () => {
    expect(() =>
      state({
        entryPrompt: 'go',
        skills: [skillDir('./skills') as never],
        exits: { ok: exit<{ ok: boolean }>({ to: 'done' }) },
      }),
    ).toThrow(/dir-form refs/);
  });
});

describe('resolveSkill', () => {
  function mk(content = '# skill\n\nbody.\n'): {
    repoRoot: string;
    fsmFileDir: string;
    homeDir: string;
    codexHome: string;
    abs: (rel: string) => string;
    write: (rel: string, body?: string) => string;
  } {
    const root = mkdtempSync(join(tmpdir(), 'aharness-skill-test-'));
    const repoRoot = join(root, 'repo');
    const fsmFileDir = join(repoRoot, 'fsm');
    const homeDir = join(root, 'home');
    const codexHome = join(homeDir, '.codex');
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(fsmFileDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    return {
      repoRoot,
      fsmFileDir,
      homeDir,
      codexHome,
      abs: (rel) => join(root, rel),
      write: (rel, body = content) => {
        const p = join(root, rel);
        mkdirSync(join(p, '..'), { recursive: true });
        writeFileSync(p, body);
        return p;
      },
    };
  }

  it('resolves name-form against repo .agents/skills first', () => {
    const fx = mk();
    const repoSkill = fx.write('repo/.agents/skills/foo/SKILL.md');
    fx.write('home/.agents/skills/foo/SKILL.md');
    const r = resolveSkill(skill('foo'), {
      fsmFileDir: fx.fsmFileDir,
      repoRoot: fx.repoRoot,
      homeDir: fx.homeDir,
      codexHome: fx.codexHome,
    });
    expect(r.kind).toBe('resolved');
    if (r.kind !== 'resolved') return;
    expect(r.absPath).toBe(repoSkill);
  });

  it('falls back to ~/.agents/skills when repo has no match', () => {
    const fx = mk();
    const homeSkill = fx.write('home/.agents/skills/foo/SKILL.md');
    const r = resolveSkill(skill('foo'), {
      fsmFileDir: fx.fsmFileDir,
      repoRoot: fx.repoRoot,
      homeDir: fx.homeDir,
      codexHome: fx.codexHome,
    });
    if (r.kind !== 'resolved') throw new Error(`expected resolved, got ${r.kind}`);
    expect(r.absPath).toBe(homeSkill);
  });

  it('falls back to $CODEX_HOME/skills when neither earlier root has a match', () => {
    const fx = mk();
    const codexSkill = fx.write('home/.codex/skills/foo/SKILL.md');
    const r = resolveSkill(skill('foo'), {
      fsmFileDir: fx.fsmFileDir,
      repoRoot: fx.repoRoot,
      homeDir: fx.homeDir,
      codexHome: fx.codexHome,
    });
    if (r.kind !== 'resolved') throw new Error('expected resolved');
    expect(r.absPath).toBe(codexSkill);
  });

  it('returns unresolved when none of the roots have the skill', () => {
    const fx = mk();
    const r = resolveSkill(skill('missing'), {
      fsmFileDir: fx.fsmFileDir,
      repoRoot: fx.repoRoot,
      homeDir: fx.homeDir,
      codexHome: fx.codexHome,
    });
    expect(r.kind).toBe('unresolved');
    if (r.kind !== 'unresolved') return;
    expect(r.searched).toHaveLength(3);
    expect(r.optional).toBe(false);
  });

  it('marks unresolved-optional when ref is optional', () => {
    const fx = mk();
    const r = resolveSkill(skill('missing', { optional: true }), {
      fsmFileDir: fx.fsmFileDir,
      repoRoot: fx.repoRoot,
      homeDir: fx.homeDir,
      codexHome: fx.codexHome,
    });
    if (r.kind !== 'unresolved') throw new Error('expected unresolved');
    expect(r.optional).toBe(true);
  });

  it('resolves path-form relative to fsmFileDir', () => {
    const fx = mk();
    const localSkill = fx.write('repo/fsm/skills/local/SKILL.md');
    const r = resolveSkill(skill({ path: './skills/local/SKILL.md' }), {
      fsmFileDir: fx.fsmFileDir,
      repoRoot: fx.repoRoot,
      homeDir: fx.homeDir,
      codexHome: fx.codexHome,
    });
    if (r.kind !== 'resolved') throw new Error('expected resolved');
    expect(r.absPath).toBe(localSkill);
  });

  it('resolves path-form absolute as-is', () => {
    const fx = mk();
    const abs = fx.write('repo/some/abs/SKILL.md');
    const r = resolveSkill(skill({ path: abs }), {
      fsmFileDir: fx.fsmFileDir,
      repoRoot: fx.repoRoot,
      homeDir: fx.homeDir,
      codexHome: fx.codexHome,
    });
    if (r.kind !== 'resolved') throw new Error('expected resolved');
    expect(r.absPath).toBe(abs);
  });
});

describe('structured state skill selection', () => {
  const resolved = [
    { stateId: 'a', index: 0, name: 'alpha', path: '/skills/alpha/SKILL.md' },
    { stateId: 'a', index: 1, name: 'local', path: '/repo/local/SKILL.md' },
    { stateId: 'a', index: 3, name: 'alpha-alias', path: '/skills/alpha/SKILL.md' },
    { stateId: 'b', index: 0, name: 'beta', path: '/skills/beta/SKILL.md' },
  ];

  it('emits structured skill items for resolved name and path refs in declaration order', () => {
    const selected = selectStateSkillInput({
      stateId: 'a',
      skills: [skill('alpha'), skill({ path: './local/SKILL.md' })],
      resolvedSkills: resolved,
      alreadyInjected: new Set(),
    });

    expect(selected.skillItems).toEqual([
      { type: 'skill', name: 'alpha', path: '/skills/alpha/SKILL.md' },
      { type: 'skill', name: 'local', path: '/repo/local/SKILL.md' },
    ]);
    expect(selected.pendingKeys).toEqual([
      'path:/skills/alpha/SKILL.md',
      'path:/repo/local/SKILL.md',
    ]);
  });

  it('skips optional refs absent from startup resolved skills', () => {
    const selected = selectStateSkillInput({
      stateId: 'a',
      skills: [skill('alpha'), skill('optional-miss', { optional: true })],
      resolvedSkills: [resolved[0]!],
      alreadyInjected: new Set(),
    });
    expect(selected.skillItems).toEqual([
      { type: 'skill', name: 'alpha', path: '/skills/alpha/SKILL.md' },
    ]);
    expect(selected.pendingKeys).toEqual(['path:/skills/alpha/SKILL.md']);
  });

  it('throws for required refs absent from startup resolved skills', () => {
    expect(() =>
      selectStateSkillInput({
        stateId: 'a',
        skills: [skill('missing-required')],
        resolvedSkills: [],
        alreadyInjected: new Set(),
      }),
    ).toThrow(/required skill.*startup preflight/);
  });

  it('dedupes already injected catalog paths and duplicate pending paths in one build', () => {
    const selected = selectStateSkillInput({
      stateId: 'a',
      skills: [
        skill('alpha'),
        skill({ path: './local/SKILL.md' }),
        skill('unresolved-optional', { optional: true }),
        skill({ path: './alpha-alias/SKILL.md' }),
      ],
      resolvedSkills: resolved,
      alreadyInjected: new Set(['path:/repo/local/SKILL.md']),
    });

    expect(selected.skillItems).toEqual([
      { type: 'skill', name: 'alpha', path: '/skills/alpha/SKILL.md' },
    ]);
    expect(selected.pendingKeys).toEqual(['path:/skills/alpha/SKILL.md']);
  });

  it('commits pending keys only when commit is invoked', () => {
    const alreadyInjected = new Set<string>();
    const selected = selectStateSkillInput({
      stateId: 'b',
      skills: [skill('beta')],
      resolvedSkills: resolved,
      alreadyInjected,
    });

    expect(alreadyInjected).toEqual(new Set());
    selected.commit();
    expect(alreadyInjected).toEqual(new Set(['path:/skills/beta/SKILL.md']));
  });

  it('service builds text-first turn input and resets dedupe for a fresh thread', () => {
    const service = createStateSkillInjectionService({ resolvedSkills: resolved });
    const first = service.buildTurnInputForActive({
      stateId: 'b',
      skills: [skill('beta')],
      orientationText: 'orientation',
    });
    expect(first.input).toEqual([
      { type: 'text', text: 'orientation' },
      { type: 'skill', name: 'beta', path: '/skills/beta/SKILL.md' },
    ]);

    first.commit();
    const deduped = service.buildTurnInputForActive({
      stateId: 'b',
      skills: [skill('beta')],
      orientationText: 'again',
    });
    expect(deduped.input).toEqual([{ type: 'text', text: 'again' }]);

    service.resetForFreshThread();
    const afterReset = service.buildTurnInputForActive({
      stateId: 'b',
      skills: [skill('beta')],
      orientationText: 'fresh',
    });
    expect(afterReset.input).toEqual([
      { type: 'text', text: 'fresh' },
      { type: 'skill', name: 'beta', path: '/skills/beta/SKILL.md' },
    ]);
  });
});

describe('runtime skill catalog preflight', () => {
  function manifest(rootSourceDir: string, childSourceDir: string): SkillOriginManifest {
    return {
      rootSourceDir,
      sourceDirPrefixes: [{ stateIdPrefix: 'child', sourceDir: childSourceDir }],
      availableSkills: [
        { sourceDir: rootSourceDir, ref: skillDir('./support') },
        { sourceDir: childSourceDir, ref: skill({ path: './child-available/SKILL.md' }) },
      ],
    };
  }

  it('builds sorted extra roots and uses dot-boundary state origins', () => {
    const root = '/tmp/root-fsm';
    const child = '/tmp/child-fsm';
    const machine = aharness.machine({
      id: 'catalog-roots',
      initial: 'child',
      states: {
        child: {
          initial: 'review',
          states: {
            review: state({
              entryPrompt: 'child',
              skills: [skill({ path: './child-skill/../child-skill/SKILL.md' })],
              exits: { done: exit({ to: '#catalog-roots.done' }) },
            }),
          },
        },
        childish: state({
          entryPrompt: 'sibling',
          skills: [skill({ path: './root-skill/SKILL.md' })],
          exits: { done: exit({ to: 'done' }) },
        }),
        done: terminal('success'),
      },
    });

    const preflight = buildSkillCatalogPreflight({
      machine,
      skillOriginManifest: manifest(root, child),
    });

    expect(preflight.extraRoots).toEqual(
      [
        resolve(child, 'child-available'),
        resolve(child, 'child-skill'),
        resolve(root, 'root-skill'),
        resolve(root, 'support'),
      ].sort(),
    );
    expect(preflight.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stateId: 'child.review',
          resolvedPath: resolve(child, 'child-skill/SKILL.md'),
        }),
        expect.objectContaining({
          stateId: 'childish',
          resolvedPath: resolve(root, 'root-skill/SKILL.md'),
        }),
      ]),
    );
  });

  it('validates required and optional catalog entries', () => {
    const root = '/tmp/root-fsm';
    const machine = aharness.machine({
      id: 'catalog-validate',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'a',
          skills: [
            skill('review-plan'),
            skill('missing-required'),
            skill('missing-optional', { optional: true }),
            skill({ path: './path-skill/./SKILL.md' }),
          ],
          exits: { done: exit({ to: 'done' }) },
        }),
        done: terminal('success'),
      },
    });
    const preflight = buildSkillCatalogPreflight({
      machine,
      skillOriginManifest: {
        rootSourceDir: root,
        sourceDirPrefixes: [],
        availableSkills: [],
      },
    });

    const result = validateSkillCatalog({
      repoRoot: root,
      preflight,
      response: {
        data: [
          {
            cwd: root,
            errors: [{ path: '/tmp/bad/SKILL.md', message: 'invalid frontmatter' }],
            skills: [
              { name: 'review-plan', path: '/tmp/skills/review-plan/SKILL.md', enabled: true },
              { name: 'disabled', path: '/tmp/skills/disabled/SKILL.md', enabled: false },
              { name: 'path-skill', path: resolve(root, 'path-skill/SKILL.md'), enabled: true },
            ],
          },
        ],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("catalog error at '/tmp/bad/SKILL.md'"),
        expect.stringContaining("name 'missing-required' is missing"),
      ]),
    );
    expect(result.warnings).toEqual([
      expect.stringContaining("name 'missing-optional' is missing"),
    ]);
    expect(result.resolvedSkills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'review-plan' }),
        expect.objectContaining({ name: 'path-skill', path: resolve(root, 'path-skill/SKILL.md') }),
      ]),
    );
  });

  it('treats ambiguous required names and wrong cwd entries as fatal', () => {
    const root = '/tmp/root-fsm';
    const machine = aharness.machine({
      id: 'catalog-ambiguous',
      initial: 'a',
      states: {
        a: state({
          entryPrompt: 'a',
          skills: [skill('review-plan')],
          exits: { done: exit({ to: 'done' }) },
        }),
        done: terminal('success'),
      },
    });
    const preflight = buildSkillCatalogPreflight({
      machine,
      skillOriginManifest: { rootSourceDir: root, sourceDirPrefixes: [], availableSkills: [] },
    });

    const result = validateSkillCatalog({
      repoRoot: root,
      preflight,
      response: {
        data: [
          {
            cwd: '/tmp/other',
            errors: [],
            skills: [
              { name: 'review-plan', path: '/tmp/one/SKILL.md', enabled: true },
              { name: 'review-plan', path: '/tmp/two/SKILL.md', enabled: true },
            ],
          },
        ],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("returned cwd '/tmp/other'"),
        expect.stringContaining('matched 2 enabled Codex skills'),
      ]),
    );
  });
});
