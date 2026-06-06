import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';

import { runCompletionMain } from '../src/cli/completionMain.js';

function captureStdout(): { readonly stream: PassThrough; readonly text: () => string } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', (chunk) => chunks.push(chunk.toString()));
  return { stream, text: () => chunks.join('') };
}

describe('completion-only binary entrypoint', () => {
  it('serves root command completion without importing the full bridge', async () => {
    const stdout = captureStdout();
    const runCompletionBridge = vi.fn(async () => ({ exitCode: 0 }));

    const result = await runCompletionMain({
      argv: ['completion-server', '--', 'aharness', 'r'],
      env: { COMP_LINE: 'aharness r', COMP_POINT: '10', COMP_CWORD: '1' },
      cwd: '/repo',
      stdout: stdout.stream,
      runCompletionBridge,
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(runCompletionBridge).not.toHaveBeenCalled();
    expect(stdout.text()).toBe('run\n');
  });

  it('routes tabtab completion-server argv to the bridge', async () => {
    const stdout = captureStdout();
    const runCompletionBridge = vi.fn(async (opts: { readonly stdout: NodeJS.WritableStream }) => {
      opts.stdout.write('run\n');
      return { exitCode: 0 };
    });

    const result = await runCompletionMain({
      argv: ['completion-server', '--', 'aharness', 'r'],
      env: {
        COMP_LINE: 'aharness run fixture.fsm.ts --',
        COMP_POINT: '31',
        COMP_CWORD: '3',
      },
      cwd: '/repo',
      stdout: stdout.stream,
      runCompletionBridge,
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(runCompletionBridge).toHaveBeenCalledWith({
      env: {
        COMP_LINE: 'aharness run fixture.fsm.ts --',
        COMP_POINT: '31',
        COMP_CWORD: '3',
      },
      cwd: '/repo',
      stdout: stdout.stream,
    });
    expect(stdout.text()).toBe('run\n');
  });

  it('bounds a hung bridge with the completion watchdog', async () => {
    const runCompletionBridge = vi.fn(() => new Promise<{ exitCode: number }>(() => {}));
    const start = Date.now();

    const result = await runCompletionMain({
      argv: ['completion-server'],
      env: {},
      cwd: '/repo',
      stdout: new PassThrough(),
      runCompletionBridge,
      watchdogMs: 10,
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(Date.now() - start).toBeLessThan(100);
    expect(runCompletionBridge).toHaveBeenCalledOnce();
  });
});
