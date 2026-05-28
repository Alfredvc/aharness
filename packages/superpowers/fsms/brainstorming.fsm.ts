import { createFsm } from '@aharness/core';
import {
  directCommandGuidePath,
  renderBrainstormingFinalArtifact,
  type ReviewSummary,
} from './helpers/shared.js';

interface BrainstormingData {
  topic: string;
  proposedSpecPath: string;
  specPath: string | null;
  designSummary: string | null;
  specReviewSummary: string | null;
  lastBlocker: string | null;
  gateDecisions: ReviewSummary[];
}

interface BrainstormingOutput {
  specPath: string;
}

const fsm = createFsm<BrainstormingData>();

function recordGate(
  draft: BrainstormingData,
  gate: string,
  decision: ReviewSummary['decision'],
  summary: string,
): void {
  draft.gateDecisions.push({ gate, decision, summary });
}

function brainstormingOutput(data: Readonly<BrainstormingData>): BrainstormingOutput {
  if (!data.specPath) {
    throw new Error('brainstorming reached success before specPath was recorded');
  }
  return { specPath: data.specPath };
}

export const machine = fsm.machine({
  id: 'superpowers-brainstorming',
  input: {
    topic: fsm.input.string({
      description: 'Idea, feature, or behavior to explore before implementation',
    }),
    specPath: fsm.input.path({
      description: 'Target written design spec path',
      default: './docs/specs/implementation-design.md',
      complete: 'file',
    }),
  },
  data: ({ input }) => ({
    topic: input.topic,
    proposedSpecPath: input.specPath,
    specPath: null,
    designSummary: null,
    specReviewSummary: null,
    lastBlocker: null,
    gateDecisions: [],
  }),
  initial: 'designConversation',
  states: {
    designConversation: fsm.state({
      mode: 'open',
      prompt: (data) =>
        [
          'Explore the idea with the owner and turn it into an approved design.',
          `Topic: ${data.topic}`,
          'Read relevant project context, ask clarifying questions one at a time, propose approaches with trade-offs, and present the design for owner approval.',
          'When the owner approves the design, submit designReview with approved=true. If the owner rejects or revises the design, submit approved=false and keep iterating in this state.',
          data.gateDecisions.length > 0
            ? `Recent gate feedback:\n${data.gateDecisions
                .slice(-3)
                .map((entry) => `- ${entry.gate}: ${entry.decision} - ${entry.summary}`)
                .join('\n')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      skills: [fsm.skill.path(directCommandGuidePath('brainstorming', 'design-conversation'))],
      on: {
        designReview: fsm.submit<{
          approved: boolean;
          designSummary: string;
          ownerFeedback: string;
        }>({
          route: [
            {
              if: (_data, payload) => payload.approved,
              to: 'writeAndReviewSpec',
              reduce: (draft, payload) => {
                draft.designSummary = payload.designSummary;
                recordGate(draft, 'design-approval', 'approved', payload.ownerFeedback);
              },
            },
            {
              to: 'designConversation',
              reduce: (draft, payload) => {
                draft.designSummary = payload.designSummary;
                recordGate(draft, 'design-approval', 'rejected', payload.ownerFeedback);
              },
            },
          ],
        }),
        blocked: fsm.submit<{
          reason: string;
          evidence: string;
        }>({
          to: 'blocked',
          reduce: (draft, payload) => {
            draft.lastBlocker = `${payload.reason} Evidence: ${payload.evidence}`;
            recordGate(draft, 'design-conversation', 'blocked', payload.reason);
          },
        }),
      },
    }),
    writeAndReviewSpec: fsm.state({
      prompt: (data) =>
        [
          'Write the approved design spec and self-review it before owner review.',
          `Topic: ${data.topic}`,
          `Target spec path: ${data.proposedSpecPath}`,
          data.designSummary ? `Approved design summary: ${data.designSummary}` : '',
          'Save the spec, then check it for placeholders, contradictions, ambiguity, and scope drift.',
          'If the self-review finds required changes, submit specReview with approved=false. When the written spec is ready for owner review, submit approved=true with the final spec path.',
        ]
          .filter(Boolean)
          .join('\n\n'),
      skills: [fsm.skill.path(directCommandGuidePath('brainstorming', 'write-and-review-spec'))],
      on: {
        specReview: fsm.submit<{
          approved: boolean;
          specPath: string;
          summary: string;
          requiredChanges: string[];
        }>({
          route: [
            {
              if: (_data, payload) => payload.approved,
              to: 'ownerSpecApprovalGate',
              reduce: (draft, payload) => {
                draft.specPath = payload.specPath;
                draft.specReviewSummary = payload.summary;
                recordGate(draft, 'spec-self-review', 'approved', payload.summary);
              },
            },
            {
              to: 'writeAndReviewSpec',
              reduce: (draft, payload) => {
                draft.specPath = payload.specPath;
                draft.specReviewSummary = payload.summary;
                recordGate(
                  draft,
                  'spec-self-review',
                  'changes-requested',
                  `${payload.summary} Required changes: ${payload.requiredChanges.join('; ')}`,
                );
              },
            },
          ],
        }),
        blocked: fsm.submit<{
          reason: string;
          evidence: string;
        }>({
          to: 'blocked',
          reduce: (draft, payload) => {
            draft.lastBlocker = `${payload.reason} Evidence: ${payload.evidence}`;
            recordGate(draft, 'spec-writing', 'blocked', payload.reason);
          },
        }),
      },
    }),
    ownerSpecApprovalGate: fsm.state({
      prompt: (data) =>
        [
          'Present the written spec to the owner for explicit approval before planning.',
          `Spec path: ${data.specPath ?? data.proposedSpecPath}`,
          'If the owner requests changes, submit approved=false and return to spec writing with concrete feedback.',
          'If the owner approves, submit approved=true to complete brainstorming.',
        ].join('\n\n'),
      ask: (data) =>
        `Review ${data.specPath ?? data.proposedSpecPath}. Is this written spec approved?`,
      on: {
        review: fsm.submit<{
          approved: boolean;
          summary: string;
          requestedChanges: string[];
        }>({
          route: [
            {
              if: (_data, payload) => payload.approved,
              to: 'approved',
              reduce: (draft, payload) => {
                recordGate(draft, 'owner-spec-review', 'approved', payload.summary);
              },
            },
            {
              to: 'writeAndReviewSpec',
              reduce: (draft, payload) => {
                recordGate(
                  draft,
                  'owner-spec-review',
                  'changes-requested',
                  `${payload.summary} Requested changes: ${payload.requestedChanges.join('; ')}`,
                );
              },
            },
          ],
        }),
      },
    }),
    approved: fsm.final({
      outcome: 'success',
      output: brainstormingOutput,
      artifacts: {
        'brainstorming-result.md': renderBrainstormingFinalArtifact,
      },
    }),
    blocked: fsm.final({
      outcome: 'failure',
      artifacts: {
        'brainstorming-result.md': renderBrainstormingFinalArtifact,
      },
    }),
  },
});

export default machine;
