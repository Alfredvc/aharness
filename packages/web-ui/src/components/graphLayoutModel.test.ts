import { describe, expect, it } from 'vitest';

import { buildGraphLayoutModel } from './graphLayoutModel.js';
import type { Topology, VizEdge, VizNode } from '../types/topology.js';

const node = (
  id: string,
  kind: VizNode['kind'] = 'stateful',
  extra: Partial<VizNode> = {},
): VizNode => ({
  id,
  label: id,
  kind,
  ...extra,
});

const edge = (
  from: string,
  to: string,
  id = `${from}->${to}`,
  extra: Partial<VizEdge> = {},
): VizEdge => ({
  id,
  from,
  to,
  exit: id,
  kind: 'submit',
  ...extra,
});

const topology = (initial: string, nodes: VizNode[], edges: VizEdge[]): Topology => ({
  machineId: 'test',
  initial,
  nodes,
  edges,
});

const rootScope = (model: ReturnType<typeof buildGraphLayoutModel>) =>
  model.scopes.find((scope) => scope.id === 'root')!;

const edgeBySemanticId = (model: ReturnType<typeof buildGraphLayoutModel>, semanticId: string) => {
  const found = model.layoutEdges.find((candidate) => candidate.semanticId === semanticId);
  if (!found) throw new Error(`Missing layout edge ${semanticId}`);
  return found;
};

const selfLoopBySemanticId = (
  model: ReturnType<typeof buildGraphLayoutModel>,
  semanticId: string,
) => {
  const found = model.selfLoops.find((candidate) => candidate.semanticId === semanticId);
  if (!found) throw new Error(`Missing self-loop edge ${semanticId}`);
  return found;
};

const recipeRunnerShapedTopology = (): Topology =>
  topology(
    'orientSlice',
    [
      node('orientSlice'),
      node('planSlice'),
      node('executeSlice'),
      node('reviewSlice'),
      node('repairSlice'),
      node('verifySlice'),
      node('finishSlice'),
      node('clearNextSlice'),
      node('recover', 'embed', { entry: 'recover.start' }),
      node('resumeAfterRecovery', 'passive'),
      node('completed', 'terminal', { outcome: 'success' }),
      node('failed', 'terminal', { outcome: 'failure' }),
      node('recover.start', 'stateful', { parent: 'recover' }),
      node('recover.done', 'terminal', { parent: 'recover' }),
    ],
    [
      edge('orientSlice', 'planSlice', 'orient->plan', { exit: 'ready' }),
      edge('planSlice', 'executeSlice', 'plan->execute', { exit: 'planned' }),
      edge('executeSlice', 'reviewSlice', 'execute->review', { exit: 'complete' }),
      edge('reviewSlice', 'verifySlice', 'review->verify', {
        exit: 'approved',
        branchIndex: 0,
        branchTotal: 2,
      }),
      edge('reviewSlice', 'failed', 'review->failed', {
        exit: 'rejected',
        branchIndex: 1,
        branchTotal: 2,
      }),
      edge('verifySlice', 'finishSlice', 'verify->finish', { exit: 'verified' }),
      edge('finishSlice', 'clearNextSlice', 'finish->clear', { exit: 'finished' }),
      edge('clearNextSlice', 'completed', 'clear->completed', { exit: 'done' }),
      edge('reviewSlice', 'repairSlice', 'review->repair', { exit: 'repair' }),
      edge('repairSlice', 'reviewSlice', 'repair->review', { exit: 'repaired' }),
      edge('planSlice', 'recover.start', 'plan->recover', { exit: 'needsRecovery' }),
      edge('executeSlice', 'recover.start', 'execute->recover', { exit: 'needsRecovery' }),
      edge('reviewSlice', 'recover.start', 'review->recover', { exit: 'needsRecovery' }),
      edge('verifySlice', 'recover.start', 'verify->recover', { exit: 'needsRecovery' }),
      edge('failed', 'recover.start', 'failed->recover', { exit: 'needsRecovery' }),
      edge('recover.done', 'resumeAfterRecovery', 'recover->resume', { exit: 'recovered' }),
      edge('resumeAfterRecovery', 'planSlice', 'resume->plan', {
        exit: 'always',
        kind: 'always',
      }),
      edge('resumeAfterRecovery', 'executeSlice', 'resume->execute', {
        exit: 'always',
        kind: 'always',
      }),
      edge('resumeAfterRecovery', 'reviewSlice', 'resume->review', {
        exit: 'always',
        kind: 'always',
      }),
      edge('resumeAfterRecovery', 'verifySlice', 'resume->verify', {
        exit: 'always',
        kind: 'always',
      }),
      edge('resumeAfterRecovery', 'finishSlice', 'resume->finish', {
        exit: 'always',
        kind: 'always',
      }),
    ],
  );

const markMainNodes = (source: Topology, ids: ReadonlyArray<string>): Topology => {
  const mainIds = new Set(ids);
  return {
    ...source,
    nodes: source.nodes.map((candidate) =>
      mainIds.has(candidate.id) ? { ...candidate, main: true } : candidate,
    ),
  };
};

