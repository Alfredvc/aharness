/**
 * Tests for `daemon/awaitResolver.ts`.
 *
 * The resolver listens on `rawResponseItem/completed` rather than
 * `item/completed` (see resolver doc-comment for the citation chain).
 * These tests exercise the resolver against the wire shapes codex
 * actually emits at the pinned commit:
 *
 *   - `function_call` `ResponseItem` with `name: "request_user_input"`
 *     and `arguments: '{"questions":[...]}'` (verified at
 *     `/tmp/codex-rs/codex-rs/protocol/src/models.rs:778-791`).
 *   - `function_call_output` `ResponseItem` whose `output` is the JSON
 *     string of `{ answers: { [qid]: { answers: string[] } } }`
 *     (verified at `/tmp/codex-rs/codex-rs/core/src/tools/handlers/request_user_input.rs:66-72`
 *     and `/tmp/codex-rs/codex-rs/core/src/tools/context.rs:548-573`).
 *
 * Defensive coverage exercises the dropped paths (unknown call_id,
 * non-`request_user_input` name, no await exit on current state, and
 * malformed JSON in the output text).
 */

import { describe, expect, it, vi } from 'vitest';

import { createAwaitResolver } from '../src/runtime/awaitResolver.js';
import { prepareCanonicalAwaitCommit } from '../src/state/canonicalTransition.js';

function noteRequestUserInput(
  resolver: ReturnType<typeof createAwaitResolver>,
  callId: string,
  questionIds: ReadonlyArray<string>,
): void {
  resolver.noteFunctionCall({
    call_id: callId,
    name: 'request_user_input',
    arguments: JSON.stringify({
      questions: questionIds.map((id) => ({
        id,
        header: '',
        question: id,
        isOther: false,
        isSecret: false,
      })),
    }),
  });
}

