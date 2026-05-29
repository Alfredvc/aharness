/**
 * `CacheMetrics` — running snapshot of input-token caching health for a
 * single daemon run. Updated once per turn from the
 * `thread/tokenUsage/updated` notification's `tokenUsage.last`
 * `TokenUsageBreakdown` (see codex-rs
 * `app-server-protocol/src/protocol/v2.rs` `TokenUsageBreakdown` and
 * `bespoke_event_handling.rs::handle_token_count_event`).
 *
 * # Design intent
 *
 * The cached-input ratio is the operator's signal that codex's prefix
 * cache is doing its job. Anthropic's cached prefix is the dominant
 * cost lever — once a thread's stable prefix grows, every subsequent
 * turn should hit the cache, so a ratio sustained well below ~70 %
 * after the warm-up turns means something is invalidating the prefix
 * (system-prompt churn, dynamic-tool list churn, etc.) and operator
 * attention is warranted. The threshold is taken from the §16 q1
 * baseline answer; treat it as a soft floor, not a hard alarm. The
 * first four turns are excluded because the warm-up window cannot have
 * meaningful cache hits (the first turn always pays the full input
 * cost; the next few are amortising fixture overhead).
 *
 * # Field-name choice
 *
 * The internal observe-API uses snake_case (`input_tokens`,
 * `cached_input_tokens`) because those are codex's persisted
 * field-names everywhere except the v2 wire surface — see
 * `rollout-trace/src/model/conversation.rs` (`cached_input_tokens:
 * u64`), `core/src/goals.rs`, `core/src/tasks/mod.rs`. The v2 wire
 * payload is camelCase (`inputTokens`, `cachedInputTokens`) per the
 * `#[serde(rename_all = "camelCase")]` on `TokenUsageBreakdown`. The
 * notification router does the camelCase→snake_case translation at
 * the boundary so this class stays aligned with codex's storage shape
 * and the observe-API matches the spec text in `task49.md`.
 */
export interface UsageObservation {
  readonly input_tokens?: number;
  readonly cached_input_tokens?: number;
}

export interface WireUsageObservation {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
}

export interface CacheMetricsSummary {
  readonly turns: number;
  readonly totalInput: number;
  readonly totalCached: number;
  /**
   * Cumulative cached-input ratio expressed as a percentage, computed
   * only once at least five turns have been observed; `null` during the
   * warm-up window so callers can gate alerting on the warm-up.
   */
  readonly ratioPctSinceTurn5: number | null;
  /**
   * `true` while warm-up (`ratioPctSinceTurn5 === null`) or while the
   * ratio is at/above the 70 % soft floor. `false` only once turn 5
   * has been observed and the ratio has fallen below the floor.
   */
  readonly healthy: boolean;
}

/**
 * Soft floor for the cumulative cached-input ratio. §16 q1 baseline.
 * Below this, `summary().healthy` is `false` (after warm-up).
 */
export const CACHE_RATIO_HEALTHY_PCT = 70;

/**
 * Number of turns the warm-up window covers; before this many turns
 * have been observed, the ratio is reported as `null` and `healthy`
 * stays `true`. `5` is the first turn after the typical four-turn
 * fixture-amortisation window — early enough to surface persistent
 * cache misses, late enough to discount the cold-start tax.
 */
export const CACHE_RATIO_WARMUP_TURNS = 5;

export class CacheMetrics {
  private inputs = 0;
  private cached = 0;
  private turnsObserved = 0;

  /**
   * Fold one turn's `TokenUsageBreakdown` (in snake_case) into the
   * running counters. Missing fields are treated as zero so a partial
   * payload (e.g. a turn that pre-dates the cached-input column being
   * populated) does not poison the totals.
   */
  observe(usage: UsageObservation): void {
    this.inputs += usage.input_tokens ?? 0;
    this.cached += usage.cached_input_tokens ?? 0;
    this.turnsObserved += 1;
  }

  observeWire(usage: WireUsageObservation): void {
    this.observe({
      ...(usage.inputTokens !== undefined ? { input_tokens: usage.inputTokens } : {}),
      ...(usage.cachedInputTokens !== undefined
        ? { cached_input_tokens: usage.cachedInputTokens }
        : {}),
    });
  }

  summary(): CacheMetricsSummary {
    const ratio =
      this.turnsObserved >= CACHE_RATIO_WARMUP_TURNS
        ? (this.cached / Math.max(this.inputs, 1)) * 100
        : null;
    return {
      turns: this.turnsObserved,
      totalInput: this.inputs,
      totalCached: this.cached,
      ratioPctSinceTurn5: ratio,
      healthy: ratio === null ? true : ratio >= CACHE_RATIO_HEALTHY_PCT,
    };
  }
}
