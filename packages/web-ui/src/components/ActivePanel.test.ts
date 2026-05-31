import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Virtuoso, VirtuosoMockContext } from 'react-virtuoso';
import { describe, expect, it } from 'vitest';

import {
  activePanelVirtuosoComponentsForTest,
  activePanelFollowOutputForTest,
  activePanelRowForTest,
  activePanelShouldAutoscrollForTest,
  buildRunTranscriptRowsForTest,
  buildNodeDetailRowsForTest,
  ActivePanel,
} from './ActivePanel.js';
import type { ActivePanelTimelineRow } from './ActivePanel.js';
import { canAcceptElicitation } from './elicitationActions.js';
import { OwnerInputComposer } from './OwnerInputComposer.js';
import type { UiState, UiActions } from '../state/store.js';

type TestSession = UiState & UiActions;

function baseSession(overrides: Partial<TestSession> = {}): TestSession {
  return {
    mode: 'run',
    run: {
      runId: 'run-1',
      threadId: 'thread-1',
      repoRoot: '/repo',
      fsmFile: 'workflow.ts',
      fsmHash6: 'abc123',
      codexPin: 'pin-1',
      startedAt: '2026-05-29T00:00:00.000Z',
    },
    latestEventId: 'run-1:4',
    posture: {
      isTerminal: false,
      isAwaiting: false,
      submittedThisTurn: false,
      open: false,
    },
    activeTurnId: null,
    state: {
      path: 'workflow.collect',
      leaf: 'collect',
      kind: 'stateful',
      exits: [],
      visitCount: 2,
    },
    topology: {
      machineId: 'workflow',
      initial: 'workflow.collect',
      nodes: [{ id: 'workflow.collect', label: 'collect', kind: 'stateful' }],
      edges: [],
    },
    transcript: [],
    pending: {
      fileApprovals: [],
      cmdApprovals: [],
      permissionApprovals: [],
      elicitations: [],
      ownerInput: null,
    },
    diagnostics: [],
    stateVisits: [
      {
        id: 'workflow.collect#1',
        path: 'workflow.collect',
        seq: 1,
        time: '2026-05-29T00:00:01.000Z',
        to: 'workflow.collect',
      },
      {
        id: 'workflow.collect#2',
        path: 'workflow.collect',
        seq: 3,
        time: '2026-05-29T00:00:03.000Z',
        from: null,
        to: 'workflow.collect',
        cause: 'loop',
      },
    ],
    statePathVisits: {
      'workflow.collect': ['workflow.collect#1', 'workflow.collect#2'],
    },
    rowPageCursors: {},
    rowLoadStatus: {},
    recentRowsCursor: null,
    recentRowsLoadStatus: { loading: false, loaded: false, error: null },
    aggregateStats: { turnCount: 0 },
    history: [
      {
        at: 1,
        from: null,
        to: 'workflow.collect',
        cause: 'boot',
        visitId: 'workflow.collect#1',
      },
      {
        at: 3,
        from: null,
        to: 'workflow.collect',
        cause: 'loop',
        visitId: 'workflow.collect#2',
      },
    ],
    turns: [],
    connection: 'live',
    replyError: null,
    rowLoadError: null,
    activeVisitId: 'workflow.collect#2',
    scopedPath: null,
    devMode: false,
    reply: () => Promise.resolve(),
    requestRowsForStatePath: () => Promise.resolve(),
    requestRecentRows: () => Promise.resolve(),
    toggleDevMode: () => undefined,
    setScope: () => undefined,
    ...overrides,
  };
}

function renderActivePanel(session: TestSession): string {
  return renderToStaticMarkup(
    createElement(() =>
      createElement(
        VirtuosoMockContext.Provider,
        { value: { viewportHeight: 640, itemHeight: 48 } },
        createElement(ActivePanel, { session }),
      ),
    ),
  );
}

describe('ActivePanel elicitation actions', () => {
  it('only offers accept when the browser can send valid elicitation content', () => {
    expect(canAcceptElicitation({ mode: 'url' })).toBe(true);
    expect(canAcceptElicitation({ mode: 'form' })).toBe(false);
  });
});

