/**
 * Phase 2a `itemCompletedWatcher` registry tests. Spec §5.3.
 *
 * Covers FIFO match on `dynamic_tools` callId, sync bookkeeping
 * invariant, timeout behavior, defensive item-shape guards, and the
 * duplicate-registration throw. The "all watcher bookkeeping is
 * synchronous" assertion is load-bearing for the dispatcher's reply-
 * before-dance ordering (see plan Contracts and invariants).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createItemCompletedWatcherRegistry } from '../src/transport/itemCompletedWatcher.js';

describe('itemCompletedWatcher registry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves on matching item/completed within the timeout', async () => {
    const reg = createItemCompletedWatcherRegistry();
    const matched = reg.register('call-1', { timeoutMs: 1_000 });
    expect(reg.dispatch({ type: 'dynamicToolCall', id: 'call-1', extra: 42 })).toBe(true);
    await expect(matched).resolves.toMatchObject({
      type: 'dynamicToolCall',
      id: 'call-1',
    });
    expect(reg.getPending()).toEqual([]);
  });

  it('times out with the expected message text when no match arrives', async () => {
    const reg = createItemCompletedWatcherRegistry();
    const matched = reg.register('call-2', { timeoutMs: 500 });
    vi.advanceTimersByTime(501);
    await expect(matched).rejects.toThrow(
      'itemCompletedWatcher: timeout after 500ms for callId=call-2',
    );
    expect(reg.getPending()).toEqual([]);
  });

  it("ignores items whose type !== 'dynamicToolCall'", () => {
    const reg = createItemCompletedWatcherRegistry();
    void reg.register('call-3', { timeoutMs: 1_000 });
    expect(reg.dispatch({ type: 'agentMessage', id: 'call-3' })).toBe(false);
    expect(reg.dispatch({ type: 'collabAgentToolCall', id: 'call-3' })).toBe(false);
    expect(reg.getPending()).toEqual(['call-3']);
  });

  it('ignores items whose id does not match', () => {
    const reg = createItemCompletedWatcherRegistry();
    void reg.register('call-4', { timeoutMs: 1_000 });
    expect(reg.dispatch({ type: 'dynamicToolCall', id: 'call-other' })).toBe(false);
    expect(reg.dispatch({ type: 'dynamicToolCall' })).toBe(false);
    expect(reg.dispatch(null)).toBe(false);
    expect(reg.dispatch('not-an-object')).toBe(false);
    expect(reg.getPending()).toEqual(['call-4']);
  });

  it('deregisters after a match (next dispatch returns false)', async () => {
    const reg = createItemCompletedWatcherRegistry();
    const matched = reg.register('call-5', { timeoutMs: 1_000 });
    expect(reg.dispatch({ type: 'dynamicToolCall', id: 'call-5' })).toBe(true);
    await matched;
    expect(reg.dispatch({ type: 'dynamicToolCall', id: 'call-5' })).toBe(false);
    expect(reg.getPending()).toEqual([]);
  });

  it('duplicate register for the same callId throws', () => {
    const reg = createItemCompletedWatcherRegistry();
    void reg.register('call-6', { timeoutMs: 1_000 });
    expect(() => reg.register('call-6', { timeoutMs: 1_000 })).toThrow(
      'itemCompletedWatcher: duplicate registration for callId=call-6',
    );
  });

  it('register() bookkeeping is synchronous (getPending() includes the callId immediately after the call, no await)', () => {
    const reg = createItemCompletedWatcherRegistry();
    // Capture state synchronously before any microtask boundary.
    void reg.register('call-7', { timeoutMs: 1_000 });
    const pendingImmediately = reg.getPending();
    expect(pendingImmediately).toContain('call-7');
  });
});
