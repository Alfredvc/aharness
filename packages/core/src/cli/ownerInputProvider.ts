/**
 * `OwnerInputProvider` — pluggable producer of answers for parked
 * `item/tool/requestUserInput` ServerRequests.
 *
 * The CLI's ServerRequest handler (see `runCli.ts`) parks each
 * `item/tool/requestUserInput` request, calls the provider with the
 * params verbatim, and replies with the provider's response. The
 * provider knows nothing about the rest of the run — it is the only
 * thing that knows how to satisfy a batch of questions.
 *
 * Two factories live here:
 *
 *   - `createStdinOwnerInputProvider({stdin, stdout})` — production
 *     implementation. Reads one line per question from stdin via Node's
 *     built-in `readline`. The `readline.Interface` is constructed
 *     lazily on first `provideAnswers` call so importing the module has
 *     no side-effect on stdin. `close()` ends the interface so the
 *     surrounding process can exit cleanly.
 *
 *   - `createMockOwnerInputProviderQueue()` — in-tree CLI-test
 *     convenience. Returns a provider with a `queue(...)` setter that
 *     accepts either a pre-built response or an arrow function that
 *     produces one. (The richer cross-package `MockOwnerInputProvider`
 *     lives in `@aharness/test-support`.)
 *
 * `DECLINED_ANSWER_TEXT` is re-exported from the runtime abandoned-thread
 * response helpers. It is the verbatim placeholder ("(declined)") that
 * the ServerRequest handler emits for every question id when the provider
 * throws or rejects. Sharing it with the runtime helper keeps provider
 * errors and abandoned-request replies in lockstep.
 */

import * as readline from 'node:readline';

import type {
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
} from '../protocol/types.js';
import { DECLINED_ANSWER_TEXT } from '../runtime/abandonedThreadResponses.js';

/**
 * Synthetic-decline marker text. Re-exported here for existing CLI and
 * public-barrel imports. The leading "(" + trailing ")" are load-bearing
 * — the marker is meant to be visually distinct in the model's tool
 * result so the model can advance with a non-empty answer.
 */
export { DECLINED_ANSWER_TEXT };

/**
 * Verbatim error message thrown when stdin reaches EOF before the
 * provider could read an answer. Pinned so the synthetic-decline
 * handler can route on it deterministically.
 */
const STDIN_CLOSED_ERROR = 'stdin closed before answer was provided';

/**
 * Pluggable producer of answers for `item/tool/requestUserInput`
 * ServerRequests.
 *
 * `provideAnswers(params)` receives the full questions array verbatim
 * and MUST return the matching `answers` map (the double-nested wire
 * shape is `{answers: {<qid>: {answers: [<text>]}}}`).
 *
 * Exceptions thrown from `provideAnswers` propagate to the caller — the
 * ServerRequest handler is responsible for synthesising the
 * `DECLINED_ANSWER_TEXT` fallback. The provider MUST NOT swallow
 * errors.
 *
 * `close?()` lets the surrounding process release any held resources
 * (a `readline.Interface` for `StdinOwnerInputProvider`). Optional on
 * the interface so trivial providers (e.g. the test-support queue) can
 * omit it; `runShutdown` (Phase-1b runtime) invokes it when present.
 */
export interface OwnerInputProvider {
  provideAnswers(params: ToolRequestUserInputParams): Promise<ToolRequestUserInputResponse>;
  close?(): void;
}

/**
 * Options for `createStdinOwnerInputProvider`. Defaults: `process.stdin`
 * / `process.stdout`. Tests inject an in-memory `Readable` for stdin
 * and a capturing `Writable` for stdout.
 */
export interface CreateStdinOwnerInputProviderOpts {
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
}

/**
 * Build a stdin-backed `OwnerInputProvider`. The `readline.Interface`
 * is constructed lazily on first `provideAnswers` call; `close()` ends
 * it (a subsequent `provideAnswers` call will reject with
 * `STDIN_CLOSED_ERROR` when it tries to rebuild against the now-closed
 * stdin).
 *
 * NOTE: v1 ignores `isSecret: true` questions. The `readline` echoes
 * the answer by default; turning that off in a cross-platform way
 * requires raw-mode handling on a TTY which is out of v1 scope. Manual
 * smoke for secret prompts will surface this as a limitation; document
 * the gap inline at the prompt site.
 */
