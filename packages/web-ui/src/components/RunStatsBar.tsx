import { useEffect, useMemo, useState } from 'react';

import { formatAggregateStats } from '../state/activity.js';
import type { UiState } from '../state/store.js';
import type { RunScopedAggregateStats } from '../types/events.js';

type RunStatsSession = Pick<UiState, 'aggregateStats' | 'connection' | 'mode' | 'posture' | 'run'>;

type RunStatsBarProps = {
  session: RunStatsSession;
  variant?: 'header' | 'bottom';
  nowMs?: number;
  tickMs?: number;
};

type StatCell = {
  kind: 'status' | 'duration' | 'tokens' | 'context' | 'run';
  label: string;
  value: string;
};

function hasTerminalStatus(stats: RunScopedAggregateStats): boolean {
  return stats.endedAt !== undefined || (stats.status !== undefined && stats.status !== 'running');
}

function hasDurationAnchor(session: RunStatsSession): boolean {
  if (session.mode === 'inspect' && session.aggregateStats.startedAt === undefined) return false;
  return session.aggregateStats.startedAt !== undefined || session.run?.startedAt !== undefined;
}

function shouldTickRunDuration(session: RunStatsSession): boolean {
  return (
    session.mode === 'run' &&
    session.connection === 'live' &&
    !session.posture.isTerminal &&
    !hasTerminalStatus(session.aggregateStats) &&
    hasDurationAnchor(session)
  );
}

function statusLabel(session: RunStatsSession): string {
  if (session.connection === 'connecting') return 'connecting';
  if (session.connection === 'lost') return 'lost';
  if (session.mode === 'inspect') return 'inspect';
  if (session.posture.isTerminal || hasTerminalStatus(session.aggregateStats)) return 'terminal';
  if (session.posture.isAwaiting) return 'awaiting owner';
  return 'live';
}

function statsRun(session: RunStatsSession): RunStatsSession['run'] {
  if (session.mode !== 'inspect') return session.run;
  return session.aggregateStats.startedAt === undefined ? null : session.run;
}

export function RunStatsBar({
  session,
  variant = 'bottom',
  nowMs: initialNowMs,
  tickMs = 1000,
}: RunStatsBarProps) {
  const [nowMs, setNowMs] = useState(() => initialNowMs ?? Date.now());
  const tickDuration = initialNowMs === undefined && shouldTickRunDuration(session);

  useEffect(() => {
    if (!tickDuration) return undefined;

    const intervalId = window.setInterval(() => setNowMs(Date.now()), tickMs);
    return () => window.clearInterval(intervalId);
  }, [tickDuration, tickMs]);

  const formatted = useMemo(
    () =>
      formatAggregateStats({
        aggregateStats: session.aggregateStats,
        run: statsRun(session),
        nowMs,
      }),
    [nowMs, session],
  );
  const tokenLabel = formatted.totalTokens ?? formatted.tokenBreakdownLabels.join(' / ');
  const cells: StatCell[] = [
    ...(variant === 'bottom'
      ? [{ kind: 'status' as const, label: 'status', value: statusLabel(session) }]
      : []),
    ...(formatted.duration === undefined
      ? []
      : [{ kind: 'duration' as const, label: 'time', value: formatted.duration }]),
    ...(tokenLabel.length === 0
      ? []
      : [{ kind: 'tokens' as const, label: 'tokens', value: tokenLabel }]),
    ...(formatted.contextWindow === undefined
      ? []
      : [{ kind: 'context' as const, label: 'ctx', value: formatted.contextWindow }]),
    ...(variant === 'bottom' && session.run?.runId
      ? [{ kind: 'run' as const, label: 'run', value: session.run.runId }]
      : []),
  ];

  if (cells.length === 0) return null;

  return (
    <div
      className={variant === 'header' ? 'run-stats run-stats-header' : 'run-status-bar'}
      data-surface={variant === 'header' ? 'header-run-stats' : 'bottom-run-stats'}
    >
      {cells.map((cell) => (
        <span className="run-stat-cell" data-stat-kind={cell.kind} key={cell.kind}>
          <span className="run-stat-label">{cell.label}</span>
          <span className="run-stat-value">{cell.value}</span>
        </span>
      ))}
    </div>
  );
}
