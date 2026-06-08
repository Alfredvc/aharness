import { describe, expect, it, vi } from 'vitest';

import { createAharnessOps } from '../src/state/aharnessOps.js';
import type { CodexSidecarThread } from '../src/state/codexSidecar.js';

describe('createAharnessOps', () => {
  it('exposes deterministic codex and emit operations', () => {
    const h = createAharnessOps();
    expect(Object.isFrozen(h.ops)).toBe(true);
    expect(Object.isFrozen(h.ops.codex)).toBe(true);
    expect(typeof h.ops.codex.createThread).toBe('function');
    expect(typeof h.ops.codex.thread).toBe('function');
    expect(typeof h.ops.emit).toBe('function');
  });

  it('does not expose clear at runtime', () => {
    const h = createAharnessOps();
    expect('clear' in h.ops).toBe(false);
  });

  it('throws on use before live operations are bound', async () => {
    const h = createAharnessOps();

    await expect(h.ops.codex.createThread('subject')).rejects.toThrow(
      'Aharness ops.codex.createThread is only available during a live run',
    );
    expect(() => h.ops.codex.thread('subject')).toThrow(
      'Aharness ops.codex.thread is only available during a live run',
    );
    await expect(h.ops.emit('sidecarDone', {})).rejects.toThrow(
      'Aharness ops.emit is only available during a live run',
    );
  });

  it('delegates to bound live operations', async () => {
    const h = createAharnessOps();
    const thread: CodexSidecarThread = {
      key: 'subject',
      threadId: 'thread-1',
      async send() {
        return {
          ok: true,
          kind: 'completed',
          turn: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            assistantText: 'done',
            events: [],
          },
        };
      },
      async sendOrThrow() {
        return {
          ok: true,
          kind: 'completed',
          turn: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            assistantText: 'done',
            events: [],
          },
        };
      },
      async answer() {
        return {
          ok: true,
          kind: 'completed',
          turn: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            assistantText: 'done',
            events: [],
          },
        };
      },
      async close() {},
    };
    const createThread = vi.fn(async () => thread);
    const lookupThread = vi.fn(() => thread);
    const emit = vi.fn(async () => ({
      handled: true,
      stateChanged: false,
      returnValue: 'ok',
    }));

    h.bind({
      codex: {
        createThread,
        thread: lookupThread,
      },
      emit,
    });

    await expect(h.ops.codex.createThread('subject', { label: 'Subject' })).resolves.toBe(thread);
    expect(h.ops.codex.thread('subject')).toBe(thread);
    await expect(h.ops.emit('sidecarDone', { ok: true })).resolves.toEqual({
      handled: true,
      stateChanged: false,
      returnValue: 'ok',
    });
    expect(createThread).toHaveBeenCalledWith('subject', { label: 'Subject' });
    expect(lookupThread).toHaveBeenCalledWith('subject');
    expect(emit).toHaveBeenCalledWith('sidecarDone', { ok: true });
  });
});
