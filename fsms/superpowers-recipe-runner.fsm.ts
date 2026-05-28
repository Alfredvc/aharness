import { createFsm } from '@aharness/core';

type PhaseStatus = 'ok' | 'changes-requested' | 'needs-recovery' | 'failed' | 'done' | 'recovered';
type RepairSource = 'review' | 'verification';
type RecoveryPhase =
  | 'orient'
  | 'plan'
  | 'execute'
  | 'review'
  | 'verify'
  | 'repair'
  | 'finish'
  | 'clear-next';

interface PhaseRecord {
  readonly iteration: number;
  readonly phase: string;
  readonly status: PhaseStatus;
  readonly summary: string;
}

interface Data {
  recipePath: string;
  roadmapPath: string | null;
  currentSlice: string | null;
  currentPlanPath: string | null;
  lastCompleted: string | null;
  completedIterations: number;
  maxIterations: number;
  maxRecoveryAttempts: number;
  workspaceSummary: string | null;
  sliceSummary: string | null;
  planSummary: string | null;
  executionSummary: string | null;
  reviewSummary: string | null;
  repairSource: RepairSource | null;
  repairSummary: string | null;
  blockingFindings: string[];
  changedFiles: string[];
  verificationCommands: string[];
  verificationSummary: string | null;
  stagedFiles: string[];
  commitSha: string | null;
  nextSlice: string | null;
  recoveryPhase: RecoveryPhase | null;
  recoveryReason: string | null;
  recoveryEvidence: string | null;
  recoveryGuidance: string | null;
  finalSummary: string | null;
  failures: string[];
  history: PhaseRecord[];
}

interface RunnerOutput {
  recipePath: string;
  completedIterations: number;
  lastCommitSha: string | null;
  finalSummary: string;
}

interface RecoveryData {
  phase: string;
  reason: string;
  evidence: string;
  guidance: string;
  attempt: number;
  maxAttempts: number;
  summary: string | null;
  changedFiles: string[];
}

interface RecoveryOutput {
  phase: string;
  attempts: number;
  summary: string;
  changedFiles: string[];
}

const DEFAULT_RECIPE_PATH =
  'docs/plans/2026-05-27-superpowers-fsm-package-implementation-recipe.md';

const runner = createFsm<Data>();
const recovery = createFsm<RecoveryData>();

function record(draft: Data, phase: string, status: PhaseStatus, summary: string): void {
  draft.history.push({
    iteration: draft.completedIterations,
    phase,
    status,
    summary,
  });
}

function appendUnique(existing: string[], incoming: readonly string[]): string[] {
  const merged = new Set(existing);
  for (const item of incoming) {
    const trimmed = item.trim();
    if (trimmed.length > 0) merged.add(trimmed);
  }
  return [...merged];
}

function requestRecovery(
  draft: Data,
  phase: RecoveryPhase,
  reason: string,
  evidence: string,
  guidance: string,
): void {
  draft.recoveryPhase = phase;
  draft.recoveryReason = reason;
  draft.recoveryEvidence = evidence;
  draft.recoveryGuidance = guidance;
  record(draft, `${phase}-phase`, 'needs-recovery', `${reason} Evidence: ${evidence}`);
}

function resetRecovery(draft: Data): void {
  draft.recoveryPhase = null;
  draft.recoveryReason = null;
  draft.recoveryEvidence = null;
  draft.recoveryGuidance = null;
}

function resetSliceRuntime(draft: Data): void {
  draft.executionSummary = null;
  draft.reviewSummary = null;
  draft.repairSource = null;
  draft.repairSummary = null;
  draft.blockingFindings = [];
  draft.changedFiles = [];
  draft.verificationSummary = null;
  draft.stagedFiles = [];
  draft.nextSlice = null;
  resetRecovery(draft);
}

function hasNextSlice(nextSlice: string | null): nextSlice is string {
  return nextSlice !== null && nextSlice.trim().length > 0;
}

function runnerOutput(data: Readonly<Data>): RunnerOutput {
  return {
    recipePath: data.recipePath,
    completedIterations: data.completedIterations,
    lastCommitSha: data.commitSha,
    finalSummary: data.finalSummary ?? 'Recipe runner completed.',
  };
}

