import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { createActor } from '../../core/node_modules/xstate/dist/xstate.cjs.mjs';

import { readInstallPackageManifest } from '../../core/src/installPackage/index.js';
import { loadFsm, loadInstalledFsm } from '../../core/src/loader/index.js';
import { verify } from '../../core/src/verify/index.js';
import brainstormingMachine from '../fsms/brainstorming.fsm.js';
import writingPlansMachine from '../fsms/writing-plans.fsm.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const CURRENT_CORE_VERSION = '0.1.0';

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
  it('declares explicit install command metadata', async () => {
    const result = await readInstallPackageManifest({
      packageRoot,
      currentCoreVersion: CURRENT_CORE_VERSION,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.packageName).toBe('@aharness/superpowers');
      expect(result.value.coreDependencyRange).toBe('^0.1.0');
      expect(result.value.commands).toEqual([
        expect.objectContaining({
          commandName: 'brainstorming',
          entry: 'fsms/brainstorming.fsm.ts',
          description: 'Explore an idea into an approved design spec.',
        }),
        expect.objectContaining({
          commandName: 'writing-plans',
          entry: 'fsms/writing-plans.fsm.ts',
          description: 'Write and review an implementation plan before execution.',
        }),
      ]);
    }
  });

  it('loads and verifies declared commands from an installed package layout', async () => {
    const installed = await copySuperpowersToManagedProject();
    try {
      const manifest = await readInstallPackageManifest({
        packageRoot: installed.packageRoot,
        currentCoreVersion: CURRENT_CORE_VERSION,
      });
      expect(manifest.ok).toBe(true);
      if (!manifest.ok) return;

      for (const command of manifest.value.commands) {
        const loaded = await loadInstalledFsm({
          entryFile: command.entryPath,
          packageName: manifest.value.packageName,
          commandName: command.commandName,
          packageRoot: installed.packageRoot,
          managedProjectRoot: installed.managedProjectRoot,
          storeRoot: installed.storeRoot,
          lockFingerprint: 'lock:superpowers-test',
          noCache: true,
        });

        const result = verify(loaded.machine, loaded.sidecar, loaded.issues, {
          skillEnv: {
            fsmFileDir: path.dirname(command.entryPath),
            repoRoot: installed.packageRoot,
          },
        });
        expect(result.ok, command.commandName).toBe(true);
      }
    } finally {
      await rm(installed.storeRoot, { recursive: true, force: true });
    }
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

async function copySuperpowersToManagedProject(): Promise<{
  readonly storeRoot: string;
  readonly managedProjectRoot: string;
  readonly packageRoot: string;
}> {
  const storeRoot = await mkdtemp(path.join(os.tmpdir(), 'aharness-superpowers-install-'));
  const managedProjectRoot = path.join(storeRoot, 'packages');
  const installedPackageRoot = path.join(
    managedProjectRoot,
    'node_modules',
    '@aharness',
    'superpowers',
  );
  await mkdir(installedPackageRoot, { recursive: true });
  await cp(path.join(packageRoot, 'package.json'), path.join(installedPackageRoot, 'package.json'));
  await cp(path.join(packageRoot, 'fsms'), path.join(installedPackageRoot, 'fsms'), {
    recursive: true,
  });
  await cp(path.join(packageRoot, 'skills'), path.join(installedPackageRoot, 'skills'), {
    recursive: true,
  });
  return {
    storeRoot,
    managedProjectRoot,
    packageRoot: installedPackageRoot,
  };
}

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
