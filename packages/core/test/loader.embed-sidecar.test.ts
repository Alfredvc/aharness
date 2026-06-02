import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { extractSchemaSidecar } from '../src/loader/sidecar.js';

const fixturesDir = path.resolve(__dirname, 'fixtures/embed');

describe('loader — embed sidecar recursion', () => {
  it('extracts root and child available skills with declaring source dirs', async () => {
    const result = await extractSchemaSidecar({
      filePath: path.join(fixturesDir, 'loader-parent.fsm.ts'),
    });

    expect(result.skillOriginManifest.rootSourceDir).toBe(fixturesDir);
    expect(result.skillOriginManifest.availableSkills).toEqual(
      expect.arrayContaining([
        {
          sourceDir: fixturesDir,
          ref: {
            __aharnessSkillRef: true,
            source: 'path',
            path: './root-skill/SKILL.md',
            optional: false,
          },
        },
        {
          sourceDir: fixturesDir,
          ref: { __aharnessSkillRef: true, source: 'dir', path: './root-skills' },
        },
        {
          sourceDir: fixturesDir,
          ref: {
            __aharnessSkillRef: true,
            source: 'path',
            path: './child-skill/SKILL.md',
            optional: false,
          },
        },
        {
          sourceDir: fixturesDir,
          ref: { __aharnessSkillRef: true, source: 'dir', path: './child-skills' },
        },
      ]),
    );
  });

  it('extracts child submit-exit schemas under the embed-host qualified prefix', async () => {
    const result = await extractSchemaSidecar({
      filePath: path.join(fixturesDir, 'loader-parent.fsm.ts'),
    });
    // Parent's own router state has the local id `router`.
    expect(result.sidecar['router']?.['go']?.jsonSchema).toBeDefined();
    // Child's `go` state lifts under host `inner` → `inner.go`.
    expect(result.sidecar['inner.go']?.['out']?.jsonSchema).toBeDefined();
    expect(result.sidecar['inner.go']?.['bad']?.jsonSchema).toBeDefined();
    expect(result.skillOriginManifest.sourceDirPrefixes).toContainEqual({
      stateIdPrefix: 'inner',
      sourceDir: fixturesDir,
    });
  });

  it('extracts child submit schemas under canonical fsm.embed host prefixes', async () => {
    const result = await extractSchemaSidecar({
      filePath: path.join(fixturesDir, 'canonical-loader-parent.fsm.ts'),
    });

    expect(result.sidecar['router']?.['go']?.jsonSchema).toBeDefined();
    expect(result.sidecar['spec.compose']?.['ship']?.jsonSchema).toBeDefined();
    expect(result.sidecar['spec.compose']?.['reject']?.jsonSchema).toBeDefined();
  });

  it('recurses through multi-level embeds, prepending each host prefix', async () => {
    const result = await extractSchemaSidecar({
      filePath: path.join(fixturesDir, 'multi-level-parent.fsm.ts'),
    });
    expect(result.sidecar['router']?.['go']?.jsonSchema).toBeDefined();
    // mid embeds grandchild under host `inner`. The parent embeds mid under
    // host `middle`. The grandchild's `leaf` state qualifies as
    // `middle.inner.leaf`.
    expect(result.sidecar['middle.router']?.['go']?.jsonSchema).toBeDefined();
    expect(result.sidecar['middle.inner.leaf']?.['out']?.jsonSchema).toBeDefined();
    expect(result.skillOriginManifest.sourceDirPrefixes).toEqual(
      expect.arrayContaining([
        { stateIdPrefix: 'middle', sourceDir: fixturesDir },
        { stateIdPrefix: 'middle.inner', sourceDir: fixturesDir },
      ]),
    );
    expect(result.skillOriginManifest.availableSkills).toContainEqual({
      sourceDir: fixturesDir,
      ref: { __aharnessSkillRef: true, source: 'dir', path: './grandchild-skills' },
    });
  });

  it('breaks on a cycle without infinite-looping', async () => {
    const result = await extractSchemaSidecar({
      filePath: path.join(fixturesDir, 'loader-cycle-a.fsm.ts'),
    });
    // A's own go state was walked.
    expect(result.sidecar['go']?.['out']?.jsonSchema).toBeDefined();
    // B was reached once and its `go` state lifted under A's host `inner`.
    expect(result.sidecar['inner.go']?.['out']?.jsonSchema).toBeDefined();
    // The recursion stopped — A is on the cycle-guard when B tries to embed it,
    // so `inner.inner.go` would be the third level if recursion continued; the
    // loader must not produce that key.
    expect(result.sidecar['inner.inner.go']).toBeUndefined();
    expect(
      result.skillOriginManifest.sourceDirPrefixes.filter(
        (prefix) => prefix.stateIdPrefix === 'inner',
      ),
    ).toHaveLength(1);
  });

  it('omits child source-prefix metadata for raw embedded configs', async () => {
    const result = await extractSchemaSidecar({
      filePath: path.join(fixturesDir, 'raw-embed-parent.fsm.ts'),
    });

    expect(result.sidecar['router']?.['go']?.jsonSchema).toBeDefined();
    expect(result.skillOriginManifest.sourceDirPrefixes).toEqual([]);
  });

  it('extracts available skills even when the file has no schema-bearing helper calls', async () => {
    const result = await extractSchemaSidecar({
      filePath: path.join(fixturesDir, 'available-only-direct.fsm.ts'),
    });

    expect(result.sidecar).toEqual({});
    expect(result.issues).toEqual([]);
    expect(result.skillOriginManifest.rootSourceDir).toBe(fixturesDir);
    expect(result.skillOriginManifest.sourceDirPrefixes).toEqual([]);
    expect(result.skillOriginManifest.availableSkills).toEqual(
      expect.arrayContaining([
        {
          sourceDir: fixturesDir,
          ref: {
            __aharnessSkillRef: true,
            source: 'path',
            path: './direct-only/SKILL.md',
            optional: true,
          },
        },
        {
          sourceDir: fixturesDir,
          ref: { __aharnessSkillRef: true, source: 'dir', path: './direct-dir' },
        },
      ]),
    );
  });

  it('omits available skill refs with non-literal optional values', async () => {
    const result = await extractSchemaSidecar({
      filePath: path.join(fixturesDir, 'malformed-available-optional.fsm.ts'),
    });

    expect(result.skillOriginManifest.availableSkills).toEqual(
      expect.arrayContaining([
        {
          sourceDir: fixturesDir,
          ref: {
            __aharnessSkillRef: true,
            source: 'path',
            path: './direct-valid/SKILL.md',
            optional: false,
          },
        },
        {
          sourceDir: fixturesDir,
          ref: {
            __aharnessSkillRef: true,
            source: 'path',
            path: './canonical-valid/SKILL.md',
            optional: true,
          },
        },
      ]),
    );
    expect(
      result.skillOriginManifest.availableSkills.some(
        (entry) =>
          entry.ref.source === 'path' &&
          (entry.ref.path === './direct-dynamic/SKILL.md' ||
            entry.ref.path === './canonical-dynamic/SKILL.md'),
      ),
    ).toBe(false);
  });

  it('forwards child issues with stateIds prefixed by the embed-host key', async () => {
    const result = await extractSchemaSidecar({
      filePath: path.join(fixturesDir, 'parent-of-errored-child.fsm.ts'),
    });
    const childIssues = result.issues.filter((i) => i.code === 'exit-payload-any');
    expect(childIssues.length).toBeGreaterThan(0);
    const stateIds = childIssues.map((i) => i.stateId);
    expect(stateIds.every((sid) => sid !== null && sid.startsWith('inner.'))).toBe(true);
  });
});