function renderReport(data: Readonly<Data>): string {
  return [
    '# Superpowers Recipe Runner Report',
    '',
    `Recipe: \`${data.recipePath}\``,
    `Roadmap: \`${data.roadmapPath ?? 'not recorded'}\``,
    `Completed iterations: ${data.completedIterations}`,
    `Last commit: \`${data.commitSha ?? 'none'}\``,
    `Current slice: ${data.currentSlice ?? 'none'}`,
    `Next slice: ${data.nextSlice ?? 'none'}`,
    '',
    '## Final Summary',
    '',
    data.finalSummary ?? 'No final summary recorded.',
    '',
    '## Last Slice Evidence',
    '',
    `Plan: \`${data.currentPlanPath ?? 'none'}\``,
    `Changed files: ${data.changedFiles.length > 0 ? data.changedFiles.join(', ') : 'none'}`,
    `Verification commands: ${
      data.verificationCommands.length > 0 ? data.verificationCommands.join('; ') : 'none'
    }`,
    `Verification summary: ${data.verificationSummary ?? 'none'}`,
    '',
    '## Unresolved Failures',
    '',
    ...(data.failures.length > 0 ? data.failures.map((entry) => `- ${entry}`) : ['- none']),
    '',
    '## History',
    '',
    ...data.history.map(
      (entry) =>
        `- Iteration ${entry.iteration} / ${entry.phase}: ${entry.status} - ${entry.summary}`,
    ),
    '',
  ].join('\n');
}

function currentSliceLine(data: Readonly<Data>): string {
  return data.currentSlice ? `Current slice: ${data.currentSlice}` : 'Current slice not recorded.';
}

function currentPlanLine(data: Readonly<Data>): string {
  return data.currentPlanPath
    ? `Current detailed plan: ${data.currentPlanPath}`
    : 'Current detailed plan is not written yet.';
}

function defaultRecoveryGuidance(phase: RecoveryPhase): string {
  const shared =
    'Stay within the current recipe slice. Preserve unrelated owner changes. Do not ask for owner input; inspect files, docs, git state, and command output to recover.';
  switch (phase) {
    case 'orient':
      return `${shared} Reconcile recipe and roadmap by reading both files, checking recent commits, and distinguishing unrelated dirty files from slice-owned work.`;
    case 'plan':
      return `${shared} If the plan is missing or stale, write a bounded current-slice plan from the roadmap and recipe instead of stopping.`;
    case 'execute':
      return `${shared} Re-read the detailed plan, then continue implementation with the smallest current-slice fix that removes the blocker.`;
    case 'review':
      return `${shared} Reconstruct the intended diff and review basis from the plan, roadmap, and git diff, then retry review.`;
    case 'verify':
      return `${shared} Derive verification commands from the plan and roadmap, fix command setup issues owned by the slice, and rerun focused checks.`;
    case 'repair':
      return `${shared} Re-read the last review or verification failure, fix only current-slice issues, and preserve the gate that failed.`;
    case 'finish':
      return `${shared} Re-check git status, stage only slice-owned files plus the recipe, and use the repository commit convention without adding co-author tags.`;
    case 'clear-next':
      return `${shared} Re-read the committed recipe state and roadmap, confirm the next slice, and continue even if the prior context was lost.`;
  }
}

