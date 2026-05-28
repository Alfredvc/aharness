/**
 * Tests for `cli/ownerInputProvider.ts`.
 *
 * Covers:
 *   - The interface surface (factory shapes + `DECLINED_ANSWER_TEXT`).
 *   - `createStdinOwnerInputProvider` against an in-memory stdin
 *     (`Readable.from`) and a capturing stdout (`PassThrough` with a
 *     chunk collector) — one line per question, EOF-rejection contract,
 *     per-question prompt format, `close()` lifecycle.
 *   - `createMockOwnerInputProviderQueue` FIFO + function-form entries.
 *
 * The factory uses Node's built-in `readline` lazily; the imports below
 * are static so the test file's evaluation does not load `readline` at
 * top level beyond what `process` already loads.
 */

import { PassThrough, Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  DECLINED_ANSWER_TEXT,
  createMockOwnerInputProviderQueue,
  createStdinOwnerInputProvider,
} from '../src/cli/ownerInputProvider.js';
import type {
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
} from '../src/protocol/types.js';

function paramsOf(
  questions: ReadonlyArray<{
    id: string;
    header?: string;
    question: string;
  }>,
): ToolRequestUserInputParams {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    questions: questions.map((q) => ({
      id: q.id,
      header: q.header ?? '',
      question: q.question,
      isOther: false,
      isSecret: false,
    })),
  };
}

function collectingStdout(): {
  readonly stream: NodeJS.WritableStream;
  readonly chunks: string[];
} {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (c: Buffer | string) => {
    chunks.push(typeof c === 'string' ? c : c.toString('utf8'));
  });
  return { stream, chunks };
}

describe('DECLINED_ANSWER_TEXT', () => {
  it('is the literal "(declined)" so the handler and tests share one source of truth', () => {
    expect(DECLINED_ANSWER_TEXT).toBe('(declined)');
  });
});

describe('createStdinOwnerInputProvider', () => {
  it('single-question request reads one line and returns {answers: {<qid>: {answers: [<line>]}}}', async () => {
    const stdin = Readable.from(['banana\n']);
    const { stream: stdout } = collectingStdout();
    const provider = createStdinOwnerInputProvider({ stdin, stdout });

    const reply = await provider.provideAnswers(
      paramsOf([{ id: 'owner', question: 'What fruit?' }]),
    );

    expect(reply).toEqual({
      answers: { owner: { answers: ['banana'] } },
    });
    provider.close?.();
  });

  it('two-question request reads two lines and returns answers in question-declaration order', async () => {
    // PassThrough (not Readable.from) — Readable.from auto-ends once
    // its source is exhausted, which would close readline mid-batch.
    // Feed one line per `> ` prompt the provider writes so readline's
    // line-buffered protocol can dispatch each line to the matching
    // rl.question callback (lines that arrive between rl.question
    // calls would emit as 'line' events and be dropped).
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const chunks: string[] = [];
    let promptsSeen = 0;
    const lines = ['first-line\n', 'second-line\n'];
    stdout.on('data', (c: Buffer | string) => {
      const s = typeof c === 'string' ? c : c.toString('utf8');
      chunks.push(s);
      if (s.endsWith('> ')) {
        const idx = promptsSeen++;
        if (idx < lines.length) stdin.write(lines[idx]);
      }
    });
    const provider = createStdinOwnerInputProvider({ stdin, stdout });

    const reply = await provider.provideAnswers(
      paramsOf([
        { id: 'q-a', question: 'First?' },
        { id: 'q-b', question: 'Second?' },
      ]),
    );

    expect(reply).toEqual({
      answers: {
        'q-a': { answers: ['first-line'] },
        'q-b': { answers: ['second-line'] },
      },
    });
    expect(promptsSeen).toBe(2);
    provider.close?.();
  });

  it('stdin closes before answer rejects with the pinned error message', async () => {
    // Empty source — readline observes EOF immediately on first read.
    const stdin = Readable.from([]);
    const { stream: stdout } = collectingStdout();
    const provider = createStdinOwnerInputProvider({ stdin, stdout });

    await expect(
      provider.provideAnswers(paramsOf([{ id: 'owner', question: 'What fruit?' }])),
    ).rejects.toThrow('stdin closed before answer was provided');
    provider.close?.();
  });

  it('question with non-empty header prints header + ":" + "\\n" + question to stdout before reading', async () => {
    const stdin = Readable.from(['ignored\n']);
    const { stream: stdout, chunks } = collectingStdout();
    const provider = createStdinOwnerInputProvider({ stdin, stdout });

    await provider.provideAnswers(
      paramsOf([{ id: 'owner', header: 'Owner', question: 'What fruit?' }]),
    );

    const combined = chunks.join('');
    // Header + ":" + "\n" + question appears before the readline prompt's "> ".
    expect(combined).toContain('Owner:\nWhat fruit?');
    provider.close?.();
  });

  it('close() ends the underlying readline.Interface', async () => {
    const stdin = Readable.from(['banana\n']);
    const { stream: stdout } = collectingStdout();
    const provider = createStdinOwnerInputProvider({ stdin, stdout });

    // Force the lazy readline.Interface to be constructed.
    await provider.provideAnswers(paramsOf([{ id: 'owner', question: 'What fruit?' }]));

    // After close(), a fresh provideAnswers call must reject (the
    // interface is gone; the EOF-rejection path fires).
    provider.close?.();
    await expect(
      provider.provideAnswers(paramsOf([{ id: 'owner', question: 'Again?' }])),
    ).rejects.toThrow('stdin closed before answer was provided');
  });
});

describe('createMockOwnerInputProviderQueue', () => {
  it('returns each queued response in FIFO order, throws when the queue is empty', async () => {
    const provider = createMockOwnerInputProviderQueue();
    const r1: ToolRequestUserInputResponse = {
      answers: { owner: { answers: ['first'] } },
    };
    const r2: ToolRequestUserInputResponse = {
      answers: { owner: { answers: ['second'] } },
    };
    provider.queue(r1);
    provider.queue(r2);

    await expect(
      provider.provideAnswers(paramsOf([{ id: 'owner', question: '?' }])),
    ).resolves.toEqual(r1);
    await expect(
      provider.provideAnswers(paramsOf([{ id: 'owner', question: '?' }])),
    ).resolves.toEqual(r2);
    await expect(
      provider.provideAnswers(paramsOf([{ id: 'owner', question: '?' }])),
    ).rejects.toThrow();
  });

  it('a function-form queued entry is invoked with the request params and may return sync or async', async () => {
    const provider = createMockOwnerInputProviderQueue();

    // Sync function form.
    provider.queue((params) => ({
      answers: Object.fromEntries(
        params.questions.map((q) => [q.id, { answers: [`sync:${q.id}`] }]),
      ),
    }));
    // Async function form.
    provider.queue(async (params) => ({
      answers: Object.fromEntries(
        params.questions.map((q) => [q.id, { answers: [`async:${q.id}`] }]),
      ),
    }));

    const p1 = paramsOf([{ id: 'a', question: '?' }]);
    await expect(provider.provideAnswers(p1)).resolves.toEqual({
      answers: { a: { answers: ['sync:a'] } },
    });

    const p2 = paramsOf([
      { id: 'x', question: '?' },
      { id: 'y', question: '?' },
    ]);
    await expect(provider.provideAnswers(p2)).resolves.toEqual({
      answers: {
        x: { answers: ['async:x'] },
        y: { answers: ['async:y'] },
      },
    });
  });
});
