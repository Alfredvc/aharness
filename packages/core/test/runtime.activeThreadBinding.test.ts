import { describe, expect, it, vi } from 'vitest';

import { createActiveThreadBinding } from '../src/runtime/activeThreadBinding.js';

describe('createActiveThreadBinding', () => {
  it('supports optional and required reads after initialization', () => {
    const binding = createActiveThreadBinding('thread-1');

    expect(binding.current()).toBe('thread-1');
    expect(binding.require()).toBe('thread-1');
  });

  it('throws a clear internal error when a required read happens before initialization', () => {
    const binding = createActiveThreadBinding();

    expect(binding.current()).toBeUndefined();
    expect(() => binding.require()).toThrow(/active thread binding read before thread\/start/);
  });

  it('rejects empty thread ids', () => {
    const binding = createActiveThreadBinding();

    expect(() => binding.set('')).toThrow(/active thread id must be non-empty/);
    expect(() => createActiveThreadBinding('')).toThrow(/active thread id must be non-empty/);
  });

  it('updates the current id and notifies onChange callbacks', () => {
    const onChange = vi.fn();
    const binding = createActiveThreadBinding('thread-1', { onChange });

    binding.set('thread-2');

    expect(binding.current()).toBe('thread-2');
    expect(binding.require()).toBe('thread-2');
    expect(onChange).toHaveBeenCalledWith('thread-2');
  });

  it('records abandoned parent thread ids only after real swaps', () => {
    const binding = createActiveThreadBinding();

    binding.set('thread-1');
    expect(binding.isAbandoned('thread-1')).toBe(false);

    binding.set('thread-1');
    expect(binding.isAbandoned('thread-1')).toBe(false);

    binding.set('thread-2');
    expect(binding.current()).toBe('thread-2');
    expect(binding.isAbandoned('thread-1')).toBe(true);
    expect(binding.isAbandoned('thread-2')).toBe(false);

    binding.set('thread-3');
    expect(binding.isAbandoned('thread-1')).toBe(true);
    expect(binding.isAbandoned('thread-2')).toBe(true);
    expect(binding.isAbandoned('thread-3')).toBe(false);

    binding.set('thread-1');
    expect(binding.current()).toBe('thread-1');
    expect(binding.isAbandoned('thread-1')).toBe(false);
    expect(binding.isAbandoned('thread-2')).toBe(true);
    expect(binding.isAbandoned('thread-3')).toBe(true);
  });

  it('can mark the current thread abandoned before a replacement id is known', () => {
    const binding = createActiveThreadBinding('thread-1');

    binding.markAbandoned('thread-1');

    expect(binding.current()).toBe('thread-1');
    expect(binding.require()).toBe('thread-1');
    expect(binding.isAbandoned('thread-1')).toBe(true);

    binding.set('thread-2');
    expect(binding.isAbandoned('thread-1')).toBe(true);
    expect(binding.isAbandoned('thread-2')).toBe(false);
  });

  it('notifies multiple subscribers in registration order and keeps onChange as the initial subscriber', () => {
    const calls: string[] = [];
    const binding = createActiveThreadBinding('thread-1', {
      onChange: (threadId) => calls.push(`initial:${threadId}`),
    });

    binding.subscribe((threadId) => calls.push(`first:${threadId}`));
    binding.subscribe((threadId) => calls.push(`second:${threadId}`));

    binding.set('thread-2');

    expect(calls).toEqual(['initial:thread-2', 'first:thread-2', 'second:thread-2']);
  });

  it('swallows subscriber errors so later subscribers still run', () => {
    const calls: string[] = [];
    const binding = createActiveThreadBinding('thread-1');

    binding.subscribe((threadId) => calls.push(`first:${threadId}`));
    binding.subscribe(() => {
      throw new Error('subscriber failed');
    });
    binding.subscribe((threadId) => calls.push(`third:${threadId}`));

    expect(() => binding.set('thread-2')).not.toThrow();
    expect(calls).toEqual(['first:thread-2', 'third:thread-2']);
  });

  it('returns idempotent unsubscribe functions', () => {
    const listener = vi.fn();
    const binding = createActiveThreadBinding('thread-1');
    const unsubscribe = binding.subscribe(listener);

    unsubscribe();
    unsubscribe();
    binding.set('thread-2');

    expect(listener).not.toHaveBeenCalled();
  });
});
