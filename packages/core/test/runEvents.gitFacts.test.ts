import { describe, expect, it } from 'vitest';

import {
  createGitDiffRecordedEvent,
  createGitSnapshotRecordedEvent,
  type GitFactExec,
  type GitFactExecOptions,
  type GitSnapshotRecordedRunEventAppendInput,
} from '../src/runEvents/index.js';

const HEAD_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function availableSnapshot(
  phase: 'start' | 'terminal',
  head = phase === 'start' ? HEAD_A : HEAD_B,
): GitSnapshotRecordedRunEventAppendInput {
  return {
    type: 'git.snapshot.recorded',
    data: { phase, status: 'available', head },
  };
}

function unavailableSnapshot(phase: 'start' | 'terminal'): GitSnapshotRecordedRunEventAppendInput {
  return {
    type: 'git.snapshot.recorded',
    data: { phase, status: 'unavailable', reason: 'not-a-git-repository' },
  };
}

function execFromResponses(
  responses: ReadonlyArray<string | Error>,
  seen: Array<{
    readonly file: string;
    readonly args: ReadonlyArray<string>;
    readonly options: GitFactExecOptions;
  }> = [],
): GitFactExec {
  let index = 0;
  return async (file, args, options) => {
    seen.push({ file, args, options });
    const response = responses[index++];
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error('missing test response');
    return { stdout: response };
  };
}

function errorWith(fields: Record<string, unknown>): Error {
  return Object.assign(new Error('/private/repo leaked stderr fatal'), fields);
}

function expectNoSensitivePayload(value: unknown): void {
  const json = JSON.stringify(value);
  expect(json).not.toContain('/private/repo');
  expect(json).not.toContain('feature/branch');
  expect(json).not.toContain('git@github.com');
  expect(json).not.toContain('secret-file.ts');
  expect(json).not.toContain('git diff');
  expect(json).not.toContain('fatal:');
  expect(json).not.toContain('raw output');
}

