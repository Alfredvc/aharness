// Demo scenes for the web-ui prototype. Each scene plays a sequence of
// AppEvent frames at relative delays, optionally awaiting a reply.

import type { AppEvent } from '../types/events.js';
import type { ReplyPayload } from './engine.js';

export type Frame = { at: number; event: AppEvent };

export type Scene = {
  id: string;
  frames: Frame[];
  // Autonomous scenes (no owner input, no approval) advance themselves once
  // their frames have drained. `next` defaults to `cursor + 1`. Mutually
  // exclusive with `awaits`.
  autoAdvance?: { next?: (cursor: number) => number; gapMs?: number };
  awaits?:
    | {
        kind: 'owner-input';
        next: (payload: Extract<ReplyPayload, { kind: 'owner-input' }>, cursor: number) => number;
      }
    | {
        kind: 'approval';
        next: (payload: Extract<ReplyPayload, { kind: 'approval' }>, cursor: number) => number;
      };
};

const ROOT = 'requirement_spec';
const P = (leaf: string) => `${ROOT}.${leaf}`;

/* ─────────────────────────────────────────── helpers */

function stream(itemId: string, text: string, chunk = 14): Frame[] {
  const out: Frame[] = [];
  for (let i = 0; i < text.length; i += chunk) {
    const slice = text.slice(i, i + chunk);
    out.push({
      at: i === 0 ? 60 : 26,
      event: { kind: 'AgentMessageDelta', id: itemId, delta: slice },
    });
  }
  return out;
}

function enter(
  to: string,
  cause: 'submit' | 'await' | 'always' | 'embed-final' | 'boot',
  from: string | null,
  awaits = false,
  visitCount = 1,
  outcome?: 'success' | 'failure',
): Frame {
  const leaf = to.split('.').pop()!;
  return {
    at: 0,
    event: {
      kind: 'StateChange',
      from,
      to,
      cause,
      newState: {
        path: to,
        leaf,
        kind: outcome ? 'terminal' : 'stateful',
        ...(awaits ? { awaitsOwnerText: { messageToUser: '' } } : {}),
        exits: [],
        visitCount,
      },
    },
  };
}

function modelMsg(id: string, text: string): Frame[] {
  return [
    { at: 0, event: { kind: 'ItemStarted', id, type: 'agent_message', text: '' } },
    ...stream(id, text),
  ];
}

function reqUserInput(id: string, question: string, choices?: string[]): Frame[] {
  // Two events: the function_call (filtered out in default view) + the
  // ServerRequest the UI binds the InteractionSlot to.
  return [
    {
      at: 200,
      event: {
        kind: 'ItemStarted',
        id: `tc-${id}`,
        type: 'function_call',
        name: 'request_user_input',
        arguments: JSON.stringify({ questions: [{ id: 'owner', question, choices }] }, null, 2),
      },
    },
    {
      at: 60,
      event: {
        kind: 'ServerRequest',
        id,
        method: 'item/tool/requestUserInput',
        questions: [
          {
            id: 'owner',
            header: '',
            question,
            isOther: false,
            isSecret: false,
            ...(choices ? { choices } : {}),
          },
        ],
      },
    },
  ];
}

function multiReqUserInput(
  id: string,
  questions: Array<{ id: string; header?: string; question: string; isSecret?: boolean }>,
): Frame[] {
  return [
    {
      at: 200,
      event: {
        kind: 'ItemStarted',
        id: `tc-${id}`,
        type: 'function_call',
        name: 'request_user_input',
        arguments: JSON.stringify({ questions }, null, 2),
      },
    },
    {
      at: 60,
      event: {
        kind: 'ServerRequest',
        id,
        method: 'item/tool/requestUserInput',
        questions: questions.map((q) => ({
          id: q.id,
          header: q.header ?? '',
          question: q.question,
          isOther: false,
          isSecret: q.isSecret ?? false,
        })),
      },
    },
  ];
}

function submitFrame(id: string, args: object): Frame {
  return {
    at: 200,
    event: {
      kind: 'ItemStarted',
      id,
      type: 'function_call',
      name: 'harness_submit',
      arguments: JSON.stringify(args, null, 2),
    },
  };
}

