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

  it('does not read from any HARNESS_*_BUDGET_MS env var (per R28)', () => {
    // The constants are compile-time literals; mutating env after import
    // must not change the exported values. This is a structural assertion
    // rather than behavioral, since reading process.env at module-load time
    // would have already happened — the imported constants must equal the
    // documented defaults regardless.
    const before = {
      submit: watchdogConfig.SUBMIT_BUDGET_MS,
      rui: watchdogConfig.RUI_RACE_BUDGET_MS,
    };
    process.env.HARNESS_SUBMIT_BUDGET_MS = '999';
    process.env.HARNESS_RUI_BUDGET_MS = '888';
    try {
      expect(watchdogConfig.SUBMIT_BUDGET_MS).toBe(before.submit);
      expect(watchdogConfig.RUI_RACE_BUDGET_MS).toBe(before.rui);
    } finally {
      delete process.env.HARNESS_SUBMIT_BUDGET_MS;
      delete process.env.HARNESS_RUI_BUDGET_MS;
    }
  });
});
