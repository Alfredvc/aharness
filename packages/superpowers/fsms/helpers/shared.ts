export const EXECUTION_MODES = ['subagent-driven', 'inline'] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export type GateDecision = 'approved' | 'rejected' | 'blocked' | 'fixed';
export type ReviewDecision = 'approved' | 'changes-requested';

export interface SpecPathRecord {
  readonly specPath: string;
}

export interface PlanPathRecord {
  readonly planPath: string;
}

export interface ExecutionModeRecord {
  readonly executionMode: ExecutionMode;
}

export interface ReviewSummary {
  readonly gate: string;
  readonly decision: GateDecision | ReviewDecision;
  readonly summary: string;
}

export interface WritingPlansArtifactData extends SpecPathRecord {
  readonly planPath: string | null;
  readonly proposedPlanPath: string;
  readonly executionMode: ExecutionMode | null;
  readonly authoringSummary: string | null;
  readonly planFixSummary: string | null;
  readonly planFindings: readonly string[];
  readonly planFixCycles: number;
  readonly maxPlanFixCycles: number;
  readonly lastBroadSpecFinding: string | null;
  readonly lastBlocker: string | null;
  readonly gateDecisions: readonly ReviewSummary[];
}

export interface BrainstormingArtifactData {
  readonly topic: string;
  readonly proposedSpecPath: string;
  readonly specPath: string | null;
  readonly designSummary: string | null;
  readonly specReviewSummary: string | null;
  readonly lastBlocker: string | null;
  readonly gateDecisions: readonly ReviewSummary[];
}

export function isExecutionMode(value: string): value is ExecutionMode {
  return (EXECUTION_MODES as readonly string[]).includes(value);
}

export function directCommandGuidePath(skillName: string, guideName: string): string {
  return `../skills/superpowers/${skillName}/guides/${guideName}.md`;
}

export function renderReviewSummaries(summaries: readonly ReviewSummary[]): string {
  if (summaries.length === 0) return '- No gates recorded yet.\n';
  return summaries
    .map((summary) => `- ${summary.gate}: ${summary.decision} - ${summary.summary}`)
    .join('\n')
    .concat('\n');
}

export function renderWritingPlansFinalArtifact(data: WritingPlansArtifactData): string {
  const planPath = data.planPath ?? data.proposedPlanPath;
  return [
    '# Writing Plans Result',
    '',
    `Spec path: ${data.specPath}`,
    `Plan path: ${planPath}`,
    `Execution mode: ${data.executionMode ?? 'not selected'}`,
    '',
    '## Authoring Summary',
    '',
    data.authoringSummary ?? 'No plan has been accepted yet.',
    '',
    '## Plan Fix Summary',
    '',
    `Plan fix cycles: ${data.planFixCycles} of ${data.maxPlanFixCycles}`,
    '',
    data.planFixSummary ?? 'No plan-quality fix cycle has run.',
    '',
    '## Current Plan Findings',
    '',
    data.planFindings.length > 0
      ? data.planFindings.map((finding) => `- ${finding}`).join('\n')
      : '- None recorded.',
    '',
    '## Gate Decisions',
    '',
    renderReviewSummaries(data.gateDecisions).trimEnd(),
    '',
    '## Broad Spec Finding',
    '',
    data.lastBroadSpecFinding ?? 'None recorded.',
    '',
    '## Blocker',
    '',
    data.lastBlocker ?? 'None recorded.',
    '',
  ].join('\n');
}

export function renderBrainstormingFinalArtifact(data: BrainstormingArtifactData): string {
  const specPath = data.specPath ?? data.proposedSpecPath;
  return [
    '# Brainstorming Result',
    '',
    `Topic: ${data.topic}`,
    `Spec path: ${specPath}`,
    '',
    '## Design Summary',
    '',
    data.designSummary ?? 'No design has been approved yet.',
    '',
    '## Spec Review Summary',
    '',
    data.specReviewSummary ?? 'No written spec has been accepted yet.',
    '',
    '## Gate Decisions',
    '',
    renderReviewSummaries(data.gateDecisions).trimEnd(),
    '',
    '## Blocker',
    '',
    data.lastBlocker ?? 'None recorded.',
    '',
  ].join('\n');
}
