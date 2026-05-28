/**
 * Loader walker error-path tests — one test per `SidecarIssueCode`.
 *
 * Each test loads a minimal malformed fixture via `extractSchemaSidecar` (AST-only,
 * no module execution) and asserts that exactly the target issue code is present,
 * keyed to the expected stateId and exitName. No spurious codes should appear for
 * each individual error being exercised.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { extractSchemaSidecar, type SidecarIssue } from '../src/loader/sidecar.js';

const fixturesDir = path.resolve(__dirname, 'fixtures/sidecar-errors');
const createFsmFixturesDir = path.resolve(__dirname, 'fixtures/create-fsm-errors');

function fixture(name: string): string {
  return path.join(fixturesDir, name);
}

function createFsmFixture(name: string): string {
  return path.join(createFsmFixturesDir, name);
}

function issuesForExit(issues: readonly SidecarIssue[], stateId: string, exitName: string) {
  return issues.filter((i) => i.stateId === stateId && i.exitName === exitName);
}

describe('loader — sidecar walker error paths', () => {
  it('exit-payload-missing: plain object literal without exit<T>() wrapper', async () => {
    const { issues } = await extractSchemaSidecar({
      filePath: fixture('exit-payload-missing.fsm.ts'),
    });
    const target = issuesForExit(issues, 's1', 'done');
    expect(target.length).toBe(1);
    expect(target[0]!.code).toBe('exit-payload-missing');
    // No spurious codes for this exit.
    const codes = target.map((i) => i.code);
    expect(codes).toEqual(['exit-payload-missing']);
  });

  it('exit-payload-any: exit<any>(...) is rejected', async () => {
    const { issues } = await extractSchemaSidecar({
      filePath: fixture('exit-payload-any.fsm.ts'),
    });
    const target = issuesForExit(issues, 's1', 'done');
    expect(target.length).toBe(1);
    expect(target[0]!.code).toBe('exit-payload-any');
  });

  it('exit-payload-unknown: exit<unknown>(...) is rejected', async () => {
    const { issues } = await extractSchemaSidecar({
      filePath: fixture('exit-payload-unknown.fsm.ts'),
    });
    const target = issuesForExit(issues, 's1', 'done');
    expect(target.length).toBe(1);
    expect(target[0]!.code).toBe('exit-payload-unknown');
  });

  it('exit-payload-never: exit<never>(...) is rejected', async () => {
    const { issues } = await extractSchemaSidecar({
      filePath: fixture('exit-payload-never.fsm.ts'),
    });
    const target = issuesForExit(issues, 's1', 'done');
    expect(target.length).toBe(1);
    expect(target[0]!.code).toBe('exit-payload-never');
  });

  it('exit-payload-non-object: exit<string>(...) — primitive top-level type', async () => {
    const { issues } = await extractSchemaSidecar({
      filePath: fixture('exit-payload-non-object-primitive.fsm.ts'),
    });
    const target = issuesForExit(issues, 's1', 'done');
    expect(target.length).toBe(1);
    expect(target[0]!.code).toBe('exit-payload-non-object');
  });

  it('exit-payload-non-object: exit<A|B>(...) — top-level discriminated union', async () => {
    const { issues } = await extractSchemaSidecar({
      filePath: fixture('exit-payload-non-object-union.fsm.ts'),
    });
    const target = issuesForExit(issues, 's1', 'done');
    expect(target.length).toBe(1);
    expect(target[0]!.code).toBe('exit-payload-non-object');
  });

  it('await-with-payload: await exit wrapped in exit() factory is rejected', async () => {
    const { issues } = await extractSchemaSidecar({
      filePath: fixture('await-with-payload.fsm.ts'),
    });
    const target = issuesForExit(issues, 's1', 'done');
    expect(target.length).toBe(1);
    expect(target[0]!.code).toBe('await-with-payload');
  });

  it.each([
    ['canonical-submit-payload-missing.fsm.ts', 'exit-payload-missing'],
    ['canonical-submit-payload-any.fsm.ts', 'exit-payload-any'],
    ['canonical-submit-payload-unknown.fsm.ts', 'exit-payload-unknown'],
    ['canonical-submit-payload-never.fsm.ts', 'exit-payload-never'],
    ['canonical-submit-payload-non-object.fsm.ts', 'exit-payload-non-object'],
    ['canonical-await-with-payload.fsm.ts', 'await-with-payload'],
  ] as const)('canonical %s emits %s', async (fileName, code) => {
    const { issues } = await extractSchemaSidecar({
      filePath: createFsmFixture(fileName),
    });
    const target = issuesForExit(issues, 's1', 'done');
    expect(target.length).toBe(1);
    expect(target[0]!.code).toBe(code);
  });
});
