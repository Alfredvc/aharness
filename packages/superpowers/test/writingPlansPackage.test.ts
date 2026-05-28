import * as path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';
import { createActor } from '../../core/node_modules/xstate/dist/xstate.cjs.mjs';

import { verifyFsmPackage } from '../../core/src/fsmPackage/verify.js';
import { runPackagedFsmCliForTest } from '../../core/src/fsmPackage/runner.js';
import { loadFsm } from '../../core/src/loader/index.js';
import brainstormingMachine from '../fsms/brainstorming.fsm.js';
import writingPlansMachine from '../fsms/writing-plans.fsm.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

function captureStream(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, cb) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

async function runPackageCommand(
  argv: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = captureStream();
  const stderr = captureStream();
  const rootUrl = pathToFileURL(packageRoot.endsWith(path.sep) ? packageRoot : `${packageRoot}/`);
  const exitCode = await runPackagedFsmCliForTest({
    packageRootUrl: rootUrl,
    argv,
    cwd: packageRoot,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

function startWritingPlansActor() {
  const actor = createActor(writingPlansMachine, {
    input: {
      specPath: 'docs/specs/superpowers.md',
      planPath: 'docs/plans/superpowers-slice.md',
    },
  });
  actor.start();
  return actor;
}

function startBrainstormingActor() {
  const actor = createActor(brainstormingMachine, {
    input: {
      topic: 'Improve package workflows',
      specPath: 'docs/specs/package-workflows-design.md',
    },
  });
  actor.start();
  return actor;
}

function submit(
  actor: ReturnType<typeof startWritingPlansActor>,
  state: string,
  exit: string,
  payload: object,
) {
  actor.send({ type: `SUBMIT__${state}__${exit}`, payload });
}

function submitBrainstorming(
  actor: ReturnType<typeof startBrainstormingActor>,
  state: string,
  exit: string,
  payload: object,
) {
  actor.send({ type: `SUBMIT__${state}__${exit}`, payload });
}

function successOutput(context: unknown): unknown {
  const readyState = writingPlansMachine.root.states['readyForExecution'];
  const output = readyState?.meta?.aharness?.output as
    | ((args: { context: unknown }) => unknown)
    | undefined;
  return output?.({ context });
}

function brainstormingSuccessOutput(context: unknown): unknown {
  const approvedState = brainstormingMachine.root.states['approved'];
  const output = approvedState?.meta?.aharness?.output as
    | ((args: { context: unknown }) => unknown)
    | undefined;
  return output?.({ context });
}

function stateSkillRefs(machine: unknown, stateId: string): readonly unknown[] {
  const config = (machine as { config?: { states?: Record<string, unknown> } }).config;
  const state = config?.states?.[stateId] as
    | { meta?: { aharness?: { skills?: readonly unknown[] } } }
    | undefined;
  return state?.meta?.aharness?.skills ?? [];
}

describe('@aharness/superpowers package', () => {
  it('verifies the package with visible FSM commands', async () => {
    const result = await verifyFsmPackage({ packageRoot });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verifiedFsmCount).toBe(2);
      expect(result.value.config.packageName).toBe('@aharness/superpowers');
      expect(result.value.config.binName).toBe('ah-superpowers');
    }
  });

  it('lists package commands and prints command input help', async () => {
    const list = await runPackageCommand(['list']);

    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain('brainstorming');
    expect(list.stdout).toContain('Explore an idea into an approved design spec.');
    expect(list.stdout).toContain('writing-plans');
    expect(list.stdout).toContain('Write and review an implementation plan before execution.');

    const brainstormingHelp = await runPackageCommand(['help', 'brainstorming']);

    expect(brainstormingHelp.exitCode).toBe(0);
    expect(brainstormingHelp.stdout).toContain('usage:\n  ah-superpowers brainstorming');
    expect(brainstormingHelp.stdout).toContain('--spec-path <string>');
    expect(brainstormingHelp.stdout).toContain('--topic <string>');

    const help = await runPackageCommand(['help', 'writing-plans']);

    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('usage:\n  ah-superpowers writing-plans');
    expect(help.stdout).toContain('--plan-path <string>');
    expect(help.stdout).toContain('--spec-path <string>');
  });

  it('resolves bundled state guides by package-relative path', async () => {
    const brainstorming = await loadFsm({
      filePath: path.join(packageRoot, 'fsms', 'brainstorming.fsm.ts'),
      repoRoot: packageRoot,
      noCache: true,
    });
    const designConversationGuides = stateSkillRefs(brainstorming.machine, 'designConversation');
    const writeAndReviewSpecGuides = stateSkillRefs(brainstorming.machine, 'writeAndReviewSpec');

    expect(designConversationGuides).toContainEqual(
      expect.objectContaining({
        path: '../skills/superpowers/brainstorming/guides/design-conversation.md',
      }),
    );
    expect(writeAndReviewSpecGuides).toContainEqual(
      expect.objectContaining({
        path: '../skills/superpowers/brainstorming/guides/write-and-review-spec.md',
      }),
    );

    const writingPlans = await loadFsm({
      filePath: path.join(packageRoot, 'fsms', 'writing-plans.fsm.ts'),
      repoRoot: packageRoot,
      noCache: true,
    });
    const planAuthoringGuides = stateSkillRefs(writingPlans.machine, 'planAuthoring');
    const planQualityGateGuides = stateSkillRefs(writingPlans.machine, 'planQualityGate');

    expect(planAuthoringGuides).toContainEqual(
      expect.objectContaining({
        path: '../skills/superpowers/writing-plans/guides/plan-authoring.md',
      }),
    );
    expect(planQualityGateGuides).toContainEqual(
      expect.objectContaining({
        path: '../skills/superpowers/writing-plans/guides/plan-quality-review.md',
      }),
    );
  });
});

describe('brainstorming route gates', () => {
  it('loops from design rejection back to designConversation', () => {
    const actor = startBrainstormingActor();

    submitBrainstorming(actor, 'designConversation', 'designReview', {
      approved: false,
      designSummary: 'proposed package brainstorming command',
      ownerFeedback: 'needs clearer spec review boundary',
    });

    expect(actor.getSnapshot().value).toBe('designConversation');
    expect(actor.getSnapshot().context).toMatchObject({
      designSummary: 'proposed package brainstorming command',
    });
  });

  it('routes design approval to spec writing and review', () => {
    const actor = startBrainstormingActor();

    submitBrainstorming(actor, 'designConversation', 'designReview', {
      approved: true,
      designSummary: 'approved package brainstorming command',
      ownerFeedback: 'design approved',
    });

    expect(actor.getSnapshot().value).toBe('writeAndReviewSpec');
    expect(actor.getSnapshot().context).toMatchObject({
      designSummary: 'approved package brainstorming command',
    });
  });

  it('loops from requested spec changes back to spec writing and review', () => {
    const actor = startBrainstormingActor();

    submitBrainstorming(actor, 'designConversation', 'designReview', {
      approved: true,
      designSummary: 'approved package brainstorming command',
      ownerFeedback: 'design approved',
    });
    submitBrainstorming(actor, 'writeAndReviewSpec', 'specReview', {
      approved: false,
      specPath: 'docs/specs/package-workflows-design.md',
      summary: 'self-review found unclear approval wording',
      requiredChanges: ['clarify owner spec gate'],
    });

    expect(actor.getSnapshot().value).toBe('writeAndReviewSpec');
    expect(actor.getSnapshot().context).toMatchObject({
      specPath: 'docs/specs/package-workflows-design.md',
      specReviewSummary: 'self-review found unclear approval wording',
    });
  });

  it('loops from owner requested spec changes back to spec writing and review', () => {
    const actor = startBrainstormingActor();

    submitBrainstorming(actor, 'designConversation', 'designReview', {
      approved: true,
      designSummary: 'approved package brainstorming command',
      ownerFeedback: 'design approved',
    });
    submitBrainstorming(actor, 'writeAndReviewSpec', 'specReview', {
      approved: true,
      specPath: 'docs/specs/package-workflows-design.md',
      summary: 'spec is internally consistent',
      requiredChanges: [],
    });
    submitBrainstorming(actor, 'ownerSpecApprovalGate', 'review', {
      approved: false,
      summary: 'owner wants clearer failure handling',
      requestedChanges: ['add blocked-state expectations'],
    });

    expect(actor.getSnapshot().value).toBe('writeAndReviewSpec');
    expect(actor.getSnapshot().context).toMatchObject({
      specPath: 'docs/specs/package-workflows-design.md',
    });
  });

  it('routes owner spec approval to success with specPath output', () => {
    const actor = startBrainstormingActor();

    submitBrainstorming(actor, 'designConversation', 'designReview', {
      approved: true,
      designSummary: 'approved package brainstorming command',
      ownerFeedback: 'design approved',
    });
    submitBrainstorming(actor, 'writeAndReviewSpec', 'specReview', {
      approved: true,
      specPath: 'docs/specs/package-workflows-design.md',
      summary: 'spec is internally consistent',
      requiredChanges: [],
    });
    submitBrainstorming(actor, 'ownerSpecApprovalGate', 'review', {
      approved: true,
      summary: 'owner approved the written spec',
      requestedChanges: [],
    });

    expect(actor.getSnapshot().value).toBe('approved');
    expect(actor.getSnapshot().status).toBe('done');
    expect(actor.getSnapshot().context).toMatchObject({
      specPath: 'docs/specs/package-workflows-design.md',
    });
    expect(brainstormingSuccessOutput(actor.getSnapshot().context)).toEqual({
      specPath: 'docs/specs/package-workflows-design.md',
    });
  });
});

describe('writing-plans route gates', () => {
  it('loops from plan quality rejection back to planAuthoring', () => {
    const actor = startWritingPlansActor();

    submit(actor, 'planAuthoring', 'planReady', {
      planPath: 'docs/plans/superpowers-slice.md',
      summary: 'drafted plan',
      qualityNotes: 'self-reviewed',
    });
    submit(actor, 'planQualityGate', 'review', {
      approved: false,
      summary: 'missing verification details',
      requiredChanges: ['add package verify command'],
    });

    expect(actor.getSnapshot().value).toBe('planAuthoring');
    expect(actor.getSnapshot().context).toMatchObject({
      planPath: 'docs/plans/superpowers-slice.md',
    });
  });

  it('loops from owner plan rejection back to planAuthoring', () => {
    const actor = startWritingPlansActor();

    submit(actor, 'planAuthoring', 'planReady', {
      planPath: 'docs/plans/superpowers-slice.md',
      summary: 'drafted plan',
      qualityNotes: 'self-reviewed',
    });
    submit(actor, 'planQualityGate', 'review', {
      approved: true,
      summary: 'structurally sound',
      requiredChanges: [],
    });
    submit(actor, 'ownerPlanReview', 'review', {
      approved: false,
      summary: 'owner wants narrower scope',
      requestedChanges: ['split tests from package shell'],
    });

    expect(actor.getSnapshot().value).toBe('planAuthoring');
    expect(actor.getSnapshot().context).toMatchObject({
      planPath: 'docs/plans/superpowers-slice.md',
    });
  });

  it('routes broad-spec owner continuation back to planAuthoring', () => {
    const actor = startWritingPlansActor();

    submit(actor, 'planAuthoring', 'broadSpec', {
      reason: 'spec covers all commands',
      suggestedNarrowing: 'plan only Slice 0',
    });
    submit(actor, 'broadSpecOwnerDecision', 'decide', {
      continuePlanning: true,
      ownerDecisionSummary: 'continue with Slice 0 only',
      narrowingInstructions: 'limit to package foundation and writing-plans',
    });

    expect(actor.getSnapshot().value).toBe('planAuthoring');
    expect(actor.getSnapshot().context).toMatchObject({
      authoringSummary: 'Owner narrowed scope: limit to package foundation and writing-plans',
    });
  });

  it('routes broad-spec owner stop to failure', () => {
    const actor = startWritingPlansActor();

    submit(actor, 'planAuthoring', 'broadSpec', {
      reason: 'spec covers all commands',
      suggestedNarrowing: 'write a roadmap first',
    });
    submit(actor, 'broadSpecOwnerDecision', 'decide', {
      continuePlanning: false,
      ownerDecisionSummary: 'stop and split upstream',
      narrowingInstructions: '',
    });

    expect(actor.getSnapshot().value).toBe('stoppedForBroadSpec');
    expect(actor.getSnapshot().status).toBe('done');
  });

  it('chooses execution mode and exposes final planPath plus executionMode output', () => {
    const actor = startWritingPlansActor();

    submit(actor, 'planAuthoring', 'planReady', {
      planPath: 'docs/plans/superpowers-slice.md',
      summary: 'drafted plan',
      qualityNotes: 'self-reviewed',
    });
    submit(actor, 'planQualityGate', 'review', {
      approved: true,
      summary: 'structurally sound',
      requiredChanges: [],
    });
    submit(actor, 'ownerPlanReview', 'review', {
      approved: true,
      summary: 'owner approved',
      requestedChanges: [],
    });
    submit(actor, 'chooseExecutionMode', 'choose', {
      executionMode: 'inline',
      reason: 'execute in the current session',
    });

    expect(actor.getSnapshot().value).toBe('readyForExecution');
    expect(actor.getSnapshot().context).toMatchObject({
      planPath: 'docs/plans/superpowers-slice.md',
      executionMode: 'inline',
    });
    expect(successOutput(actor.getSnapshot().context)).toEqual({
      planPath: 'docs/plans/superpowers-slice.md',
      executionMode: 'inline',
    });
  });
});
