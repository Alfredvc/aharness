import { useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type Components, type VirtuosoHandle } from 'react-virtuoso';
import type { UiState, UiActions, TranscriptItem, ReplyPayload } from '../state/store';
import type {
  FileChangeApproval,
  CommandApproval,
  PermissionApproval,
  ElicitationRequest,
} from '../types/events';
import type { VizNode } from '../types/topology';
import { hasVisibleContent, visibleItems } from '../state/store';
import { deriveActivity, formatElapsed } from '../state/activity';
import type { Activity } from '../state/activity';
import { InteractionSlot } from './InteractionSlot';
import { canAcceptElicitation } from './elicitationActions';

type Props = { session: UiState & UiActions };
type VisitGroup = {
  visitId: string;
  visit: number;
  rowCount: number;
  items: TranscriptItem[];
  loadStatus: UiState['rowLoadStatus'][string] | undefined;
};
export type ActivePanelTimelineRow =
  | { kind: 'inspect_empty'; key: string; text: string }
  | { kind: 'awaiting_codex'; key: string }
  | { kind: 'empty'; key: string; text: string }
  | {
      kind: 'visit_header';
      key: string;
      visit: number;
      entry: (UiState['history'][number] & { visitId: string }) | null;
    }
  | { kind: 'transcript'; key: string; item: TranscriptItem }
  | { kind: 'inline_indicator'; key: string; activity: Activity }
  | { kind: 'approvals'; key: string };

const activePanelVirtuosoComponents: Components<ActivePanelTimelineRow> = {
  Header: () => <div className="ap-virtual-header" aria-hidden />,
  Item: ({ children, context: _context, item: _item, ...props }) => (
    <div {...props} className="ap-virtual-item">
      {children}
    </div>
  ),
};

export const activePanelVirtuosoComponentsForTest = activePanelVirtuosoComponents;

function activePanelFollowOutput(input: { isFollowing: boolean; atBottom: boolean }) {
  return input.isFollowing && input.atBottom ? 'smooth' : false;
}

function activePanelShouldAutoscroll(input: { isFollowing: boolean; atBottom: boolean }): boolean {
  return input.isFollowing && input.atBottom;
}

export const activePanelFollowOutputForTest = activePanelFollowOutput;
export const activePanelShouldAutoscrollForTest = activePanelShouldAutoscroll;

function leafOf(path: string): string {
  return path.split('.').pop() ?? path;
}

function breadcrumbOf(path: string): string[] {
  return path.split('.').slice(0, -1);
}

function visitNumber(visitId: string): number {
  const raw = visitId.split('#').pop();
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : 1;
}

function emptyVisitMessage(group: VisitGroup): string {
  if (group.rowCount > 0) return 'activity hidden in this view';
  if (group.loadStatus?.loading) return 'loading activity for this visit…';
  if (group.loadStatus?.error) return 'could not load activity for this visit';
  if (group.loadStatus?.loaded) return 'no activity in this visit';
  return 'activity not loaded yet';
}

function submitReply(onReply: UiActions['reply'], payload: ReplyPayload) {
  void onReply(payload).catch(() => undefined);
}

