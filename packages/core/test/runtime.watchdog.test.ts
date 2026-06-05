import { describe, expect, it, vi } from 'vitest';

import { RUI_RACE_BUDGET_MS, SUBMIT_BUDGET_MS, withWatchdog } from '../src/runtime/watchdog.js';
import * as watchdogConfig from '../src/runtime/watchdogConfig.js';

describe('withWatchdog', () => {
  it('does not warn when handler completes within budget', async () => {
    const warn = vi.fn();
    const out = await withWatchdog({ name: 'submit', budgetMs: 50, onOver: warn }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when handler exceeds budget but still resolves', async () => {
    const warn = vi.fn();
    const out = await withWatchdog({ name: 'submit', budgetMs: 5, onOver: warn }, async () => {
      await new Promise((r) => setTimeout(r, 30));
      return 42;
    });
    expect(out).toBe(42);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ name: 'submit', budgetMs: 5 });
  });
});

describe('watchdogConfig (R28: no env-var override)', () => {
  it('exports SUBMIT_BUDGET_MS as a positive number defaulting to 500 ms', () => {
    expect(typeof watchdogConfig.SUBMIT_BUDGET_MS).toBe('number');
    expect(Number.isFinite(watchdogConfig.SUBMIT_BUDGET_MS)).toBe(true);
    expect(watchdogConfig.SUBMIT_BUDGET_MS).toBeGreaterThan(0);
    expect(watchdogConfig.SUBMIT_BUDGET_MS).toBe(500);
  });

  it('exports RUI_RACE_BUDGET_MS as a positive number defaulting to 100 ms', () => {
    expect(typeof watchdogConfig.RUI_RACE_BUDGET_MS).toBe('number');
    expect(Number.isFinite(watchdogConfig.RUI_RACE_BUDGET_MS)).toBe(true);
    expect(watchdogConfig.RUI_RACE_BUDGET_MS).toBeGreaterThan(0);
    expect(watchdogConfig.RUI_RACE_BUDGET_MS).toBe(100);
  });

  it('re-exports the constants from watchdog.ts for ergonomic import', () => {
    expect(SUBMIT_BUDGET_MS).toBe(watchdogConfig.SUBMIT_BUDGET_MS);
    expect(RUI_RACE_BUDGET_MS).toBe(watchdogConfig.RUI_RACE_BUDGET_MS);
  });

  it('ignores AHARNESS_*_BUDGET_MS env vars at module load (per R28)', async () => {
    vi.resetModules();
    vi.stubEnv('AHARNESS_SUBMIT_BUDGET_MS', '999');
    vi.stubEnv('AHARNESS_RUI_BUDGET_MS', '888');
    try {
      const importedConfig = await import('../src/runtime/watchdogConfig.js');

      expect(importedConfig.SUBMIT_BUDGET_MS).toBe(500);
      expect(importedConfig.RUI_RACE_BUDGET_MS).toBe(100);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