describe('ActivePanel inspect node details', () => {
  it('formats prompt, clear, hooks, and exit details for visualize mode', () => {
    expect(
      buildNodeDetailRowsForTest({
        id: 'plan',
        label: 'plan',
        kind: 'stateful',
        detail: {
          entryPrompt: { kind: 'static', text: 'Plan carefully.' },
          clearOnEntry: true,
          open: true,
          hooks: [{ kind: 'PreToolUse', count: 1, matchers: ['^Bash$'] }],
          exits: [
            {
              name: 'submitPlan',
              kind: 'submit',
              targets: ['review'],
              description: 'Plan is ready.',
            },
          ],
        },
      }),
    ).toEqual([
      { label: 'mode', value: 'open' },
      { label: 'clear on entry', value: 'yes' },
      { label: 'entry prompt', value: 'Plan carefully.' },
      { label: 'hooks', value: 'PreToolUse x1 (^Bash$)' },
      { label: 'exits', value: 'submitPlan -> review: Plan is ready.' },
    ]);
  });
});

describe('ActivePanel tool rows', () => {
  it('renders completed tool output inside the tool-call card', () => {
    const html = renderToStaticMarkup(
      createElement(() =>
        activePanelRowForTest({
          id: 'call-bash-1',
          type: 'tool_call',
          name: 'bash',
          preview: 'pnpm test',
          status: 'completed',
          reserved: false,
          stateVisitId: 'workflow.collect#2',
          output: 'completed',
          ok: true,
          resultId: 'call-bash-1:output',
        }),
      ),
    );

    expect(html).toContain('<pre>completed</pre>');
    expect(html).toContain('tool-output');
    expect(html).not.toContain('tool-result');
  });
});

describe('ActivePanel timeline rows', () => {
  it('keeps pending approvals and elicitations visible in the global view before transcript rows exist', () => {
    const rows = buildRunTranscriptRowsForTest({
      mode: 'run',
      items: [],
      devMode: false,
      hasAnyVisibleContent: false,
      turnsLength: 0,
      showInlineIndicator: false,
      activity: { kind: 'idle', label: 'idle', tone: 'muted', motion: 'still' },
      showApprovals: true,
    });

    expect(rows.map((row) => row.kind)).toEqual(['approvals']);
  });

  it('adds approval and inline activity rows to the virtualized timeline tail', () => {
    const rows = buildRunTranscriptRowsForTest({
      mode: 'run',
      turnsLength: 1,
      hasAnyVisibleContent: true,
      devMode: false,
      items: [
        {
          id: 'state-change-1',
          type: 'state_change',
          from: null,
          to: 'workflow.collect',
          cause: 'boot',
          stateVisitId: 'workflow.collect#2',
        },
        {
          id: 'agent-1',
          type: 'agent_message',
          text: 'Hello',
          streaming: false,
          stateVisitId: 'workflow.collect#2',
        },
      ],
      showInlineIndicator: true,
      activity: {
        kind: 'thinking',
        label: 'model thinking',
        tone: 'indigo',
        motion: 'wave',
      },
      showApprovals: true,
    });

    expect(rows.map((row) => row.kind)).toEqual(['transcript', 'inline_indicator', 'approvals']);
  });
});

describe('ActivePanel virtualized list', () => {
  it('only follows output and height changes while viewing the live transcript', () => {
    expect(activePanelFollowOutputForTest({ isFollowing: true, atBottom: true })).toBe('smooth');
    expect(activePanelFollowOutputForTest({ isFollowing: true, atBottom: false })).toBe(false);
    expect(activePanelFollowOutputForTest({ isFollowing: false, atBottom: true })).toBe(false);
    expect(activePanelShouldAutoscrollForTest({ isFollowing: true, atBottom: true })).toBe(true);
    expect(activePanelShouldAutoscrollForTest({ isFollowing: false, atBottom: true })).toBe(false);
  });

  it('renders measured timeline rows with the Virtuoso mock context', () => {
    const data: ActivePanelTimelineRow[] = [
      { kind: 'empty', key: 'empty-current', text: 'no activity yet in this visit' },
    ];
    const html = renderToStaticMarkup(
      createElement(() =>
        createElement(
          VirtuosoMockContext.Provider,
          { value: { viewportHeight: 300, itemHeight: 48 } },
          createElement(Virtuoso<ActivePanelTimelineRow>, {
            data,
            components: activePanelVirtuosoComponentsForTest,
            initialItemCount: 1,
            itemContent: (_: number, row: ActivePanelTimelineRow) =>
              row.kind === 'empty'
                ? createElement('div', { className: 'ap-empty quiet' }, row.text)
                : null,
          }),
        ),
      ),
    );

    expect(html).toContain('ap-virtual-item');
    expect(html).toContain('ap-virtual-header');
    expect(html).toContain('no activity yet in this visit');
  });
});