function buildActivePanelTimelineRows(input: {
  mode: UiState['mode'];
  displayNode: VizNode | null;
  isFollowing: boolean;
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
  if (input.isFollowing && input.turnsLength === 0 && !input.hasAnyVisibleContent) {
    return [{ kind: 'awaiting_codex', key: 'awaiting-codex' }];
  }
  const rows: ActivePanelTimelineRow[] = [];
  if (input.groups.length === 0) {
    rows.push({
      kind: 'empty',
      key: 'empty-current',
      text: input.isFollowing ? 'no activity yet in this visit' : 'activity not loaded yet',
    });
  } else {
    for (const group of input.groups) {
      if (!input.isFollowing) {
        rows.push({
          kind: 'visit_header',
          key: `${group.visitId}:header`,
          visit: group.visit,
          entry: input.entryByVisit.get(group.visitId) ?? null,
        });
      }
      if (group.items.length === 0) {
        rows.push({
          kind: 'empty',
          key: `${group.visitId}:empty`,
          text: emptyVisitMessage(group),
        });
      } else {
        for (const item of group.items) {
          if (item.type === 'state_change') continue;
          rows.push({ kind: 'transcript', key: item.id, item });
        }
      }
    }
  }
  if (input.showInlineIndicator) {
    rows.push({ kind: 'inline_indicator', key: 'inline-indicator', activity: input.activity });
  }
  if (input.showApprovals) {
    rows.push({ kind: 'approvals', key: 'approvals' });
  }
  return rows;
}

export const buildActivePanelTimelineRowsForTest = buildActivePanelTimelineRows;

export function ActivePanel({ session }: Props) {
  const isFollowing = session.scopedPath === null;
  // When following: scope is the active visit (single group).
  // When frozen: scope is a path; we render every visit to it as its own group.
  const scopePath = isFollowing
    ? session.activeVisitId
      ? session.activeVisitId.split('#')[0]
      : null
    : session.scopedPath;

  useEffect(() => {
    if (isFollowing || !scopePath || !session.requestRowsForStatePath) return;
    void session.requestRowsForStatePath(scopePath).catch(() => undefined);
  }, [isFollowing, scopePath, session.requestRowsForStatePath]);

  const groups = useMemo(() => {
    if (!scopePath) return [] as VisitGroup[];
    const filter = isFollowing
      ? (vid: string) => vid === session.activeVisitId
      : (vid: string) => vid.startsWith(`${scopePath}#`);
    const buckets = new Map<string, TranscriptItem[]>();
    for (const it of session.transcript) {
      if (!filter(it.stateVisitId)) continue;
      const bucket = buckets.get(it.stateVisitId);
      if (bucket) bucket.push(it);
      else buckets.set(it.stateVisitId, [it]);
    }
    const visitIds = isFollowing
      ? Array.from(buckets.keys()).sort((a, b) => visitNumber(a) - visitNumber(b))
      : [
          ...(session.statePathVisits[scopePath] ?? []),
          ...Array.from(buckets.keys()).filter(
            (visitId) => !(session.statePathVisits[scopePath] ?? []).includes(visitId),
          ),
        ];
    return visitIds.map((visitId) => ({
      visitId,
      visit: visitNumber(visitId),
      rowCount: Math.max(
        buckets.get(visitId)?.length ?? 0,
        session.rowLoadStatus[visitId]?.storedRows ?? 0,
      ),
      items: visibleItems(buckets.get(visitId) ?? [], session.devMode),
      loadStatus: session.rowLoadStatus[visitId],
    }));
  }, [
    session.transcript,
    session.statePathVisits,
    session.rowLoadStatus,
    scopePath,
    isFollowing,
    session.activeVisitId,
    session.devMode,
  ]);

  const entryByVisit = useMemo(() => {
    const m = new Map<string, (typeof session.history)[number]>();
    for (const h of session.history) m.set(h.visitId, h);
    return m;
  }, [session.history]);

  const fsmState = session.state;
  if (!fsmState) {
    return (
      <section className="active-panel">
        <div className="ap-empty">connecting…</div>
      </section>
    );
  }

  // When scope is frozen (not following), reconstruct displayed state from path.
  const displayLeaf = isFollowing ? fsmState.leaf : leafOf(scopePath!);
  const displayPath = isFollowing ? fsmState.path : scopePath!;
  const displayNode = session.topology.nodes.find((node) => node.id === displayPath) ?? null;
  const totalVisits = groups.length;
  const crumbs = breadcrumbOf(displayPath);
  const activeEntry =
    isFollowing && session.activeVisitId ? entryByVisit.get(session.activeVisitId) : null;

  const totalApprovals =
    session.pending.fileApprovals.length +
    session.pending.cmdApprovals.length +
    session.pending.permissionApprovals.length +
    session.pending.elicitations.length;
  const activity = useMemo(() => deriveActivity(session), [session]);
  // Inline thinking indicator lives at the tail of the transcript so it appears
  // exactly where the next message will arrive. Skip kinds that already have a
  // visible surface: tool calls render their own pending wave, streaming
  // messages/reasoning stream tokens inline, approvals/owner-input render their
  // own cards/composer, terminal/lost ends the run.
  const showInlineIndicator =
    isFollowing &&
    !session.posture.isTerminal &&
    !session.pending.ownerInput &&
    totalApprovals === 0 &&
    (activity.kind === 'thinking' || activity.kind === 'submitted');
  const showOpenComposer =
    isFollowing &&
    fsmState.kind === 'stateful' &&
    session.posture.open &&
    !session.pending.ownerInput &&
    !session.posture.isAwaiting &&
    !session.posture.isTerminal;
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const atBottomRef = useRef(true);
  useEffect(() => {
    atBottomRef.current = isFollowing;
  }, [isFollowing]);
  const timelineRows = useMemo(
    () =>
      buildActivePanelTimelineRows({
        mode: session.mode,
        displayNode,
        isFollowing,
        turnsLength: session.turns.length,
        hasAnyVisibleContent: hasVisibleContent(session.transcript),
        groups,
        entryByVisit,
        showInlineIndicator,
        activity,
        showApprovals: isFollowing && totalApprovals > 0,
      }),
    [
      session.mode,
      displayNode,
      isFollowing,
      session.turns.length,
      session.transcript,
      groups,
      entryByVisit,
      showInlineIndicator,
      activity,
      totalApprovals,
    ],
  );
  const initialItemCount = typeof window === 'undefined' ? timelineRows.length : undefined;
  const initialTopMostItemIndexProps =
    typeof window !== 'undefined' && isFollowing && timelineRows.length > 0
      ? { initialTopMostItemIndex: timelineRows.length - 1 }
      : {};

  return (
    <section
      className={`active-panel ${session.posture.isAwaiting && isFollowing ? 'awaits' : ''}`}
    >
      <header className="ap-head">
        {session.mode === 'inspect' ? <NodeDetailBox node={displayNode} /> : null}
        {session.devMode && session.mode !== 'inspect' ? (
          <DevContextBox fsmState={fsmState} />
        ) : null}
        {session.devMode ? <DevDiagnosticsBox diagnostics={session.diagnostics} /> : null}
        {crumbs.length > 0 ? (
          <div className="ap-crumbs">
            {crumbs.map((c, i) => (
              <span key={i} className="crumb">
                {c}
                <span className="sep">›</span>
              </span>
            ))}
          </div>
        ) : null}
        <h2 className="ap-leaf">
          {displayLeaf}
          {isFollowing ? (
            <span className="ap-visit">· visit {fsmState.visitCount}</span>
          ) : totalVisits > 1 ? (
            <span className="ap-visit">· {totalVisits} visits</span>
          ) : (
            <span className="ap-visit">· visit 1</span>
          )}
        </h2>
        {(() => {
          // Posture chips here only carry signal that the top-bar pill cannot.
          // Top pill already shows: terminal, awaits owner, clearing, lost, live, connecting.
          // So we drop kind/awaits/terminal here and keep only the deltas.
          const chips: Array<{
            label: string;
            tone: 'indigo' | 'amber' | 'mint' | 'plasma' | 'rose';
          }> = [];
          if (isFollowing) {
            if (session.posture.submittedThisTurn)
              chips.push({ label: 'submitted', tone: 'plasma' });
            if (totalApprovals > 0)
              chips.push({
                label: `${totalApprovals} approval${totalApprovals === 1 ? '' : 's'}`,
                tone: 'rose',
              });
          } else {
            chips.push({ label: 'frozen scope', tone: 'plasma' });
          }
          if (chips.length === 0) return null;
          return (
            <div className="ap-posture">
              {chips.map((c) => (
                <PostureChip key={c.label} label={c.label} tone={c.tone} />
              ))}
            </div>
          );
        })()}
        {!isFollowing ? (
          <button
            className="ap-unfreeze"
            onClick={() => session.setScope(null)}
            title="Return to live view of the active state."
          >
            ↩ follow active
          </button>
        ) : null}
        {activeEntry ? <EntryLine entry={activeEntry} /> : null}
      </header>

      <Virtuoso
        ref={virtuosoRef}
        className="ap-body"
        data={timelineRows}
        components={activePanelVirtuosoComponents}
        initialItemCount={initialItemCount}
        {...initialTopMostItemIndexProps}
        computeItemKey={(_, row) => row.key}
        followOutput={(atBottom) => activePanelFollowOutput({ isFollowing, atBottom })}
        atBottomStateChange={(atBottom) => {
          atBottomRef.current = atBottom;
        }}
        totalListHeightChanged={() => {
          if (activePanelShouldAutoscroll({ isFollowing, atBottom: atBottomRef.current })) {
            virtuosoRef.current?.autoscrollToBottom();
          }
        }}
        itemContent={(_, row) => <ActivePanelTimelineRowView row={row} session={session} />}
      />

      {isFollowing && session.pending.ownerInput ? (
        <InteractionSlot req={session.pending.ownerInput} reply={session.reply} />
      ) : showOpenComposer ? (
        <OpenStateComposer onReply={session.reply} />
      ) : null}
    </section>
  );
}

type DetailRow = { label: string; value: string };

function NodeDetailBox({ node }: { node: VizNode | null }) {
  const rows = node ? buildNodeDetailRows(node) : [];
  return (
    <section className="dev-context-box" aria-label="FSM state inspector">
      <header className="dcb-head">
        <span className="dcb-kicker">state</span>
        <span className="dcb-state">{node?.id ?? 'none'}</span>
      </header>
      {rows.length === 0 ? (
        <div className="dcb-empty">no inspectable metadata</div>
      ) : (
        <div className="inspect-detail-list">
          {rows.map((row) => (
            <div className="inspect-detail-row" key={row.label}>
              <span className="dcb-label">{row.label}</span>
              <pre className="dcb-prompt">{row.value}</pre>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function buildNodeDetailRows(node: VizNode): DetailRow[] {
  const detail = node.detail;
  if (!detail) return [];
  const rows: DetailRow[] = [];
  if (node.kind === 'stateful') {
    rows.push({ label: 'mode', value: detail.open ? 'open' : 'strict' });
    rows.push({ label: 'clear on entry', value: detail.clearOnEntry ? 'yes' : 'no' });
  }
  if (detail.entryPrompt) {
    rows.push({ label: 'entry prompt', value: detail.entryPrompt.text });
  }
  if (detail.awaitsOwnerText) {
    rows.push({ label: 'owner prompt', value: detail.awaitsOwnerText.text });
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

export const buildNodeDetailRowsForTest = buildNodeDetailRows;

export const activePanelRowForTest = (item: TranscriptItem) => <ActivePanelRow item={item} />;

function ActivePanelTimelineRowView({
  row,
  session,
}: {
  row: ActivePanelTimelineRow;
  session: UiState & UiActions;
}) {
  switch (row.kind) {
    case 'inspect_empty':
    case 'empty':
      return <div className="ap-empty quiet">{row.text}</div>;
    case 'awaiting_codex':
      return <AwaitingCodexPlaceholder />;
    case 'visit_header':
      return <VisitHeader visit={row.visit} entry={row.entry} />;
    case 'transcript':
      return <ActivePanelRow item={row.item} />;
    case 'inline_indicator':
      return <InlineThinking activity={row.activity} />;
    case 'approvals':
      return <ApprovalsStack session={session} />;
  }
}

function VisitHeader({
  visit,
  entry,
}: {
  visit: number;
  entry: (UiState['history'][number] & { visitId: string }) | null;
}) {
  return (
    <div className="ap-visit-header">
      <span className="ap-visit-rule" aria-hidden />
      <span className="ap-visit-label">
        visit {visit}
        {entry ? (
          <>
            {' '}
            · via <em>{entry.cause}</em>
            {entry.from ? (
              <>
                {' '}
                from <span className="from">{leafOf(entry.from)}</span>
              </>
            ) : (
              <> at boot</>
            )}
          </>
        ) : null}
      </span>
      <span className="ap-visit-rule" aria-hidden />
    </div>
  );
}

function ApprovalsStack({ session }: { session: UiState & UiActions }) {
  return (
    <div className="ap-approvals">
      {session.pending.fileApprovals.map((r, i) => (
        <FileApprovalCard
          key={r.id}
          req={r}
          top={i === 0 && session.pending.cmdApprovals.length === 0}
          onReply={session.reply}
        />
      ))}
      {session.pending.cmdApprovals.map((r, i) => (
        <CmdApprovalCard
          key={r.id}
          req={r}
          top={i === 0 && session.pending.fileApprovals.length === 0}
          onReply={session.reply}
        />
      ))}
      {session.pending.permissionApprovals.map((r) => (
        <PermissionApprovalCard key={r.id} req={r} onReply={session.reply} />
      ))}
      {session.pending.elicitations.map((r) => (
        <ElicitationCard key={r.id} req={r} onReply={session.reply} />
      ))}
    </div>
  );
}

function DevContextBox({ fsmState }: { fsmState: UiState['state'] }) {
  if (!fsmState) return null;
  const ctx = fsmState.context ?? {};
  const prompt = fsmState.entryPrompt;
  return (
    <section className="dev-context-box" aria-label="dev context inspector">
      <header className="dcb-head">
        <span className="dcb-kicker">context</span>
        <span className="dcb-state">{fsmState.path}</span>
      </header>
      <div className="dcb-section">
        <span className="dcb-label">ctx</span>
        {Object.keys(ctx).length === 0 ? (
          <div className="dcb-empty">empty</div>
        ) : (
          <div className="dcb-json">
            <JsonNode value={ctx} depth={0} />
          </div>
        )}
      </div>
      <div className="dcb-section">
        <span className="dcb-label">state prompt</span>
        {prompt ? (
          <pre className="dcb-prompt">{prompt}</pre>
        ) : (
          <div className="dcb-empty">no entryPrompt for this state</div>
        )}
      </div>
    </section>
  );
}

function DevDiagnosticsBox({ diagnostics }: { diagnostics: UiState['diagnostics'] }) {
  if (diagnostics.length === 0) return null;
  const visible = diagnostics.slice(-5).reverse();
  return (
    <section className="dev-context-box dev-diagnostics-box" aria-label="abandoned diagnostics">
      <header className="dcb-head">
        <span className="dcb-kicker">abandoned</span>
        <span className="dcb-state">{diagnostics.length} events</span>
      </header>
      <div className="diagnostic-list">
        {visible.map((diagnostic) => (
          <div key={diagnostic.id} className="diagnostic-row">
            <span className="diagnostic-source">{diagnostic.source}</span>
            <span className="diagnostic-thread">{diagnostic.threadId}</span>
            <span className="diagnostic-message">{diagnostic.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function JsonNode({ value, depth }: { value: unknown; depth: number }) {
  if (value === null) return <span className="dcb-val null">null</span>;
  if (typeof value === 'string')
    return <span className="dcb-val string">{JSON.stringify(value)}</span>;
  if (typeof value === 'number') return <span className="dcb-val number">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="dcb-val boolean">{String(value)}</span>;
  if (typeof value !== 'object') {
    return <span className="dcb-val">{JSON.stringify(value)}</span>;
  }
  const isArray = Array.isArray(value);
  const entries: Array<[string, unknown]> = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return <span className="dcb-val">{isArray ? '[]' : '{}'}</span>;
  }
  return (
    <div className="dcb-obj">
      {entries.map(([k, v]) => (
        <JsonRow key={k} k={k} v={v} isArray={isArray} depth={depth} />
      ))}
    </div>
  );
}

function JsonRow({
  k,
  v,
  isArray,
  depth,
}: {
  k: string;
  v: unknown;
  isArray: boolean;
  depth: number;
}) {
  const isObj = v !== null && typeof v === 'object';
  const collapsedDefault =
    depth >= 2 ||
    (Array.isArray(v) && v.length > 6) ||
    (isObj && !Array.isArray(v) && Object.keys(v).length > 8);
  const [open, setOpen] = useState(!collapsedDefault);
  if (!isObj) {
    return (
      <div className="dcb-row">
        <span className="dcb-key">{isArray ? `[${k}]` : `${k}`}:</span>
        <JsonNode value={v} depth={depth + 1} />
      </div>
    );
  }
  const len = Array.isArray(v) ? v.length : Object.keys(v).length;
  const summary = Array.isArray(v) ? `[${len}]` : `{${len}}`;
  return (
    <div className="dcb-row">
      <span className="dcb-key">
        <button
          type="button"
          className="dcb-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? '▾' : '▸'}
        </button>
        {isArray ? `[${k}]` : `${k}`}:<span className="dcb-summary"> {summary}</span>
      </span>
      {open ? (
        <div className="dcb-nest">
          <JsonNode value={v} depth={depth + 1} />
        </div>
      ) : null}
    </div>
  );
}

function EntryLine({ entry }: { entry: UiState['history'][number] }) {
  return (
    <div className="ap-entry">
      entered via <em>{entry.cause}</em>
      {entry.from ? (
        <>
          {' '}
          from <span className="from">{leafOf(entry.from)}</span>
        </>
      ) : (
        <> at boot</>
      )}
    </div>
  );
}

function FileApprovalCard({
  req,
  top,
  onReply,
}: {
  req: FileChangeApproval;
  top: boolean;
  onReply: UiActions['reply'];
}) {
  return (
    <article className={`approval ${top ? 'is-top' : ''}`}>
      <header className="approval-head">
        <div className="kind">file change · apply_patch{top ? ' · top' : ''}</div>
        <div className="title">
          {req.changes.length > 0
            ? req.changes.map((change) => change.path).join(', ')
            : req.grantRoot
              ? `writes under ${req.grantRoot}`
              : req.itemId}
        </div>
      </header>
      {req.reason ? <p className="approval-rationale">"{req.reason}"</p> : null}
      {req.changes.length > 0 ? (
        req.changes.map((change) => (
          <div className="diff" key={`${change.path}:${change.kind.type}`}>
            <div className="diff-path">{change.path}</div>
            {renderDiff(change.diff)}
          </div>
        ))
      ) : (
        <div className="diff empty">No patch details have arrived yet.</div>
      )}
      <div className="actions">
        <button
          className="decline"
          onClick={() =>
            submitReply(onReply, { kind: 'approval', requestId: req.id, decision: 'decline' })
          }
        >
          decline {top ? <kbd>D</kbd> : null}
        </button>
        <button
          className="accept"
          onClick={() =>
            submitReply(onReply, { kind: 'approval', requestId: req.id, decision: 'accept' })
          }
        >
          accept {top ? <kbd>A</kbd> : null}
        </button>
      </div>
    </article>
  );
}

function CmdApprovalCard({
  req,
  top,
  onReply,
}: {
  req: CommandApproval;
  top: boolean;
  onReply: UiActions['reply'];
}) {
  return (
    <article className={`approval ${top ? 'is-top' : ''}`}>
      <header className="approval-head">
        <div className="kind">command · bash{top ? ' · top' : ''}</div>
        <div className="title">{truncate(req.command ?? req.reason ?? req.itemId, 80)}</div>
      </header>
      {req.reason ? <p className="approval-rationale">"{req.reason}"</p> : null}
      <pre className="cmd">
        <span className="prompt">$</span>
        {req.command ?? '(network or policy approval)'}
        {req.cwd ? <span className="cwd">cwd · {req.cwd}</span> : null}
      </pre>
      <div className="actions">
        <button
          className="cancel"
          onClick={() =>
            submitReply(onReply, { kind: 'approval', requestId: req.id, decision: 'cancel' })
          }
          title="Drop the tool call entirely; codex receives a cancel result."
        >
          cancel
        </button>
        <button
          className="decline"
          onClick={() =>
            submitReply(onReply, { kind: 'approval', requestId: req.id, decision: 'decline' })
          }
        >
          decline {top ? <kbd>D</kbd> : null}
        </button>
        <button
          className="accept-session"
          onClick={() =>
            submitReply(onReply, {
              kind: 'approval',
              requestId: req.id,
              decision: 'acceptForSession',
            })
          }
          title="Approve and trust this command shape for the rest of the session."
        >
          accept · session
        </button>
        <button
          className="accept"
          onClick={() =>
            submitReply(onReply, { kind: 'approval', requestId: req.id, decision: 'accept' })
          }
        >
          accept {top ? <kbd>A</kbd> : null}
        </button>
      </div>
    </article>
  );
}

function PermissionApprovalCard({
  req,
  onReply,
}: {
  req: PermissionApproval;
  onReply: UiActions['reply'];
}) {
  return (
    <article className="approval permission-approval">
      <header className="approval-head">
        <div className="kind">permissions · grant request</div>
        <div className="title">{summarizePermissions(req.permissions)}</div>
      </header>
      {req.reason ? <p className="approval-rationale">"{req.reason}"</p> : null}
      <div className="actions">
        <button
          className="decline"
          onClick={() =>
            submitReply(onReply, { kind: 'permission', requestId: req.id, decision: 'decline' })
          }
        >
          decline
        </button>
        <button
          className="accept"
          onClick={() =>
            submitReply(onReply, { kind: 'permission', requestId: req.id, decision: 'accept' })
          }
        >
          accept
        </button>
      </div>
    </article>
  );
}

function ElicitationCard({
  req,
  onReply,
}: {
  req: ElicitationRequest;
  onReply: UiActions['reply'];
}) {
  return (
    <article className="approval elicitation">
      <header className="approval-head">
        <div className="kind">mcp · elicitation · {req.serverName}</div>
        <div className="title">{truncate(req.message, 100)}</div>
      </header>
      <div className="actions">
        <button
          className="cancel"
          onClick={() =>
            submitReply(onReply, { kind: 'elicitation', requestId: req.id, action: 'cancel' })
          }
        >
          cancel
        </button>
        <button
          className="decline"
          onClick={() =>
            submitReply(onReply, { kind: 'elicitation', requestId: req.id, action: 'decline' })
          }
        >
          decline
        </button>
        {canAcceptElicitation(req) ? (
          <button
            className="accept"
            onClick={() =>
              submitReply(onReply, { kind: 'elicitation', requestId: req.id, action: 'accept' })
            }
          >
            accept
          </button>
        ) : null}
      </div>
    </article>
  );
}

function OpenStateComposer({ onReply }: { onReply: UiActions['reply'] }) {
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 220);
    return () => clearTimeout(t);
  }, []);

  async function send() {
    const trimmed = value.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onReply({ kind: 'user-prompt', text: trimmed });
      setValue('');
    } catch {
      setError('reply failed; input retained');
    } finally {
      setSubmitting(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="slot slot-open">
      <div className="slot-head">
        <span className="dot" aria-hidden />
        <span className="label">open state — your prompt opens the next turn</span>
      </div>
      <div className="slot-row">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKey}
          placeholder="Type a message to the model. Drives a fresh turn under the active state."
          spellCheck={false}
        />
        <button
          className="slot-send"
          onClick={() => void send()}
          disabled={!value.trim() || submitting}
        >
          {submitting ? 'sending…' : 'send →'}
        </button>
      </div>
      {error ? <div className="slot-error">{error}</div> : null}
      <div className="slot-hint">
        <kbd>⌘</kbd>+<kbd>↵</kbd> send · routes through <code>POST /api/runs/:runId/reply</code>
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

function summarizePermissions(permissions: unknown): string {
  if (permissions === null || permissions === undefined) return 'permission profile';
  if (typeof permissions === 'string') return permissions;
  if (typeof permissions === 'number' || typeof permissions === 'boolean') {
    return String(permissions);
  }
  if (typeof permissions !== 'object') return 'permission profile';
  const p = permissions as { network?: unknown; fileSystem?: unknown };
  const parts: string[] = [];
  if (p.network !== null && p.network !== undefined) parts.push('network');
  if (p.fileSystem !== null && p.fileSystem !== undefined) parts.push('filesystem');
  return parts.length > 0 ? parts.join(', ') : 'permission profile';
}

function renderDiff(patch: string) {
  return patch.split('\n').map((line, i) => {
    let cls = '';
    if (line.startsWith('+++') || line.startsWith('---')) cls = 'meta';
    else if (line.startsWith('@@')) cls = 'hunk';
    else if (line.startsWith('+')) cls = 'add';
    else if (line.startsWith('-')) cls = 'del';
    return (
      <div key={i} className={`line ${cls}`}>
        {line || ' '}
      </div>
    );
  });
}

function PostureChip({
  label,
  tone,
}: {
  label: string;
  tone: 'indigo' | 'amber' | 'mint' | 'plasma' | 'rose';
}) {
  return (
    <span className="posture-chip" data-tone={tone}>
      {label}
    </span>
  );
}

function ActivePanelRow({ item }: { item: TranscriptItem }) {
  switch (item.type) {
    case 'agent_message':
      return (
        <article className={`msg agent-msg${item.streaming ? ' streaming' : ''}`}>
          <header className="msg-head">
            <span className="by">model</span>
          </header>
          <div className="body" dangerouslySetInnerHTML={{ __html: renderInline(item.text) }} />
        </article>
      );
    case 'user_message':
      // Real owner reply (synthetic is filtered out by visibleItems).
      return (
        <article className="msg user-msg">
          <header className="msg-head">
            <span className="by">owner</span>
          </header>
          <div className="body">{item.text}</div>
        </article>
      );
    case 'reasoning':
      return <ReasoningRow item={item} />;
    case 'tool_call':
      return <ToolCallRow item={item} />;
    case 'tool_result':
      return (
        <div className="tool-result" data-ok={item.ok}>
          <span className="glyph" aria-hidden>
            {item.ok ? '✓' : '✗'}
          </span>
          <div>
            <div className="tr-head">
              {prettyToolName(item.name)} · {item.ok ? 'completed' : 'failed'}
            </div>
            <div className="tr-body">{item.output}</div>
          </div>
        </div>
      );
    case 'framework_note':
      // Dev-mode only renders this; warn variant always shown.
      return <FrameworkNoteRow item={item} />;
    case 'compact_status':
      return <CompactStatusRow item={item} />;
    case 'state_change':
      // Already represented by the graph; skip in panel.
      return null;
    case 'fresh_clear_boundary':
      return (
        <div className="fresh-clear-boundary">
          <span className="lead">fresh clear · replacement thread</span>
          <div>
            {shortThread(item.previousThreadId)} → {shortThread(item.nextThreadId)} ·{' '}
            {item.statePath}
          </div>
        </div>
      );
    default:
      return null;
  }
}

function ToolCallRow({ item }: { item: Extract<TranscriptItem, { type: 'tool_call' }> }) {
  const startedRef = useRef<number>(Date.now());
  const [, setTick] = useState(0);
  const pending = item.status === 'pending';
  useEffect(() => {
    if (!pending) return;
    const id = window.setInterval(() => setTick((n) => (n + 1) % 1_000_000), 200);
    return () => window.clearInterval(id);
  }, [pending]);
  const elapsed =
    item.elapsedMs !== undefined
      ? formatElapsed(item.elapsedMs)
      : pending
        ? formatElapsed(Date.now() - startedRef.current)
        : null;
  const preview = truncate(item.preview, 140);
  return (
    <article className={`tool-call ${pending ? 'is-pending' : ''}`} data-status={item.status}>
      <header className="tc-head">
        {pending ? (
          <span className="tc-wave" aria-hidden>
            <i style={{ animationDelay: '0ms' }} />
            <i style={{ animationDelay: '120ms' }} />
            <i style={{ animationDelay: '240ms' }} />
            <i style={{ animationDelay: '360ms' }} />
          </span>
        ) : (
          <span className={`tc-glyph ${item.status}`} aria-hidden>
            {item.status === 'completed' ? '✓' : item.status === 'failed' ? '✗' : '•'}
          </span>
        )}
        <span className="name">{prettyToolName(item.name)}</span>
        {item.category === 'subagent' ? <span className="badge subagent">subagent</span> : null}
        <span className="badge" data-status={item.status}>
          {item.status}
        </span>
        {elapsed ? <span className="tc-elapsed mono">{elapsed}</span> : null}
      </header>
      {pending ? <div className="tc-scan" aria-hidden /> : null}
      {preview ? <div className="tc-preview">{preview}</div> : null}
      {item.output && item.output.length > 0 ? (
        <div className="tool-output" data-ok={item.ok ?? item.status === 'completed'}>
          <div className="to-head">{item.ok === false ? 'output · failed' : 'output'}</div>
          <pre>{item.output}</pre>
        </div>
      ) : null}
    </article>
  );
}

function AwaitingCodexPlaceholder() {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setSecs((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const STAGES = [
    { id: 'spawn', label: 'spawning codex app-server', cap: 4 },
    { id: 'ws', label: 'opening websocket', cap: 6 },
    { id: 'thread', label: 'thread/start handshake', cap: 8 },
  ];
  let activeIdx = -1;
  let cum = 0;
  for (let i = 0; i < STAGES.length; i++) {
    cum += STAGES[i].cap;
    if (secs < cum) {
      activeIdx = i;
      break;
    }
  }
  return (
    <div className="awaiting-codex">
      <div className="ac-eyebrow">
        <span className="ac-wave" aria-hidden>
          <i style={{ animationDelay: '0ms' }} />
          <i style={{ animationDelay: '120ms' }} />
          <i style={{ animationDelay: '240ms' }} />
          <i style={{ animationDelay: '360ms' }} />
          <i style={{ animationDelay: '480ms' }} />
        </span>
        <span>starting codex</span>
        <span className="ac-elapsed mono">
          {secs < 60
            ? `${secs}s`
            : `${Math.floor(secs / 60)}m ${(secs % 60).toString().padStart(2, '0')}s`}
        </span>
      </div>
      <h3 className="ac-title">Waiting for the first frame from codex</h3>
      <p className="ac-sub">
        The FSM is verified and the aharness is connected. Codex is starting in the background — the
        model will begin streaming into this panel as soon as it's online.
      </p>
      <ol className="ac-stages">
        {STAGES.map((stage, i) => {
          const status =
            activeIdx === -1 || i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'pending';
          return (
            <li key={stage.id} className="ac-stage" data-status={status}>
              <span className="ac-bullet" aria-hidden>
                {status === 'done' ? '✓' : ''}
              </span>
              <span className="ac-label">{stage.label}</span>
              {status === 'active' ? (
                <span className="ac-dots" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function InlineThinking({ activity }: { activity: Activity }) {
  return (
    <div className="inline-thinking" data-tone={activity.tone} role="status" aria-live="polite">
      <span className="it-wave" aria-hidden>
        <i style={{ animationDelay: '0ms' }} />
        <i style={{ animationDelay: '120ms' }} />
        <i style={{ animationDelay: '240ms' }} />
        <i style={{ animationDelay: '360ms' }} />
      </span>
      <span className="it-label">{activity.label}</span>
    </div>
  );
}

function FrameworkNoteRow({ item }: { item: Extract<TranscriptItem, { type: 'framework_note' }> }) {
  // Orientation notes are filtered upstream (their content lives in the
  // dev-mode context inspector), so only `info` and `warn` reach this row.
  const long = item.text.length > 180 || item.text.includes('{') || item.text.includes('\n');
  const label = item.variant === 'warn' ? 'framework warning' : 'framework note';
  if (long) {
    return (
      <details className="fw-note fw-note-long" data-variant={item.variant}>
        <summary>
          <span>{label}</span>
          <em>{item.text.length} chars</em>
        </summary>
        <pre>{item.text}</pre>
      </details>
    );
  }
  return (
    <div className="fw-note" data-variant={item.variant}>
      <span className="rule" aria-hidden />
      <span className="body">{item.text}</span>
      <span className="rule" aria-hidden />
    </div>
  );
}

function CompactStatusRow({ item }: { item: Extract<TranscriptItem, { type: 'compact_status' }> }) {
  const elapsed = item.elapsedMs === undefined ? null : formatElapsed(item.elapsedMs);
  return (
    <div className="compact-row" data-kind={item.category} data-status={item.status ?? 'info'}>
      <span className="compact-kicker">{item.category}</span>
      <span className="compact-label">{item.label}</span>
      {item.status ? <span className="compact-status">{item.status}</span> : null}
      {elapsed ? <span className="compact-elapsed mono">{elapsed}</span> : null}
      {item.summary ? <span className="compact-summary">{truncate(item.summary, 120)}</span> : null}
    </div>
  );
}

function ReasoningRow({ item }: { item: Extract<TranscriptItem, { type: 'reasoning' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <article className="msg reasoning-msg">
      <button className="reasoning-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span>model · reasoning</span>
        <span className="ct quiet">{item.text.length} chars</span>
      </button>
      {open ? <div className="body quiet">{item.text}</div> : null}
    </article>
  );
}

function prettyToolName(name: string): string {
  if (name === 'apply_patch') return '✎ apply_patch';
  if (name === 'bash') return '⚙ bash';
  if (name.startsWith('web_')) return '⌘ ' + name;
  return name;
}

function shortThread(threadId: string): string {
  return threadId.length <= 12 ? threadId : `${threadId.slice(0, 8)}…${threadId.slice(-4)}`;
}

function renderInline(text: string): string {
  const esc = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  return esc.replace(/`([^`]+?)`/g, '<code>$1</code>');
}
