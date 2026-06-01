import * as path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { runTargetCli } from '../src/cli/runTargetCli.js';
import type { RunCliOpts } from '../src/cli/runCli.js';
import type { RunInstalledCliOptions } from '../src/cli/runInstalledCli.js';

describe('aharness run target dispatch', () => {
  it('runs an existing local FSM file through the normal runtime', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aharness-run-target-local-'));
    try {
      await writeFile(path.join(cwd, 'workflow.fsm.ts'), '');
      const runCliImpl = vi.fn(async () => ({ exitCode: 0 }));
      const runInstalledCliImpl = vi.fn(async () => ({ exitCode: 0 }));

      const result = await runTargetCli({
        target: './workflow.fsm.ts',
        cwd,
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        inputArgs: ['--topic', 'auth'],
        permissionMode: 'ask',
        runCliImpl,
        runInstalledCliImpl,
      });

      expect(result).toEqual({ exitCode: 0 });
      expect(runCliImpl).toHaveBeenCalledWith({
        fsmPath: './workflow.fsm.ts',
        cwd,
        stdout: expect.any(Writable),
        stderr: expect.any(Writable),
        inputArgs: ['--topic', 'auth'],
        permissionMode: 'ask',
      } satisfies RunCliOpts);
      expect(runInstalledCliImpl).not.toHaveBeenCalled();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('runs a missing qualified command through installed command execution', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aharness-run-target-installed-'));
    try {
      const runCliImpl = vi.fn(async () => ({ exitCode: 0 }));
      const runInstalledCliImpl = vi.fn(async () => ({ exitCode: 0 }));

      const result = await runTargetCli({
        target: '@scope/tools/build',
        cwd,
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        inputArgs: ['--topic', 'auth'],
        permissionMode: 'yolo',
        runCliImpl,
        runInstalledCliImpl,
      });

      expect(result).toEqual({ exitCode: 0 });
      expect(runInstalledCliImpl).toHaveBeenCalledWith({
        command: '@scope/tools/build',
        cwd,
        stdout: expect.any(Writable),
        stderr: expect.any(Writable),
        inputArgs: ['--topic', 'auth'],
        permissionMode: 'yolo',
      } satisfies RunInstalledCliOptions);
      expect(runCliImpl).not.toHaveBeenCalled();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('lets an existing local file shadow an installed bare command', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aharness-run-target-shadow-'));
    try {
      await writeFile(path.join(cwd, 'build'), '');
      const runCliImpl = vi.fn(async () => ({ exitCode: 0 }));
      const runInstalledCliImpl = vi.fn(async () => ({ exitCode: 0 }));

      const result = await runTargetCli({
        target: 'build',
        cwd,
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        runCliImpl,
        runInstalledCliImpl,
      });

      expect(result).toEqual({ exitCode: 0 });
      expect(runCliImpl).toHaveBeenCalledWith({
        fsmPath: 'build',
        cwd,
        stdout: expect.any(Writable),
        stderr: expect.any(Writable),
        inputArgs: [],
      } satisfies RunCliOpts);
      expect(runInstalledCliImpl).not.toHaveBeenCalled();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not scan input flag values for local FSM files', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'aharness-run-target-input-scan-'));
    try {
      await writeFile(path.join(cwd, 'other.fsm.ts'), '');
      const runCliImpl = vi.fn(async () => ({ exitCode: 0 }));
      const runInstalledCliImpl = vi.fn(async () => ({ exitCode: 0 }));

      const result = await runTargetCli({
        target: 'build',
        cwd,
        stdout: captureStream().stream,
        stderr: captureStream().stream,
        inputArgs: ['--spec', './other.fsm.ts'],
        runCliImpl,
        runInstalledCliImpl,
      });

      expect(result).toEqual({ exitCode: 0 });
      expect(runInstalledCliImpl).toHaveBeenCalledWith({
        command: 'build',
        cwd,
        stdout: expect.any(Writable),
        stderr: expect.any(Writable),
        inputArgs: ['--spec', './other.fsm.ts'],
      } satisfies RunInstalledCliOptions);
      expect(runCliImpl).not.toHaveBeenCalled();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

function captureStream(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, cb) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}
