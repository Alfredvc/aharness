import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { buildNodeDetailRowsForTest, ActivePanel } from './ActivePanel.js';
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
    toggleDevMode: () => undefined,
    setScope: () => undefined,
    ...overrides,
  };
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

describe('ActivePanel historical visits', () => {
  it('renders frozen historical scope visits from loaded row pages without false empty placeholders', () => {
    const html = renderToStaticMarkup(
      createElement(ActivePanel, {
        session: baseSession({
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
    const html = renderToStaticMarkup(
      createElement(ActivePanel, {
        session: baseSession({
          scopedPath: 'workflow.collect',
          statePathVisits: { 'workflow.collect': ['workflow.collect#1'] },
          rowLoadStatus: {
            'workflow.collect#1': { loading: true, loaded: false, error: null },
          },
        }),
      }),
    );

    expect(html).toContain('visit 1');
    expect(html).toContain('loading activity for this visit');
    expect(html).not.toContain('no activity in this visit');
    expect(html).not.toContain('no activity yet in this visit');
  });

  it('does not claim emptiness when a loaded visit only has rows hidden by the default filter', () => {
    const html = renderToStaticMarkup(
      createElement(ActivePanel, {
        session: baseSession({
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
      }),
    );

    expect(html).toContain('activity hidden in this view');
    expect(html).not.toContain('no activity in this visit');
    expect(html).not.toContain('no activity yet in this visit');
  });

  it('uses the run-scoped reply endpoint hint for open-state composer replies', () => {
    const html = renderToStaticMarkup(
      createElement(ActivePanel, {
        session: baseSession({
          posture: {
            isTerminal: false,
            isAwaiting: false,
            submittedThisTurn: false,
            open: true,
          },
        }),
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
