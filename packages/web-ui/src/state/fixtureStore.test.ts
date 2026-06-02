import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildFixtureInitial, readShareFixtureModeFromLocation } from './fixtureStore.js';
import { resolveFixture } from '../fixtures/registry.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fixtureStore share validation mode', () => {
  it('reads only supported share fixture modes from the URL', () => {
    vi.stubGlobal('location', { search: '?fsm=auto&share=success' });
    expect(readShareFixtureModeFromLocation()).toBe('success');

    vi.stubGlobal('location', { search: '?fsm=auto&share=failure' });
    expect(readShareFixtureModeFromLocation()).toBe('failure');

    vi.stubGlobal('location', { search: '?fsm=auto&share=unknown' });
    expect(readShareFixtureModeFromLocation()).toBeNull();
  });

  it('initializes a terminal success share fixture with stats and open final overview', () => {
    const state = buildFixtureInitial(resolveFixture('auto'), 'success');

    expect(state.posture.isTerminal).toBe(true);
    expect(state.connection).toBe('live');
    expect(state.completionStats?.outcome).toBe('success');
    expect(state.completionStats?.fsmDisplayName).toBe('autonomous-repair');
    expect(state.finalOverview).toEqual({
      open: true,
      autoOpened: true,
      dismissed: false,
      loading: false,
      error: null,
    });
  });

  it('initializes a terminal failure share fixture without exposing raw fixture paths', () => {
    const state = buildFixtureInitial(resolveFixture('auto'), 'failure');

    expect(state.completionStats?.outcome).toBe('failure');
    expect(state.completionStats?.fsmDisplayName).not.toContain('examples/');
    expect(state.completionStats?.workDelta.status).toBe('available');
  });
});
