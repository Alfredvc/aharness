import { createFsm } from '@aharness/core';

type GateStatus = 'ok' | 'changes-requested' | 'failed' | 'done' | 'blocked';
type RepairSource = 'review' | 'verification';
type RecoveryPhase =
  | 'create-recipe'
  | 'plan'
  | 'execute'
  | 'review'
  | 'verify'
  | 'repair'
  | 'finish'
  | 'clear-next';

interface GateRecord {
  readonly sliceNumber: number;
  readonly phase: string;
  readonly status: GateStatus;
  readonly summary: string;
}

interface Data {
  roadmapPath: string;
  worktree: boolean;
  worktreePath: string | null;
  worktreeCreated: boolean;
  requiredContextFiles: string[];
  recipePath: string | null;
  currentSlice: string | null;
  currentPlanPath: string | null;
  lastCompleted: string | null;
  completedSlices: number;
  maxSlices: number;
  maxRecoveryAttempts: number;
  workspaceSummary: string | null;
  sliceSummary: string | null;
  planSummary: string | null;
  executionSummary: string | null;
  reviewSummary: string | null;
  verificationCommands: string[];
  verificationSummary: string | null;
  repairSource: RepairSource | null;
  repairSummary: string | null;
  blockingFindings: string[];
  changedFiles: string[];
  stagedFiles: string[];
  commitSha: string | null;
  nextSlice: string | null;
  finalSummary: string | null;
  blocker: string | null;
  recoveryPhase: RecoveryPhase | null;
  recoveryReason: string | null;
  recoveryEvidence: string | null;
  recoveryGuidance: string | null;
  completedSliceSummaries: string[];
  finalOwnerRequest: string | null;
  history: GateRecord[];
}

