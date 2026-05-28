import { createFsm } from '@aharness/core';
import {
  directCommandSkillPath,
  isExecutionMode,
  renderWritingPlansFinalArtifact,
  type ExecutionMode,
  type ReviewSummary,
} from './helpers/shared.js';

interface WritingPlansData {
  specPath: string;
  proposedPlanPath: string;
  planPath: string | null;
  executionMode: ExecutionMode | null;
  authoringSummary: string | null;
  lastBroadSpecFinding: string | null;
  lastBlocker: string | null;
  gateDecisions: ReviewSummary[];
}

interface WritingPlansOutput {
  planPath: string;
  executionMode: ExecutionMode;
}

const fsm = createFsm<WritingPlansData>();

function recordGate(
  draft: WritingPlansData,
  gate: string,
  decision: ReviewSummary['decision'],
  summary: string,
): void {
  draft.gateDecisions.push({ gate, decision, summary });
}

function writingPlansOutput(data: Readonly<WritingPlansData>): WritingPlansOutput {
  if (!data.executionMode) {
    throw new Error('writing-plans reached success before executionMode was selected');
  }
  return {
    planPath: data.planPath ?? data.proposedPlanPath,
    executionMode: data.executionMode,
  };
}

export const machine = fsm.machine({
  id: 'superpowers-writing-plans',
  input: {
    specPath: fsm.input.path({
      description: 'Approved spec or requirements document to plan from',
      complete: 'file',
    }),
    planPath: fsm.input.path({
      description: 'Target implementation plan path',
      default: './docs/plans/implementation-plan.md',
      complete: 'file',
    }),
  },
  data: ({ input }) => ({
    specPath: input.specPath,
    proposedPlanPath: input.planPath,
    planPath: null,
    executionMode: null,
    authoringSummary: null,
    lastBroadSpecFinding: null,
    lastBlocker: null,
    gateDecisions: [],
  }),
  initial: 'planAuthoring',
  states: {
    planAuthoring: fsm.state({
      prompt: (data) =>
        [
          'Write a bounded implementation plan from the approved spec.',
          `Spec path: ${data.specPath}`,
          `Target plan path: ${data.proposedPlanPath}`,
          'Read the spec and relevant code first. If the spec is too broad for one executable plan, submit broadSpec instead of continuing.',
          'When the plan is written and self-reviewed, submit planReady with the plan path and a concise evidence summary.',
          data.gateDecisions.length > 0
            ? `Recent gate feedback:\n${data.gateDecisions
                .slice(-3)
                .map((entry) => `- ${entry.gate}: ${entry.decision} - ${entry.summary}`)
                .join('\n')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      skills: [fsm.skill.path(directCommandSkillPath('writing-plans'))],
      on: {
        planReady: fsm.submit<{
          planPath: string;
          summary: string;
          qualityNotes: string;
        }>({
          to: 'planQualityGate',
          reduce: (draft, payload) => {
            draft.planPath = payload.planPath;
            draft.authoringSummary = payload.summary;
            recordGate(draft, 'plan-authoring', 'approved', payload.qualityNotes);
          },
        }),
        broadSpec: fsm.submit<{
          reason: string;
          suggestedNarrowing: string;
        }>({
          to: 'broadSpecOwnerDecision',
          reduce: (draft, payload) => {
            draft.lastBroadSpecFinding = `${payload.reason} Suggested narrowing: ${payload.suggestedNarrowing}`;
            recordGate(draft, 'scope-check', 'blocked', payload.reason);
          },
        }),
        blocked: fsm.submit<{
          reason: string;
          evidence: string;
        }>({
          to: 'blocked',
          reduce: (draft, payload) => {
            draft.lastBlocker = `${payload.reason} Evidence: ${payload.evidence}`;
            recordGate(draft, 'plan-authoring', 'blocked', payload.reason);
          },
        }),
      },
    }),
    broadSpecOwnerDecision: fsm.state({
      prompt: (data) =>
        [
          'The spec appears too broad for one implementation plan.',
          `Finding: ${data.lastBroadSpecFinding ?? 'No scope finding recorded.'}`,
          'Ask the owner whether to narrow and continue, or stop this run so the upstream roadmap/spec can be split.',
        ].join('\n\n'),
      ask: 'Should this run narrow the scope and continue planning, or stop for upstream decomposition?',
      on: {
        decide: fsm.submit<{
          continuePlanning: boolean;
          ownerDecisionSummary: string;
          narrowingInstructions: string;
        }>({
          route: [
            {
              if: (_data, payload) => payload.continuePlanning,
              to: 'planAuthoring',
              reduce: (draft, payload) => {
                draft.authoringSummary = `Owner narrowed scope: ${payload.narrowingInstructions}`;
                recordGate(
                  draft,
                  'broad-spec-owner-decision',
                  'approved',
                  payload.ownerDecisionSummary,
                );
              },
            },
            {
              to: 'stoppedForBroadSpec',
              reduce: (draft, payload) => {
                recordGate(
                  draft,
                  'broad-spec-owner-decision',
                  'blocked',
                  payload.ownerDecisionSummary,
                );
              },
            },
          ],
        }),
      },
    }),
    planQualityGate: fsm.state({
      prompt: (data) =>
        [
          'Review the implementation plan for structural defects before owner review.',
          `Plan path: ${data.planPath ?? data.proposedPlanPath}`,
          'Check boundary, current-reality references, buildability, test design, verification gates, and absence of placeholders.',
          'Submit review with approved=false if the plan needs changes.',
        ].join('\n\n'),
      skills: [fsm.skill.path(directCommandSkillPath('writing-plans'))],
      on: {
        review: fsm.submit<{
          approved: boolean;
          summary: string;
          requiredChanges: string[];
        }>({
          route: [
            {
              if: (_data, payload) => payload.approved,
              to: 'ownerPlanReview',
              reduce: (draft, payload) => {
                recordGate(draft, 'plan-quality-review', 'approved', payload.summary);
              },
            },
            {
              to: 'planAuthoring',
              reduce: (draft, payload) => {
                recordGate(
                  draft,
                  'plan-quality-review',
                  'changes-requested',
                  `${payload.summary} Required changes: ${payload.requiredChanges.join('; ')}`,
                );
              },
            },
          ],
        }),
      },
    }),
    ownerPlanReview: fsm.state({
      prompt: (data) =>
        [
          'Present the plan to the owner for explicit approval before execution.',
          `Plan path: ${data.planPath ?? data.proposedPlanPath}`,
          'If the owner requests changes, submit approved=false and return to plan authoring with concrete feedback.',
        ].join('\n\n'),
      ask: (data) =>
        `Review ${data.planPath ?? data.proposedPlanPath}. Is this plan approved for execution?`,
      on: {
        review: fsm.submit<{
          approved: boolean;
          summary: string;
          requestedChanges: string[];
        }>({
          route: [
            {
              if: (_data, payload) => payload.approved,
              to: 'chooseExecutionMode',
              reduce: (draft, payload) => {
                recordGate(draft, 'owner-plan-review', 'approved', payload.summary);
              },
            },
            {
              to: 'planAuthoring',
              reduce: (draft, payload) => {
                recordGate(
                  draft,
                  'owner-plan-review',
                  'changes-requested',
                  `${payload.summary} Requested changes: ${payload.requestedChanges.join('; ')}`,
                );
              },
            },
          ],
        }),
      },
    }),
    chooseExecutionMode: fsm.state({
      prompt: (data) =>
        [
          'Ask the owner how this approved plan should be executed.',
          `Plan path: ${data.planPath ?? data.proposedPlanPath}`,
          'Valid execution modes are subagent-driven and inline.',
          'This command only records the choice; later package commands execute the selected mode.',
        ].join('\n\n'),
      ask: 'Choose execution mode: subagent-driven or inline.',
      on: {
        choose: fsm.submit<{
          executionMode: ExecutionMode;
          reason: string;
        }>({
          route: [
            {
              if: (_data, payload) => isExecutionMode(payload.executionMode),
              to: 'readyForExecution',
              reduce: (draft, payload) => {
                draft.executionMode = payload.executionMode;
                recordGate(draft, 'execution-choice', 'approved', payload.reason);
              },
            },
            {
              to: 'chooseExecutionMode',
              reduce: (draft, payload) => {
                recordGate(
                  draft,
                  'execution-choice',
                  'changes-requested',
                  `Invalid execution mode requested: ${payload.executionMode}`,
                );
              },
            },
          ],
        }),
      },
    }),
    readyForExecution: fsm.final({
      outcome: 'success',
      output: writingPlansOutput,
      artifacts: {
        'writing-plans-result.md': renderWritingPlansFinalArtifact,
      },
    }),
    stoppedForBroadSpec: fsm.final({
      outcome: 'failure',
      artifacts: {
        'writing-plans-result.md': renderWritingPlansFinalArtifact,
      },
    }),
    blocked: fsm.final({
      outcome: 'failure',
      artifacts: {
        'writing-plans-result.md': renderWritingPlansFinalArtifact,
      },
    }),
  },
});

export default machine;