function turnDone(id: string, finishReason: 'tool_calls' | 'stop' = 'tool_calls'): Frame {
  return {
    at: 0,
    event: { kind: 'TurnCompleted', turnId: id, finishReason },
  };
}

const STATE_ENTRY = (to: string) =>
  `You have entered \`${to.split('.').pop()}\`. Read the active state's exits and submit when ready.`;

function syntheticOrientation(id: string, to: string): Frame {
  return {
    at: 240,
    event: {
      kind: 'ItemStarted',
      id,
      type: 'user_message',
      text: STATE_ENTRY(to),
    },
  };
}

/* ─────────────────────────────────────────── PATCHES */

const PATCH = `--- a/examples/requirement-spec.fsm.ts
+++ b/examples/requirement-spec.fsm.ts
@@ -42,6 +42,18 @@ export const machine = createMachine({
   id: 'requirement_spec',
   initial: 'gathering_constraints',
   states: {
+    gathering_constraints: state({
+      kind: 'stateful',
+      awaitsOwnerText: {
+        messageToUser:
+          'Tell me the purpose of this project in one sentence, the named stakeholders, and any mandated constraints (regulatory, technical, organizational).',
+      },
+      exits: {
+        proceed: submit({ to: 'drafting_drivers', data: DriversIntake }),
+      },
+    }),
+
     drafting_drivers: state({
       kind: 'stateful',`;

/* ─────────────────────────────────────────── scenes */

