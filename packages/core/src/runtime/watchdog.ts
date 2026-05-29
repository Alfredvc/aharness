/**
 * Handler watchdog.
 *
 * Wraps an async handler with a soft budget: if the handler does not
 * resolve within `budgetMs`, `onOver` is invoked exactly once with the
 * budget that was exceeded. The handler itself is never aborted — the
 * watchdog is observational, designed to surface budget overruns
 * (500 ms for submit, 100 ms for shorter request handlers) so callers
 * can record canonical diagnostics in `events.jsonl` without changing
 * handler behavior.
 *
 * Implementation note: only the timer fires `onOver`. The `finally`
 * block does not re-check the elapsed time, which would otherwise
 * double-fire whenever the handler runs past the budget (the timer
 * has already fired, and the elapsed time is also now over budget).
 * The timer is reliable for any non-zero budget on async handlers,
 * because the handler resolution must yield to the event loop at
 * least once before the `finally` runs.
 */
export { SUBMIT_BUDGET_MS, RUI_RACE_BUDGET_MS } from './watchdogConfig.js';

export interface WatchdogOpts {
  readonly name: string;
  readonly budgetMs: number;
  readonly onOver: (info: { name: string; budgetMs: number; tookMs: number }) => void;
}

export async function withWatchdog<T>(o: WatchdogOpts, fn: () => Promise<T>): Promise<T> {
  const t = setTimeout(
    () => o.onOver({ name: o.name, budgetMs: o.budgetMs, tookMs: o.budgetMs }),
    o.budgetMs,
  );
  try {
    return await fn();
  } finally {
    clearTimeout(t);
  }
}