describe('git fact events', () => {
  it('records an available snapshot with no-shell git commands and prompt suppression', async () => {
    const seen: Array<{
      readonly file: string;
      readonly args: ReadonlyArray<string>;
      readonly options: GitFactExecOptions;
    }> = [];
    const event = await createGitSnapshotRecordedEvent({
      cwd: '/private/repo',
      phase: 'start',
      timeoutMs: 123,
      exec: execFromResponses(['true\n', `${HEAD_A}\n`], seen),
    });

    expect(event).toEqual({
      type: 'git.snapshot.recorded',
      data: { phase: 'start', status: 'available', head: HEAD_A },
    });
    expect(seen.map((call) => [call.file, call.args])).toEqual([
      ['git', ['rev-parse', '--is-inside-work-tree']],
      ['git', ['rev-parse', 'HEAD']],
    ]);
    expect(seen.every((call) => call.options.timeout === 123)).toBe(true);
    expect(seen.every((call) => call.options.env.GIT_TERMINAL_PROMPT === '0')).toBe(true);
    expectNoSensitivePayload(event);
  });

  it('treats detached HEAD as an available snapshot', async () => {
    const event = await createGitSnapshotRecordedEvent({
      cwd: '/private/repo',
      phase: 'terminal',
      exec: execFromResponses(['true\n', `${HEAD_B}\n`]),
    });

    expect(event.data).toEqual({ phase: 'terminal', status: 'available', head: HEAD_B });
  });

  it('normalizes non-git, missing-git, spawn, unreadable cwd, timeout, and malformed HEAD failures', async () => {
    await expect(
      createGitSnapshotRecordedEvent({
        cwd: '/private/repo',
        phase: 'start',
        exec: execFromResponses([errorWith({ stderr: 'fatal: not a git repository' })]),
      }),
    ).resolves.toEqual({
      type: 'git.snapshot.recorded',
      data: { phase: 'start', status: 'unavailable', reason: 'not-a-git-repository' },
    });

    await expect(
      createGitSnapshotRecordedEvent({
        cwd: '/private/repo',
        phase: 'start',
        exec: execFromResponses([errorWith({ code: 'ENOENT' })]),
      }),
    ).resolves.toEqual({
      type: 'git.snapshot.recorded',
      data: { phase: 'start', status: 'unavailable', reason: 'git-unavailable' },
    });

    await expect(
      createGitSnapshotRecordedEvent({
        cwd: '/private/repo',
        phase: 'start',
        exec: execFromResponses(['true\n', errorWith({ code: 'EACCES' })]),
      }),
    ).resolves.toEqual({
      type: 'git.snapshot.recorded',
      data: { phase: 'start', status: 'unavailable', reason: 'head-unavailable' },
    });

    await expect(
      createGitSnapshotRecordedEvent({
        cwd: '/private/repo',
        phase: 'start',
        exec: execFromResponses([errorWith({ code: 'EACCES' })]),
      }),
    ).resolves.toEqual({
      type: 'git.snapshot.recorded',
      data: { phase: 'start', status: 'unavailable', reason: 'not-a-git-repository' },
    });

    await expect(
      createGitSnapshotRecordedEvent({
        cwd: '/private/repo',
        phase: 'start',
        exec: execFromResponses([errorWith({ killed: true })]),
      }),
    ).resolves.toEqual({
      type: 'git.snapshot.recorded',
      data: { phase: 'start', status: 'unavailable', reason: 'timeout' },
    });

    await expect(
      createGitSnapshotRecordedEvent({
        cwd: '/private/repo',
        phase: 'start',
        exec: execFromResponses(['true\n', 'raw output feature/branch\n']),
      }),
    ).resolves.toEqual({
      type: 'git.snapshot.recorded',
      data: { phase: 'start', status: 'unavailable', reason: 'head-unavailable' },
    });
  });

  it('records same-head and aggregate numstat diffs without retaining paths', async () => {
    await expect(
      createGitDiffRecordedEvent({
        cwd: '/private/repo',
        from: availableSnapshot('start', HEAD_A),
        to: availableSnapshot('terminal', HEAD_A),
      }),
    ).resolves.toEqual({
      type: 'git.diff.recorded',
      data: {
        status: 'available',
        from: HEAD_A,
        to: HEAD_A,
        filesChanged: 0,
        linesAdded: 0,
        linesDeleted: 0,
      },
    });

    const event = await createGitDiffRecordedEvent({
      cwd: '/private/repo',
      from: availableSnapshot('start', HEAD_A),
      to: availableSnapshot('terminal', HEAD_B),
      exec: execFromResponses([
        '5\t2\tsecret-file.ts\n-\t-\tassets/logo.png\n1\t0\told.ts => new.ts\n',
      ]),
    });

    expect(event).toEqual({
      type: 'git.diff.recorded',
      data: {
        status: 'available',
        from: HEAD_A,
        to: HEAD_B,
        filesChanged: 3,
        linesAdded: 6,
        linesDeleted: 2,
      },
    });
    expectNoSensitivePayload(event);
  });

  it('normalizes unavailable, missing object, timeout, shallow-history, and malformed diff failures', async () => {
    await expect(
      createGitDiffRecordedEvent({
        cwd: '/private/repo',
        from: unavailableSnapshot('start'),
        to: availableSnapshot('terminal', HEAD_B),
      }),
    ).resolves.toEqual({
      type: 'git.diff.recorded',
      data: { status: 'unavailable', reason: 'object-unavailable' },
    });

    await expect(
      createGitDiffRecordedEvent({
        cwd: '/private/repo',
        from: availableSnapshot('start', HEAD_A),
        to: availableSnapshot('terminal', HEAD_B),
        exec: execFromResponses([errorWith({ stderr: 'fatal: bad object secret-file.ts' })]),
      }),
    ).resolves.toEqual({
      type: 'git.diff.recorded',
      data: { status: 'unavailable', reason: 'object-unavailable' },
    });

    await expect(
      createGitDiffRecordedEvent({
        cwd: '/private/repo',
        from: availableSnapshot('start', HEAD_A),
        to: availableSnapshot('terminal', HEAD_B),
        exec: execFromResponses([errorWith({ killed: true })]),
      }),
    ).resolves.toEqual({
      type: 'git.diff.recorded',
      data: { status: 'unavailable', reason: 'timeout' },
    });

    await expect(
      createGitDiffRecordedEvent({
        cwd: '/private/repo',
        from: availableSnapshot('start', HEAD_A),
        to: availableSnapshot('terminal', HEAD_B),
        exec: execFromResponses(['not-num\t1\tsecret-file.ts\n']),
      }),
    ).resolves.toEqual({
      type: 'git.diff.recorded',
      data: { status: 'unavailable', reason: 'diff-unavailable' },
    });
  });
});