describe('ActivePanel historical visits', () => {
  it('renders no selected state as a chronological run transcript without visit headers', () => {
    const session = baseSession({
      scopedPath: null,
      transcript: [
        {
          id: 'later',
          type: 'agent_message',
          text: 'later',
          streaming: false,
          seq: 3,
          stateVisitId: 'workflow.review#1',
        },
        {
          id: 'earlier',
          type: 'agent_message',
          text: 'earlier',
          streaming: false,
          seq: 1,
          stateVisitId: 'workflow.collect#1',
        },
      ],
    });

    const html = renderToStaticMarkup(createElement(ActivePanel, { session }));

    expect(html).toContain('Run transcript');
    expect(html.indexOf('earlier')).toBeLessThan(html.indexOf('later'));
    expect(html).not.toContain('ap-visit-header');
  });

  it('keeps selected states grouped by visit', () => {
    const session = baseSession({
      scopedPath: 'workflow.collect',
      statePathVisits: { 'workflow.collect': ['workflow.collect#1', 'workflow.collect#2'] },
      transcript: [
        {
          id: 'v1',
          type: 'agent_message',
          text: 'first visit',
          streaming: false,
          seq: 1,
          stateVisitId: 'workflow.collect#1',
        },
        {
          id: 'v2',
          type: 'agent_message',
          text: 'second visit',
          streaming: false,
          seq: 2,
          stateVisitId: 'workflow.collect#2',
        },
      ],
    });

    const html = renderToStaticMarkup(createElement(ActivePanel, { session }));

    expect(html).toContain('visit 1');
    expect(html).toContain('visit 2');
    expect(html).toContain('first visit');
    expect(html).toContain('second visit');
  });

  it('renders compact normalized rows without raw expansion', () => {
    const html = renderActivePanel(
      baseSession({
        transcript: [
          {
            id: 'msg-1',
            type: 'agent_message',
            text: 'model text',
            streaming: false,
            stateVisitId: 'workflow.collect#2',
          },
          {
            id: 'reason-1',
            type: 'reasoning',
            text: 'hidden reasoning text',
            streaming: false,
            stateVisitId: 'workflow.collect#2',
          },
          {
            id: 'tool-1',
            type: 'tool_call',
            name: 'bash',
            preview: 'pnpm test',
            status: 'completed',
            reserved: false,
            elapsedMs: 4200,
            category: 'tool',
            stateVisitId: 'workflow.collect#2',
          },
          {
            id: 'tool-pending',
            type: 'tool_call',
            name: 'python',
            preview: 'python script.py',
            status: 'pending',
            reserved: false,
            category: 'tool',
            stateVisitId: 'workflow.collect#2',
          },
          {
            id: 'tool-failed',
            type: 'tool_call',
            name: 'eslint',
            preview: 'lint failed',
            status: 'failed',
            reserved: false,
            elapsedMs: 1200,
            category: 'tool',
            stateVisitId: 'workflow.collect#2',
          },
          {
            id: 'subagent-1',
            type: 'tool_call',
            name: 'spawn_agent',
            preview: 'worker running',
            status: 'pending',
            reserved: false,
            category: 'subagent',
            stateVisitId: 'workflow.collect#2',
          },
          {
            id: 'request-1',
            type: 'compact_status',
            category: 'request',
            label: 'command approval',
            status: 'pending',
            summary: 'approve command',
            stateVisitId: 'workflow.collect#2',
          },
          {
            id: 'reply-1',
            type: 'compact_status',
            category: 'reply',
            label: 'approval',
            status: 'submitted',
            summary: 'request-1',
            stateVisitId: 'workflow.collect#2',
          },
          {
            id: 'reply-2',
            type: 'compact_status',
            category: 'reply',
            label: 'approval',
            status: 'accepted',
            summary: 'request-1',
            stateVisitId: 'workflow.collect#2',
          },
          {
            id: 'reply-3',
            type: 'compact_status',
            category: 'reply',
            label: 'approval',
            status: 'failed',
            summary: 'rejected',
            stateVisitId: 'workflow.collect#2',
          },
          {
            id: 'diagnostic-1',
            type: 'compact_status',
            category: 'diagnostic',
            label: 'abandoned',
            status: 'warn',
            summary: 'old thread ignored',
            stateVisitId: 'workflow.collect#2',
          },
          {
            id: 'fresh-clear-1',
            type: 'fresh_clear_boundary',
            reason: 'clearOnEntry',
            previousThreadId: 'old-thread',
            nextThreadId: 'new-thread',
            statePath: 'workflow.collect',
            stateVisitId: 'workflow.collect#2',
          },
        ],
      }),
    );

    expect(html).toContain('model text');
    expect(html).toContain('model · reasoning');
    expect(html).toContain('4s');
    expect(html).toContain('pnpm test');
    expect(html).toContain('python');
    expect(html).toContain('python script.py');
    expect(html).toContain('eslint');
    expect(html).toContain('lint failed');
    expect(html).toContain('1s');
    expect(html).toContain('subagent');
    expect(html).toContain('worker running');
    expect(html).toContain('command approval');
    expect(html).toContain('submitted');
    expect(html).toContain('accepted');
    expect(html).toContain('failed');
    expect(html).toContain('old thread ignored');
    expect(html).toContain('fresh clear · replacement thread');
    expect(html).toContain('old-thread');
    expect(html).toContain('new-thread');
    expect(html).not.toContain('{&quot;');
    expect(html).not.toContain('<pre');
  });

  it('keeps aharness internal tools hidden by default and visible in dev mode', () => {
    const transcript: TestSession['transcript'] = [
      {
        id: 'internal-tool',
        type: 'tool_call',
        name: 'aharness_submit',
        preview: '{}',
        status: 'completed',
        reserved: true,
        stateVisitId: 'workflow.collect#2',
      },
    ];
    const hidden = renderActivePanel(
      baseSession({
        scopedPath: 'workflow.collect',
        rowLoadStatus: {
          'workflow.collect#2': { loading: false, loaded: true, error: null, storedRows: 1 },
        },
        transcript,
      }),
    );
    const dev = renderActivePanel(
      baseSession({ scopedPath: 'workflow.collect', transcript, devMode: true }),
    );

    expect(hidden).toContain('activity hidden in this view');
    expect(hidden).not.toContain('aharness_submit');
    expect(dev).toContain('aharness_submit');
  });

  it('renders frozen historical scope visits from loaded row pages without false empty placeholders', () => {
    const html = renderActivePanel(
      baseSession({
        scopedPath: 'workflow.collect',
        rowLoadStatus: {
          'workflow.collect#1': { loading: false, loaded: true, error: null },
          'workflow.collect#2': { loading: false, loaded: true, error: null },
        },
        transcript: [
          {
            id: 'row-v1',
            type: 'agent_message',
            text: 'first visit row',
            streaming: false,
            stateVisitId: 'workflow.collect#1',
            seq: 2,
            eventId: 'run-1:2',
          },
          {
            id: 'row-v2',
            type: 'agent_message',
            text: 'second visit row',
            streaming: false,
            stateVisitId: 'workflow.collect#2',
            seq: 4,
            eventId: 'run-1:4',
          },
        ],
      }),
    );

    expect(html).toContain('visit 1');
    expect(html).toContain('first visit row');
    expect(html).toContain('visit 2');
    expect(html).toContain('second visit row');
    expect(html).not.toContain('no activity in this visit');
    expect(html).not.toContain('no activity yet in this visit');
  });

  it('does not claim emptiness for a known visit while row loading is in flight', () => {
    const html = renderActivePanel(
      baseSession({
        scopedPath: 'workflow.collect',
        statePathVisits: { 'workflow.collect': ['workflow.collect#1'] },
        rowLoadStatus: {
          'workflow.collect#1': { loading: true, loaded: false, error: null },
        },
      }),
    );

    expect(html).toContain('visit 1');
    expect(html).toContain('loading activity for this visit');
    expect(html).not.toContain('no activity in this visit');
    expect(html).not.toContain('no activity yet in this visit');
  });

  it('does not claim emptiness when a loaded visit only has rows hidden by the default filter', () => {
    const html = renderActivePanel(
      baseSession({
        scopedPath: 'workflow.collect',
        statePathVisits: { 'workflow.collect': ['workflow.collect#1'] },
        rowLoadStatus: {
          'workflow.collect#1': { loading: false, loaded: true, error: null },
        },
        transcript: [
          {
            id: 'state-row',
            type: 'state_change',
            from: null,
            to: 'workflow.collect',
            cause: 'boot',
            stateVisitId: 'workflow.collect#1',
            seq: 1,
            eventId: 'run-1:1',
          },
        ],
      }),
    );

    expect(html).toContain('activity hidden in this view');
    expect(html).not.toContain('no activity in this visit');
    expect(html).not.toContain('no activity yet in this visit');
  });

  it('does not claim emptiness when loaded row pages only produced unsupported diagnostics', () => {
    const html = renderActivePanel(
      baseSession({
        scopedPath: 'workflow.collect',
        statePathVisits: { 'workflow.collect': ['workflow.collect#1', 'workflow.collect#2'] },
        rowLoadStatus: {
          'workflow.collect#1': { loading: false, loaded: true, error: null, storedRows: 2 },
          'workflow.collect#2': { loading: false, loaded: true, error: null },
        },
        transcript: [
          {
            id: 'row-v2',
            type: 'agent_message',
            text: 'second visit row',
            streaming: false,
            stateVisitId: 'workflow.collect#2',
          },
        ],
      }),
    );

    expect(html).toContain('visit 1');
    expect(html).toContain('activity hidden in this view');
    expect(html).toContain('visit 2');
    expect(html).toContain('second visit row');
    expect(html).not.toContain('no activity in this visit');
    expect(html).not.toContain('no activity yet in this visit');
  });

  it('shows row-load errors without false empty placeholders', () => {
    const html = renderActivePanel(
      baseSession({
        scopedPath: 'workflow.collect',
        statePathVisits: { 'workflow.collect': ['workflow.collect#1'] },
        rowLoadStatus: {
          'workflow.collect#1': { loading: false, loaded: false, error: 'boom' },
        },
      }),
    );

    expect(html).toContain('could not load activity for this visit');
    expect(html).not.toContain('no activity in this visit');
    expect(html).not.toContain('no activity yet in this visit');
  });

  it('uses the run-scoped reply endpoint hint for open-state composer replies', () => {
    const html = renderActivePanel(
      baseSession({
        posture: {
          isTerminal: false,
          isAwaiting: false,
          submittedThisTurn: false,
          open: true,
        },
      }),
    );

    expect(html).toContain('POST /api/runs/:runId/reply');
    expect(html).not.toContain('POST /api/reply');
  });
});

describe('OwnerInputComposer reply hint', () => {
  it('uses the run-scoped reply endpoint hint', () => {
    const html = renderToStaticMarkup(
      createElement(OwnerInputComposer, {
        session: baseSession({
          pending: {
            fileApprovals: [],
            cmdApprovals: [],
            permissionApprovals: [],
            elicitations: [],
            ownerInput: {
              kind: 'ServerRequest',
              id: 'owner-1',
              method: 'item/tool/requestUserInput',
              questions: [
                {
                  id: 'q1',
                  header: 'Next',
                  question: 'What now?',
                  isOther: false,
                  isSecret: false,
                },
              ],
            },
          },
        }),
      }),
    );

    expect(html).toContain('POST /api/runs/:runId/reply');
    expect(html).not.toContain('POST /api/reply');
  });
});