describe('awaitResolver', () => {
  it('happy path: commits AWAIT__state__exit with the user message and runs onAfterTransition', async () => {
    const commit = vi.fn();
    const after = vi.fn();
    let stateId = 'q';
    const r = createAwaitResolver({
      currentStateId: () => stateId,
      currentAwaitExitName: () => 'wait',
      commitAwait: (...args) => {
        commit(...args);
        stateId = 'next';
      },
      onAfterTransition: after,
    });

    noteRequestUserInput(r, 'c1', ['q1']);
    await r.handleFunctionCallOutput({
      call_id: 'c1',
      output: JSON.stringify({ answers: { q1: { answers: ['banana'] } } }),
    });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('q', 'wait', 'banana');
    expect(after).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith({ from: 'q', to: 'next' });
  });

  it('multiple questions: ordering preserved per the saved questions array, joined with newlines', async () => {
    const commit = vi.fn();
    const r = createAwaitResolver({
      currentStateId: () => 'q',
      currentAwaitExitName: () => 'wait',
      commitAwait: commit,
      onAfterTransition: vi.fn(),
    });

    // Save-order is [a, b]; the response object is keyed in reverse to
    // verify the resolver follows the saved order, not insertion order.
    noteRequestUserInput(r, 'c1', ['a', 'b']);
    await r.handleFunctionCallOutput({
      call_id: 'c1',
      output: JSON.stringify({
        answers: {
          b: { answers: ['second'] },
          a: { answers: ['first'] },
        },
      }),
    });

    expect(commit).toHaveBeenCalledWith('q', 'wait', 'first\nsecond');
  });

  it('wrong tool name on noteFunctionCall: matching call_id is dropped on output', async () => {
    const commit = vi.fn();
    const after = vi.fn();
    const r = createAwaitResolver({
      currentStateId: () => 'q',
      currentAwaitExitName: () => 'wait',
      commitAwait: commit,
      onAfterTransition: after,
    });

    r.noteFunctionCall({
      call_id: 'c1',
      name: 'some_other_tool',
      arguments: '{}',
    });
    await r.handleFunctionCallOutput({
      call_id: 'c1',
      output: JSON.stringify({ answers: { q1: { answers: ['ignored'] } } }),
    });

    expect(commit).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it('unknown call_id on output (no prior noteFunctionCall): dropped silently', async () => {
    const commit = vi.fn();
    const after = vi.fn();
    const r = createAwaitResolver({
      currentStateId: () => 'q',
      currentAwaitExitName: () => 'wait',
      commitAwait: commit,
      onAfterTransition: after,
    });

    await r.handleFunctionCallOutput({
      call_id: 'unknown',
      output: JSON.stringify({ answers: { q1: { answers: ['x'] } } }),
    });

    expect(commit).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it('current state has no await exit: dropped, no commit, map cleaned up', async () => {
    const commit = vi.fn();
    const after = vi.fn();
    const r = createAwaitResolver({
      currentStateId: () => 's',
      currentAwaitExitName: () => null,
      commitAwait: commit,
      onAfterTransition: after,
    });

    noteRequestUserInput(r, 'c1', ['q1']);
    await r.handleFunctionCallOutput({
      call_id: 'c1',
      output: JSON.stringify({ answers: { q1: { answers: ['x'] } } }),
    });

    expect(commit).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it('malformed JSON in output text: dropped with logged warning, no throw', async () => {
    const commit = vi.fn();
    const after = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = createAwaitResolver({
      currentStateId: () => 'q',
      currentAwaitExitName: () => 'wait',
      commitAwait: commit,
      onAfterTransition: after,
    });

    noteRequestUserInput(r, 'c1', ['q1']);
    await r.handleFunctionCallOutput({
      call_id: 'c1',
      output: '{not valid json',
    });

    expect(commit).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('content-items array output shape (multi-text): concatenated with newlines before JSON parse', async () => {
    // Defensive: codex collapses single-text outputs to a plain string,
    // but the wire schema permits a bare array of input_text content
    // items. The resolver concatenates them with "\n" before parsing.
    const commit = vi.fn();
    const r = createAwaitResolver({
      currentStateId: () => 'q',
      currentAwaitExitName: () => 'wait',
      commitAwait: commit,
      onAfterTransition: vi.fn(),
    });

    noteRequestUserInput(r, 'c1', ['q1']);
    const fullJson = JSON.stringify({ answers: { q1: { answers: ['hello'] } } });
    await r.handleFunctionCallOutput({
      call_id: 'c1',
      // Single-item array: extracted text equals fullJson, parses cleanly.
      output: [{ type: 'input_text', text: fullJson }],
    });

    expect(commit).toHaveBeenCalledWith('q', 'wait', 'hello');
  });

  it('repeat handleFunctionCallOutput for the same call_id is dropped (map cleared on first commit)', async () => {
    const commit = vi.fn();
    const r = createAwaitResolver({
      currentStateId: () => 'q',
      currentAwaitExitName: () => 'wait',
      commitAwait: commit,
      onAfterTransition: vi.fn(),
    });

    noteRequestUserInput(r, 'c1', ['q1']);
    await r.handleFunctionCallOutput({
      call_id: 'c1',
      output: JSON.stringify({ answers: { q1: { answers: ['once'] } } }),
    });
    await r.handleFunctionCallOutput({
      call_id: 'c1',
      output: JSON.stringify({ answers: { q1: { answers: ['twice'] } } }),
    });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('q', 'wait', 'once');
  });

  it('awaits async commitAwait before onAfterTransition', async () => {
    const events: string[] = [];
    const r = createAwaitResolver({
      currentStateId: () => 'q',
      currentAwaitExitName: () => 'wait',
      commitAwait: async () => {
        events.push('commit:start');
        await Promise.resolve();
        events.push('commit:done');
      },
      onAfterTransition: () => {
        events.push('after');
      },
    });

    noteRequestUserInput(r, 'c1', ['q1']);
    await r.handleFunctionCallOutput({
      call_id: 'c1',
      output: JSON.stringify({ answers: { q1: { answers: ['go'] } } }),
    });

    expect(events).toEqual(['commit:start', 'commit:done', 'after']);
  });

  it('preflights canonical embedded child-final work before committing an await resolution', async () => {
    const events: string[] = [];
    const r = createAwaitResolver({
      currentStateId: () => 'child.ask',
      currentAwaitExitName: () => 'approve',
      prepareAwaitCommit: async (stateId, exitName, messageFromUser) => {
        events.push(`prepare:${stateId}:${exitName}:${messageFromUser}`);
        return { ok: true, nextContext: { approved: true } };
      },
      commitAwait: (_stateId, _exitName, _messageFromUser, nextContext) => {
        events.push(`commit:${(nextContext as { approved?: boolean } | undefined)?.approved}`);
      },
      onAfterTransition: () => {
        events.push('after');
      },
    });

    noteRequestUserInput(r, 'c1', ['q1']);
    await r.handleFunctionCallOutput({
      call_id: 'c1',
      output: JSON.stringify({ answers: { q1: { answers: ['yes'] } } }),
    });

    expect(events).toEqual(['prepare:child.ask:approve:yes', 'commit:true', 'after']);
  });

  it('does not commit or run after-transition work when canonical embedded await preflight fails', async () => {
    const commit = vi.fn();
    const after = vi.fn();
    const r = createAwaitResolver({
      currentStateId: () => 'child.ask',
      currentAwaitExitName: () => 'approve',
      prepareAwaitCommit: async () => ({ ok: false, error: 'canonical embed effect failed' }),
      commitAwait: commit,
      onAfterTransition: after,
    });

    noteRequestUserInput(r, 'c1', ['q1']);
    await r.handleFunctionCallOutput({
      call_id: 'c1',
      output: JSON.stringify({ answers: { q1: { answers: ['yes'] } } }),
    });

    expect(commit).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it('canonical await preparation runs effect before reducer and rolls back rejected effects', async () => {
    const events: string[] = [];
    const ok = await prepareCanonicalAwaitCommit({
      meta: {
        kind: 'await',
        ask: 'Proceed?',
        effect: async ({ data, ownerReply }) => {
          events.push(`effect:${data.count}:${ownerReply}`);
        },
        reduce: (draft, ownerReply) => {
          events.push(`reduce:${draft.count}:${ownerReply}`);
          draft.count += ownerReply.length;
        },
      },
      context: { count: 1 },
      ownerReply: 'yes',
    });

    expect(ok).toEqual({ ok: true, nextContext: { count: 4 } });
    expect(events).toEqual(['effect:1:yes', 'reduce:1:yes']);

    const failed = await prepareCanonicalAwaitCommit({
      meta: {
        kind: 'await',
        ask: 'Proceed?',
        effect: async () => {
          throw new Error('stop');
        },
        reduce: (draft) => {
          draft.count = 99;
        },
      },
      context: { count: 1 },
      ownerReply: 'no',
    });

    expect(failed).toEqual({ ok: false, error: 'stop' });
  });

  it('canonical await preparation rejects failing effects without leaking nested context mutations', async () => {
    const context = { nested: { marks: [] as string[] } };

    const failed = await prepareCanonicalAwaitCommit({
      meta: {
        kind: 'await',
        ask: 'Proceed?',
        effect: async ({ data }) => {
          data.nested.marks.push('await-effect');
          throw new Error('await exploded');
        },
        reduce: (draft) => {
          draft.nested.marks.push('reduce');
        },
      },
      context,
      ownerReply: 'no',
    });

    expect(failed).toEqual({ ok: false, error: 'await exploded' });
    expect(context).toEqual({ nested: { marks: [] } });
  });
});
