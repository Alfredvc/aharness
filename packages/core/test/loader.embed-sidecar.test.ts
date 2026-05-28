import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { extractSchemaSidecar } from '../src/loader/sidecar.js';

const fixturesDir = path.resolve(__dirname, 'fixtures/embed');

describe('loader — embed sidecar recursion', () => {
  it('extracts child submit-exit schemas under the embed-host qualified prefix', async () => {
    const result = await extractSchemaSidecar({
      filePath: path.join(fixturesDir, 'loader-parent.fsm.ts'),
    });
    // Parent's own router state has the local id `router`.
    expect(result.sidecar['router']?.['go']?.jsonSchema).toBeDefined();
    // Child's `go` state lifts under host `inner` → `inner.go`.
    expect(result.sidecar['inner.go']?.['out']?.jsonSchema).toBeDefined();
    expect(result.sidecar['inner.go']?.['bad']?.jsonSchema).toBeDefined();
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