export default runner.machine({
  id: 'superpowers-recipe-runner',
  input: {
    recipePath: runner.input.path({
      description: 'Implementation recipe to finish',
      default: DEFAULT_RECIPE_PATH,
      complete: 'file',
    }),
    maxIterations: runner.input.number({
      description: 'Safety cap for completed recipe slices in one run',
      default: 10,
    }),
    maxRecoveryAttempts: runner.input.number({
      description: 'Recovery attempts before failing the run',
      default: 3,
    }),
  },
  data: ({ input }): Data => ({
    recipePath: input.recipePath,
    maxIterations: input.maxIterations,
    maxRecoveryAttempts: input.maxRecoveryAttempts,
    roadmapPath: null,
    currentSlice: null,
    currentPlanPath: null,
    lastCompleted: null,
    completedIterations: 0,
    workspaceSummary: null,
    sliceSummary: null,
    planSummary: null,
    executionSummary: null,
    reviewSummary: null,
    repairSource: null,
    repairSummary: null,
    blockingFindings: [],
    changedFiles: [],
    verificationCommands: [],
    verificationSummary: null,
    stagedFiles: [],
    commitSha: null,
    nextSlice: null,
    recoveryPhase: null,
    recoveryReason: null,
    recoveryEvidence: null,
    recoveryGuidance: null,
    finalSummary: null,
    failures: [],
    history: [],
  }),
  initial: 'orientSlice',
  states: {
    orientSlice: runner.state({
      main: true,
      prompt: (data) =>
        [
          'Read the implementation recipe, parent roadmap, current detailed plan if present, git status, and recent commits.',
          `Recipe path: ${data.recipePath}`,
          '',
          'Identify exactly one current slice and decide whether the workspace is safe to proceed.',
          'If unrelated dirty files are present, record them and continue without staging or reverting them.',
          'If the recipe is complete, submit finished.',
          'If the recipe, roadmap, or workspace state prevents progress, submit needsRecovery with concrete evidence instead of stopping.',
          'Do not edit files in this state.',
        ].join('\n'),
      on: {
        readyToPlan: runner.submit<{
          roadmapPath: string;
          currentSlice: string;
          currentPlanPath: string | null;
          lastCompleted: string | null;
          sliceSummary: string;
          workspaceSummary: string;
        }>({
          to: 'planSlice',
          reduce: (draft, payload) => {
            draft.roadmapPath = payload.roadmapPath;
            draft.currentSlice = payload.currentSlice;
            draft.currentPlanPath = payload.currentPlanPath;
            draft.lastCompleted = payload.lastCompleted;
            draft.sliceSummary = payload.sliceSummary;
            draft.workspaceSummary = payload.workspaceSummary;
            resetSliceRuntime(draft);
            record(draft, 'orient-slice', 'ok', payload.sliceSummary);
          },
        }),
        finished: runner.submit<{ summary: string }>({
          to: 'complete',
          reduce: (draft, payload) => {
            draft.finalSummary = payload.summary;
            record(draft, 'orient-slice', 'done', payload.summary);
          },
        }),
        needsRecovery: runner.submit<{
          reason: string;
          evidence: string;
          guidance: string;
        }>({
          to: 'recover',
          reduce: (draft, payload) => {
            requestRecovery(
              draft,
              'orient',
              payload.reason,
              payload.evidence,
              payload.guidance || defaultRecoveryGuidance('orient'),
            );
          },
        }),
      },
    }),
    planSlice: runner.state({
      main: true,
      prompt: (data) =>
        [
          'Write or confirm the bounded detailed plan for the current slice only.',
          currentSliceLine(data),
          currentPlanLine(data),
          `Roadmap: ${data.roadmapPath ?? 'not recorded'}`,
          '',
          'The plan must define the slice boundary, concrete implementation tasks, acceptance checks, verification commands, and documentation updates.',
          'Do not implement the plan in this state.',
          'If planning cannot continue after reading the recipe and roadmap, submit needsRecovery with what is missing or inconsistent.',
        ].join('\n'),
      on: {
        planReady: runner.submit<{
          planPath: string;
          wroteOrUpdated: boolean;
          summary: string;
          verificationCommands: string[];
        }>({
          to: 'executeSlice',
          reduce: (draft, payload) => {
            draft.currentPlanPath = payload.planPath;
            draft.planSummary = payload.summary;
            draft.verificationCommands = payload.verificationCommands;
            resetRecovery(draft);
            record(
              draft,
              'plan-slice',
              'ok',
              `${payload.wroteOrUpdated ? 'Wrote or updated' : 'Confirmed'} ${payload.planPath}: ${
                payload.summary
              }`,
            );
          },
        }),
        needsRecovery: runner.submit<{
          reason: string;
          evidence: string;
          guidance: string;
        }>({
          to: 'recover',
          reduce: (draft, payload) => {
            requestRecovery(
              draft,
              'plan',
              payload.reason,
              payload.evidence,
              payload.guidance || defaultRecoveryGuidance('plan'),
            );
          },
        }),
      },
    }),
    executeSlice: runner.state({
      main: true,
      clearOnEntry: true,
      prompt: (data) =>
        [
          'Fresh context checkpoint after planning.',
          'Re-read the recipe, roadmap slice, detailed plan, and git status. Then execute the current slice plan end to end.',
          currentSliceLine(data),
          currentPlanLine(data),
          '',
          'Let the detailed plan guide task order internally. Do not route through Aharness for every subtask.',
          'Keep changes inside the slice boundary, preserve existing behavior unless the plan changes it, and update docs with behavior changes.',
          'Run task-local checks where useful, but the final verification gate is later.',
          'If implementation cannot continue, submit needsRecovery with concrete evidence and a suggested recovery route.',
          'Submit implementationComplete only when the slice implementation is ready for review.',
        ].join('\n'),
      on: {
        implementationComplete: runner.submit<{
          summary: string;
          changedFiles: string[];
          completedPlanItems: string[];
          docsUpdated: boolean;
          localCheckSummary: string;
        }>({
          to: 'reviewSlice',
          reduce: (draft, payload) => {
            draft.executionSummary = [
              payload.summary,
              `Completed plan items: ${payload.completedPlanItems.join('; ')}`,
              `Docs updated: ${payload.docsUpdated}`,
              `Local checks: ${payload.localCheckSummary}`,
            ].join('\n');
            draft.changedFiles = appendUnique(draft.changedFiles, payload.changedFiles);
            resetRecovery(draft);
            record(draft, 'execute-slice', 'ok', payload.summary);
          },
        }),
        needsRecovery: runner.submit<{
          reason: string;
          evidence: string;
          guidance: string;
        }>({
          to: 'recover',
          reduce: (draft, payload) => {
            requestRecovery(
              draft,
              'execute',
              payload.reason,
              payload.evidence,
              payload.guidance || defaultRecoveryGuidance('execute'),
            );
          },
        }),
      },
    }),
    reviewSlice: runner.state({
      main: true,
      prompt: (data) =>
        [
          'Review the completed slice diff against the recipe, roadmap slice, and detailed plan.',
          currentSliceLine(data),
          currentPlanLine(data),
          '',
          'Prioritize correctness, behavior regressions, missing tests, documentation drift, and scope leaks.',
          'Critical or Important findings are blocking. Submit approved=true only when no blocking findings remain.',
          'If review cannot be performed because context is missing or inconsistent, submit needsRecovery.',
        ].join('\n'),
      on: {
        reviewComplete: runner.submit<{
          approved: boolean;
          summary: string;
          blockingFindings: string[];
          nonBlockingFindings: string[];
        }>({
          route: [
            {
              if: (_data, payload) => payload.approved && payload.blockingFindings.length === 0,
              to: 'verifySlice',
              reduce: (draft, payload) => {
                draft.reviewSummary = payload.summary;
                draft.blockingFindings = [];
                draft.repairSource = null;
                resetRecovery(draft);
                record(
                  draft,
                  'review-slice',
                  'ok',
                  `${payload.summary} Non-blocking findings: ${payload.nonBlockingFindings.join('; ')}`,
                );
              },
            },
            {
              to: 'repairSlice',
              reduce: (draft, payload) => {
                draft.reviewSummary = payload.summary;
                draft.blockingFindings = payload.blockingFindings;
                draft.repairSource = 'review';
                resetRecovery(draft);
                record(
                  draft,
                  'review-slice',
                  'changes-requested',
                  `${payload.summary} Blocking findings: ${payload.blockingFindings.join('; ')}`,
                );
              },
            },
          ],
        }),
        needsRecovery: runner.submit<{
          reason: string;
          evidence: string;
          guidance: string;
        }>({
          to: 'recover',
          reduce: (draft, payload) => {
            requestRecovery(
              draft,
              'review',
              payload.reason,
              payload.evidence,
              payload.guidance || defaultRecoveryGuidance('review'),
            );
          },
        }),
      },
    }),
    verifySlice: runner.state({
      main: true,
      prompt: (data) =>
        [
          'Run final verification for the current slice.',
          currentSliceLine(data),
          currentPlanLine(data),
          '',
          'Commands recorded from the plan:',
          ...(data.verificationCommands.length > 0
            ? data.verificationCommands.map((command) => `- ${command}`)
            : [
                '- none recorded; derive the verification commands from the plan before submitting',
              ]),
          '',
          'Submit passed=true only when all required verification completed successfully.',
          'If the verification setup itself is blocked, submit needsRecovery instead of failing the run.',
        ].join('\n'),
      on: {
        verified: runner.submit<{
          passed: boolean;
          commands: string[];
          summary: string;
          failingCommands: string[];
        }>({
          route: [
            {
              if: (_data, payload) => payload.passed,
              to: 'finishSlice',
              reduce: (draft, payload) => {
                draft.verificationCommands = payload.commands;
                draft.verificationSummary = payload.summary;
                draft.repairSource = null;
                resetRecovery(draft);
                record(draft, 'verify-slice', 'ok', payload.summary);
              },
            },
            {
              to: 'repairSlice',
              reduce: (draft, payload) => {
                draft.verificationCommands = payload.commands;
                draft.verificationSummary = payload.summary;
                draft.blockingFindings = payload.failingCommands;
                draft.repairSource = 'verification';
                resetRecovery(draft);
                record(
                  draft,
                  'verify-slice',
                  'failed',
                  `${payload.summary} Failing commands: ${payload.failingCommands.join('; ')}`,
                );
              },
            },
          ],
        }),
        needsRecovery: runner.submit<{
          reason: string;
          evidence: string;
          guidance: string;
        }>({
          to: 'recover',
          reduce: (draft, payload) => {
            requestRecovery(
              draft,
              'verify',
              payload.reason,
              payload.evidence,
              payload.guidance || defaultRecoveryGuidance('verify'),
            );
          },
        }),
      },
    }),
    repairSlice: runner.state({
      prompt: (data) =>
        [
          'Repair the current slice based on the last failed gate.',
          currentSliceLine(data),
          `Repair source: ${data.repairSource ?? 'not recorded'}`,
          `Review summary: ${data.reviewSummary ?? 'none'}`,
          `Verification summary: ${data.verificationSummary ?? 'none'}`,
          '',
          'Blocking items:',
          ...(data.blockingFindings.length > 0
            ? data.blockingFindings.map((finding) => `- ${finding}`)
            : ['- none recorded']),
          '',
          'Fix only current-slice issues. If repair cannot continue, submit needsRecovery with the missing evidence or inconsistent artifact.',
        ].join('\n'),
      on: {
        repairComplete: runner.submit<{
          summary: string;
          changedFiles: string[];
        }>({
          route: [
            {
              if: (data) => data.repairSource === 'review',
              to: 'reviewSlice',
              reduce: (draft, payload) => {
                draft.repairSummary = payload.summary;
                draft.changedFiles = appendUnique(draft.changedFiles, payload.changedFiles);
                resetRecovery(draft);
                record(draft, 'repair-slice', 'ok', payload.summary);
              },
            },
            {
              if: (data) => data.repairSource === 'verification',
              to: 'verifySlice',
              reduce: (draft, payload) => {
                draft.repairSummary = payload.summary;
                draft.changedFiles = appendUnique(draft.changedFiles, payload.changedFiles);
                resetRecovery(draft);
                record(draft, 'repair-slice', 'ok', payload.summary);
              },
            },
            {
              to: 'recover',
              reduce: (draft, payload) => {
                requestRecovery(
                  draft,
                  'repair',
                  'Repair completed but no failed gate was recorded',
                  payload.summary,
                  defaultRecoveryGuidance('repair'),
                );
              },
            },
          ],
        }),
        needsRecovery: runner.submit<{
          reason: string;
          evidence: string;
          guidance: string;
        }>({
          to: 'recover',
          reduce: (draft, payload) => {
            requestRecovery(
              draft,
              'repair',
              payload.reason,
              payload.evidence,
              payload.guidance || defaultRecoveryGuidance('repair'),
            );
          },
        }),
      },
    }),
    finishSlice: runner.state({
      main: true,
      prompt: (data) =>
        [
          'Finish the verified slice.',
          currentSliceLine(data),
          currentPlanLine(data),
          `Verification summary: ${data.verificationSummary ?? 'not recorded'}`,
          '',
          'Update the recipe to the next slice or completion state, stage only slice-owned files plus the recipe update, and commit.',
          'Do not stage unrelated dirty files.',
          'A commit cannot contain its own final SHA. If the recipe needs an exact completed SHA, use the repository convention that makes that possible and report the final commit SHA in the submit payload.',
          'If finishing cannot continue, submit needsRecovery with git status and recipe evidence.',
          'Submit nextSlice=null when the recipe is complete.',
        ].join('\n'),
      on: {
        finished: runner.submit<{
          summary: string;
          recipeUpdateSummary: string;
          stagedFiles: string[];
          commitSha: string;
          nextSlice: string | null;
        }>({
          route: [
            {
              if: (data, payload) =>
                hasNextSlice(payload.nextSlice) &&
                data.completedIterations + 1 < data.maxIterations,
              to: 'clearForNextSlice',
              reduce: (draft, payload) => {
                draft.stagedFiles = payload.stagedFiles;
                draft.commitSha = payload.commitSha;
                draft.nextSlice = payload.nextSlice;
                draft.completedIterations += 1;
                resetRecovery(draft);
                record(
                  draft,
                  'finish-slice',
                  'ok',
                  `${payload.summary} Recipe update: ${payload.recipeUpdateSummary}`,
                );
              },
            },
            {
              if: (_data, payload) => hasNextSlice(payload.nextSlice),
              to: 'failed',
              reduce: (draft, payload) => {
                const summary = `Reached maxIterations before ${payload.nextSlice}. Last commit: ${payload.commitSha}`;
                draft.stagedFiles = payload.stagedFiles;
                draft.commitSha = payload.commitSha;
                draft.nextSlice = payload.nextSlice;
                draft.completedIterations += 1;
                draft.failures.push(summary);
                draft.finalSummary = summary;
                record(draft, 'finish-slice', 'failed', summary);
              },
            },
            {
              to: 'complete',
              reduce: (draft, payload) => {
                draft.stagedFiles = payload.stagedFiles;
                draft.commitSha = payload.commitSha;
                draft.nextSlice = null;
                draft.completedIterations += 1;
                draft.finalSummary = payload.summary;
                resetRecovery(draft);
                record(
                  draft,
                  'finish-slice',
                  'done',
                  `${payload.summary} Recipe update: ${payload.recipeUpdateSummary}`,
                );
              },
            },
          ],
        }),
        needsRecovery: runner.submit<{
          reason: string;
          evidence: string;
          guidance: string;
        }>({
          to: 'recover',
          reduce: (draft, payload) => {
            requestRecovery(
              draft,
              'finish',
              payload.reason,
              payload.evidence,
              payload.guidance || defaultRecoveryGuidance('finish'),
            );
          },
        }),
      },
    }),
    clearForNextSlice: runner.state({
      main: true,
      clearOnEntry: true,
      prompt: (data) =>
        [
          'Fresh context checkpoint after a committed slice.',
          `Recipe path: ${data.recipePath}`,
          `Last commit: ${data.commitSha ?? 'not recorded'}`,
          `Expected next slice: ${data.nextSlice ?? 'not recorded'}`,
          '',
          'Re-read the recipe, roadmap, git status, and current detailed plan if present.',
          'Confirm the recipe points at the next slice before continuing.',
          'If the recipe is complete, submit finished. If it is inconsistent with the roadmap or commit, submit needsRecovery.',
        ].join('\n'),
      on: {
        readyToPlan: runner.submit<{
          currentSlice: string;
          currentPlanPath: string | null;
          lastCompleted: string | null;
          sliceSummary: string;
          workspaceSummary: string;
        }>({
          to: 'planSlice',
          reduce: (draft, payload) => {
            draft.currentSlice = payload.currentSlice;
            draft.currentPlanPath = payload.currentPlanPath;
            draft.lastCompleted = payload.lastCompleted;
            draft.sliceSummary = payload.sliceSummary;
            draft.workspaceSummary = payload.workspaceSummary;
            resetSliceRuntime(draft);
            record(draft, 'clear-for-next-slice', 'ok', payload.sliceSummary);
          },
        }),
        finished: runner.submit<{ summary: string }>({
          to: 'complete',
          reduce: (draft, payload) => {
            draft.finalSummary = payload.summary;
            record(draft, 'clear-for-next-slice', 'done', payload.summary);
          },
        }),
        needsRecovery: runner.submit<{
          reason: string;
          evidence: string;
          guidance: string;
        }>({
          to: 'recover',
          reduce: (draft, payload) => {
            requestRecovery(
              draft,
              'clear-next',
              payload.reason,
              payload.evidence,
              payload.guidance || defaultRecoveryGuidance('clear-next'),
            );
          },
        }),
      },
    }),
    recover: runner.embed(
      recovery.machine({
        id: 'autonomous-recovery',
        input: {
          phase: recovery.input.string({ description: 'Parent phase that needs recovery' }),
          reason: recovery.input.string({ description: 'Why the parent phase could not continue' }),
          evidence: recovery.input.string({ description: 'Evidence from the failed phase' }),
          guidance: recovery.input.string({ description: 'Phase-specific recovery guidance' }),
          maxAttempts: recovery.input.number({
            description: 'Maximum autonomous recovery attempts',
            default: 3,
          }),
        },
        data: ({ input }): RecoveryData => ({
          phase: input.phase,
          reason: input.reason,
          evidence: input.evidence,
          guidance: input.guidance,
          attempt: 1,
          maxAttempts: input.maxAttempts,
          summary: null,
          changedFiles: [],
        }),
        initial: 'attemptRecovery',
        states: {
          attemptRecovery: recovery.state({
            prompt: (data) =>
              [
                `Autonomous recovery attempt ${data.attempt} of ${data.maxAttempts}.`,
                `Failed parent phase: ${data.phase}`,
                `Reason: ${data.reason}`,
                `Evidence: ${data.evidence}`,
                '',
                'Recovery guidance:',
                data.guidance,
                '',
                'Work autonomously. Re-read the recipe, roadmap, detailed plan, git status, relevant code, and command output as needed.',
                'Try to remove the blocker without owner input. Prefer documented project workflow over guessing.',
                'Examples: regenerate a missing slice plan, narrow scope to the current slice, isolate unrelated dirty files, repair local compile/test errors, update stale docs, or re-run focused verification.',
                'Submit recovered when the parent phase can be retried. Submit retry if another fresh recovery attempt is needed. Submit exhausted only when the attempt budget is spent or the issue requires external state.',
              ].join('\n'),
            on: {
              recovered: recovery.submit<{
                summary: string;
                changedFiles: string[];
              }>({
                to: 'recovered',
                reduce: (draft, payload) => {
                  draft.summary = payload.summary;
                  draft.changedFiles = appendUnique(draft.changedFiles, payload.changedFiles);
                },
              }),
              retry: recovery.submit<{
                summary: string;
                changedFiles: string[];
              }>({
                route: [
                  {
                    if: (data) => data.attempt < data.maxAttempts,
                    to: 'refreshForRetry',
                    reduce: (draft, payload) => {
                      draft.summary = payload.summary;
                      draft.changedFiles = appendUnique(draft.changedFiles, payload.changedFiles);
                      draft.attempt += 1;
                    },
                  },
                  {
                    to: 'exhausted',
                    reduce: (draft, payload) => {
                      draft.summary = payload.summary;
                      draft.changedFiles = appendUnique(draft.changedFiles, payload.changedFiles);
                    },
                  },
                ],
              }),
              exhausted: recovery.submit<{
                summary: string;
                changedFiles: string[];
              }>({
                to: 'exhausted',
                reduce: (draft, payload) => {
                  draft.summary = payload.summary;
                  draft.changedFiles = appendUnique(draft.changedFiles, payload.changedFiles);
                },
              }),
            },
          }),
          refreshForRetry: recovery.state({
            clearOnEntry: true,
            prompt: (data) =>
              [
                `Fresh context checkpoint before autonomous recovery attempt ${data.attempt} of ${data.maxAttempts}.`,
                `Failed parent phase: ${data.phase}`,
                `Reason: ${data.reason}`,
                `Evidence: ${data.evidence}`,
                '',
                'Recovery guidance:',
                data.guidance,
                '',
                'Re-read the recipe, roadmap, current detailed plan if present, git status, relevant code, and the last recovery summary.',
                `Last recovery summary: ${data.summary ?? 'No prior recovery summary recorded.'}`,
                '',
                'Submit continueAttempt with proceed=true when ready to retry. Submit proceed=false only if the evidence proves recovery cannot continue within the attempt budget.',
              ].join('\n'),
            on: {
              continueAttempt: recovery.submit<{
                proceed: boolean;
                summary: string;
              }>({
                route: [
                  {
                    if: (_data, payload) => payload.proceed,
                    to: 'attemptRecovery',
                    reduce: (draft, payload) => {
                      draft.summary = payload.summary;
                    },
                  },
                  {
                    to: 'exhausted',
                    reduce: (draft, payload) => {
                      draft.summary = payload.summary;
                    },
                  },
                ],
              }),
            },
          }),
          recovered: recovery.final({
            outcome: 'success',
            output: (data): RecoveryOutput => ({
              phase: data.phase,
              attempts: data.attempt,
              summary: data.summary ?? 'Recovery completed.',
              changedFiles: data.changedFiles,
            }),
          }),
          exhausted: recovery.final({
            outcome: 'failure',
            output: (data): RecoveryOutput => ({
              phase: data.phase,
              attempts: data.attempt,
              summary: data.summary ?? 'Recovery exhausted without a recorded summary.',
              changedFiles: data.changedFiles,
            }),
          }),
        },
      }),
      {
        input: (data) => ({
          phase: data.recoveryPhase ?? 'orient',
          reason: data.recoveryReason ?? 'No recovery reason recorded.',
          evidence: data.recoveryEvidence ?? 'No recovery evidence recorded.',
          guidance:
            data.recoveryGuidance ?? defaultRecoveryGuidance(data.recoveryPhase ?? 'orient'),
          maxAttempts: data.maxRecoveryAttempts,
        }),
        on: {
          recovered: {
            to: 'resumeAfterRecovery',
            reduce: (draft, output) => {
              draft.changedFiles = appendUnique(draft.changedFiles, output.changedFiles);
              record(
                draft,
                `recover-${output.phase}`,
                'recovered',
                `${output.summary} Attempts: ${output.attempts}`,
              );
            },
          },
          exhausted: {
            to: 'failed',
            reduce: (draft, output) => {
              const summary = `Recovery exhausted for ${output.phase}: ${output.summary}`;
              draft.changedFiles = appendUnique(draft.changedFiles, output.changedFiles);
              draft.failures.push(summary);
              draft.finalSummary = summary;
              record(draft, `recover-${output.phase}`, 'failed', summary);
            },
          },
        },
      },
    ),
    resumeAfterRecovery: runner.passive({
      always: [
        {
          guard: ({ context }: { context: Data }) => context.recoveryPhase === 'plan',
          target: 'planSlice',
        },
        {
          guard: ({ context }: { context: Data }) => context.recoveryPhase === 'execute',
          target: 'executeSlice',
        },
        {
          guard: ({ context }: { context: Data }) => context.recoveryPhase === 'review',
          target: 'reviewSlice',
        },
        {
          guard: ({ context }: { context: Data }) => context.recoveryPhase === 'verify',
          target: 'verifySlice',
        },
        {
          guard: ({ context }: { context: Data }) => context.recoveryPhase === 'repair',
          target: 'repairSlice',
        },
        {
          guard: ({ context }: { context: Data }) => context.recoveryPhase === 'finish',
          target: 'finishSlice',
        },
        {
          guard: ({ context }: { context: Data }) => context.recoveryPhase === 'clear-next',
          target: 'clearForNextSlice',
        },
        { target: 'orientSlice' },
      ],
    }),
    complete: runner.final({
      main: true,
      outcome: 'success',
      output: runnerOutput,
      artifacts: {
        'superpowers-recipe-runner-report.md': renderReport,
      },
    }),
    failed: runner.final({
      outcome: 'failure',
      artifacts: {
        'superpowers-recipe-runner-report.md': renderReport,
      },
    }),
  },
});
