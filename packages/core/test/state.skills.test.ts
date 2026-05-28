/**
 * Tests for the `skill()` author surface, the static `resolveSkill`
 * resolver, and the daemon-side `resolveAndReadSkills` helper.
 *
 * Together these cover:
 *   - shape validation of the two ref forms (name / path)
 *   - dedupe key derivation
 *   - codex-roots resolution order for name-form
 *   - relative + absolute path-form resolution
 *   - once-per-run dedupe behavior
 *   - optional misses (skipped silently)
 *   - non-optional misses (warning block in the wire output)
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSkillRef, skill, skillKey, type SkillRef } from '../src/state/skills.js';
import { resolveSkill } from '../src/state/skillResolver.js';
import { resolveAndReadSkills } from '../src/runtime/skillInjection.js';

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
    const r = skill({ path: './foo.md' });
    expect(r.source).toBe('path');
    if (r.source !== 'path') throw new Error('unreachable');
    expect(r.path).toBe('./foo.md');
    expect(r.optional).toBe(false);
  });

  it('honours optional flag on path form', () => {
    const r = skill({ path: './foo.md', optional: true });
    expect(r.optional).toBe(true);
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

  it('skillKey derives stable identifier per source', () => {
    expect(skillKey(skill('foo'))).toBe('name:foo');
    expect(skillKey(skill({ path: '/abs/path.md' }))).toBe('path:/abs/path.md');
  });

  it('isSkillRef rejects plain objects', () => {
    expect(isSkillRef({ source: 'name', name: 'foo' })).toBe(false);
    expect(isSkillRef(null)).toBe(false);
    expect(isSkillRef(undefined)).toBe(false);
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
    const root = mkdtempSync(join(tmpdir(), 'harness-skill-test-'));
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
    const localSkill = fx.write('repo/fsm/skills/local.md');
    const r = resolveSkill(skill({ path: './skills/local.md' }), {
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

describe('resolveAndReadSkills', () => {
  const env = {
    fsmFileDir: '/tmp/x',
    repoRoot: '/tmp/repo',
    homeDir: '/tmp/home',
    codexHome: '/tmp/home/.codex',
    fileExists: (p: string) => p.endsWith('alpha/SKILL.md'),
  };
  const reader = (p: string) => `BODY[${p}]`;

  it('produces a wrapped block for resolved refs and tracks the new key', () => {
    const refs: SkillRef[] = [skill('alpha')];
    const r = resolveAndReadSkills({
      skills: refs,
      alreadyInjected: new Set(),
      env,
      readFile: reader,
    });
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]?.text).toContain('<skill name="alpha"');
    expect(r.blocks[0]?.text).toContain('BODY[');
    expect(r.newKeys).toEqual(['name:alpha']);
  });

  it('skips refs whose key is already in alreadyInjected', () => {
    const refs: SkillRef[] = [skill('alpha')];
    const r = resolveAndReadSkills({
      skills: refs,
      alreadyInjected: new Set(['name:alpha']),
      env,
      readFile: reader,
    });
    expect(r.blocks).toHaveLength(0);
    expect(r.newKeys).toHaveLength(0);
  });

  it('skips optional misses silently', () => {
    const refs: SkillRef[] = [skill('beta', { optional: true })];
    const r = resolveAndReadSkills({
      skills: refs,
      alreadyInjected: new Set(),
      env,
      readFile: reader,
    });
    expect(r.blocks).toHaveLength(0);
    expect(r.newKeys).toHaveLength(0);
  });

  it('emits a warning block for non-optional misses', () => {
    const refs: SkillRef[] = [skill('beta')];
    const r = resolveAndReadSkills({
      skills: refs,
      alreadyInjected: new Set(),
      env,
      readFile: reader,
    });
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]?.text).toContain('status="missing"');
    expect(r.blocks[0]?.text).toContain('beta');
    expect(r.newKeys).toEqual(['name:beta']);
  });

  it('emits a warning block when readFile throws and still tracks the key', () => {
    const throwReader = () => {
      throw new Error('boom');
    };
    const r = resolveAndReadSkills({
      skills: [skill('alpha')],
      alreadyInjected: new Set(),
      env,
      readFile: throwReader,
    });
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]?.text).toContain('read error: boom');
    expect(r.newKeys).toEqual(['name:alpha']);
  });
});
