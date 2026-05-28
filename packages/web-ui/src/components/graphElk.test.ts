import { describe, expect, it } from 'vitest';

import type { Topology, VizEdge, VizNode } from '../types/topology.js';
import { buildGraphLayoutModel } from './graphLayoutModel.js';
import {
  buildElkGraphForTest,
  probeGraphElkCapabilitiesForTest,
  runGraphElkLayout,
  type GraphElkLayout,
} from './graphElk.js';

type TestElkNode = {
  id: string;
  width?: number;
  height?: number;
  layoutOptions?: TestElkLayoutOptions;
  labels?: Array<{ id?: string; text?: string; x?: number; y?: number }>;
  children?: TestElkNode[];
  edges?: TestElkEdge[];
  ports?: Array<{
    id: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    layoutOptions?: TestElkLayoutOptions;
  }>;
};

type TestElkLayoutOptions = Record<string, string>;
type TestElkEdge = {
  id: string;
  sources: string[];
  targets: string[];
  labels?: unknown[];
  layoutOptions?: TestElkLayoutOptions;
};

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

function compoundTopology(): Topology {
  return topology(
    'spec.compose',
    [
      node('spec', 'embed', { entry: 'spec.compose' }),
      node('done', 'terminal'),
      node('spec.compose', 'stateful', { parent: 'spec' }),
      node('spec.shipped', 'terminal', { parent: 'spec' }),
    ],
    [edge('spec.compose', 'spec.shipped', 'inside'), edge('spec.shipped', 'done', 'boundary')],
  );
}

function recipeRunnerShapedTopology(): Topology {
  return topology(
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
}

function markMainNodes(source: Topology, ids: ReadonlyArray<string>): Topology {
  const mainIds = new Set(ids);
  return {
    ...source,
    nodes: source.nodes.map((candidate) =>
      mainIds.has(candidate.id) ? { ...candidate, main: true } : candidate,
    ),
  };
}

function markedMainAcyclicTopology(): Topology {
  return topology(
    'A',
    [
      node('A', 'stateful', { main: true }),
      node('B', 'stateful', { main: true }),
      node('C', 'stateful', { main: true }),
      node('D', 'terminal', { main: true }),
      node('recover', 'embed', { entry: 'recover.start' }),
      node('resume', 'passive'),
      node('failed', 'terminal', { outcome: 'failure' }),
      node('recover.start', 'stateful', { parent: 'recover' }),
      node('recover.done', 'terminal', { parent: 'recover' }),
    ],
    [
      edge('A', 'B', 'A->B'),
      edge('B', 'C', 'B->C'),
      edge('C', 'D', 'C->D'),
      edge('B', 'failed', 'B->failed', {
        exit: 'rejected',
        branchIndex: 1,
        branchTotal: 2,
      }),
      edge('B', 'recover.start', 'B->recover', { exit: 'needsRecovery' }),
      edge('C', 'recover.start', 'C->recover', { exit: 'needsRecovery' }),
      edge('recover.done', 'resume', 'recover->resume', { exit: 'recovered' }),
      edge('resume', 'B', 'resume->B', { kind: 'always', exit: 'always' }),
      edge('resume', 'C', 'resume->C', { kind: 'always', exit: 'always' }),
      edge('resume', 'D', 'resume->D', { kind: 'always', exit: 'always' }),
    ],
  );
}

function markedMainCyclicTopology(): Topology {
  return topology(
    'A',
    [
      node('A', 'stateful', { main: true }),
      node('B', 'stateful', { main: true }),
      node('C', 'stateful', { main: true }),
      node('D', 'terminal', { main: true }),
      node('recover', 'embed', { entry: 'recover.start' }),
      node('resume', 'passive'),
      node('failed', 'terminal', { outcome: 'failure' }),
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
        branchTotal: 2,
      }),
      edge('B', 'recover.start', 'B->recover', { exit: 'needsRecovery' }),
      edge('C', 'recover.start', 'C->recover', { exit: 'needsRecovery' }),
      edge('recover.done', 'resume', 'recover->resume', { exit: 'recovered' }),
      edge('resume', 'B', 'resume->B', { kind: 'always', exit: 'always' }),
      edge('resume', 'C', 'resume->C', { kind: 'always', exit: 'always' }),
      edge('resume', 'D', 'resume->D', { kind: 'always', exit: 'always' }),
    ],
  );
}

