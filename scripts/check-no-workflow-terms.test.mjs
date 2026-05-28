// scripts/check-no-workflow-terms.test.mjs
//
// Exercises the `check-no-workflow-terms.mjs` script against a tempdir.
// Two cases:
//   1. A tempdir containing a `.ts` file with a banned term exits 1 and
//      writes the matching location to stderr.
//   2. A clean tempdir (or one whose only banned-term occurrence is in
//      a `.test.ts` file or a `fixtures/` subdirectory) exits 0.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, afterEach } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, 'check-no-workflow-terms.mjs');

function runScript(rootDir) {
  return new Promise((res) => {
    const child = spawn('node', [scriptPath, rootDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      res({ code, stdout, stderr });
    });
  });
}

const tempdirs = [];
function makeTempdir() {
  const d = mkdtempSync(join(tmpdir(), 'harness-chk-'));
  tempdirs.push(d);
  return d;
}

afterEach(() => {
  while (tempdirs.length > 0) {
    const d = tempdirs.pop();
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('check-no-workflow-terms', () => {
  it('exits 1 when a banned term appears in a .ts file', async () => {
    const d = makeTempdir();
    writeFileSync(
      join(d, 'bad.ts'),
      'export const x: string = "requirement one"; // workflow vocabulary\n',
    );
    const { code, stderr } = await runScript(d);
    expect(code).toBe(1);
    expect(stderr).toMatch(/bad\.ts/);
    expect(stderr).toMatch(/requirement/);
  });

  it('exits 0 when no banned term is present', async () => {
    const d = makeTempdir();
    writeFileSync(join(d, 'good.ts'), 'export const hello: string = "nothing to see here";\n');
    const { code } = await runScript(d);
    expect(code).toBe(0);
  });

  it('ignores *.test.ts files', async () => {
    const d = makeTempdir();
    writeFileSync(
      join(d, 'thing.test.ts'),
      'describe("x", () => { it("mentions requirement", () => {}); });\n',
    );
    const { code } = await runScript(d);
    expect(code).toBe(0);
  });

  it('ignores fixtures/ subdirectories', async () => {
    const d = makeTempdir();
    mkdirSync(join(d, 'fixtures'));
    writeFileSync(join(d, 'fixtures', 'contains.ts'), 'export const sample = "requirement";\n');
    const { code } = await runScript(d);
    expect(code).toBe(0);
  });

  it('does not match capital-R Record (TypeScript utility type)', async () => {
    const d = makeTempdir();
    writeFileSync(join(d, 'types.ts'), 'export type Bag = Record<string, unknown>;\n');
    const { code } = await runScript(d);
    expect(code).toBe(0);
  });

  it('catches whole-word banned terms embedded in prose', async () => {
    const d = makeTempdir();
    writeFileSync(
      join(d, 'prose.ts'),
      '// the requirement detector is installed\nexport const enabled = true;\n',
    );
    const { code, stderr } = await runScript(d);
    expect(code).toBe(1);
    expect(stderr).toMatch(/requirement/);
  });

  it('exits 1 with a clear diagnostic when the scan root does not exist', async () => {
    const nonexistent = join(tmpdir(), `does-not-exist-${Date.now()}`);
    const { code, stderr } = await runScript(nonexistent);
    expect(code).toBe(1);
    expect(stderr).toMatch(/does not exist/);
  });
});