describe('buildGraphLayoutModel', () => {
  it('filters invalid edges and ranks a linear flow from the visible entry', () => {
    const model = buildGraphLayoutModel(
      topology(
        'start',
        [node('start'), node('middle'), node('done', 'terminal')],
        [edge('start', 'middle'), edge('middle', 'done'), edge('start', 'missing', 'bad')],
      ),
      new Set(),
    );

    const scope = rootScope(model);
    expect(model.invalidEdges.map((e) => e.id)).toEqual(['bad']);
    expect(scope.linearEdges.map((e) => e.id)).toEqual(['start->middle', 'middle->done']);
    expect(scope.orderedNodeIds).toEqual(['start', 'middle', 'done']);
    expect(scope.ranks.get('start')).toMatchObject({ reachable: true, rank: 0 });
    expect(scope.ranks.get('middle')).toMatchObject({ reachable: true, rank: 1 });
    expect(scope.ranks.get('done')).toMatchObject({ reachable: true, rank: 2 });
    expect(scope.localSinkTerminalIds).toEqual(['done']);
  });

  it('uses longest distance through branch joins when ranking reachable components', () => {
    const model = buildGraphLayoutModel(
      topology(
        'start',
        [node('start'), node('left'), node('right'), node('done', 'terminal')],
        [
          edge('start', 'left'),
          edge('start', 'right'),
          edge('left', 'done'),
          edge('right', 'done'),
        ],
      ),
      new Set(),
    );

    const scope = rootScope(model);
    expect(scope.orderedNodeIds).toEqual(['start', 'left', 'right', 'done']);
    expect(scope.ranks.get('done')).toMatchObject({ reachable: true, rank: 2 });
  });

  it('sorts layout edges by ranked source flow before original topology order', () => {
    const model = buildGraphLayoutModel(
      topology(
        'start',
        [node('start'), node('middle'), node('done', 'terminal')],
        [edge('middle', 'done', 'late-first'), edge('start', 'middle', 'entry-second')],
      ),
      new Set(),
    );

    expect(rootScope(model).linearEdges.map((candidate) => candidate.semanticId)).toEqual([
      'entry-second',
      'late-first',
    ]);
    expect(model.layoutEdges.map((candidate) => candidate.semanticId)).toEqual([
      'entry-second',
      'late-first',
    ]);
  });

  it('separates visible self-loops from linear edges before ranking', () => {
    const model = buildGraphLayoutModel(
      topology(
        'start',
        [node('start'), node('done', 'terminal')],
        [edge('start', 'start', 'retry'), edge('start', 'done', 'finish')],
      ),
      new Set(),
    );

    const scope = rootScope(model);
    expect(scope.selfLoops.map((e) => e.id)).toEqual(['retry']);
    expect(scope.linearEdges.map((e) => e.id)).toEqual(['finish']);
    expect(scope.ranks.get('done')).toMatchObject({ reachable: true, rank: 1 });
    expect(scope.localSinkTerminalIds).toEqual(['done']);
  });

  it('condenses retry cycles into one ranked component', () => {
    const model = buildGraphLayoutModel(
      topology(
        'start',
        [node('start'), node('attempt'), node('review'), node('done', 'terminal')],
        [
          edge('start', 'attempt'),
          edge('attempt', 'review'),
          edge('review', 'attempt'),
          edge('review', 'done'),
        ],
      ),
      new Set(),
    );

    const scope = rootScope(model);
    expect(scope.ranks.get('attempt')?.componentId).toBe(scope.ranks.get('review')?.componentId);
    expect(scope.ranks.get('attempt')).toMatchObject({ reachable: true, rank: 1 });
    expect(scope.ranks.get('review')).toMatchObject({ reachable: true, rank: 1 });
    expect(scope.ranks.get('done')).toMatchObject({ reachable: true, rank: 2 });
  });

  it('keeps the entry first inside a two-node cycle even when topology order differs', () => {
    const model = buildGraphLayoutModel(
      topology('b', [node('a'), node('b')], [edge('b', 'a'), edge('a', 'b')]),
      new Set(),
    );

    const scope = rootScope(model);
    expect(scope.orderedNodeIds).toEqual(['b', 'a']);
    expect(scope.ranks.get('a')?.componentId).toBe(scope.ranks.get('b')?.componentId);
  });

  it('sorts unreachable nodes after reachable nodes without displacing the entry', () => {
    const model = buildGraphLayoutModel(
      topology(
        'start',
        [node('unreachable', 'terminal'), node('start'), node('done', 'terminal')],
        [edge('start', 'done')],
      ),
      new Set(),
    );

    const scope = rootScope(model);
    expect(scope.orderedNodeIds).toEqual(['start', 'done', 'unreachable']);
    expect(scope.nodeGroups.get('unreachable')).toBe('unreachable');
    expect(scope.ranks.get('unreachable')).toMatchObject({ reachable: false, rank: null });
    expect(scope.localSinkTerminalIds).toEqual(['done']);
  });

  it('hides collapsed embed descendants behind their nearest visible host', () => {
    const model = buildGraphLayoutModel(
      topology(
        'spec.compose',
        [
          node('spec', 'embed', { entry: 'spec.compose' }),
          node('done', 'terminal'),
          node('spec.compose', 'stateful', { parent: 'spec' }),
          node('spec.shipped', 'terminal', { parent: 'spec' }),
        ],
        [edge('spec.compose', 'spec.shipped'), edge('spec.shipped', 'done')],
      ),
      new Set(),
    );

    const scope = rootScope(model);
    expect(scope.nodeIds).toEqual(['spec', 'done']);
    expect(scope.entryNodeId).toBe('spec');
    expect(scope.linearEdges.map((e) => [e.id, e.from, e.to])).toEqual([
      ['spec.shipped->done', 'spec', 'done'],
    ]);
    expect(model.visibleNodes.map((n) => n.id)).toEqual(['spec', 'done']);
  });

  it('resolves nested visible entries one expanded scope at a time', () => {
    const model = buildGraphLayoutModel(
      topology(
        'spec.worker.start',
        [
          node('spec', 'embed', { entry: 'spec.worker.start' }),
          node('spec.worker', 'embed', { parent: 'spec', entry: 'spec.worker.start' }),
          node('spec.done', 'terminal', { parent: 'spec' }),
          node('spec.worker.start', 'stateful', { parent: 'spec.worker' }),
          node('spec.worker.done', 'terminal', { parent: 'spec.worker' }),
        ],
        [edge('spec.worker.start', 'spec.worker.done'), edge('spec.worker.done', 'spec.done')],
      ),
      new Set(['spec']),
    );

    const root = rootScope(model);
    const spec = model.scopes.find((scope) => scope.id === 'spec')!;
    expect(root.entryNodeId).toBe('spec');
    expect(spec.nodeIds).toEqual(['spec.worker', 'spec.done']);
    expect(spec.entryNodeId).toBe('spec.worker');
  });

  it('does not create a nested expanded scope while its parent host is collapsed', () => {
    const model = buildGraphLayoutModel(
      topology(
        'spec.worker.start',
        [
          node('spec', 'embed', { entry: 'spec.worker.start' }),
          node('spec.worker', 'embed', { parent: 'spec', entry: 'spec.worker.start' }),
          node('spec.worker.start', 'stateful', { parent: 'spec.worker' }),
          node('spec.worker.done', 'terminal', { parent: 'spec.worker' }),
        ],
        [edge('spec.worker.start', 'spec.worker.done')],
      ),
      new Set(['spec.worker']),
    );

    expect(model.scopes.map((scope) => scope.id)).toEqual(['root']);
    expect(rootScope(model).nodeIds).toEqual(['spec']);
    expect(model.visibleNodes.map((n) => n.id)).toEqual(['spec']);
  });

  it('classifies local sink terminals per expanded scope', () => {
    const model = buildGraphLayoutModel(
      topology(
        'spec.compose',
        [
          node('spec', 'embed', { entry: 'spec.compose' }),
          node('root.done', 'terminal'),
          node('spec.compose', 'stateful', { parent: 'spec' }),
          node('spec.shipped', 'terminal', { parent: 'spec' }),
        ],
        [
          edge('spec.compose', 'spec.shipped'),
          edge('spec.shipped', 'root.done'),
          edge('spec', 'root.done', 'host-fallback'),
        ],
      ),
      new Set(['spec']),
    );

    const root = rootScope(model);
    const spec = model.scopes.find((scope) => scope.id === 'spec')!;
    expect(root.localSinkTerminalIds).toEqual(['root.done']);
    expect(spec.localSinkTerminalIds).toEqual(['spec.shipped']);
  });

  it('warns and treats an expanded embed without entry as collapsed', () => {
    const model = buildGraphLayoutModel(
      topology(
        'spec.compose',
        [
          node('spec', 'embed'),
          node('spec.compose', 'stateful', { parent: 'spec' }),
          node('spec.done', 'terminal', { parent: 'spec' }),
        ],
        [edge('spec.compose', 'spec.done')],
      ),
      new Set(['spec']),
    );

    expect(model.warnings).toEqual([
      expect.objectContaining({ code: 'missing-embed-entry', nodeId: 'spec' }),
    ]);
    expect(model.scopes.map((scope) => scope.id)).toEqual(['root']);
    expect(rootScope(model).nodeIds).toEqual(['spec']);
  });

  it('projects collapsed boundary edges through the visible host without exposing descendants', () => {
    const model = buildGraphLayoutModel(
      topology(
        'router',
        [
          node('router'),
          node('spec', 'embed', { entry: 'spec.compose' }),
          node('done', 'terminal'),
          node('spec.compose', 'stateful', { parent: 'spec' }),
          node('spec.shipped', 'terminal', { parent: 'spec' }),
        ],
        [
          edge('router', 'spec.compose', 'enter'),
          edge('spec.compose', 'spec.shipped', 'internal'),
          edge('spec.shipped', 'done', 'finish'),
        ],
      ),
      new Set(),
    );

    const scope = rootScope(model);
    expect(model.visibleNodes.map((n) => n.id)).toEqual(['router', 'spec', 'done']);
    expect(
      scope.linearEdges.map((e) => [e.semanticId, e.rankFrom, e.rankTo, e.routeFrom, e.routeTo]),
    ).toEqual([
      ['enter', 'router', 'spec', 'router', 'spec'],
      ['finish', 'spec', 'done', 'spec', 'done'],
    ]);
    expect(model.visibleEdges.map((e) => e.semanticId)).toEqual(['enter', 'finish']);
    expect(model.layoutEdges.some((e) => e.semanticId === 'internal')).toBe(false);
  });

  it('routes expanded boundary edges to visible child anchors and marks rank-only helpers', () => {
    const model = buildGraphLayoutModel(
      topology(
        'router',
        [
          node('router'),
          node('spec', 'embed', { entry: 'spec.compose' }),
          node('done', 'terminal'),
          node('spec.compose', 'stateful', { parent: 'spec' }),
          node('spec.shipped', 'terminal', { parent: 'spec' }),
        ],
        [
          edge('router', 'spec.compose', 'enter'),
          edge('spec.compose', 'spec.shipped', 'internal'),
          edge('spec.shipped', 'done', 'finish'),
        ],
      ),
      new Set(['spec']),
    );

    const root = rootScope(model);
    const spec = model.scopes.find((scope) => scope.id === 'spec')!;
    const rootVisibleEdges = root.linearEdges.filter((e) => e.isVisible);
    const rootRankOnlyEdges = root.linearEdges.filter((e) => e.isRankOnly);

    expect(
      rootVisibleEdges.map((e) => [e.semanticId, e.rankFrom, e.rankTo, e.routeFrom, e.routeTo]),
    ).toEqual([
      ['enter', 'router', 'spec', 'router', 'spec.compose'],
      ['finish', 'spec', 'done', 'spec.shipped', 'done'],
    ]);
    expect(
      rootRankOnlyEdges.map((e) => [e.semanticId, e.rankFrom, e.rankTo, e.isVisible, e.rankPolicy]),
    ).toEqual([
      ['enter', 'router', 'spec', false, 'rank-helper'],
      ['finish', 'spec', 'done', false, 'rank-helper'],
    ]);
    expect(
      spec.linearEdges.map((e) => [e.semanticId, e.routeFrom, e.routeTo, e.isRankOnly]),
    ).toEqual([['internal', 'spec.compose', 'spec.shipped', false]]);
    expect(model.visibleEdges.every((e) => !e.isRankOnly && e.isVisible)).toBe(true);
    expect(model.visibleEdges.map((e) => e.semanticId)).toEqual(['enter', 'finish', 'internal']);
  });

  it('classifies cycle edges by local SCC order', () => {
    const model = buildGraphLayoutModel(
      topology('a', [node('a'), node('b')], [edge('a', 'b', 'ab'), edge('b', 'a', 'ba')]),
      new Set(),
    );

    expect(rootScope(model).linearEdges.map((e) => [e.semanticId, e.feedbackClass])).toEqual([
      ['ab', 'cycle-forward'],
      ['ba', 'cycle-feedback'],
    ]);
  });

  it('computes deterministic label widths and parallel rendered edge groups', () => {
    const model = buildGraphLayoutModel(
      topology(
        'a',
        [node('a'), node('b'), node('c'), node('d')],
        [
          edge('a', 'b', 'short', { exit: 'go' }),
          edge('a', 'b', 'long', { exit: 'a very long exit label that must clamp' }),
          edge('b', 'c', 'empty', { exit: '' }),
          edge('c', 'd', 'branch', { exit: 'route', branchIndex: 1, branchTotal: 2 }),
        ],
      ),
      new Set(),
    );

    const bySemanticId = new Map(model.visibleEdges.map((e) => [e.semanticId, e]));
    expect(bySemanticId.get('short')?.labelWidth).toBe(48);
    expect(bySemanticId.get('long')?.labelWidth).toBe(150);
    expect(bySemanticId.get('empty')?.labelWidth).toBe(48);
    expect(bySemanticId.get('branch')?.labelWidth).toBe(69);
    expect(bySemanticId.get('short')?.parallelGroupKey).toBe('a\x00b');
    expect(bySemanticId.get('long')?.parallelGroupKey).toBe('a\x00b');
    expect(bySemanticId.get('short')).toMatchObject({ parallelIndex: 0, parallelTotal: 2 });
    expect(bySemanticId.get('long')).toMatchObject({ parallelIndex: 1, parallelTotal: 2 });
    expect(model.visibleEdges.map((e) => e.semanticId)).toEqual([
      'short',
      'long',
      'empty',
      'branch',
    ]);
  });

  it('adds renderer-local semantics for recovery fan-in, resume fan-out, and feedback edges', () => {
    const model = buildGraphLayoutModel(recipeRunnerShapedTopology(), new Set());

    expect(edgeBySemanticId(model, 'orient->plan')).toMatchObject({
      kind: 'submit',
      layoutRole: 'primary',
      rankPolicy: 'rank-defining',
      labelPolicy: 'default-visible',
    });

    for (const semanticId of [
      'plan->recover',
      'execute->recover',
      'review->recover',
      'verify->recover',
    ]) {
      expect(edgeBySemanticId(model, semanticId)).toMatchObject({
        kind: 'submit',
        layoutRole: 'auxiliary',
        rankPolicy: 'rank-neutral',
        labelPolicy: 'grouped-summary',
      });
    }

    for (const semanticId of [
      'resume->plan',
      'resume->execute',
      'resume->review',
      'resume->verify',
      'resume->finish',
    ]) {
      expect(edgeBySemanticId(model, semanticId)).toMatchObject({
        kind: 'always',
        layoutRole: 'resume',
        rankPolicy: 'rank-neutral',
        labelPolicy: 'grouped-summary',
      });
    }

    expect(edgeBySemanticId(model, 'review->failed')).toMatchObject({
      layoutRole: 'terminal',
      rankPolicy: 'rank-defining',
      labelPolicy: 'default-visible',
    });
    expect(edgeBySemanticId(model, 'repair->review')).toMatchObject({
      layoutRole: 'feedback',
      rankPolicy: 'rank-neutral',
      labelPolicy: 'hover-focus-visible',
    });
    expect(model.visibleEdges.map((candidate) => candidate.semanticId)).toContain('repair->review');
  });

  it('orders recipe-runner-shaped flow from structural edges while rendering neutral edges', () => {
    const source = recipeRunnerShapedTopology();
    const model = buildGraphLayoutModel(source, new Set());
    const scope = rootScope(model);
    const rankOf = (nodeId: string) => scope.ranks.get(nodeId)?.rank;
    const mainFlow = [
      'orientSlice',
      'planSlice',
      'executeSlice',
      'reviewSlice',
      'verifySlice',
      'finishSlice',
      'clearNextSlice',
      'completed',
    ];

    expect(model.renderEdges).toHaveLength(source.edges.length);
    expect(model.visibleEdges).toBe(model.renderEdges);
    expect(model.nodePlacementEdges).toBe(model.layoutEdges);
    expect(model.orderingEdges.map((candidate) => candidate.semanticId)).not.toEqual(
      expect.arrayContaining([
        'plan->recover',
        'execute->recover',
        'review->recover',
        'verify->recover',
        'failed->recover',
        'resume->plan',
        'resume->execute',
        'resume->review',
        'resume->verify',
        'resume->finish',
        'repair->review',
      ]),
    );
    expect(scope.orderingEdges.map((candidate) => candidate.semanticId)).toEqual(
      model.orderingEdges.map((candidate) => candidate.semanticId),
    );
    expect(model.renderEdges.map((candidate) => candidate.semanticId)).toEqual(
      expect.arrayContaining([
        'plan->recover',
        'execute->recover',
        'review->recover',
        'verify->recover',
        'failed->recover',
        'resume->plan',
        'resume->execute',
        'resume->review',
        'resume->verify',
        'resume->finish',
      ]),
    );

    for (let index = 1; index < mainFlow.length; index += 1) {
      expect(rankOf(mainFlow[index])).toBeGreaterThan(rankOf(mainFlow[index - 1]) ?? -1);
    }
    expect(scope.ranks.get('recover')).toMatchObject({ reachable: false, rank: null });
    expect(scope.ranks.get('resumeAfterRecovery')).toMatchObject({
      reachable: false,
      rank: null,
    });
    expect(scope.localSinkTerminalIds).toEqual(['completed', 'failed']);
  });

  it('uses explicit main nodes as the rank-defining spine when present', () => {
    const source = markMainNodes(recipeRunnerShapedTopology(), [
      'orientSlice',
      'planSlice',
      'executeSlice',
      'reviewSlice',
      'verifySlice',
      'finishSlice',
      'clearNextSlice',
      'completed',
    ]);
    const model = buildGraphLayoutModel(source, new Set());
    const scope = rootScope(model);
    const mainFlow = [
      'orientSlice',
      'planSlice',
      'executeSlice',
      'reviewSlice',
      'verifySlice',
      'finishSlice',
      'clearNextSlice',
      'completed',
    ];
    const rankOf = (nodeId: string) => scope.ranks.get(nodeId)?.rank;

    expect(scope.orderedNodeIds.slice(0, mainFlow.length)).toEqual(mainFlow);
    expect(scope.orderingEdges.map((candidate) => candidate.semanticId)).toEqual([
      'orient->plan',
      'plan->execute',
      'execute->review',
      'review->verify',
      'verify->finish',
      'finish->clear',
      'clear->completed',
    ]);
    for (const semanticId of [
      'orient->plan',
      'plan->execute',
      'execute->review',
      'review->verify',
      'verify->finish',
      'finish->clear',
      'clear->completed',
    ]) {
      expect(edgeBySemanticId(model, semanticId).mainRole).toBe('forward');
    }
    expect(model.renderEdges).toHaveLength(source.edges.length);
    expect(edgeBySemanticId(model, 'review->failed')).toMatchObject({
      layoutRole: 'terminal',
      rankPolicy: 'rank-neutral',
      mainRole: 'side',
    });
    expect(edgeBySemanticId(model, 'review->repair')).toMatchObject({
      rankPolicy: 'rank-neutral',
      mainRole: 'side',
    });
    expect(edgeBySemanticId(model, 'repair->review')).toMatchObject({
      rankPolicy: 'rank-neutral',
      mainRole: 'side',
    });
    for (const semanticId of [
      'plan->recover',
      'execute->recover',
      'review->recover',
      'verify->recover',
    ]) {
      expect(edgeBySemanticId(model, semanticId)).toMatchObject({
        layoutRole: 'auxiliary',
        rankPolicy: 'rank-neutral',
        mainRole: 'side',
      });
    }
    for (const semanticId of [
      'resume->plan',
      'resume->execute',
      'resume->review',
      'resume->verify',
      'resume->finish',
    ]) {
      expect(edgeBySemanticId(model, semanticId)).toMatchObject({
        layoutRole: 'resume',
        rankPolicy: 'rank-neutral',
        mainRole: 'side',
      });
    }
    expect(edgeBySemanticId(model, 'failed->recover')).toMatchObject({
      layoutRole: 'auxiliary',
      rankPolicy: 'rank-neutral',
      mainRole: 'none',
    });
    for (let index = 1; index < mainFlow.length; index += 1) {
      expect(rankOf(mainFlow[index])).toBeGreaterThan(rankOf(mainFlow[index - 1]) ?? -1);
    }
    expect(scope.ranks.get('failed')).toMatchObject({ reachable: false, rank: null });
    expect(scope.localSinkTerminalIds).toEqual(['completed', 'failed']);
  });

  it('classifies acyclic marked main path edges as main forward edges', () => {
    const model = buildGraphLayoutModel(
      topology(
        'start',
        [
          node('start', 'stateful', { main: true }),
          node('middle', 'stateful', { main: true }),
          node('done', 'terminal', { main: true }),
        ],
        [edge('start', 'middle'), edge('middle', 'done')],
      ),
      new Set(),
    );
    const scope = rootScope(model);

    expect(scope.mainSpine).toEqual({
      mainNodeIds: ['start', 'middle', 'done'],
      forwardEdgeIds: ['start->middle', 'middle->done'],
      feedbackEdgeIds: [],
      sideEdgeIds: [],
    });
    expect(edgeBySemanticId(model, 'start->middle').mainRole).toBe('forward');
    expect(edgeBySemanticId(model, 'middle->done').mainRole).toBe('forward');
  });

  it('keeps branches from marked main nodes to unmarked terminal and auxiliary nodes outside the main forward spine', () => {
    const model = buildGraphLayoutModel(
      topology(
        'start',
        [
          node('start', 'stateful', { main: true }),
          node('middle', 'stateful', { main: true }),
          node('done', 'terminal'),
          node('recover', 'embed', { entry: 'recover.start' }),
          node('recover.start', 'stateful', { parent: 'recover' }),
        ],
        [
          edge('start', 'middle'),
          edge('start', 'recover.start', 'start->recover', { exit: 'needsRecovery' }),
          edge('middle', 'done'),
          edge('middle', 'recover.start', 'middle->recover', { exit: 'needsRecovery' }),
        ],
      ),
      new Set(),
    );
    const scope = rootScope(model);

    expect(scope.mainSpine.forwardEdgeIds).toEqual(['start->middle']);
    expect(scope.mainSpine.sideEdgeIds).toEqual([
      'start->recover',
      'middle->done',
      'middle->recover',
    ]);
    expect(edgeBySemanticId(model, 'start->middle').mainRole).toBe('forward');
    expect(edgeBySemanticId(model, 'middle->done')).toMatchObject({
      layoutRole: 'terminal',
      mainRole: 'side',
    });
    expect(edgeBySemanticId(model, 'middle->recover')).toMatchObject({
      layoutRole: 'auxiliary',
      mainRole: 'side',
    });
  });

  it('classifies cyclic marked main back edges as main feedback', () => {
    const model = buildGraphLayoutModel(
      topology(
        'A',
        [
          node('A', 'stateful', { main: true }),
          node('B', 'stateful', { main: true }),
          node('C', 'stateful', { main: true }),
          node('D', 'terminal', { main: true }),
        ],
        [
          edge('A', 'B', 'A->B'),
          edge('B', 'C', 'B->C'),
          edge('C', 'B', 'C->B'),
          edge('C', 'D', 'C->D'),
        ],
      ),
      new Set(),
    );
    const scope = rootScope(model);

    expect(scope.mainSpine.mainNodeIds).toEqual(['A', 'B', 'C', 'D']);
    expect(scope.mainSpine.forwardEdgeIds).toEqual(['A->B', 'B->C', 'C->D']);
    expect(scope.mainSpine.feedbackEdgeIds).toEqual(['C->B']);
    expect(edgeBySemanticId(model, 'A->B').mainRole).toBe('forward');
    expect(edgeBySemanticId(model, 'B->C').mainRole).toBe('forward');
    expect(edgeBySemanticId(model, 'C->D').mainRole).toBe('forward');
    expect(edgeBySemanticId(model, 'C->B').mainRole).toBe('feedback');
    expect(edgeBySemanticId(model, 'C->B').rankPolicy).toBe('rank-neutral');
    expect(scope.orderingEdges.map((candidate) => candidate.semanticId)).toEqual([
      'A->B',
      'B->C',
      'C->D',
    ]);
    expect(scope.orderedNodeIds.slice(0, 4)).toEqual(['A', 'B', 'C', 'D']);
    expect(scope.ranks.get('B')?.componentId).not.toBe(scope.ranks.get('C')?.componentId);
    expect(scope.ranks.get('B')).toMatchObject({ reachable: true, rank: 1 });
    expect(scope.ranks.get('C')).toMatchObject({ reachable: true, rank: 2 });
    expect(scope.ranks.get('D')).toMatchObject({ reachable: true, rank: 3 });
  });

  it('keeps cyclic main feedback and neutral side paths renderable with explicit main nodes', () => {
    const model = buildGraphLayoutModel(
      topology(
        'A',
        [
          node('A', 'stateful', { main: true }),
          node('B', 'stateful', { main: true }),
          node('C', 'stateful', { main: true }),
          node('D', 'terminal', { main: true }),
          node('failed', 'terminal'),
          node('recover', 'embed', { entry: 'recover.start' }),
          node('resumeAfterRecovery', 'passive'),
          node('recover.start', 'stateful', { parent: 'recover' }),
          node('recover.done', 'terminal', { parent: 'recover' }),
        ],
        [
          edge('A', 'B', 'A->B'),
          edge('B', 'C', 'B->C'),
          edge('C', 'B', 'C->B'),
          edge('C', 'D', 'C->D'),
          edge('B', 'failed', 'B->failed', {
            exit: 'rejected',
            branchIndex: 1,
            branchTotal: 3,
          }),
          edge('B', 'recover.start', 'B->recover', { exit: 'needsRecovery' }),
          edge('C', 'recover.start', 'C->recover', { exit: 'needsRecovery' }),
          edge('recover.done', 'resumeAfterRecovery', 'recover->resume', {
            exit: 'recovered',
          }),
          edge('resumeAfterRecovery', 'B', 'resume->B', {
            kind: 'always',
            exit: 'always',
          }),
          edge('resumeAfterRecovery', 'C', 'resume->C', {
            kind: 'always',
            exit: 'always',
          }),
          edge('resumeAfterRecovery', 'D', 'resume->D', {
            kind: 'always',
            exit: 'always',
          }),
        ],
      ),
      new Set(),
    );
    const visibleSemanticIds = model.renderEdges.map((candidate) => candidate.semanticId);
    const layoutSemanticIds = model.layoutEdges.map((candidate) => candidate.semanticId);

    expect(visibleSemanticIds).toEqual(
      expect.arrayContaining([
        'A->B',
        'B->C',
        'C->B',
        'C->D',
        'B->failed',
        'B->recover',
        'C->recover',
        'recover->resume',
        'resume->B',
        'resume->C',
        'resume->D',
      ]),
    );
    expect(layoutSemanticIds).toEqual(expect.arrayContaining(visibleSemanticIds));
    expect(edgeBySemanticId(model, 'C->B')).toMatchObject({
      mainRole: 'feedback',
      layoutRole: 'feedback',
      rankPolicy: 'rank-neutral',
    });
    expect(edgeBySemanticId(model, 'B->failed')).toMatchObject({
      mainRole: 'side',
      layoutRole: 'terminal',
      rankPolicy: 'rank-neutral',
    });
    expect(edgeBySemanticId(model, 'B->recover')).toMatchObject({
      mainRole: 'side',
      layoutRole: 'auxiliary',
      rankPolicy: 'rank-neutral',
    });
    expect(edgeBySemanticId(model, 'C->recover')).toMatchObject({
      mainRole: 'side',
      layoutRole: 'auxiliary',
      rankPolicy: 'rank-neutral',
    });
    expect(edgeBySemanticId(model, 'resume->B')).toMatchObject({
      mainRole: 'side',
      layoutRole: 'resume',
      rankPolicy: 'rank-neutral',
    });
  });

  it('orders disconnected marked main nodes deterministically by topology order', () => {
    const model = buildGraphLayoutModel(
      topology(
        'entry',
        [
          node('entry', 'stateful', { main: true }),
          node('next', 'stateful', { main: true }),
          node('detachedB', 'stateful', { main: true }),
          node('detachedA', 'stateful', { main: true }),
        ],
        [edge('entry', 'next')],
      ),
      new Set(),
    );

    expect(rootScope(model).mainSpine.mainNodeIds).toEqual([
      'entry',
      'next',
      'detachedB',
      'detachedA',
    ]);
  });

  it('classifies marked main self-loops as main feedback', () => {
    const model = buildGraphLayoutModel(
      topology(
        'start',
        [node('start', 'stateful', { main: true }), node('done', 'terminal', { main: true })],
        [edge('start', 'start', 'retry'), edge('start', 'done', 'finish')],
      ),
      new Set(),
    );
    const scope = rootScope(model);

    expect(scope.mainSpine.forwardEdgeIds).toEqual(['finish']);
    expect(scope.mainSpine.feedbackEdgeIds).toEqual(['retry']);
    expect(edgeBySemanticId(model, 'finish').mainRole).toBe('forward');
    expect(selfLoopBySemanticId(model, 'retry').mainRole).toBe('feedback');
  });

  it('keeps non-passive always fan-out as branch ordering edges', () => {
    const model = buildGraphLayoutModel(
      topology(
        'router',
        [node('router'), node('alpha'), node('beta'), node('gamma'), node('delta')],
        [
          edge('router', 'alpha', 'router->alpha', { kind: 'always', exit: 'always' }),
          edge('router', 'beta', 'router->beta', { kind: 'always', exit: 'always' }),
          edge('router', 'gamma', 'router->gamma', { kind: 'always', exit: 'always' }),
          edge('router', 'delta', 'router->delta', { kind: 'always', exit: 'always' }),
        ],
      ),
      new Set(),
    );

    for (const semanticId of ['router->alpha', 'router->beta', 'router->gamma', 'router->delta']) {
      expect(edgeBySemanticId(model, semanticId)).toMatchObject({
        layoutRole: 'branch',
        rankPolicy: 'rank-defining',
        labelPolicy: 'default-visible',
      });
    }
    expect(model.orderingEdges.map((candidate) => candidate.semanticId)).toEqual([
      'router->alpha',
      'router->beta',
      'router->gamma',
      'router->delta',
    ]);
  });

  it('groups recipe-runner-shaped nodes into stable layout lanes', () => {
    const model = buildGraphLayoutModel(recipeRunnerShapedTopology(), new Set());
    const scope = rootScope(model);
    const groups = new Map(
      scope.orderedNodeIds.map((nodeId) => [nodeId, scope.nodeGroups.get(nodeId)]),
    );

    expect([...groups]).toEqual(
      expect.arrayContaining([
        ['orientSlice', 'main'],
        ['repairSlice', 'repair'],
        ['recover', 'recovery'],
        ['resumeAfterRecovery', 'resume'],
        ['completed', 'terminal'],
        ['failed', 'terminal'],
      ]),
    );
    expect(scope.orderedNodeIds).toEqual([
      'orientSlice',
      'planSlice',
      'executeSlice',
      'reviewSlice',
      'verifySlice',
      'repairSlice',
      'finishSlice',
      'clearNextSlice',
      'recover',
      'resumeAfterRecovery',
      'failed',
      'completed',
    ]);
  });

  it('applies node grouping independently inside expanded embed scopes', () => {
    const model = buildGraphLayoutModel(
      topology(
        'host.entry',
        [
          node('host', 'embed', { entry: 'host.entry' }),
          node('root.done', 'terminal'),
          node('host.entry', 'stateful', { parent: 'host' }),
          node('host.work', 'stateful', { parent: 'host' }),
          node('host.recover', 'embed', { parent: 'host', entry: 'host.recover.start' }),
          node('host.resume', 'passive', { parent: 'host' }),
          node('host.done', 'terminal', { parent: 'host' }),
          node('host.recover.start', 'stateful', { parent: 'host.recover' }),
          node('host.recover.done', 'terminal', { parent: 'host.recover' }),
        ],
        [
          edge('host.entry', 'host.work', 'entry->work'),
          edge('host.work', 'host.done', 'work->done'),
          edge('host.entry', 'host.recover.start', 'entry->recover', { exit: 'escape' }),
          edge('host.work', 'host.recover.start', 'work->recover', { exit: 'escape' }),
          edge('host.recover.done', 'host.resume', 'recover->resume'),
          edge('host.resume', 'host.entry', 'resume->entry', { kind: 'always', exit: 'always' }),
          edge('host.resume', 'host.work', 'resume->work', { kind: 'always', exit: 'always' }),
          edge('host.resume', 'host.done', 'resume->done', { kind: 'always', exit: 'always' }),
          edge('host.done', 'root.done', 'done->root'),
        ],
      ),
      new Set(['host']),
    );
    const hostScope = model.scopes.find((scope) => scope.id === 'host')!;

    expect(hostScope.nodeGroups.get('host.entry')).toBe('main');
    expect(hostScope.nodeGroups.get('host.work')).toBe('main');
    expect(hostScope.nodeGroups.get('host.recover')).toBe('recovery');
    expect(hostScope.nodeGroups.get('host.resume')).toBe('resume');
    expect(hostScope.nodeGroups.get('host.done')).toBe('terminal');
    expect(hostScope.orderedNodeIds).toEqual([
      'host.entry',
      'host.work',
      'host.recover',
      'host.resume',
      'host.done',
    ]);
  });

  it('aggregates active and visited hidden descendants onto collapsed hosts', () => {
    const model = buildGraphLayoutModel(
      topology(
        'spec.compose',
        [
          node('spec', 'embed', { entry: 'spec.compose' }),
          node('spec.compose', 'stateful', { parent: 'spec' }),
          node('spec.shipped', 'terminal', { parent: 'spec' }),
        ],
        [edge('spec.compose', 'spec.shipped')],
      ),
      new Set(),
      {
        activeStateId: 'spec.compose',
        visitedNodeIds: new Set(['spec.shipped']),
      },
    );

    expect(model.visibleNodeMetadata.get('spec')).toEqual({
      activeDescendant: true,
      visitedDescendant: true,
      isCollapsedEmbedHost: true,
    });
  });
});