function findNode(node: TestElkNode, id: string): TestElkNode | null {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function allElkEdges(node: TestElkNode): TestElkEdge[] {
  return [...(node.edges ?? []), ...(node.children ?? []).flatMap((child) => allElkEdges(child))];
}

function elkEdgeById(node: TestElkNode, id: string): TestElkEdge {
  const found = allElkEdges(node).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing ELK edge ${id}`);
  return found;
}

function rootScope(model: ReturnType<typeof buildGraphLayoutModel>) {
  return model.scopes.find((scope) => scope.id === 'root')!;
}

function nodeById(layout: GraphElkLayout): Map<string, GraphElkLayout['nodes'][number]> {
  return new Map(layout.nodes.map((candidate) => [candidate.id, candidate]));
}

function expectMainSpineOptions(options: TestElkLayoutOptions | undefined) {
  expect(options?.['org.eclipse.elk.layered.considerModelOrder.strategy']).toBe('NODES_AND_EDGES');
  expect(options?.['org.eclipse.elk.layered.crossingMinimization.forceNodeModelOrder']).toBe(
    'true',
  );
  expect(options?.['org.eclipse.elk.layered.cycleBreaking.strategy']).toBe('MODEL_ORDER');
  expect(options?.['org.eclipse.elk.layered.feedbackEdges']).toBe('true');
  expect(options?.['org.eclipse.elk.layered.nodePlacement.favorStraightEdges']).toBe('true');
}

function expectMainSequenceTopToBottom(layout: GraphElkLayout, sequence: string[]) {
  const nodes = nodeById(layout);
  for (let index = 1; index < sequence.length; index += 1) {
    expect(nodes.get(sequence[index])!.y).toBeGreaterThan(nodes.get(sequence[index - 1])!.y);
  }
}

function expectNodeCentersShareX(layout: GraphElkLayout, sequence: string[], tolerance = 1) {
  const nodes = nodeById(layout);
  const centers = sequence.map((nodeId) => {
    const node = nodes.get(nodeId)!;
    return node.x + node.width / 2;
  });
  const min = Math.min(...centers);
  const max = Math.max(...centers);
  expect(max - min).toBeLessThanOrEqual(tolerance);
}

function expectEdgeSegmentsShareX(layout: GraphElkLayout, semanticIds: string[], tolerance = 1) {
  const edges = new Map(layout.edges.map((candidate) => [candidate.semanticId, candidate]));
  const xs = semanticIds.flatMap((semanticId) => {
    const edge = edges.get(semanticId);
    expect(edge).toBeDefined();
    return [edge!.sourcePoint.x, ...edge!.bendPoints.map((point) => point.x), edge!.targetPoint.x];
  });
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  expect(max - min).toBeLessThanOrEqual(tolerance);
}

function expectAllVisibleSegmentsOrthogonal(layout: GraphElkLayout, tolerance = 1) {
  const diagonalSegments = layout.edges.flatMap((edge) => {
    const points = [edge.sourcePoint, ...edge.bendPoints, edge.targetPoint];
    return points.slice(1).flatMap((point, index) => {
      const previous = points[index];
      const dx = Math.abs(point.x - previous.x);
      const dy = Math.abs(point.y - previous.y);
      return dx <= tolerance || dy <= tolerance
        ? []
        : [`${edge.semanticId} segment ${index}: dx=${dx.toFixed(2)} dy=${dy.toFixed(2)}`];
    });
  });

  expect(diagonalSegments).toEqual([]);
}

function expectTerminalsBelowNonTerminals(layout: GraphElkLayout) {
  const terminals = layout.nodes.filter((candidate) => candidate.kind === 'terminal');
  const nonTerminals = layout.nodes.filter((candidate) => candidate.kind !== 'terminal');
  for (const terminal of terminals) {
    for (const nonTerminal of nonTerminals) {
      expect(terminal.y).toBeGreaterThan(nonTerminal.y);
    }
  }
}

function expectRoutedEdge(
  edge: GraphElkLayout['edges'][number] | undefined,
  semanticId: string,
  layoutRole: GraphElkLayout['edges'][number]['layoutRole'],
) {
  expect(edge?.semanticId).toBe(semanticId);
  expect(edge?.layoutRole).toBe(layoutRole);
  expect(Number.isFinite(edge?.sourcePoint.x)).toBe(true);
  expect(Number.isFinite(edge?.sourcePoint.y)).toBe(true);
  expect(Number.isFinite(edge?.targetPoint.x)).toBe(true);
  expect(Number.isFinite(edge?.targetPoint.y)).toBe(true);
  expect(Array.isArray(edge?.bendPoints)).toBe(true);
}

describe('graphElk input construction', () => {
  it('keeps collapsed embed hosts as ELK leaf nodes', () => {
    const model = buildGraphLayoutModel(compoundTopology(), new Set());
    const { graph } = buildElkGraphForTest(model);
    const spec = findNode(graph, 'spec');

    expect(graph.children?.map((child) => child.id)).toEqual(['spec', 'done']);
    expect(spec?.children).toBeUndefined();
    expect(spec?.width).toBeGreaterThan(0);
    expect(graph.layoutOptions?.['org.eclipse.elk.hierarchyHandling']).toBeUndefined();
  });

  it('builds expanded embed hosts as compound nodes with children, padding, and labels', () => {
    const model = buildGraphLayoutModel(compoundTopology(), new Set(['spec']));
    const { graph } = buildElkGraphForTest(model);
    const spec = findNode(graph, 'spec');

    expect(graph.layoutOptions?.['org.eclipse.elk.hierarchyHandling']).toBe('INCLUDE_CHILDREN');
    expect(spec?.children?.map((child) => child.id)).toEqual(['spec.compose', 'spec.shipped']);
    expect(spec?.layoutOptions?.['org.eclipse.elk.padding']).toContain('top=40');
    expect(spec?.layoutOptions?.['org.eclipse.elk.nodeLabels.placement']).toBe(
      'INSIDE H_CENTER V_TOP',
    );
    expect(spec?.labels?.[0]).toMatchObject({ text: 'spec' });
  });

  it('applies FIRST to scope entries and LAST to local sink terminals in their own scope', () => {
    const model = buildGraphLayoutModel(compoundTopology(), new Set(['spec']));
    const { graph } = buildElkGraphForTest(model);
    const spec = findNode(graph, 'spec');
    const done = findNode(graph, 'done');
    const compose = findNode(graph, 'spec.compose');
    const shipped = findNode(graph, 'spec.shipped');

    expect(spec?.layoutOptions?.['org.eclipse.elk.layered.layering.layerConstraint']).toBe('FIRST');
    expect(done?.layoutOptions?.['org.eclipse.elk.layered.layering.layerConstraint']).toBe('LAST');
    expect(compose?.layoutOptions?.['org.eclipse.elk.layered.layering.layerConstraint']).toBe(
      'FIRST',
    );
    expect(shipped?.layoutOptions?.['org.eclipse.elk.layered.layering.layerConstraint']).toBe(
      'LAST',
    );
    expect(rootScope(model).localSinkTerminalIds).toEqual(['done']);
  });

  it('preserves scoped ranked node order and sorted edge order from the model', () => {
    const model = buildGraphLayoutModel(
      topology(
        'start',
        [node('late', 'terminal'), node('start'), node('middle'), node('early', 'terminal')],
        [edge('middle', 'early', 'b'), edge('start', 'middle', 'a'), edge('middle', 'late', 'c')],
      ),
      new Set(),
    );
    const scope = rootScope(model);
    const { graph } = buildElkGraphForTest(model);

    expect(graph.children?.map((child) => child.id)).toEqual(scope.orderedNodeIds);
    expect(graph.edges?.map((candidate) => candidate.id)).toEqual(
      model.layoutEdges
        .filter((candidate) => candidate.scopeId === 'root')
        .map((candidate) => candidate.id),
    );
  });

  it('preserves recipe-runner-shaped lane order in ELK children and edges', () => {
    const model = buildGraphLayoutModel(recipeRunnerShapedTopology(), new Set());
    const { graph } = buildElkGraphForTest(model);
    const childIds = graph.children?.map((child) => child.id) ?? [];
    const mainSequence = [
      'orientSlice',
      'planSlice',
      'executeSlice',
      'reviewSlice',
      'verifySlice',
      'repairSlice',
      'finishSlice',
      'clearNextSlice',
    ];

    expect(childIds.slice(0, mainSequence.length)).toEqual(mainSequence);
    expect(childIds.indexOf('recover')).toBeGreaterThan(childIds.indexOf('clearNextSlice'));
    expect(childIds.indexOf('resumeAfterRecovery')).toBeGreaterThan(childIds.indexOf('recover'));
    expect(childIds.indexOf('failed')).toBeGreaterThan(childIds.indexOf('resumeAfterRecovery'));
    expect(childIds.indexOf('completed')).toBeGreaterThan(childIds.indexOf('resumeAfterRecovery'));
    expect(graph.edges?.map((candidate) => candidate.id)).toEqual(
      model.nodePlacementEdges
        .filter((candidate) => candidate.scopeId === 'root')
        .map((candidate) => candidate.id),
    );
  });

  it('prioritizes marked recipe-runner-shaped main edges while keeping control edges unprioritized', () => {
    const mainSequence = [
      'orientSlice',
      'planSlice',
      'executeSlice',
      'reviewSlice',
      'verifySlice',
      'finishSlice',
      'clearNextSlice',
      'completed',
    ];
    const mainEdgeIds = [
      'orient->plan',
      'plan->execute',
      'execute->review',
      'review->verify',
      'verify->finish',
      'finish->clear',
      'clear->completed',
    ];
    const controlEdgeIds = [
      'review->failed',
      'review->repair',
      'repair->review',
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
    ];
    const model = buildGraphLayoutModel(
      markMainNodes(recipeRunnerShapedTopology(), mainSequence),
      new Set(),
    );
    const { graph } = buildElkGraphForTest(model);

    expect(graph.children?.map((child) => child.id).slice(0, mainSequence.length)).toEqual(
      mainSequence,
    );
    expectMainSpineOptions(graph.layoutOptions);
    expect(graph.edges?.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining([...mainEdgeIds, ...controlEdgeIds]),
    );
    for (const semanticId of mainEdgeIds) {
      expect(
        elkEdgeById(graph, semanticId).layoutOptions?.[
          'org.eclipse.elk.layered.priority.straightness'
        ],
      ).toBe('100');
    }
    for (const semanticId of controlEdgeIds) {
      expect(
        elkEdgeById(graph, semanticId).layoutOptions?.[
          'org.eclipse.elk.layered.priority.straightness'
        ],
      ).toBeUndefined();
    }
  });

  it('uses shared fixed center ports for marked main-spine forward edges', () => {
    const mainSequence = [
      'orientSlice',
      'planSlice',
      'executeSlice',
      'reviewSlice',
      'verifySlice',
      'finishSlice',
      'clearNextSlice',
      'completed',
    ];
    const model = buildGraphLayoutModel(
      markMainNodes(recipeRunnerShapedTopology(), mainSequence),
      new Set(),
    );
    const { graph } = buildElkGraphForTest(model, { useFixedPorts: true });
    const orient = findNode(graph, 'orientSlice');
    const plan = findNode(graph, 'planSlice');
    const orientToPlan = elkEdgeById(graph, 'orient->plan');
    const reviewToFailed = elkEdgeById(graph, 'review->failed');

    expect(orientToPlan.sources).toEqual(['orientSlice:main:s']);
    expect(orientToPlan.targets).toEqual(['planSlice:main:n']);
    expect(reviewToFailed.sources).not.toContain('reviewSlice:main:s');
    expect(reviewToFailed.targets).not.toContain('failed:main:n');
    expect(orient?.layoutOptions?.['org.eclipse.elk.portConstraints']).toBe('FIXED_POS');
    expect(plan?.layoutOptions?.['org.eclipse.elk.portConstraints']).toBe('FIXED_POS');
    const orientMainOut = orient?.ports?.find((port) => port.id === 'orientSlice:main:s');
    const planMainIn = plan?.ports?.find((port) => port.id === 'planSlice:main:n');

    expect(orientMainOut).toBeDefined();
    expect(planMainIn).toBeDefined();
    expect(typeof orientMainOut?.x).toBe('number');
    expect(typeof planMainIn?.x).toBe('number');
    expect(orientMainOut?.layoutOptions?.['org.eclipse.elk.port.side']).toBe('SOUTH');
    expect(planMainIn?.layoutOptions?.['org.eclipse.elk.port.side']).toBe('NORTH');
  });

  it('adds main-spine ELK options and straightness priority only to main forward edges', () => {
    const model = buildGraphLayoutModel(markedMainCyclicTopology(), new Set());
    const { graph } = buildElkGraphForTest(model);

    expectMainSpineOptions(graph.layoutOptions);
    for (const semanticId of ['A->B', 'B->C', 'C->D']) {
      expect(
        elkEdgeById(graph, semanticId).layoutOptions?.[
          'org.eclipse.elk.layered.priority.straightness'
        ],
      ).toBe('100');
    }
    for (const semanticId of ['C->B', 'B->recover', 'resume->B']) {
      expect(
        elkEdgeById(graph, semanticId).layoutOptions?.[
          'org.eclipse.elk.layered.priority.straightness'
        ],
      ).toBeUndefined();
    }
  });

  it('keeps visible side terminals constrained to the last layer in explicit-main scopes', () => {
    const model = buildGraphLayoutModel(markedMainAcyclicTopology(), new Set());
    const { graph } = buildElkGraphForTest(model);

    expect(
      findNode(graph, 'D')?.layoutOptions?.['org.eclipse.elk.layered.layering.layerConstraint'],
    ).toBe('LAST');
    expect(
      findNode(graph, 'failed')?.layoutOptions?.[
        'org.eclipse.elk.layered.layering.layerConstraint'
      ],
    ).toBe('LAST');
  });

  it('applies main-spine ELK options to expanded compound scopes independently', () => {
    const model = buildGraphLayoutModel(
      topology(
        'box.A',
        [
          node('box', 'embed', { entry: 'box.A' }),
          node('box.A', 'stateful', { parent: 'box', main: true }),
          node('box.B', 'terminal', { parent: 'box', main: true }),
        ],
        [edge('box.A', 'box.B', 'inside')],
      ),
      new Set(['box']),
    );
    const { graph } = buildElkGraphForTest(model);
    const box = findNode(graph, 'box');

    expect(
      graph.layoutOptions?.['org.eclipse.elk.layered.crossingMinimization.forceNodeModelOrder'],
    ).toBeUndefined();
    expectMainSpineOptions(box?.layoutOptions);
    expect(
      elkEdgeById(graph, 'inside').layoutOptions?.['org.eclipse.elk.layered.priority.straightness'],
    ).toBe('100');
  });
});

describe('graphElk ELK-owned routing', () => {
  it('passes visible rank-neutral control and feedback edges to ELK routing', () => {
    const model = buildGraphLayoutModel(recipeRunnerShapedTopology(), new Set());
    const { graph } = buildElkGraphForTest(model);
    const elkEdgeIds = new Set(graph.edges?.map((candidate) => candidate.id) ?? []);

    expect(elkEdgeIds.has('orient->plan')).toBe(true);
    expect(elkEdgeIds.has('review->failed')).toBe(true);
    expect(elkEdgeIds.has('plan->recover')).toBe(true);
    expect(elkEdgeIds.has('resume->plan')).toBe(true);
    expect(elkEdgeIds.has('repair->review')).toBe(true);
  });

  it('returns ELK-routed auxiliary, resume, and feedback edges after coordinate flattening', async () => {
    const model = buildGraphLayoutModel(recipeRunnerShapedTopology(), new Set());
    const layout = await runGraphElkLayout(model);
    const bySemanticId = new Map(
      layout.edges.map((candidate) => [candidate.semanticId, candidate]),
    );

    expect(bySemanticId.get('orient->plan')?.bendPoints.length).toBeGreaterThanOrEqual(0);
    expectRoutedEdge(bySemanticId.get('plan->recover'), 'plan->recover', 'auxiliary');
    expectRoutedEdge(bySemanticId.get('resume->plan'), 'resume->plan', 'resume');
    expectRoutedEdge(bySemanticId.get('repair->review'), 'repair->review', 'feedback');
  });

  it('keeps marked acyclic main nodes monotonic while routing lower-priority side paths', async () => {
    const model = buildGraphLayoutModel(markedMainAcyclicTopology(), new Set());
    const layout = await runGraphElkLayout(model);
    const bySemanticId = new Map(
      layout.edges.map((candidate) => [candidate.semanticId, candidate]),
    );

    expectMainSequenceTopToBottom(layout, ['A', 'B', 'C', 'D']);
    expectNodeCentersShareX(layout, ['A', 'B', 'C', 'D']);
    expectEdgeSegmentsShareX(layout, ['A->B', 'B->C', 'C->D']);
    expectTerminalsBelowNonTerminals(layout);
    expectRoutedEdge(bySemanticId.get('A->B'), 'A->B', 'primary');
    expectRoutedEdge(bySemanticId.get('B->C'), 'B->C', 'primary');
    expectRoutedEdge(bySemanticId.get('C->D'), 'C->D', 'terminal');
    expectRoutedEdge(bySemanticId.get('B->recover'), 'B->recover', 'auxiliary');
    expectRoutedEdge(bySemanticId.get('resume->B'), 'resume->B', 'resume');
  });

  it('lets ELK keep marked recipe-runner-shaped routes orthogonal without post-layout rewrites', async () => {
    const mainSequence = [
      'orientSlice',
      'planSlice',
      'executeSlice',
      'reviewSlice',
      'verifySlice',
      'finishSlice',
      'clearNextSlice',
      'completed',
    ];
    const mainEdgeIds = [
      'orient->plan',
      'plan->execute',
      'execute->review',
      'review->verify',
      'verify->finish',
      'finish->clear',
      'clear->completed',
    ];
    const model = buildGraphLayoutModel(
      markMainNodes(recipeRunnerShapedTopology(), mainSequence),
      new Set(),
    );
    const layout = await runGraphElkLayout(model);

    expectMainSequenceTopToBottom(layout, mainSequence);
    expectNodeCentersShareX(layout, mainSequence);
    expectEdgeSegmentsShareX(layout, mainEdgeIds);
    expectAllVisibleSegmentsOrthogonal(layout);
  });

  it('keeps marked cyclic main nodes monotonic while routing main feedback visibly', async () => {
    const model = buildGraphLayoutModel(markedMainCyclicTopology(), new Set());
    const layout = await runGraphElkLayout(model);
    const bySemanticId = new Map(
      layout.edges.map((candidate) => [candidate.semanticId, candidate]),
    );

    expectMainSequenceTopToBottom(layout, ['A', 'B', 'C', 'D']);
    expectRoutedEdge(bySemanticId.get('A->B'), 'A->B', 'primary');
    expectRoutedEdge(bySemanticId.get('B->C'), 'B->C', 'primary');
    expectRoutedEdge(bySemanticId.get('C->D'), 'C->D', 'terminal');
    expectRoutedEdge(bySemanticId.get('C->B'), 'C->B', 'feedback');
    expectRoutedEdge(bySemanticId.get('B->recover'), 'B->recover', 'auxiliary');
    expectRoutedEdge(bySemanticId.get('resume->B'), 'resume->B', 'resume');
  });

  it('uses absolute expanded embed child bounds for ELK-routed edges', async () => {
    const model = buildGraphLayoutModel(recipeRunnerShapedTopology(), new Set(['recover']));
    const layout = await runGraphElkLayout(model);
    const nodes = nodeById(layout);
    const edge = layout.edges.find((candidate) => candidate.semanticId === 'plan->recover')!;
    const target = nodes.get('recover.start')!;

    expect(edge.targetPoint.x).toBeGreaterThanOrEqual(target.x);
    expect(edge.targetPoint.x).toBeLessThanOrEqual(target.x + target.width);
    expect(edge.targetPoint.y).toBeGreaterThanOrEqual(target.y);
    expect(edge.targetPoint.y).toBeLessThanOrEqual(target.y + target.height);
  });
});

describe('graphElk local probes', () => {
  it('accepts documented compound hierarchy and layer-constraint probes or selects the documented fallback', async () => {
    const probes = await probeGraphElkCapabilitiesForTest();

    expect(probes.layerConstraints.firstLast.ok || probes.layerConstraints.separate.ok).toBe(true);
    expect(probes.layerConstraints.mode).toBe(
      probes.layerConstraints.firstLast.ok ? 'first-last' : 'separate',
    );
  });

  it('uses fixed ports only when both routing probes pass', async () => {
    const probes = await probeGraphElkCapabilitiesForTest();
    const model = buildGraphLayoutModel(compoundTopology(), new Set(['spec']));
    const { graph } = buildElkGraphForTest(model, {
      useFixedPorts: probes.fixedPorts.useFixedPorts,
    });
    const hasPorts = Boolean(findNode(graph, 'spec.compose')?.ports?.length);

    expect(probes.fixedPorts.useFixedPorts).toBe(
      probes.fixedPorts.multiEdge.ok && probes.fixedPorts.mixedForwardBackward.ok,
    );
    expect(hasPorts).toBe(probes.fixedPorts.useFixedPorts);
  });

  it('passes ELK edge labels only when the label-shape probe succeeds', async () => {
    const probes = await probeGraphElkCapabilitiesForTest();
    const model = buildGraphLayoutModel(compoundTopology(), new Set(['spec']));
    const { graph } = buildElkGraphForTest(model, {
      useElkLabels: probes.edgeLabels.useElkLabels,
    });
    const labelledEdges = [
      ...(graph.edges ?? []),
      ...(findNode(graph, 'spec')?.edges ?? []),
    ].filter((candidate) => candidate.labels?.length);

    expect(probes.edgeLabels.useElkLabels).toBe(probes.edgeLabels.status.ok);
    expect(labelledEdges.length > 0).toBe(probes.edgeLabels.useElkLabels);
  });
});

describe('graphElk coordinate normalization', () => {
  it('flattens nested coordinates while retaining each node local scope id', async () => {
    const model = buildGraphLayoutModel(compoundTopology(), new Set(['spec']));
    const layout = await runGraphElkLayout(model);
    const nodes = nodeById(layout);
    const region = layout.compoundRegions.find((candidate) => candidate.id === 'spec')!;

    expect(region).toBeTruthy();
    expect(nodes.get('spec')?.scopeId).toBe('root');
    expect(nodes.get('spec.compose')?.scopeId).toBe('spec');
    expect(nodes.get('spec.shipped')?.scopeId).toBe('spec');
    expect(nodes.get('spec.compose')!.x).toBeGreaterThan(region.x);
    expect(nodes.get('spec.compose')!.y).toBeGreaterThan(region.y);
  });

  it('keeps scope entries above reachable same-scope nodes and local sinks below non-terminals', async () => {
    const model = buildGraphLayoutModel(compoundTopology(), new Set(['spec']));
    const layout = await runGraphElkLayout(model);
    const nodes = nodeById(layout);

    for (const scope of model.scopes) {
      const entry = scope.entryNodeId ? nodes.get(scope.entryNodeId) : null;
      if (!entry) continue;
      for (const reachableId of scope.reachableNodeIds) {
        if (reachableId === scope.entryNodeId) continue;
        expect(entry.y).toBeLessThan(nodes.get(reachableId)!.y);
      }
      for (const sinkId of scope.localSinkTerminalIds) {
        const sink = nodes.get(sinkId)!;
        const nonTerminalIds = scope.reachableNodeIds.filter((nodeId) => {
          const candidate = model.nodesById.get(nodeId);
          return candidate?.kind !== 'terminal';
        });
        for (const nonTerminalId of nonTerminalIds) {
          expect(sink.y).toBeGreaterThan(nodes.get(nonTerminalId)!.y);
        }
      }
    }
  });
});
