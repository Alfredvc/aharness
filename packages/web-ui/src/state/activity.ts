// Derive a single "what is happening right now" descriptor from UiState.
// Drives the boot skeleton and the inline thinking indicator that lives at the
// tail of the active visit transcript.

import { hasVisibleContent } from './store.js';
import type { TranscriptItem, UiState } from './store.js';
import type { RunMeta, RunScopedAggregateStats } from '../types/events.js';

export type ActivityTone = 'indigo' | 'amber' | 'mint' | 'rose' | 'plasma' | 'muted';
export type ActivityMotion = 'wave' | 'pulse' | 'scan' | 'still';

export type Activity = {
  kind:
    | 'boot.connecting'
    | 'boot.starting'
    | 'boot.awaiting_codex'
    | 'lost'
    | 'terminal'
    | 'awaiting.owner'
    | 'awaiting.approval'
    | 'submitted'
    | 'streaming.message'
    | 'streaming.reasoning'
    | 'tool'
    | 'thinking'
    | 'idle';
  label: string;
  detail?: string;
  tone: ActivityTone;
  motion: ActivityMotion;
  // Optional anchor for an elapsed-time readout. Currently surfaced for tool calls.
  since?: number;
  toolName?: string;
};

export type RunDurationFormatInput = {
  aggregateStats: RunScopedAggregateStats;
  run: Pick<RunMeta, 'startedAt'> | null;
  nowMs: number;
};

export type AggregateStatsFormatInput = RunDurationFormatInput;

export type FormattedAggregateStats = {
  duration?: string;
  totalTokens?: string;
  tokenBreakdownLabels: string[];
  contextWindow?: string;
};

const compactNumberFormatter = new Intl.NumberFormat('en-US');

function trim(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

function prettyTool(name: string): string {
  if (name === 'apply_patch') return 'apply_patch';
  if (name === 'bash') return 'bash';
  if (name.startsWith('web_')) return name;
  return name;
}

function findLastStreamingOrPending(transcript: TranscriptItem[]): TranscriptItem | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const it = transcript[i];
    if (!it) continue;
    if (it.type === 'tool_call' && it.status === 'pending' && !it.reserved) return it;
    if (it.type === 'tool_call' && it.status !== 'pending') return null;
    if (it.type === 'agent_message' && it.streaming) return it;
    if (it.type === 'reasoning' && it.streaming) return it;
    // Stop scanning past completed message/tool boundaries.
    if (it.type === 'agent_message' && !it.streaming) return null;
    if (it.type === 'tool_result') return null;
  }
  return null;
}

function findLastSignal(transcript: TranscriptItem[]): TranscriptItem | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const it = transcript[i];
    if (!it) continue;
    if (it.type === 'framework_note' && it.variant !== 'warn') continue;
    return it;
  }
  return null;
}

