import type { TranscriptDisplayItem, TranscriptItem, UiState } from '../state/store';
import { displayItems, isReadOnlyMode } from '../state/store';
import type { Activity } from '../state/activity';
import type { VizNode } from '../types/topology';

export type VisitGroup = {
  visitId: string;
  visit: number;
  rowCount: number;
  items: TranscriptDisplayItem[];
  loadStatus: UiState['rowLoadStatus'][string] | undefined;
};

export type ActivePanelTimelineRow =
  | { kind: 'inspect_empty'; key: string; text: string }
  | { kind: 'awaiting_codex'; key: string }
  | { kind: 'empty'; key: string; text: string }
  | {
      kind: 'visit_summary';
      key: string;
      tone: 'empty' | 'filtered' | 'loading' | 'error';
      title: string;
      detail: string;
    }
  | {
      kind: 'visit_header';
      key: string;
      visit: number;
      entry: (UiState['history'][number] & { visitId: string }) | null;
    }
  | { kind: 'transcript'; key: string; item: TranscriptDisplayItem }
  | { kind: 'inline_indicator'; key: string; activity: Activity }
  | { kind: 'approvals'; key: string };

type DetailRow = { label: string; value: string };

type ArrayByCopy<T> = readonly T[] & {
  toSorted?: (compareFn: (a: T, b: T) => number) => T[];
};

export function activePanelFollowOutput(input: { isFollowing: boolean; atBottom: boolean }) {
  return input.isFollowing && input.atBottom ? 'smooth' : false;
}

export function activePanelShouldAutoscroll(input: {
  isFollowing: boolean;
  atBottom: boolean;
}): boolean {
  return input.isFollowing && input.atBottom;
}

export function leafOf(path: string): string {
  return path.split('.').pop() ?? path;
}

export function breadcrumbOf(path: string): string[] {
  return path.split('.').slice(0, -1);
}

export function visitNumber(visitId: string): number {
  const raw = visitId.split('#').pop();
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : 1;
}

function emptyVisitSummary(
  group: VisitGroup,
): Extract<ActivePanelTimelineRow, { kind: 'visit_summary' }> {
  if (group.loadStatus?.loading) {
    return {
      kind: 'visit_summary',
      key: `${group.visitId}:summary`,
      tone: 'loading',
      title: 'loading activity',
      detail: 'fetching rows for this visit',
    };
  }
  if (group.loadStatus?.error) {
    return {
      kind: 'visit_summary',
      key: `${group.visitId}:summary`,
      tone: 'error',
      title: 'activity unavailable',
      detail: 'could not load rows for this visit',
    };
  }
  if (group.rowCount > 0) {
    return {
      kind: 'visit_summary',
      key: `${group.visitId}:summary`,
      tone: 'filtered',
      title: 'transition-only visit',
      detail: 'no model or tool rows recorded for this visit',
    };
  }
  return {
    kind: 'visit_summary',
    key: `${group.visitId}:summary`,
    tone: 'empty',
    title: 'no activity recorded',
    detail: 'this visit has no compact rows',
  };
}

export function buildActivePanelTimelineRows(input: {
  mode: UiState['mode'];
  displayNode: VizNode | null;
  turnsLength: number;
  hasAnyVisibleContent: boolean;
  groups: VisitGroup[];
  entryByVisit: Map<string, UiState['history'][number]>;
  showInlineIndicator: boolean;
  activity: Activity;
  showApprovals: boolean;
}): ActivePanelTimelineRow[] {
  if (input.mode === 'inspect') {
    return [
      {
        kind: 'inspect_empty',
        key: 'inspect-empty',
        text: input.displayNode
          ? 'static visualization mode; no run transcript'
          : 'select any state in the graph to inspect its metadata',
      },
    ];
  }
  const readOnly = isReadOnlyMode(input.mode);
  const showInlineIndicator = input.showInlineIndicator && !readOnly;
  const showApprovals = input.showApprovals && !readOnly;
  const rows: ActivePanelTimelineRow[] = [];
  if (input.groups.length === 0) {
    rows.push({
      kind: 'empty',
      key: 'empty-current',
      text: 'activity not loaded yet',
    });
  } else {
    for (const group of input.groups) {
      rows.push({
        kind: 'visit_header',
        key: `${group.visitId}:header`,
        visit: group.visit,
        entry: input.entryByVisit.get(group.visitId) ?? null,
      });
      const renderableItems = group.items.filter((item) => {
        // Scoped state views use visit headers for transitions; keep those
        // rows in the chronological run transcript only.
        return item.type !== 'state_change';
      });
      if (renderableItems.length === 0) {
        rows.push(emptyVisitSummary(group));
      } else {
        for (const item of renderableItems) {
          rows.push({ kind: 'transcript', key: item.id, item });
        }
      }
    }
  }
  if (showInlineIndicator) {
    rows.push({ kind: 'inline_indicator', key: 'inline-indicator', activity: input.activity });
  }
  if (showApprovals) {
    rows.push({ kind: 'approvals', key: 'approvals' });
  }
  return rows;
}

function compareTranscriptItems(a: TranscriptItem, b: TranscriptItem): number {
  const aSeq = a.seq ?? Number.MAX_SAFE_INTEGER;
  const bSeq = b.seq ?? Number.MAX_SAFE_INTEGER;
  if (aSeq !== bSeq) return aSeq - bSeq;
  return a.id.localeCompare(b.id);
}