interface RecipeOutput {
  roadmapPath: string;
  worktree: boolean;
  worktreePath: string | null;
  requiredContextFiles: string[];
  recipePath: string | null;
  completedSlices: number;
  lastCommitSha: string | null;
  finalOwnerRequest: string | null;
  summary: string;
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

const fsm = createFsm<Data>();
const recovery = createFsm<RecoveryData>();

function worktreeSlug(roadmapPath: string): string {
  const basename = roadmapPath.split('/').pop() ?? 'roadmap';
  const withoutExtension = basename.replace(/\.[^.]*$/, '');
  const slug = withoutExtension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : 'roadmap';
}

function makeWorktreePath(roadmapPath: string): string {
  return `/tmp/aharness-rdd-${worktreeSlug(roadmapPath)}-${Date.now().toString(36)}`;
}

function isTmpWorktreePath(path: string | null): path is string {
  return path !== null && path.startsWith('/tmp/') && path.trim().length > '/tmp/'.length;
}

function worktreeLine(data: Readonly<Data>): string {
  if (!data.worktree) return 'Worktree mode: disabled; use the current checkout.';
  const status = data.worktreeCreated ? 'created' : 'target';
  return `Worktree mode: enabled; ${status} worktree path: ${data.worktreePath ?? 'not recorded'}. Use this worktree for all repository commands and file edits.`;
}

function worktreeCreationLine(data: Readonly<Data>): string {
  if (!data.worktree) return 'Worktree mode is disabled; use the current checkout.';
  return [
    'Worktree mode is enabled.',
    `Create a git worktree under /tmp at: ${data.worktreePath ?? '/tmp/<unique-aharness-worktree>'}`,
    'After creating it, re-read the roadmap and grounding files from inside that worktree and do all recipe, code, documentation, staging, and commit work there.',
    'Do not merge, remove, prune, or otherwise clean up the worktree automatically.',
  ].join('\n');
}

function worktreeReady(data: Readonly<Data>, worktreeCreated: boolean): boolean {
  return !data.worktree || (worktreeCreated && isTmpWorktreePath(data.worktreePath));
}

function currentRecoveryGuidance(data: Readonly<Data>, phase: RecoveryPhase): string {
  return defaultRecoveryGuidance(
    phase,
    data.requiredContextFiles,
    data.worktree,
    data.worktreePath,
  );
}

function hasNextSlice(nextSlice: string | null): nextSlice is string {
  return nextSlice !== null && nextSlice.trim().length > 0;
}

function record(draft: Data, phase: string, status: GateStatus, summary: string): void {
  draft.history.push({
    sliceNumber: draft.completedSlices + 1,
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
  record(draft, `${phase}-phase`, 'blocked', `${reason} Evidence: ${evidence}`);
}

function resetRecovery(draft: Data): void {
  draft.recoveryPhase = null;
  draft.recoveryReason = null;
  draft.recoveryEvidence = null;
  draft.recoveryGuidance = null;
  draft.blocker = null;
}

function resetSliceRuntime(draft: Data): void {
  draft.planSummary = null;
  draft.executionSummary = null;
  draft.reviewSummary = null;
  draft.verificationCommands = [];
  draft.verificationSummary = null;
  draft.repairSource = null;
  draft.repairSummary = null;
  draft.blockingFindings = [];
  draft.changedFiles = [];
  draft.stagedFiles = [];
  draft.nextSlice = null;
  resetRecovery(draft);
}

function contextFilesLine(data: Readonly<Data>): string {
  return data.requiredContextFiles.length > 0
    ? `Required context files: ${data.requiredContextFiles.join(', ')}`
    : 'Required context files: none recorded.';
}

function defaultRecoveryGuidance(
  phase: RecoveryPhase,
  requiredContextFiles: readonly string[] = [],
  worktree = false,
  worktreePath: string | null = null,
): string {
  const contextFiles =
    requiredContextFiles.length > 0
      ? ` Re-read these required context files when relevant: ${requiredContextFiles.join(', ')}.`
      : ' No extra context files are recorded; if recovery suggests missing grounding, re-check the roadmap for referenced idea, spec, architecture, or design files.';
  const worktreeGuidance = worktree
    ? ` Worktree mode is enabled; keep repository commands and file edits in ${worktreePath ?? 'the /tmp worktree'}. If the worktree is missing, recover by creating it under /tmp. Do not merge, remove, prune, or clean it up automatically.`
    : '';
  const shared = `Work autonomously inside the current roadmap and recipe. Re-read the relevant files, git state, and command output.${contextFiles}${worktreeGuidance} Preserve unrelated owner changes. Do not ask the owner to solve routine implementation uncertainty. A failed gate may expose a small repository-local consistency repair outside the current slice; recover it without owner input when the command output identifies the exact files or symbols, the edit is narrowly bounded, it does not revert or overwrite owner changes, and it is required to make the current parent phase retryable. Do not use this allowance for broad unrelated features, cleanup, speculative refactors, dependency or pin decisions, destructive isolation, or reverting dirty work; route those as blockers with the decision needed.`;
  switch (phase) {
    case 'create-recipe':
      return `${shared} Recover by re-reading the roadmap and referenced docs, identifying the first unimplemented slice from repository evidence, and creating or correcting the recipe without implementing roadmap work.`;
    case 'plan':
      return `${shared} Recover by reconciling the roadmap slice with the recipe, checking whether an existing detailed plan is stale, and writing a bounded slice plan with explicit verification commands.`;
    case 'execute':
      return `${shared} Recover by re-reading the detailed plan, isolating the exact implementation blocker, consulting local code/docs, and continuing only the current slice.`;
    case 'review':
      return `${shared} Recover by rebuilding the review basis from the roadmap, recipe, plan, and git diff, then retrying review with concrete findings.`;
    case 'verify':
      return `${shared} Recover by deriving or fixing the verification command setup from the plan, running focused checks, and preserving failures as repair inputs when they are real slice issues or narrowly bounded gate-blocking repository consistency issues.`;
    case 'repair':
      return `${shared} Recover by re-reading the failed review or verification gate, restoring the repair source if missing, and fixing current-slice issues or narrowly bounded gate-blocking repository consistency issues before returning to the failed gate.`;
    case 'finish':
      return `${shared} Recover by re-checking git status, confirming the recipe update, staging only slice-owned files plus the recipe, and committing with the repository convention.`;
    case 'clear-next':
      return `${shared} Recover by re-reading the committed recipe state, roadmap, and last commit, then confirming the next slice before returning to planning.`;
  }
}

function recipeOutput(data: Readonly<Data>): RecipeOutput {
  return {
    roadmapPath: data.roadmapPath,
    worktree: data.worktree,
    worktreePath: data.worktreePath,
    requiredContextFiles: data.requiredContextFiles,
    recipePath: data.recipePath,
    completedSlices: data.completedSlices,
    lastCommitSha: data.commitSha,
    finalOwnerRequest: data.finalOwnerRequest,
    summary: data.finalSummary ?? 'Recipe-driven development completed.',
  };
}

function renderReport(data: Readonly<Data>): string {
  return [
    '# Recipe-Driven Development Result',
    '',
    `Roadmap: \`${data.roadmapPath}\``,
    `Worktree: ${data.worktree ? `enabled at \`${data.worktreePath ?? 'not recorded'}\`` : 'disabled'}`,
    `Recipe: \`${data.recipePath ?? 'not recorded'}\``,
    `Required context files: ${
      data.requiredContextFiles.length > 0 ? data.requiredContextFiles.join(', ') : 'none'
    }`,
    `Completed slices: ${data.completedSlices}`,
    `Last commit: \`${data.commitSha ?? 'none'}\``,
    `Current slice: ${data.currentSlice ?? 'none'}`,
    `Next slice: ${data.nextSlice ?? 'none'}`,
    '',
    '## Summary',
    '',
    data.finalSummary ?? 'No final summary recorded.',
    '',
    '## Final Owner Request',
    '',
    data.finalOwnerRequest ?? 'None recorded.',
    '',
    '## Completed Slice Summaries',
    '',
    ...(data.completedSliceSummaries.length > 0
      ? data.completedSliceSummaries.map((entry) => `- ${entry}`)
      : ['- none']),
    '',
    '## Last Slice Evidence',
    '',
    `Plan: \`${data.currentPlanPath ?? 'none'}\``,
    `Workspace: ${data.workspaceSummary ?? 'not recorded'}`,
    `Plan summary: ${data.planSummary ?? 'not recorded'}`,
    `Implementation: ${data.executionSummary ?? 'not recorded'}`,
    `Review: ${data.reviewSummary ?? 'not recorded'}`,
    `Verification: ${data.verificationSummary ?? 'not recorded'}`,
    `Repair: ${data.repairSummary ?? 'not recorded'}`,
    `Changed files: ${data.changedFiles.length > 0 ? data.changedFiles.join(', ') : 'none'}`,
    `Staged files: ${data.stagedFiles.length > 0 ? data.stagedFiles.join(', ') : 'none'}`,
    `Verification commands: ${
      data.verificationCommands.length > 0 ? data.verificationCommands.join('; ') : 'none'
    }`,
    '',
    '## Blocker',
    '',
    data.blocker ?? 'None recorded.',
    '',
    '## History',
    '',
    ...(data.history.length > 0
      ? data.history.map(
          (entry) =>
            `- Slice ${entry.sliceNumber} / ${entry.phase}: ${entry.status} - ${entry.summary}`,
        )
      : ['- none']),
    '',
  ].join('\n');
}

function currentSliceLine(data: Readonly<Data>): string {
  return data.currentSlice
    ? `Current slice/chunk: ${data.currentSlice}`
    : 'No current slice recorded.';
}

function currentPlanLine(data: Readonly<Data>): string {
  return data.currentPlanPath
    ? `Current detailed plan: ${data.currentPlanPath}`
    : 'No detailed plan recorded yet.';
}

function subagentReviewInstruction(scope: string): string {
  return [
    'Subagent review is required for this step.',
    `Spawn one or more subagents to review ${scope}.`,
    'Resolve or route every blocking subagent finding before advancing.',
  ].join('\n');
}

export const machine = fsm.machine({
  id: 'recipe-driven-development',
  input: {
    roadmapPath: fsm.input.path({
      description: 'Implementation roadmap file to execute fully',
      complete: 'file',
    }),
    maxSlices: fsm.input.number({
      description: 'Safety cap for roadmap slices in one run',
      default: 50,
    }),
    maxRecoveryAttempts: fsm.input.number({
      description: 'Autonomous recovery attempts before terminal failure',
      default: 5,
    }),
    worktree: fsm.input.custom<boolean>({
      description: 'Create and use a temporary git worktree under /tmp',
      default: false,
    }),
  },
  data: ({ input }): Data => ({
    roadmapPath: input.roadmapPath,
    worktree: input.worktree,
    worktreePath: input.worktree ? makeWorktreePath(input.roadmapPath) : null,
    worktreeCreated: false,
    requiredContextFiles: [],
    recipePath: null,
    currentSlice: null,
    currentPlanPath: null,
    lastCompleted: null,
    completedSlices: 0,
    maxSlices: input.maxSlices,
    maxRecoveryAttempts: input.maxRecoveryAttempts,
    workspaceSummary: null,
    sliceSummary: null,
    planSummary: null,
    executionSummary: null,
    reviewSummary: null,
    verificationCommands: [],
    verificationSummary: null,
    repairSource: null,
    repairSummary: null,
    blockingFindings: [],
    changedFiles: [],
    stagedFiles: [],
    commitSha: null,
    nextSlice: null,
    finalSummary: null,
    blocker: null,
    recoveryPhase: null,
    recoveryReason: null,
    recoveryEvidence: null,
    recoveryGuidance: null,
    completedSliceSummaries: [],
    finalOwnerRequest: null,
    history: [],
  }),
  initial: 'createRecipe',
  states: {
    createRecipe: fsm.state({
      main: true,
      prompt: (data) =>
        [
          'Read the implementation roadmap, every grounding file it references, git status, and recent commits.',
          `Roadmap path: ${data.roadmapPath}`,
          worktreeCreationLine(data),
          '',
          subagentReviewInstruction(
            'the roadmap interpretation, required context-file list, recipe contents, current slice selection, and worktree setup if enabled',
          ),
          '',
          'Identify and store every required extra file that future planning, execution, review, or recovery should re-read. Examples include idea files, design specs, architecture docs, requirements docs, parent plans, API contracts, and migration notes.',
          'Create a short implementation recipe file for this roadmap. The recipe must record the roadmap path, current slice/chunk, current detailed plan path if one exists, last completed commit if any, iteration rules, and current handoff notes.',
          'The recipe must also record the required extra context files so a later agent or recovery attempt can reload them.',
          'Set the current slice/chunk to the first unimplemented roadmap slice. Do not implement roadmap work in this state.',
          'When worktree mode is enabled, submit worktreeCreated=true only after the /tmp worktree exists and the recipe work was done there.',
          'If the roadmap is already fully implemented, submit roadmapComplete after writing or updating the recipe to record completion.',
          'If the roadmap cannot be interpreted safely, submit needsRecovery with concrete evidence and any useful recovery guidance.',
        ].join('\n'),
      on: {
        recipeReady: fsm.submit<{
          worktreeCreated: boolean;
          recipePath: string;
          requiredContextFiles: string[];
          currentSlice: string;
          currentPlanPath: string | null;
          lastCompleted: string | null;
          workspaceSummary: string;
          sliceSummary: string;
        }>({
          route: [
            {
              if: (data, payload) => worktreeReady(data, payload.worktreeCreated),
              to: 'planSlice',
              reduce: (draft, payload) => {
                draft.worktreeCreated = draft.worktree ? payload.worktreeCreated : false;
                draft.recipePath = payload.recipePath;
                draft.requiredContextFiles = appendUnique([], payload.requiredContextFiles);
                draft.currentSlice = payload.currentSlice;
                draft.currentPlanPath = payload.currentPlanPath;
                draft.lastCompleted = payload.lastCompleted;
                draft.workspaceSummary = payload.workspaceSummary;
                draft.sliceSummary = payload.sliceSummary;
                resetSliceRuntime(draft);
                record(draft, 'create-recipe', 'ok', payload.sliceSummary);
              },
            },
            {
              to: 'recover',
              reduce: (draft, payload) => {
                requestRecovery(
                  draft,
                  'create-recipe',
                  'Worktree mode was requested but the /tmp worktree was not confirmed',
                  `Expected worktree path: ${draft.worktreePath ?? 'not recorded'}. worktreeCreated=${payload.worktreeCreated}`,
                  currentRecoveryGuidance(draft, 'create-recipe'),
                );
              },
            },
          ],
        }),
        roadmapComplete: fsm.submit<{
          worktreeCreated: boolean;
          recipePath: string;
          requiredContextFiles: string[];
          summary: string;
        }>({
          route: [
            {
              if: (data, payload) => !worktreeReady(data, payload.worktreeCreated),
              to: 'recover',
              reduce: (draft, payload) => {
                requestRecovery(
                  draft,
                  'create-recipe',
                  'Worktree mode was requested but the /tmp worktree was not confirmed',
                  `Expected worktree path: ${draft.worktreePath ?? 'not recorded'}. worktreeCreated=${payload.worktreeCreated}`,
                  currentRecoveryGuidance(draft, 'create-recipe'),
                );
              },
            },
            {
              if: (data) => data.worktree,
              to: 'worktreeHandoff',
              reduce: (draft, payload) => {
                draft.worktreeCreated = payload.worktreeCreated;
                draft.recipePath = payload.recipePath;
                draft.requiredContextFiles = appendUnique([], payload.requiredContextFiles);
                draft.finalSummary = payload.summary;
                resetRecovery(draft);
                record(draft, 'create-recipe', 'done', payload.summary);
              },
            },
            {
              to: 'complete',
              reduce: (draft, payload) => {
                draft.recipePath = payload.recipePath;
                draft.requiredContextFiles = appendUnique([], payload.requiredContextFiles);
                draft.finalSummary = payload.summary;
                resetRecovery(draft);
                record(draft, 'create-recipe', 'done', payload.summary);
              },
            },
          ],
        }),
        needsRecovery: fsm.submit<{
          reason: string;
          evidence: string;
          guidance: string;
        }>({
          to: 'recover',
          reduce: (draft, payload) => {
            requestRecovery(
              draft,
              'create-recipe',
              payload.reason,
              payload.evidence,
              payload.guidance || currentRecoveryGuidance(draft, 'create-recipe'),
            );
          },
        }),
      },
    }),
    planSlice: fsm.state({
      main: true,
      prompt: (data) =>
        [
          'Confirm or write the detailed implementation plan for this slice only.',
          `Roadmap: ${data.roadmapPath}`,
          `Recipe: ${data.recipePath ?? 'not recorded'}`,
          worktreeLine(data),
          contextFilesLine(data),
          currentSliceLine(data),
          currentPlanLine(data),
          '',
          subagentReviewInstruction(
            'the slice plan against the roadmap, recipe, required context, scope boundaries, documentation updates, and verification commands',
          ),
          '',
          'The plan must define scope boundaries, implementation tasks, acceptance checks, verification commands, and required documentation updates.',
          'If the existing plan is stale, update it before continuing. Do not implement in this state.',
          'Submit needsRecovery if the current slice cannot be planned from the roadmap and recipe after inspection.',
        ].join('\n'),
      on: {
        planReady: fsm.submit<{
          planPath: string;
          wroteOrUpdated: boolean;
          summary: string;
          verificationCommands: string[];
        }>({
          to: 'executeSlice',
          reduce: (draft, payload) => {
            draft.currentPlanPath = payload.planPath;
            draft.planSummary = `${payload.wroteOrUpdated ? 'Wrote or updated' : 'Confirmed'} ${
              payload.planPath
            }: ${payload.summary}`;
            draft.verificationCommands = payload.verificationCommands;
            resetRecovery(draft);
            record(draft, 'plan-slice', 'ok', draft.planSummary);
          },
        }),
        needsRecovery: fsm.submit<{
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
              payload.guidance || currentRecoveryGuidance(draft, 'plan'),
            );
          },
        }),
      },
    }),
    executeSlice: fsm.state({
      main: true,
      clearOnEntry: true,
      prompt: (data) =>
        [
          'Fresh context checkpoint after planning.',
          'Re-read the roadmap, recipe, detailed plan, git status, and relevant code. Execute the current slice end to end.',
          `Roadmap: ${data.roadmapPath}`,
          `Recipe: ${data.recipePath ?? 'not recorded'}`,
          worktreeLine(data),
          contextFilesLine(data),
          currentSliceLine(data),
          currentPlanLine(data),
          '',
          subagentReviewInstruction(
            'the implementation diff, tests, documentation updates, and slice-boundary compliance before marking implementation complete',
          ),
          '',
          'Keep work inside the slice boundary. Preserve existing behavior unless the current plan intentionally changes it.',
          'Update relevant documentation in the same slice as behavior changes. Run task-local checks where useful.',
          'Submit implementationComplete only when the slice is ready for review.',
          'Submit needsRecovery only when you have concrete evidence that recovery work is needed before implementation can continue.',
        ].join('\n'),
      on: {
        implementationComplete: fsm.submit<{
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
        needsRecovery: fsm.submit<{
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
              payload.guidance || currentRecoveryGuidance(draft, 'execute'),
            );
          },
        }),
      },
    }),
    reviewSlice: fsm.state({
      main: true,
      prompt: (data) =>
        [
          'Review the completed slice diff against the roadmap, recipe, and detailed plan.',
          worktreeLine(data),
          contextFilesLine(data),
          currentSliceLine(data),
          currentPlanLine(data),
          '',
          subagentReviewInstruction(
            'the completed slice diff independently; use focused reviewer subagents for plan/spec compliance and code quality when both apply',
          ),
          '',
          'Prioritize correctness, behavior regressions, missing tests, documentation drift, and scope leaks.',
          'Critical or Important findings are blocking. Submit approved=true only when no blocking findings remain.',
          'Submit needsRecovery only if the review basis itself is missing or inconsistent and must be reconstructed.',
        ].join('\n'),
      on: {
        reviewComplete: fsm.submit<{
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
                draft.reviewSummary = `${payload.summary} Non-blocking findings: ${payload.nonBlockingFindings.join(
                  '; ',
                )}`;
                draft.blockingFindings = [];
                draft.repairSource = null;
                resetRecovery(draft);
                record(draft, 'review-slice', 'ok', payload.summary);
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
        needsRecovery: fsm.submit<{
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
              payload.guidance || currentRecoveryGuidance(draft, 'review'),
            );
          },
        }),
      },
    }),
    verifySlice: fsm.state({
      main: true,
      prompt: (data) =>
        [
          'Run final verification for the current slice.',
          worktreeLine(data),
          contextFilesLine(data),
          currentSliceLine(data),
          currentPlanLine(data),
          '',
          'Verification commands from the plan:',
          ...(data.verificationCommands.length > 0
            ? data.verificationCommands.map((command) => `- ${command}`)
            : ['- none recorded; derive the required commands from the plan before submitting']),
          '',
          subagentReviewInstruction(
            'the verification command selection and command results, including whether additional required checks are missing',
          ),
          '',
          'Submit passed=true only when every required verification command completed successfully.',
          'Submit needsRecovery only if verification cannot be run or interpreted after inspecting the plan and command output.',
        ].join('\n'),
      on: {
        verified: fsm.submit<{
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
                draft.blockingFindings = [];
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
        needsRecovery: fsm.submit<{
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
              payload.guidance || currentRecoveryGuidance(draft, 'verify'),
            );
          },
        }),
      },
    }),
    repairSlice: fsm.state({
      prompt: (data) =>
        [
          'Repair the current slice based on the last failed gate.',
          worktreeLine(data),
          contextFilesLine(data),
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
          subagentReviewInstruction(
            'the repair diff against the failed review or verification gate before returning to that gate',
          ),
          '',
          'Fix only current-slice issues. Preserve the failed gate: review repairs return to review, verification repairs return to verification.',
          'Submit needsRecovery only if the failed gate context is missing or contradictory.',
        ].join('\n'),
      on: {
        repairComplete: fsm.submit<{
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
                  currentRecoveryGuidance(draft, 'repair'),
                );
              },
            },
          ],
        }),
        needsRecovery: fsm.submit<{
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
              payload.guidance || currentRecoveryGuidance(draft, 'repair'),
            );
          },
        }),
      },
    }),
    finishSlice: fsm.state({
      main: true,
      prompt: (data) =>
        [
          'Finish the verified slice.',
          currentSliceLine(data),
          currentPlanLine(data),
          contextFilesLine(data),
          worktreeLine(data),
          `Recipe: ${data.recipePath ?? 'not recorded'}`,
          `Verification summary: ${data.verificationSummary ?? 'not recorded'}`,
          '',
          subagentReviewInstruction(
            'the recipe update, staged files, git status, and commit readiness before committing or declaring the roadmap complete',
          ),
          '',
          'Update the recipe to the next slice/chunk or completion state.',
          'Stage only slice-owned files plus the recipe update, then commit.',
          'Do not stage unrelated dirty files. Do not add Co-Authored-By tags.',
          'When worktree mode is enabled, do not merge, remove, prune, or clean up the worktree after committing.',
          'Submit nextSlice with the next unimplemented roadmap slice. Submit nextSlice=null only when the whole roadmap is complete after this commit.',
          'Submit needsRecovery only if recipe update, staging, or commit state cannot be reconciled after checking git status and roadmap state.',
        ].join('\n'),
      on: {
        finished: fsm.submit<{
          summary: string;
          recipeUpdateSummary: string;
          stagedFiles: string[];
          commitSha: string;
          nextSlice: string | null;
        }>({
          route: [
            {
              if: (data, payload) =>
                hasNextSlice(payload.nextSlice) && data.completedSlices + 1 < data.maxSlices,
              to: 'clearForNextSlice',
              reduce: (draft, payload) => {
                const completedSummary = `${draft.currentSlice ?? 'Current slice'}: ${
                  payload.summary
                }`;
                draft.stagedFiles = payload.stagedFiles;
                draft.commitSha = payload.commitSha;
                draft.nextSlice = payload.nextSlice;
                draft.completedSlices += 1;
                draft.lastCompleted = payload.commitSha;
                draft.completedSliceSummaries.push(completedSummary);
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
                const summary = `Reached maxSlices before ${payload.nextSlice}. Last commit: ${payload.commitSha}`;
                draft.stagedFiles = payload.stagedFiles;
                draft.commitSha = payload.commitSha;
                draft.nextSlice = payload.nextSlice;
                draft.completedSlices += 1;
                draft.lastCompleted = payload.commitSha;
                draft.blocker = summary;
                draft.finalSummary = summary;
                record(draft, 'finish-slice', 'blocked', summary);
              },
            },
            {
              if: (data) => data.worktree,
              to: 'worktreeHandoff',
              reduce: (draft, payload) => {
                const completedSummary = `${draft.currentSlice ?? 'Current slice'}: ${
                  payload.summary
                }`;
                draft.stagedFiles = payload.stagedFiles;
                draft.commitSha = payload.commitSha;
                draft.nextSlice = null;
                draft.completedSlices += 1;
                draft.lastCompleted = payload.commitSha;
                draft.completedSliceSummaries.push(completedSummary);
                draft.finalSummary = `${payload.summary} Recipe update: ${payload.recipeUpdateSummary}`;
                resetRecovery(draft);
                record(draft, 'finish-slice', 'done', draft.finalSummary);
              },
            },
            {
              to: 'complete',
              reduce: (draft, payload) => {
                const completedSummary = `${draft.currentSlice ?? 'Current slice'}: ${
                  payload.summary
                }`;
                draft.stagedFiles = payload.stagedFiles;
                draft.commitSha = payload.commitSha;
                draft.nextSlice = null;
                draft.completedSlices += 1;
                draft.lastCompleted = payload.commitSha;
                draft.completedSliceSummaries.push(completedSummary);
                draft.finalSummary = `${payload.summary} Recipe update: ${payload.recipeUpdateSummary}`;
                resetRecovery(draft);
                record(draft, 'finish-slice', 'done', draft.finalSummary);
              },
            },
          ],
        }),
        needsRecovery: fsm.submit<{
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
              payload.guidance || currentRecoveryGuidance(draft, 'finish'),
            );
          },
        }),
      },
    }),
    clearForNextSlice: fsm.state({
      main: true,
      clearOnEntry: true,
      prompt: (data) =>
        [
          'Fresh context checkpoint after a committed slice.',
          `Roadmap path: ${data.roadmapPath}`,
          `Recipe path: ${data.recipePath ?? 'not recorded'}`,
          worktreeLine(data),
          contextFilesLine(data),
          `Last commit: ${data.commitSha ?? 'not recorded'}`,
          `Expected next slice: ${data.nextSlice ?? 'not recorded'}`,
          '',
          subagentReviewInstruction(
            'the committed recipe state, roadmap progress, and expected next slice before planning continues or completion is declared',
          ),
          '',
          'Re-read the roadmap, recipe, git status, and current detailed plan if present.',
          'Confirm the recipe points at the expected next slice before continuing.',
          'If the recipe is complete, submit recipeComplete. If it is inconsistent with the roadmap or commit, submit needsRecovery.',
        ].join('\n'),
      on: {
        readyToPlan: fsm.submit<{
          currentSlice: string;
          currentPlanPath: string | null;
          workspaceSummary: string;
          sliceSummary: string;
        }>({
          to: 'planSlice',
          reduce: (draft, payload) => {
            draft.currentSlice = payload.currentSlice;
            draft.currentPlanPath = payload.currentPlanPath;
            draft.workspaceSummary = payload.workspaceSummary;
            draft.sliceSummary = payload.sliceSummary;
            resetSliceRuntime(draft);
            record(draft, 'clear-for-next-slice', 'ok', payload.sliceSummary);
          },
        }),
        recipeComplete: fsm.submit<{
          summary: string;
        }>({
          route: [
            {
              if: (data) => data.worktree,
              to: 'worktreeHandoff',
              reduce: (draft, payload) => {
                draft.finalSummary = payload.summary;
                resetRecovery(draft);
                record(draft, 'clear-for-next-slice', 'done', payload.summary);
              },
            },
            {
              to: 'complete',
              reduce: (draft, payload) => {
                draft.finalSummary = payload.summary;
                resetRecovery(draft);
                record(draft, 'clear-for-next-slice', 'done', payload.summary);
              },
            },
          ],
        }),
        needsRecovery: fsm.submit<{
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
              payload.guidance || currentRecoveryGuidance(draft, 'clear-next'),
            );
          },
        }),
      },
    }),
    worktreeHandoff: fsm.state({
      mode: 'open',
      main: true,
      prompt: (data) =>
        [
          'The roadmap run is complete in worktree mode.',
          worktreeLine(data),
          `Roadmap: ${data.roadmapPath}`,
          `Recipe: ${data.recipePath ?? 'not recorded'}`,
          `Last commit: ${data.commitSha ?? 'none'}`,
          '',
          'Do not merge branches, remove the worktree, prune worktrees, delete temporary files, or perform cleanup in this state.',
          'Ask the owner what they want to do next, such as merge, cleanup, continue inspection, or leave the worktree as-is.',
        ].join('\n'),
      on: {
        ownerDecision: fsm.await({
          ask: (data) =>
            [
              'Worktree run complete.',
              `Worktree: ${data.worktreePath ?? 'not recorded'}`,
              `Last commit: ${data.commitSha ?? 'none'}`,
              'What do you want to do next: merge, cleanup, inspect further, leave it as-is, or something else?',
            ].join('\n'),
          to: 'complete',
          reduce: (draft, ownerReply) => {
            draft.finalOwnerRequest =
              ownerReply.trim().length > 0 ? ownerReply : 'No owner instruction recorded.';
            record(draft, 'worktree-handoff', 'done', draft.finalOwnerRequest);
          },
        }),
      },
    }),
    recover: fsm.embed(
      recovery.machine({
        id: 'recipe-driven-development-recovery',
        input: {
          phase: recovery.input.string({ description: 'Parent phase that needs recovery' }),
          reason: recovery.input.string({ description: 'Why the parent phase could not continue' }),
          evidence: recovery.input.string({ description: 'Evidence from the failed phase' }),
          guidance: recovery.input.string({ description: 'Phase-specific recovery guidance' }),
          maxAttempts: recovery.input.number({
            description: 'Maximum autonomous recovery attempts',
            default: 5,
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
            clearOnEntry: true,
            prompt: (data) =>
              [
                `Autonomous recovery attempt ${data.attempt} of ${data.maxAttempts}.`,
                `Failed parent phase: ${data.phase}`,
                `Reason: ${data.reason}`,
                `Evidence: ${data.evidence}`,
                '',
                'Phase-specific recovery guidance:',
                data.guidance,
                '',
                subagentReviewInstruction(
                  'the recovery diagnosis, proposed correction, changed files, and whether the parent phase can be retried safely',
                ),
                '',
                'Recover the workflow rather than stopping. Re-read the roadmap, recipe, current detailed plan if present, git status, relevant code, and command output.',
                'Prefer documented local workflow and project evidence over guessing. Default to current-slice boundaries, but do not treat outside-slice ownership as an automatic stop when the active gate is blocked by a small repository-local consistency failure.',
                'You may repair a gate-blocking consistency failure without owner input when command output identifies the exact files or symbols, the edit is narrowly bounded, it preserves unrelated owner changes, and it is necessary for the parent phase to retry.',
                'Do not use that allowance for broad unrelated features, cleanup, speculative refactors, dependency or pin decisions, destructive isolation, or reverting dirty work. Route those as exhausted with the concrete decision needed.',
                'Submit recovered when the parent phase can be retried. Submit retry only when another fresh recovery attempt can make new progress. Submit exhausted only when the attempt budget is spent or the blocker requires external state outside the repository.',
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
                    to: 'attemptRecovery',
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
          phase: data.recoveryPhase ?? 'create-recipe',
          reason: data.recoveryReason ?? 'No recovery reason recorded.',
          evidence: data.recoveryEvidence ?? 'No recovery evidence recorded.',
          guidance:
            data.recoveryGuidance ??
            currentRecoveryGuidance(data, data.recoveryPhase ?? 'create-recipe'),
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
                'ok',
                `${output.summary} Attempts: ${output.attempts}`,
              );
            },
          },
          exhausted: {
            to: 'failed',
            reduce: (draft, output) => {
              const summary = `Recovery exhausted for ${output.phase}: ${output.summary}`;
              draft.changedFiles = appendUnique(draft.changedFiles, output.changedFiles);
              draft.blocker = summary;
              draft.finalSummary = summary;
              record(draft, `recover-${output.phase}`, 'failed', summary);
            },
          },
        },
      },
    ),
    resumeAfterRecovery: fsm.passive({
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
        { target: 'createRecipe' },
      ],
    }),
    complete: fsm.final({
      main: true,
      outcome: 'success',
      output: recipeOutput,
      artifacts: {
        'recipe-driven-development-result.md': renderReport,
      },
    }),
    failed: fsm.final({
      outcome: 'failure',
      artifacts: {
        'recipe-driven-development-result.md': renderReport,
      },
    }),
  },
});

export default machine;