export function deriveActivity(s: UiState): Activity {
  if (s.connection === 'connecting') {
    return {
      kind: 'boot.connecting',
      label: 'connecting',
      detail: 'spawning codex · opening fresh thread',
      tone: 'indigo',
      motion: 'scan',
    };
  }
  if (s.connection === 'lost') {
    return {
      kind: 'lost',
      label: 'connection lost',
      detail: 'foreground run ended; artifacts retained',
      tone: 'rose',
      motion: 'still',
    };
  }
  if (s.posture.isTerminal) {
    return {
      kind: 'terminal',
      label: 'run complete',
      detail: s.state?.leaf ?? '',
      tone: 'mint',
      motion: 'still',
    };
  }
  if (!s.state) {
    return {
      kind: 'boot.starting',
      label: 'starting run',
      detail: 'awaiting first state from codex',
      tone: 'indigo',
      motion: 'scan',
    };
  }

  const totalApprovals =
    s.pending.fileApprovals.length +
    s.pending.cmdApprovals.length +
    s.pending.permissionApprovals.length +
    s.pending.elicitations.length;
  if (totalApprovals > 0) {
    const f = s.pending.fileApprovals[0];
    const c = s.pending.cmdApprovals[0];
    const p = s.pending.permissionApprovals[0];
    const e = s.pending.elicitations[0];
    let detail = f?.changes[0]?.path ?? f?.grantRoot ?? c?.command ?? '';
    if (!detail && p) detail = 'permission grant request';
    if (!detail && e) detail = `mcp · ${e.serverName ?? 'elicit'}`;
    return {
      kind: 'awaiting.approval',
      label: totalApprovals === 1 ? 'awaiting approval' : `awaiting ${totalApprovals} approvals`,
      detail: trim(detail, 70),
      tone: 'rose',
      motion: 'pulse',
    };
  }

  if (s.pending.ownerInput) {
    return {
      kind: 'awaiting.owner',
      label: 'awaiting your input',
      detail: trim(s.state.awaitsOwnerText?.messageToUser ?? 'open the composer below', 80),
      tone: 'amber',
      motion: 'pulse',
    };
  }

  if (s.pending.ownerChoice) {
    return {
      kind: 'awaiting.owner',
      label: 'awaiting your choice',
      detail: trim(s.pending.ownerChoice.question, 80),
      tone: 'indigo',
      motion: 'pulse',
    };
  }

  const live = findLastStreamingOrPending(s.transcript);
  if (live?.type === 'tool_call') {
    return {
      kind: 'tool',
      label: `running ${prettyTool(live.name)}`,
      detail: live.reserved ? 'reserved tool' : trim(live.preview, 70),
      tone: 'indigo',
      motion: 'wave',
      toolName: live.name,
    };
  }
  if (live?.type === 'reasoning') {
    return {
      kind: 'streaming.reasoning',
      label: 'reasoning',
      detail: `${live.text.length.toLocaleString()} chars`,
      tone: 'indigo',
      motion: 'wave',
    };
  }
  if (live?.type === 'agent_message') {
    return {
      kind: 'streaming.message',
      label: 'writing response',
      detail: `${live.text.length.toLocaleString()} chars`,
      tone: 'indigo',
      motion: 'wave',
    };
  }

  if (s.posture.submittedThisTurn) {
    return {
      kind: 'submitted',
      label: 'transitioning',
      detail: 'awaiting state change',
      tone: 'plasma',
      motion: 'wave',
    };
  }

  if (s.activeTurnId) {
    return {
      kind: 'thinking',
      label: 'model working',
      detail: `turn ${trim(s.activeTurnId, 32)}`,
      tone: 'indigo',
      motion: 'wave',
    };
  }

  // Cold-boot gap. The FSM publishes its initial StateChange before the
  // codex app-server is spawned, so the UI lands on the live shell with
  // state in hand but nothing visible on the wire. Codex spawn + WS
  // handshake + thread/start typically take 5–15s; surface that wait
  // explicitly. hasVisibleContent still treats framework orientation notes and
  // reserved/internal tool plumbing as invisible for this renderability
  // heuristic.
  if (s.turns.length === 0 && !hasVisibleContent(s.transcript)) {
    return {
      kind: 'boot.awaiting_codex',
      label: 'starting codex',
      detail: 'spawning app-server · awaiting first turn',
      tone: 'indigo',
      motion: 'scan',
    };
  }

  // Distinguish "thinking" (model has the turn, no tokens yet) from "idle"
  // (no turn in flight). Heuristic: most recent transcript signal is a
  // state_change with nothing visible after it — model is mid-turn.
  const tail = findLastSignal(s.transcript);
  if (tail?.type === 'state_change') {
    return {
      kind: 'thinking',
      label: 'model thinking',
      detail: 'first tokens incoming',
      tone: 'indigo',
      motion: 'wave',
    };
  }

  // Active state has visited but model is between turns and not currently generating.
  const turnsLabel = `turn ${s.turns.length}`;
  return {
    kind: 'idle',
    label: 'idle',
    detail: turnsLabel,
    tone: 'muted',
    motion: 'still',
  };
}

function parseTimestampMs(value: string | undefined): number | null {
  if (value === undefined || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTerminalRunStatus(status: string | undefined): boolean {
  return status !== undefined && status !== 'running';
}

export function formatRunDurationLabel(input: RunDurationFormatInput): string | null {
  const startMs =
    parseTimestampMs(input.aggregateStats.startedAt) ?? parseTimestampMs(input.run?.startedAt);
  if (startMs === null) return null;

  const endMs = isTerminalRunStatus(input.aggregateStats.status)
    ? parseTimestampMs(input.aggregateStats.endedAt)
    : input.nowMs;
  if (endMs === null || !Number.isFinite(endMs)) return null;
  if (endMs < startMs) return null;

  return formatElapsed(endMs - startMs);
}

export function formatTokenCountLabel(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  const unit = value === 1 ? 'token' : 'tokens';
  return `${compactNumberFormatter.format(value)} ${unit}`;
}

function labelledTokenCount(label: string, value: number | undefined): string | null {
  const tokenCount = formatTokenCountLabel(value);
  return tokenCount === null ? null : `${label} ${tokenCount}`;
}

export function formatTokenBreakdownLabels(stats: RunScopedAggregateStats): string[] {
  return [
    labelledTokenCount('input', stats.inputTokens),
    labelledTokenCount('cached input', stats.cachedInputTokens),
    labelledTokenCount('output', stats.outputTokens),
    labelledTokenCount('reasoning', stats.reasoningOutputTokens),
  ].filter((label): label is string => label !== null);
}

export function formatContextWindowLabel(stats: RunScopedAggregateStats): string | null {
  const tokenCount = formatTokenCountLabel(stats.modelContextWindow);
  return tokenCount === null ? null : `context ${tokenCount}`;
}

export function formatAggregateStats(input: AggregateStatsFormatInput): FormattedAggregateStats {
  const duration = formatRunDurationLabel(input);
  const totalTokens = formatTokenCountLabel(input.aggregateStats.totalTokens);
  const contextWindow = formatContextWindowLabel(input.aggregateStats);
  return {
    ...(duration === null ? {} : { duration }),
    ...(totalTokens === null ? {} : { totalTokens }),
    tokenBreakdownLabels: formatTokenBreakdownLabels(input.aggregateStats),
    ...(contextWindow === null ? {} : { contextWindow }),
  };
}

// Pure-formatter for elapsed ms → "1.2s" / "12s" / "1m 04s".
export function formatElapsed(ms: number): string {
  if (ms < 0) return '0.0s';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}