function sortedTranscriptItems(items: TranscriptItem[]): TranscriptItem[] {
  const sorted = (items as ArrayByCopy<TranscriptItem>).toSorted?.(compareTranscriptItems);
  return sorted ?? items.slice().sort(compareTranscriptItems);
}

export function buildRunTranscriptRows(input: {
  mode: UiState['mode'];
  items: TranscriptItem[];
  devMode: boolean;
  hasAnyVisibleContent: boolean;
  turnsLength: number;
  showInlineIndicator: boolean;
  activity: Activity;
  showApprovals: boolean;
}): ActivePanelTimelineRow[] {
  if (input.mode === 'inspect') {
    return [
      {
        kind: 'inspect_empty',
        key: 'inspect-empty',
        text: 'static visualization mode; no run transcript',
      },
    ];
  }
  const readOnly = isReadOnlyMode(input.mode);
  const showInlineIndicator = input.showInlineIndicator && !readOnly;
  const showApprovals = input.showApprovals && !readOnly;
  const visible = displayItems(sortedTranscriptItems(input.items), input.devMode);

  if (
    visible.length === 0 &&
    input.turnsLength === 0 &&
    !input.hasAnyVisibleContent &&
    !showApprovals &&
    !readOnly
  ) {
    return [{ kind: 'awaiting_codex', key: 'awaiting-codex' }];
  }

  const rows: ActivePanelTimelineRow[] =
    visible.length === 0 && showApprovals
      ? []
      : visible.length === 0
        ? [{ kind: 'empty', key: 'empty-run', text: 'no run activity yet' }]
        : visible.map((item) => ({ kind: 'transcript' as const, key: item.id, item }));

  if (showInlineIndicator) {
    rows.push({ kind: 'inline_indicator', key: 'inline-indicator', activity: input.activity });
  }
  if (showApprovals) {
    rows.push({ kind: 'approvals', key: 'approvals' });
  }
  return rows;
}

export function buildNodeDetailRows(node: VizNode): DetailRow[] {
  const detail = node.detail;
  if (!detail) return [];
  const rows: DetailRow[] = [];
  if (node.kind === 'stateful') {
    rows.push({ label: 'mode', value: detail.open ? 'open' : 'strict' });
    rows.push({ label: 'clear on entry', value: detail.clearOnEntry ? 'yes' : 'no' });
  }
  if (node.kind === 'choice' && detail.question) {
    rows.push({ label: 'question', value: detail.question.text });
  }
  if (node.kind === 'choice' && detail.options && detail.options.length > 0) {
    rows.push({ label: 'options', value: detail.options.join('\n') });
  }
  if (detail.entryPrompt) {
    rows.push({ label: 'entry prompt', value: detail.entryPrompt.text });
  }
  // Historical topology compatibility: old bootstrap fixtures can still carry
  // awaitsOwnerText so archived rows explain why the composer was open.
  if (detail.awaitsOwnerText) {
    rows.push({ label: 'legacy owner prompt', value: detail.awaitsOwnerText.text });
  }
  const lifecycle = [
    detail.hasOnEntry ? 'onEntry' : null,
    detail.hasStopGuidance ? 'stopGuidance' : null,
  ].filter((item): item is string => item !== null);
  if (lifecycle.length > 0) {
    rows.push({ label: 'lifecycle', value: lifecycle.join(', ') });
  }
  if (detail.skills && detail.skills.length > 0) {
    rows.push({
      label: 'skills',
      value: detail.skills
        .map((skill) => `${skill.label}${skill.optional ? ' (optional)' : ''}`)
        .join(', '),
    });
  }
  if (detail.hooks && detail.hooks.length > 0) {
    rows.push({
      label: 'hooks',
      value: detail.hooks
        .map((hook) => {
          const matchers =
            hook.matchers && hook.matchers.length > 0 ? ` (${hook.matchers.join(', ')})` : '';
          return `${hook.kind} x${hook.count}${matchers}`;
        })
        .join(', '),
    });
  }
  if (detail.exits && detail.exits.length > 0) {
    rows.push({
      label: 'exits',
      value: detail.exits
        .map((exit) => {
          const targets = exit.targets.join(' | ');
          const description = exit.description ? `: ${exit.description}` : '';
          const branches = exit.branchCount ? ` [${exit.branchCount} branches]` : '';
          return `${exit.name} -> ${targets}${branches}${description}`;
        })
        .join('\n'),
    });
  }
  if (detail.outcome) {
    rows.push({ label: 'outcome', value: detail.outcome });
  }
  if (detail.artifacts && detail.artifacts.length > 0) {
    rows.push({ label: 'artifacts', value: detail.artifacts.join('\n') });
  }
  return rows;
}

export const activePanelFollowOutputForTest = activePanelFollowOutput;
export const activePanelShouldAutoscrollForTest = activePanelShouldAutoscroll;
export const buildActivePanelTimelineRowsForTest = buildActivePanelTimelineRows;
export const buildRunTranscriptRowsForTest = buildRunTranscriptRows;
export const buildNodeDetailRowsForTest = buildNodeDetailRows;
