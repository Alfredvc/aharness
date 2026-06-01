import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFsm, exit, aharness, skill, state } from '../src/index.js';
import { loadFsm } from '../src/loader/index.js';
import { extractUiTopology } from '../src/ui/topology.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const adventurePath = path.resolve(repoRoot, 'examples/adventure.fsm.ts');
const composedPipelinePath = path.resolve(repoRoot, 'examples/composed-pipeline.fsm.ts');

describe('extractUiTopology', () => {
  it('exposes visualization main-state markers from canonical FSM states and finals', () => {
    const fsm = createFsm<Record<string, never>>();
    const machine = fsm.machine({
      id: 'marked-main',
      initial: 'start',
      states: {
        start: fsm.state({
          main: true,
          prompt: 'Start the primary workflow.',
          on: {
            proceed: fsm.submit<Record<string, never>>({ to: 'done' }),
          },
        }),
        done: fsm.final({ outcome: 'success', main: true }),
      },
    });

    const topology = extractUiTopology(machine);

    expect(topology.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'start', kind: 'stateful', main: true }),
        expect.objectContaining({ id: 'done', kind: 'terminal', main: true }),
      ]),
    );
  });

  it('includes inspectable state details for visualize-only UI surfaces', () => {
    function reviewPrompt(ctx: { plan?: string }) {
      return `Review this plan: ${ctx.plan ?? 'missing'}`;
    }

    const machine = aharness.machine({
      id: 'inspectable',
      initial: 'plan',
      states: {
        plan: state({
          entryPrompt: 'Write a careful plan with risks and verification steps.',
          open: true,
          clearOnEntry: true,
          stopGuidance: () => 'Stop once the plan has been submitted.',
          onEntry: () => undefined,
          skills: [skill('reviewer', { optional: true })],
          hooks: {
            preToolUse: [{ matcher: '^Bash$', handler: () => undefined }],
            userPromptSubmit: [{ handler: () => undefined }],
            permissionRequest: [{ matcher: '^apply_patch$', handler: () => 'delegate' }],
          },
          exits: {
            submitPlan: exit<{ plan: string }>({
              to: 'review',
              description: 'Plan is ready for review.',
            }),
            reroute: exit<{ accepted: boolean }>({
              description: 'Route based on reviewer decision.',
              when: [{ guard: () => false, to: 'done' }, { to: 'plan' }],
            }),
          },
        }),
        review: state({
          entryPrompt: reviewPrompt,
          clearOnEntry: { cwd: '/tmp/review' },
          exits: {
            approve: exit<{ ok: boolean }>({ to: 'done' }),
          },
        }),
        done: {
          type: 'final',
          meta: {
            aharness: {
              kind: 'terminal',
              outcome: 'success',
              artifacts: {
                'report.md': () => '# Report\n',
              },
            },
          },
        },
      },
    });

    const topology = extractUiTopology(machine);
    const plan = topology.nodes.find((node) => node.id === 'plan');
    const review = topology.nodes.find((node) => node.id === 'review');
    const done = topology.nodes.find((node) => node.id === 'done');

    expect(plan).toMatchObject({
      id: 'plan',
      kind: 'stateful',
      detail: {
        entryPrompt: {
          kind: 'static',
          text: 'Write a careful plan with risks and verification steps.',
        },
        open: true,
        clearOnEntry: true,
        hasStopGuidance: true,
        hasOnEntry: true,
        skills: [{ source: 'name', label: 'reviewer', optional: true }],
        hooks: expect.arrayContaining([
          { kind: 'PreToolUse', count: 1, matchers: ['^Bash$'] },
          { kind: 'UserPromptSubmit', count: 1 },
          { kind: 'PermissionRequest', count: 1, matchers: ['^apply_patch$'] },
        ]),
        exits: expect.arrayContaining([
          expect.objectContaining({
            name: 'submitPlan',
            kind: 'submit',
            targets: ['review'],
            description: 'Plan is ready for review.',
          }),
          expect.objectContaining({
            name: 'reroute',
            kind: 'submit',
            targets: ['done', 'plan'],
            branchCount: 2,
            description: 'Route based on reviewer decision.',
          }),
        ]),
      },
    });
    expect(review).toMatchObject({
      detail: {
        entryPrompt: {
          kind: 'dynamic',
          text: reviewPrompt.toString(),
        },
        clearOnEntry: true,
      },
    });
    expect(review?.detail).not.toHaveProperty('cwd');
    expect(done).toMatchObject({
      detail: {
        outcome: 'success',
        artifacts: ['report.md'],
      },
    });
  });

  it('emits choice nodes and one choice edge per authored option label', () => {
    function dynamicQuestion() {
      return 'Choose the next route.';
    }

    const fsm = createFsm<Record<string, never>>();
    const machine = fsm.machine({
      id: 'choice-topology',
      initial: 'pick',
      states: {
        pick: fsm.choice({
          main: true,
          question: dynamicQuestion,
          options: [
            { label: 'Go left', to: 'left' },
            { label: 'Retry / stay?', to: 'pick' },
          ],
        }),
        left: fsm.state({
          prompt: 'Continue after the selected branch.',
          on: {
            finish: fsm.submit<Record<string, never>>({ to: 'done' }),
          },
        }),
        done: fsm.final({ outcome: 'success' }),
      },
    });

    const topology = extractUiTopology(machine);
    const pick = topology.nodes.find((node) => node.id === 'pick');

    expect(pick).toMatchObject({
      id: 'pick',
      kind: 'choice',
      main: true,
      detail: {
        question: {
          kind: 'dynamic',
          text: dynamicQuestion.toString(),
        },
        options: ['Go left', 'Retry / stay?'],
      },
    });
    expect(pick?.detail).not.toHaveProperty('exits');
    expect(pick?.detail).not.toHaveProperty('awaitsOwnerText');
    expect(pick?.detail).not.toHaveProperty('entryPrompt');
    expect(pick?.detail).not.toHaveProperty('open');
    expect(topology.edges).toEqual(
      expect.arrayContaining([
        {
          id: 'pick::choice#0',
          from: 'pick',
          to: 'left',
          exit: 'Go left',
          kind: 'choice',
        },
        {
          id: 'pick::choice#1',
          from: 'pick',
          to: 'pick',
          exit: 'Retry / stay?',
          kind: 'choice',
        },
      ]),
    );
    expect(topology.edges.filter((edge) => edge.from === 'pick')).toHaveLength(2);
  });

  it('connects adventure routes directly to final artifact terminals', async () => {
    const loaded = await loadFsm({ filePath: adventurePath, repoRoot, noCache: true });

    const topology = extractUiTopology(loaded.machine);

    expect(topology.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'victory', kind: 'terminal', outcome: 'success' }),
        expect.objectContaining({ id: 'defeat', kind: 'terminal', outcome: 'failure' }),
      ]),
    );
    expect(topology.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'forestChoice',
          to: 'forestVictory',
          exit: 'Bold',
          kind: 'choice',
        }),
        expect.objectContaining({
          from: 'forestChoice',
          to: 'forestDefeat',
          exit: 'Cautious',
          kind: 'choice',
        }),
        expect.objectContaining({
          from: 'forestVictory',
          to: 'victory',
          exit: 'submit',
          kind: 'submit',
        }),
        expect.objectContaining({
          from: 'forestDefeat',
          to: 'defeat',
          exit: 'submit',
          kind: 'submit',
        }),
        expect.objectContaining({
          from: 'caveChoice',
          to: 'caveVictory',
          exit: 'Cautious',
          kind: 'choice',
        }),
        expect.objectContaining({
          from: 'riverChoice',
          to: 'riverVictory',
          exit: 'Bold',
          kind: 'choice',
        }),
        expect.objectContaining({
          from: 'riverDefeat',
          to: 'defeat',
          exit: 'submit',
          kind: 'submit',
        }),
      ]),
    );
    expect(topology.nodes.map((node) => node.id)).not.toEqual(
      expect.arrayContaining(['writeVictoryArtifact', 'writeDefeatArtifact']),
    );
  });

  it('exposes canonical embed entries without adding entries to non-embed nodes', async () => {
    const loaded = await loadFsm({ filePath: composedPipelinePath, repoRoot, noCache: true });

    const topology = extractUiTopology(loaded.machine);

    expect(topology.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'spec', kind: 'embed', entry: 'spec.compose' }),
        expect.objectContaining({ id: 'spec.compose', parent: 'spec' }),
        expect.objectContaining({ id: 'spec.shipped', parent: 'spec' }),
        expect.objectContaining({ id: 'spec.failed', parent: 'spec' }),
      ]),
    );
    for (const node of topology.nodes.filter((candidate) => candidate.kind !== 'embed')) {
      expect(node).not.toHaveProperty('entry');
    }
  });
});
