// scripts/check-no-stale-stateless-contracts.test.mjs
//
// Exercises the stateless-runs/fresh-clear stale-contract scanner against
// temp repository layouts.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, 'check-no-stale-stateless-contracts.mjs');

const requiredFiles = [
  'README.md',
  'CLAUDE.md',
  'docs/architecture.md',
  'docs/reference.md',
  'docs/troubleshooting.md',
  'examples/DEMOS.md',
  'packages/core/README.md',
  'packages/core/scripts/browserGoldenServer.mjs',
  'packages/core/src/events.ts',
  'packages/core/src/index.ts',
  'packages/core/src/snapshot.ts',
  'packages/core/src/cli/runCli.ts',
  'packages/core/src/state/aharnessOps.ts',
  'packages/core/src/runtime/freshClear.ts',
];

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
  const d = mkdtempSync(join(tmpdir(), 'aharness-stateless-chk-'));
  tempdirs.push(d);
  return d;
}

function write(root, relPath, text) {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

function makeCleanRepo() {
  const root = makeTempdir();
  for (const relPath of requiredFiles) {
    write(root, relPath, 'Current stateless fresh-clear contract.\n');
  }
  write(
    root,
    'README.md',
    'If an FSM declares a root input named resume, --resume parses as that author input flag.\n',
  );
  write(root, 'examples/demo.fsm.ts', 'export const demo = "clearOnEntry";\n');
  write(root, 'packages/core/src/ui/events.ts', 'export const boundary = "fresh";\n');
  write(root, 'packages/web-ui/src/App.tsx', 'export const App = () => null;\n');
  return root;
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

describe('check-no-stale-stateless-contracts', () => {
  it('exits 0 for current contract copy and allowed author --resume wording', async () => {
    const root = makeCleanRepo();
    const { code, stderr } = await runScript(root);

    expect(code).toBe(0);
    expect(stderr).toBe('');
  });

  it('rejects framework resume recovery guidance', async () => {
    const root = makeCleanRepo();
    write(root, 'README.md', 'Crash recovery: resume with: aharness <file.fsm.ts> --resume\n');

    const { code, stderr } = await runScript(root);

    expect(code).toBe(1);
    expect(stderr).toContain('framework-resume-guidance');
    expect(stderr).toContain('README.md');
  });

  it('rejects durable pending-clear state', async () => {
    const root = makeCleanRepo();
    write(
      root,
      'packages/core/scripts/browserGoldenServer.mjs',
      'export const posture = { pendingClear: false };\n',
    );

    const { code, stderr } = await runScript(root);

    expect(code).toBe(1);
    expect(stderr).toContain('durable-pending-clear');
    expect(stderr).toContain('pendingClear');
  });

  it('rejects public callable ops.clear examples', async () => {
    const root = makeCleanRepo();
    write(root, 'packages/core/README.md', 'effect: async ({ ops }) => ops.clear()\n');

    const { code, stderr } = await runScript(root);

    expect(code).toBe(1);
    expect(stderr).toContain('legacy-ops-clear');
    expect(stderr).toContain('ops.clear(');
  });

  it('scans exported source comments for stale recovery language', async () => {
    const root = makeCleanRepo();
    write(root, 'packages/core/src/events.ts', '// State recovery is from snapshot.json.\n');

    const { code, stderr } = await runScript(root);

    expect(code).toBe(1);
    expect(stderr).toContain('framework-recovery-promise');
    expect(stderr).toContain('events.ts');
  });

  it('rejects snapshot.json as the current inspection source', async () => {
    const root = makeCleanRepo();
    write(root, 'docs/troubleshooting.md', 'The current inspection state is snapshot.json.\n');

    const { code, stderr } = await runScript(root);

    expect(code).toBe(1);
    expect(stderr).toContain('snapshot-current-source');
    expect(stderr).toContain('docs/troubleshooting.md');
  });

  it('rejects flat browser routes as a current served contract', async () => {
    const root = makeCleanRepo();
    write(root, 'docs/reference.md', 'The /api/state route remains served for browser state.\n');

    const { code, stderr } = await runScript(root);

    expect(code).toBe(1);
    expect(stderr).toContain('flat-browser-routes-current');
    expect(stderr).toContain('docs/reference.md');
  });

  it('rejects rollback-backed clear copy and UI rollback terms', async () => {
    const root = makeCleanRepo();
    write(
      root,
      'packages/web-ui/src/App.tsx',
      'export const label = "Rolling back";\nexport const event = "Rollback";\n',
    );

    const { code, stderr } = await runScript(root);

    expect(code).toBe(1);
    expect(stderr).toContain('rollback-backed-clear');
    expect(stderr).toContain('Rolling back');
  });

  it('allows negated rollback and pending-clear statements in current docs', async () => {
    const root = makeCleanRepo();
    write(
      root,
      'docs/SPEC_SDK.md',
      'Fresh clear never calls thread/rollback and does not persist pendingClear.\n',
    );

    const { code } = await runScript(root);

    expect(code).toBe(0);
  });

  it('does not scan historical docs, protocol pins, or tests', async () => {
    const root = makeCleanRepo();
    write(root, 'docs/specs/old-design.md', 'resume with: aharness <file.fsm.ts> --resume\n');
    write(root, 'docs/plans/old-plan.md', 'pendingClear and thread/rollback\n');
    write(root, 'packages/core/SUPPORTED_CODEX.md', 'thread/resume and thread/rollback\n');
    write(root, 'packages/web-ui/src/App.test.tsx', 'const text = "Rollback";\n');

    const { code, stderr } = await runScript(root);

    expect(code).toBe(0);
    expect(stderr).toBe('');
  });

  it('scans active UI fixtures', async () => {
    const root = makeCleanRepo();
    write(root, 'packages/web-ui/src/fixtures/sample.ts', 'const text = "pendingClear";\n');

    const { code, stderr } = await runScript(root);

    expect(code).toBe(1);
    expect(stderr).toContain('durable-pending-clear');
    expect(stderr).toContain('fixtures/sample.ts');
  });

  it('exits 1 with a clear diagnostic when a configured target is missing', async () => {
    const root = makeTempdir();
    write(root, 'README.md', 'Only one required file exists.\n');

    const { code, stderr } = await runScript(root);

    expect(code).toBe(1);
    expect(stderr).toContain('scan target does not exist');
  });
});