export function createStdinOwnerInputProvider(
  opts: CreateStdinOwnerInputProviderOpts = {},
): OwnerInputProvider {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  // Lazily constructed on first provideAnswers call. Held for the
  // provider's lifetime; close() ends it. Construction is deferred so
  // module import has no observable effect on stdin.
  let rl: readline.Interface | null = null;
  let closed = false;

  const ensureRl = (): readline.Interface => {
    if (closed) {
      // close() was called; force a fresh EOF rejection on the next
      // provideAnswers so the caller sees the same error shape as a
      // genuine stdin EOF.
      throw new Error(STDIN_CLOSED_ERROR);
    }
    if (rl === null) {
      rl = readline.createInterface({
        input: stdin,
        output: stdout,
        // terminal=false so we don't try to drive ANSI cursor moves
        // against a non-TTY (in-memory streams in tests, piped stdin
        // in CI).
        terminal: false,
      });
    }
    return rl;
  };

  const askOne = async (iface: readline.Interface, prompt: string): Promise<string> => {
    return await new Promise<string>((resolve, reject) => {
      // Subscribe to 'close' BEFORE calling iface.question — readline's
      // 'question' callback is silently dropped on EOF, so we route the
      // pending promise through an explicit 'close' listener.
      const onClose = (): void => {
        reject(new Error(STDIN_CLOSED_ERROR));
      };
      iface.once('close', onClose);
      iface.question(prompt, (line: string) => {
        // Detach the close listener — a later close() must not
        // spuriously reject this already-resolved answer.
        iface.off('close', onClose);
        resolve(line);
      });
    });
  };

  return {
    async provideAnswers(
      params: ToolRequestUserInputParams,
    ): Promise<ToolRequestUserInputResponse> {
      const iface = ensureRl();
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of params.questions) {
        // Per-question prompt format:
        //   <header>:\n<question>\n>    (when header is non-empty)
        //   <question>\n>                (otherwise)
        // The trailing "> " mirrors the shape used by `stdoutUI` sinks
        // elsewhere in the codebase. NOTE: `isSecret: true` is ignored
        // in v1 — readline echoes by default and platform-portable
        // raw-mode echo suppression is out of scope.
        const header = q.header.length > 0 ? `${q.header}:\n` : '';
        const prompt = `${header}${q.question}\n> `;
        const line = await askOne(iface, prompt);
        answers[q.id] = { answers: [line] };
      }
      return { answers };
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (rl !== null) {
        rl.close();
        rl = null;
      }
    },
  };
}

/**
 * Mock provider with a FIFO `queue` of pre-built responses or
 * params-aware producer callbacks. Used by in-tree CLI tests that need
 * a provider without depending on the richer cross-package mock in
 * `@aharness/test-support`.
 *
 * The function-form union is parenthesised because TypeScript would
 * otherwise mis-bind the second branch of `|` against the `Promise<...>`
 * tail. Authors who want a synchronous response use the value form;
 * authors who need access to the request params use the function form.
 */
export type MockOwnerInputQueueEntry =
  | ToolRequestUserInputResponse
  | ((
      params: ToolRequestUserInputParams,
    ) => ToolRequestUserInputResponse | Promise<ToolRequestUserInputResponse>);

export interface MockOwnerInputProviderQueue extends OwnerInputProvider {
  queue(entry: MockOwnerInputQueueEntry): void;
}

export function createMockOwnerInputProviderQueue(): MockOwnerInputProviderQueue {
  const pending: MockOwnerInputQueueEntry[] = [];
  return {
    queue(entry) {
      pending.push(entry);
    },
    async provideAnswers(params) {
      const next = pending.shift();
      if (next === undefined) {
        throw new Error(
          'createMockOwnerInputProviderQueue: queue is empty; call queue(...) before provideAnswers',
        );
      }
      if (typeof next === 'function') {
        return await next(params);
      }
      return next;
    },
  };
}