export const scenes: Scene[] = [
  // 0 — boot, enter gathering_constraints, ask for owner intake
  {
    id: 'boot',
    frames: [
      enter(P('gathering_constraints'), 'boot', null, true, 1),
      ...modelMsg(
        'm-1',
        `Booting in \`gathering_constraints\`. I'll ask the owner for the Volere shell — purpose, stakeholders, mandated constraints — before drafting anything.`,
      ),
      ...reqUserInput(
        'req-owner-1',
        'Tell me the purpose of this project in one sentence, the named stakeholders, and any mandated constraints (regulatory, technical, organizational).',
      ),
    ],
    awaits: { kind: 'owner-input', next: () => 1 },
  },

  // 1 — drafting_drivers (visit 1), proposes apply_patch, asks for approval
  {
    id: 'enter-drafting-1',
    frames: [
      submitFrame('sub-1', {
        state: 'gathering_constraints',
        exit: 'proceed',
        data: {
          purpose: 'A CLI that runs deterministic FSM-driven Codex sessions.',
          stakeholders: ['platform', 'agent ops'],
          constraints: ['reuse ~/.codex/', 'two-process topology'],
        },
      }),
      turnDone('t-1'),
      enter(P('drafting_drivers'), 'submit', P('gathering_constraints'), false, 1),
      syntheticOrientation('orient-1', P('drafting_drivers')),
      ...modelMsg(
        'm-2',
        `Drafting drivers. Two constraints look load-bearing but one is ambiguous — "two-process topology" could mean the old harness shape or the new one. I'll ask a clarification before committing the artifact.`,
      ),
      {
        at: 200,
        event: {
          kind: 'ItemStarted',
          id: 'fc-patch-1',
          type: 'function_call',
          name: 'apply_patch',
          arguments: JSON.stringify(
            {
              file_path: 'examples/requirement-spec.fsm.ts',
              patch: '<unified diff — see approval card>',
            },
            null,
            2,
          ),
        },
      },
      {
        at: 80,
        event: {
          kind: 'ServerRequest',
          id: 'req-patch-1',
          requestId: 'req-patch-1',
          method: 'item/fileChange/requestApproval',
          threadId: 'thread-fixture',
          turnId: 'turn-fixture',
          itemId: 'call_apply_patch_1',
          changes: [
            {
              path: 'examples/requirement-spec.fsm.ts',
              kind: { type: 'update', move_path: null },
              diff: PATCH,
            },
          ],
          reason:
            'Add the gathering_constraints state shell so the harness has a real first leaf to land in.',
        },
      },
    ],
    awaits: {
      kind: 'approval',
      next: (p) => (p.decision === 'accept' ? 2 : 2), // either way fall through
    },
  },

  // 2 — patch result, ask_followup → clarifying
  {
    id: 'ask-followup',
    frames: [
      {
        at: 0,
        event: {
          kind: 'ItemStarted',
          id: 'fco-patch-1',
          type: 'function_call_output',
          name: 'apply_patch',
          output: 'Patch applied. 1 file changed, 12 insertions(+).',
          ok: true,
        },
      },
      submitFrame('sub-2', {
        state: 'drafting_drivers',
        exit: 'ask_followup',
        data: { topic: 'topology' },
      }),
      turnDone('t-2'),
      enter(P('clarifying'), 'submit', P('drafting_drivers'), true, 1),
      syntheticOrientation('orient-2', P('clarifying')),
      ...modelMsg(
        'm-3',
        `One clarification before I commit. Which topology is mandated — the old single-process or the new daemon + app-server + remote-TUI trio?`,
      ),
      ...reqUserInput(
        'req-owner-2',
        'Which topology is mandated — old single-process, or new daemon + app-server + remote-TUI trio?',
      ),
    ],
    awaits: { kind: 'owner-input', next: () => 3 },
  },

  // 3 — clarifying → resolved → drafting_drivers (re-entry, visit 2)
  {
    id: 'enter-drafting-2',
    frames: [
      submitFrame('sub-3', {
        state: 'clarifying',
        exit: 'resolved',
        data: { topology: 'three-process' },
      }),
      turnDone('t-3'),
      enter(P('drafting_drivers'), 'submit', P('clarifying'), false, 2),
      syntheticOrientation('orient-3', P('drafting_drivers')),
      ...modelMsg(
        'm-4',
        `Clarification noted. Three-process topology is the mandated shape. Artifact draft is clean — moving to \`review\` for approval.`,
      ),
      submitFrame('sub-4', {
        state: 'drafting_drivers',
        exit: 'present',
        data: { artifact: 'Project Drivers v1' },
      }),
      turnDone('t-4'),
      enter(P('review'), 'submit', P('drafting_drivers'), true, 1),
      syntheticOrientation('orient-4', P('review')),
      ...modelMsg(
        'm-5',
        `In \`review\`. Owner can approve to ship, reject to redraft, or ask me to revisit (re-render the same draft).`,
      ),
      ...reqUserInput('req-owner-3', 'Verdict on the drivers draft?', [
        'approve',
        'reject — needs another draft',
        'revisit — just re-render the draft',
      ]),
    ],
    awaits: {
      kind: 'owner-input',
      next: (p) => {
        const v = p.answers['owner'] ?? '';
        if (v === 'reject — needs another draft') return 4;
        if (v === 'revisit — just re-render the draft') return 5;
        if (v === 'approve') return 6;
        // "other…" or unknown → treat as reject for demo
        return 4;
      },
    },
  },

  // 4 — review→reject→drafting_drivers (visit 3), self-recover, present again
  {
    id: 'review-reject',
    frames: [
      submitFrame('sub-5', { state: 'review', exit: 'reject', data: { reason: 'redraft' } }),
      turnDone('t-5'),
      enter(P('drafting_drivers'), 'submit', P('review'), false, 3),
      syntheticOrientation('orient-5', P('drafting_drivers')),
      ...modelMsg(
        'm-6',
        `Redrafting. Tightening the stakeholder list and constraint hierarchy. Will present again.`,
      ),
      submitFrame('sub-6', {
        state: 'drafting_drivers',
        exit: 'present',
        data: { artifact: 'Project Drivers v2' },
      }),
      turnDone('t-6'),
      enter(P('review'), 'submit', P('drafting_drivers'), true, 2),
      syntheticOrientation('orient-6', P('review')),
      ...modelMsg('m-7', `Re-presenting v2. Same choices.`),
      ...reqUserInput('req-owner-4', 'Verdict on v2?', [
        'approve',
        'reject — needs another draft',
        'revisit — just re-render the draft',
      ]),
    ],
    awaits: {
      kind: 'owner-input',
      next: (p) => {
        const v = p.answers['owner'] ?? '';
        if (v === 'approve') return 6;
        if (v === 'revisit — just re-render the draft') return 5;
        return 6;
      },
    },
  },

  // 5 — review self-loop revisit
  {
    id: 'review-revisit',
    frames: [
      submitFrame('sub-7', { state: 'review', exit: 'revisit', data: {} }),
      turnDone('t-7'),
      enter(P('review'), 'submit', P('review'), true, 3),
      syntheticOrientation('orient-7', P('review')),
      ...modelMsg('m-8', `Re-rendering the same draft. No changes — just a fresh read.`),
      ...reqUserInput('req-owner-5', 'Verdict after the re-render?', ['approve', 'reject']),
    ],
    awaits: {
      kind: 'owner-input',
      next: (p) => (p.answers['owner'] === 'reject' ? 4 : 6),
    },
  },

  // 6 — review→approve (branch #0 to present, multi-question form for ship metadata)
  {
    id: 'review-approve',
    frames: [
      submitFrame('sub-8', { state: 'review', exit: 'approve', data: { intent: 'present' } }),
      turnDone('t-8'),
      enter(P('present'), 'submit', P('review'), false, 1),
      syntheticOrientation('orient-8', P('present')),
      ...modelMsg(
        'm-9',
        `In \`present\`. Final pass: a smoke test before \`ship\`. I'll need a release tag and a publication channel from the owner.`,
      ),
      ...multiReqUserInput('req-owner-6', [
        { id: 'tag', question: 'Release tag (e.g. v0.4.2)?', header: 'tag' },
        { id: 'channel', question: 'Channel? (canary, beta, stable)', header: 'channel' },
        { id: 'note', question: 'Release note (optional)', header: 'note' },
      ]),
    ],
    awaits: { kind: 'owner-input', next: () => 7 },
  },

  // 7 — present: bash test + approval, then ship
  {
    id: 'present-ship',
    frames: [
      ...modelMsg('m-10', `Tag + channel noted. Running the smoke test before ship.`),
      {
        at: 200,
        event: {
          kind: 'ItemStarted',
          id: 'fc-bash-1',
          type: 'function_call',
          name: 'bash',
          arguments: JSON.stringify(
            { command: 'pnpm exec vitest run --reporter dot', timeout_ms: 60000 },
            null,
            2,
          ),
        },
      },
      {
        at: 80,
        event: {
          kind: 'ServerRequest',
          id: 'req-bash-1',
          requestId: 'req-bash-1',
          method: 'item/commandExecution/requestApproval',
          threadId: 'thread-fixture',
          turnId: 'turn-fixture',
          itemId: 'call_bash_1',
          command: 'pnpm exec vitest run --reporter dot',
          cwd: '/Users/alfredvc/src/aharness',
          reason: 'Smoke-check before ship.',
        },
      },
    ],
    awaits: {
      kind: 'approval',
      next: (p) => (p.decision === 'accept' ? 8 : 9),
    },
  },

  // 8 — accepted → tests pass, ship → done_success
  {
    id: 'ship',
    frames: [
      {
        at: 0,
        event: {
          kind: 'ItemStarted',
          id: 'fco-bash-1',
          type: 'function_call_output',
          name: 'bash',
          output: '...... 42 tests passed in 4.1s',
          ok: true,
        },
      },
      ...modelMsg('m-11', `All green. Shipping.`),
      submitFrame('sub-9', { state: 'present', exit: 'ship', data: { tag: 'v0.4.2' } }),
      turnDone('t-9'),
      enter(P('done_success'), 'submit', P('present'), false, 1, 'success'),
      ...modelMsg('m-12', `Run complete. Terminal: success.`),
    ],
  },

  // 9 — declined → abort → done_abort
  {
    id: 'abort',
    frames: [
      ...modelMsg('m-11b', `Smoke test declined. Aborting the ship.`),
      submitFrame('sub-9b', { state: 'present', exit: 'abort', data: { reason: 'no_smoke' } }),
      turnDone('t-9b'),
      enter(P('done_abort'), 'submit', P('present'), false, 1, 'failure'),
    ],
  },
];
