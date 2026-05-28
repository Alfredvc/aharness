import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { zoomIdentity } from 'd3-zoom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Topology } from '../types/topology.js';
import { resolveFixture } from '../fixtures/registry.js';
import { formatNodeLabelForTest, graphInternalsForTest } from './Graph.js';
import type { GraphElkLayout, LaidOutEdge, LaidOutNode } from './graphElk.js';

const {
  EmbedToggleControl,
  buildEdgeLabelRenderItems,
  classifyFiredEdge,
  createGraphZoomBehavior,
  createLayoutRequestController,
  edgeClassName,
  edgePathD,
  fallbackEdgeLabelPoint,
  fitGraphTransform,
  firedEdgeIdsForLastTransition,
  graphTransformAttribute,
  GraphLegend,
  handleEmbedToggleClick,
  nodeClassName,
  paintOrderedEdges,
  pruneExpandedEmbedIds,
  renderableEdges,
  startGraphLayoutRequest,
  stopEmbedTogglePointerEvent,
  truncateEdgeLabel,
} = graphInternalsForTest;

afterEach(() => {
  vi.unstubAllGlobals();
});

function topology(nodes: Topology['nodes'], edges: Topology['edges'] = []): Topology {
  return {
    machineId: 'test',
    initial: nodes[0]?.id ?? 'missing',
    nodes,
    edges,
  };
}

function edge(extra: Partial<LaidOutEdge> = {}): LaidOutEdge {
  return {
    id: 'edge',
    semanticId: 'edge',
    from: 'a',
    to: 'b',
    originalFrom: 'a',
    originalTo: 'b',
    rankFrom: 'a',
    rankTo: 'b',
    routeFrom: 'a',
    routeTo: 'b',
    exit: 'go',
    kind: 'submit',
    scopeId: 'root',
    isRankOnly: false,
    isVisible: true,
    feedbackClass: 'forward',
    layoutRole: 'primary',
    rankPolicy: 'rank-defining',
    labelPolicy: 'default-visible',
    mainRole: 'none',
    parallelGroupKey: 'a\x00b',
    parallelIndex: 0,
    parallelTotal: 1,
    labelWidth: 48,
    edgeIndex: 0,
    bendPoints: [],
    sourcePoint: { x: 0, y: 0 },
    targetPoint: { x: 1, y: 1 },
    ...extra,
  };
}

function labelNode(
  id: string,
  extra: Partial<Pick<Topology['nodes'][number], 'label' | 'kind' | 'outcome'>> = {},
) {
  return {
    id,
    label: extra.label ?? id,
    kind: extra.kind ?? 'stateful',
    outcome: extra.outcome,
  };
}

function node(extra: Partial<LaidOutNode> = {}): LaidOutNode {
  return {
    id: 'node',
    label: 'node',
    kind: 'stateful',
    x: 0,
    y: 0,
    width: 150,
    height: 56,
    scopeId: 'root',
    isExpandedEmbedHost: false,
    isCollapsedEmbedHost: false,
    activeDescendant: false,
    visitedDescendant: false,
    ...extra,
  };
}

function layout(width: number, warning = ''): GraphElkLayout {
  return {
    nodes: [],
    edges: [],
    selfLoops: [],
    compoundRegions: [],
    warnings: warning ? [{ code: 'elk-probe', message: warning }] : [],
    probeResults: {
      layerConstraints: {
        mode: 'first-last',
        firstLast: { ok: true, message: 'accepted' },
        separate: { ok: true, message: 'accepted' },
      },
      fixedPorts: {
        useFixedPorts: false,
        multiEdge: { ok: false, message: 'not used' },
        mixedForwardBackward: { ok: false, message: 'not used' },
      },
      edgeLabels: {
        useElkLabels: false,
        status: { ok: false, message: 'not used' },
      },
    },
    width,
    height: 100,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Graph node labels', () => {
  it('renders passive states with their state name instead of an empty diamond glyph', () => {
    expect(
      formatNodeLabelForTest({
        label: 'writeVictoryArtifact',
        kind: 'passive',
      }),
    ).toBe('writeVictoryArtifact');
  });
});

describe('Graph expansion and async layout helpers', () => {
  it('prunes expanded embed ids that are removed or no longer embed nodes', () => {
    const next = pruneExpandedEmbedIds(
      new Set(['kept', 'plain', 'missing']),
      topology([
        { id: 'kept', label: 'kept', kind: 'embed', entry: 'child' },
        { id: 'plain', label: 'plain', kind: 'stateful' },
      ]),
    );

    expect([...next]).toEqual(['kept']);
  });

  it('accepts only the latest layout request id', () => {
    const requests = createLayoutRequestController();
    const first = requests.next();
    const second = requests.next();

    expect(requests.isCurrent(first)).toBe(false);
    expect(requests.isCurrent(second)).toBe(true);

    requests.invalidate(second);
    expect(requests.isCurrent(second)).toBe(false);
  });

  it('applies only the latest async layout result and keeps the prior layout while pending', async () => {
    const requests = createLayoutRequestController();
    const first = deferred<GraphElkLayout>();
    const second = deferred<GraphElkLayout>();
    const graph = topology([{ id: 'a', label: 'a', kind: 'stateful' }]);
    const applied: GraphElkLayout[] = [layout(10)];
    const warnings: string[] = [];
    let call = 0;
    const layoutRunner = () => {
      call += 1;
      return call === 1 ? first.promise : second.promise;
    };

    startGraphLayoutRequest({
      topology: graph,
      expandedEmbedIds: new Set(),
      activeStateId: null,
      visitedNodeIds: new Set(),
      requests,
      layoutRunner,
      onLayout: (next) => applied.push(next),
      onWarning: (message) => warnings.push(message),
      onError: (error) => {
        throw error;
      },
    });
    startGraphLayoutRequest({
      topology: graph,
      expandedEmbedIds: new Set(),
      activeStateId: null,
      visitedNodeIds: new Set(),
      requests,
      layoutRunner,
      onLayout: (next) => applied.push(next),
      onWarning: (message) => warnings.push(message),
      onError: (error) => {
        throw error;
      },
    });

    expect(applied.map((candidate) => candidate.width)).toEqual([10]);
    first.resolve(layout(20, 'stale'));
    await flushPromises();
    expect(applied.map((candidate) => candidate.width)).toEqual([10]);
    expect(warnings).toEqual([]);

    second.resolve(layout(30, 'fresh'));
    await flushPromises();
    expect(applied.map((candidate) => candidate.width)).toEqual([10, 30]);
    expect(warnings).toEqual(['fresh']);
  });

  it('renders dedicated expand and collapse controls with accessible names', () => {
    const expand = renderToStaticMarkup(
      createElement(EmbedToggleControl, {
        x: 0,
        y: 0,
        label: 'delegate',
        expanded: false,
        onToggle: () => undefined,
      }),
    );
    const collapse = renderToStaticMarkup(
      createElement(EmbedToggleControl, {
        x: 0,
        y: 0,
        label: 'delegate',
        expanded: true,
        onToggle: () => undefined,
      }),
    );

    expect(expand).toContain('aria-label="Expand delegate"');
    expect(collapse).toContain('aria-label="Collapse delegate"');
    expect(expand).toContain('<button');
  });

  it('stops node body selection when the embed toggle is clicked', () => {
    const calls: string[] = [];

    handleEmbedToggleClick(
      {
        stopPropagation: () => calls.push('stop'),
      },
      () => calls.push('toggle'),
    );

    expect(calls).toEqual(['stop', 'toggle']);
  });

  it('stops graph pan gestures when pressing the embed toggle', () => {
    const calls: string[] = [];

    stopEmbedTogglePointerEvent({
      stopPropagation: () => calls.push('stop'),
    });

    expect(calls).toEqual(['stop']);
  });
});

describe('Graph zoom interactions', () => {
  it('creates a d3 zoom behavior with graph scale limits and live SVG viewport extents', () => {
    const behavior = createGraphZoomBehavior(() => undefined);
    const extent = behavior.extent();
    const svg = {
      getBoundingClientRect: () => ({ width: 640, height: 480 }),
    } as SVGSVGElement;

    expect(behavior.scaleExtent()).toEqual([0.2, 2.4]);
    expect(extent.call(svg, undefined)).toEqual([
      [0, 0],
      [640, 480],
    ]);
  });

  it('uses d3 zoom transforms for fit and SVG rendering', () => {
    const transform = fitGraphTransform(layout(400), { width: 500, height: 300 });

    expect(transform.k).toBeCloseTo(0.8625);
    expect(transform.x).toBeCloseTo(80.95);
    expect(transform.y).toBeCloseTo(125.85);
    expect(graphTransformAttribute(zoomIdentity.translate(12, 34).scale(1.5))).toBe(
      'translate(12,34) scale(1.5)',
    );
  });
});

describe('Graph edge rendering helpers', () => {
  it('filters rank-only edges before SVG rendering', () => {
    expect(
      renderableEdges([
        edge({ id: 'visible', semanticId: 'visible' }),
        edge({ id: 'rank', semanticId: 'visible', isRankOnly: true }),
      ]).map((candidate) => candidate.id),
    ).toEqual(['visible']);
  });

  it('reserves exact fired for a single from-to match and marks parallel matches as candidates', () => {
    const graph = topology(
      [
        { id: 'a', label: 'a', kind: 'stateful' },
        { id: 'b', label: 'b', kind: 'stateful' },
      ],
      [
        { id: 'first', from: 'a', to: 'b', exit: 'first', kind: 'submit' },
        { id: 'second', from: 'a', to: 'b', exit: 'second', kind: 'submit' },
      ],
    );
    const parallelMatches = firedEdgeIdsForLastTransition(graph, [
      { from: 'a', to: 'b', cause: 'submit', at: 1 },
    ]);
    const singleMatches = firedEdgeIdsForLastTransition({ ...graph, edges: [graph.edges[0]] }, [
      { from: 'a', to: 'b', cause: 'submit', at: 1 },
    ]);

    expect(classifyFiredEdge(edge({ semanticId: 'first' }), parallelMatches)).toBe('candidate');
    expect(classifyFiredEdge(edge({ semanticId: 'second' }), parallelMatches)).toBe('candidate');
    expect(classifyFiredEdge(edge({ semanticId: 'first' }), singleMatches)).toBe('exact');
  });

  it('adds distinct feedback and lower-emphasis candidate fired classes', () => {
    expect(edgeClassName(edge({ feedbackClass: 'feedback' }), 'none', false)).toContain(
      'feedback-feedback',
    );
    expect(edgeClassName(edge({ feedbackClass: 'cycle-feedback' }), 'candidate', false)).toContain(
      'feedback-cycle-feedback',
    );
    expect(edgeClassName(edge({ feedbackClass: 'cycle-feedback' }), 'candidate', false)).toContain(
      'candidate-fired',
    );
  });

  it('adds semantic role classes alongside transition-priority classes', () => {
    const className = edgeClassName(
      edge({
        layoutRole: 'auxiliary',
        rankPolicy: 'rank-neutral',
        labelPolicy: 'grouped-summary',
      }),
      'candidate',
      false,
    );

    expect(className).toContain('edge-role-auxiliary');
    expect(className).toContain('rank-rank-neutral');
    expect(className).toContain('label-grouped-summary');
    expect(className).toContain('candidate-fired');
  });

  it('adds main path classes without suppressing fired state classes', () => {
    const forward = edgeClassName(edge({ mainRole: 'forward' }), 'none', false);
    const feedback = edgeClassName(edge({ mainRole: 'feedback' }), 'none', false, 'edge-self');
    const firedForward = edgeClassName(edge({ mainRole: 'forward' }), 'exact', false);

    expect(forward).toContain('main-forward');
    expect(forward).not.toContain('main-feedback');
    expect(feedback).toContain('main-feedback');
    expect(feedback).toContain('edge-self');
    expect(firedForward).toContain('main-forward');
    expect(firedForward).toContain('fired');
  });

  it('paints passive main edges above lower-priority edges but below fired edges', () => {
    const ordered = paintOrderedEdges(
      [
        edge({
          id: 'main-forward',
          semanticId: 'main-forward',
          mainRole: 'forward',
        }),
        edge({
          id: 'auxiliary',
          semanticId: 'auxiliary',
          layoutRole: 'auxiliary',
          rankPolicy: 'rank-neutral',
          mainRole: 'none',
        }),
        edge({
          id: 'main-feedback',
          semanticId: 'main-feedback',
          layoutRole: 'feedback',
          mainRole: 'feedback',
        }),
        edge({
          id: 'fired-auxiliary',
          semanticId: 'fired-auxiliary',
          layoutRole: 'auxiliary',
          mainRole: 'none',
        }),
      ],
      new Set(['fired-auxiliary']),
    );

    expect(ordered.map((candidate) => candidate.id)).toEqual([
      'auxiliary',
      'main-feedback',
      'main-forward',
      'fired-auxiliary',
    ]);
  });

  it('keeps recipe-shaped side and control edges below main-forward rendering priority', () => {
    const sideEdges = [
      edge({
        id: 'review->failed',
        semanticId: 'review->failed',
        layoutRole: 'terminal',
        rankPolicy: 'rank-neutral',
        mainRole: 'side',
      }),
      edge({
        id: 'plan->recover',
        semanticId: 'plan->recover',
        layoutRole: 'auxiliary',
        rankPolicy: 'rank-neutral',
        mainRole: 'side',
      }),
      edge({
        id: 'resume->plan',
        semanticId: 'resume->plan',
        layoutRole: 'resume',
        rankPolicy: 'rank-neutral',
        mainRole: 'side',
      }),
      edge({
        id: 'repair->review',
        semanticId: 'repair->review',
        feedbackClass: 'feedback',
        layoutRole: 'feedback',
        rankPolicy: 'rank-neutral',
        mainRole: 'side',
      }),
    ];
    const mainForward = edge({
      id: 'orient->plan',
      semanticId: 'orient->plan',
      mainRole: 'forward',
    });

    for (const candidate of sideEdges) {
      const className = edgeClassName(candidate, 'none', false);
      expect(className).toContain('main-side');
      expect(className).not.toContain('main-forward');
      expect(className).not.toContain('main-feedback');
    }
    const ordered = paintOrderedEdges([...sideEdges, mainForward]);

    expect(ordered[ordered.length - 1]?.semanticId).toBe('orient->plan');
  });

  it('adds a main node class from VizNode main metadata', () => {
    const className = nodeClassName(node({ id: 'plan', main: true }), {
      activeStateId: null,
      visitedNodeIds: new Set(),
      awaitsOwner: false,
      isTerminal: false,
    });

    expect(className).toContain('main');
    expect(className).toContain('unvisited');
  });

  it('renders the semantic graph legend entries', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => 'true',
      setItem: vi.fn(),
    });

    const markup = renderToStaticMarkup(createElement(GraphLegend));

    expect(markup).toContain('primary path');
    expect(markup).toContain('main feedback loop');
    expect(markup).toContain('auxiliary/control flow');
    expect(markup).toContain('candidate fired');
    expect(markup).toContain('collapsed embed');
    expect(markup).toContain('expanded embed');
  });

  it('truncates long labels to fit the deterministic label width', () => {
    expect(truncateEdgeLabel('short', 150)).toBe('short');
    expect(truncateEdgeLabel('child_success_with_a_long_label', 62)).toBe('child…');
  });

  it('groups repeated auxiliary labels into one summary label', () => {
    const labels = buildEdgeLabelRenderItems(
      [
        edge({
          id: 'plan->recover',
          semanticId: 'plan->recover',
          from: 'plan',
          originalFrom: 'plan',
          rankFrom: 'plan',
          routeFrom: 'plan',
          to: 'recover',
          originalTo: 'recover',
          rankTo: 'recover',
          routeTo: 'recover',
          exit: 'needsRecovery',
          layoutRole: 'auxiliary',
          rankPolicy: 'rank-neutral',
          labelPolicy: 'grouped-summary',
          sourcePoint: { x: 0, y: 0 },
          targetPoint: { x: 80, y: 80 },
        }),
        edge({
          id: 'execute->recover',
          semanticId: 'execute->recover',
          from: 'execute',
          originalFrom: 'execute',
          rankFrom: 'execute',
          routeFrom: 'execute',
          to: 'recover',
          originalTo: 'recover',
          rankTo: 'recover',
          routeTo: 'recover',
          exit: 'needsRecovery',
          layoutRole: 'auxiliary',
          rankPolicy: 'rank-neutral',
          labelPolicy: 'grouped-summary',
          sourcePoint: { x: 80, y: 0 },
          targetPoint: { x: 80, y: 80 },
        }),
        edge({
          id: 'review->recover',
          semanticId: 'review->recover',
          from: 'review',
          originalFrom: 'review',
          rankFrom: 'review',
          routeFrom: 'review',
          to: 'recover',
          originalTo: 'recover',
          rankTo: 'recover',
          routeTo: 'recover',
          exit: 'needsRecovery',
          layoutRole: 'auxiliary',
          rankPolicy: 'rank-neutral',
          labelPolicy: 'grouped-summary',
          sourcePoint: { x: 160, y: 0 },
          targetPoint: { x: 80, y: 80 },
        }),
      ],
      new Map([['recover', labelNode('recover', { kind: 'embed' })]]),
    );

    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      label: 'needsRecovery x3',
      title: 'needsRecovery',
      grouped: true,
    });
  });

  it('uses target outcome fallback instead of branch suffixes for visible branch labels', () => {
    const labels = buildEdgeLabelRenderItems(
      [
        edge({
          id: 'review->failed',
          semanticId: 'review->failed',
          to: 'failed',
          originalTo: 'failed',
          rankTo: 'failed',
          routeTo: 'failed',
          exit: 'branch',
          branchIndex: 0,
          branchTotal: 2,
          layoutRole: 'terminal',
          labelPolicy: 'default-visible',
        }),
      ],
      new Map([['failed', labelNode('failed', { kind: 'terminal', outcome: 'failure' })]]),
    );

    expect(labels[0]?.label).toBe('failure');
    expect(labels[0]?.title).toBe('branch#0');
  });

  it('keeps target-derived long labels inside the computed edge label width', () => {
    const labels = buildEdgeLabelRenderItems(
      [
        edge({
          id: 'route->target',
          semanticId: 'route->target',
          to: 'target',
          originalTo: 'target',
          rankTo: 'target',
          routeTo: 'target',
          exit: 'route',
          branchIndex: 1,
          branchTotal: 2,
          layoutRole: 'branch',
          labelPolicy: 'default-visible',
          labelWidth: 62,
        }),
      ],
      new Map([['target', labelNode('target', { label: 'target_with_a_long_label' })]]),
    );

    expect(labels[0]?.label).toBe('target_with_a_long_label');
    expect(labels[0]?.width).toBe(62);
    expect(truncateEdgeLabel(labels[0]?.label ?? '', labels[0]?.width ?? 0)).toBe('targe…');
  });

  it('does not draw low-information single primary labels by default', () => {
    expect(
      buildEdgeLabelRenderItems(
        [edge({ layoutRole: 'primary', labelPolicy: 'default-visible', parallelTotal: 1 })],
        new Map(),
      ),
    ).toEqual([]);
  });

  it('offsets fallback labels for parallel rendered edges', () => {
    const first = fallbackEdgeLabelPoint(
      edge({
        parallelIndex: 0,
        parallelTotal: 2,
        sourcePoint: { x: 0, y: 0 },
        targetPoint: { x: 100, y: 0 },
      }),
    );
    const second = fallbackEdgeLabelPoint(
      edge({
        parallelIndex: 1,
        parallelTotal: 2,
        sourcePoint: { x: 0, y: 0 },
        targetPoint: { x: 100, y: 0 },
      }),
    );

    expect(first).toEqual({ x: 50, y: -9 });
    expect(second).toEqual({ x: 50, y: 9 });
  });

  it('builds SVG paths from the same laid-out points for primary and control edges', () => {
    expect(
      edgePathD(
        edge({
          layoutRole: 'auxiliary',
          rankPolicy: 'rank-neutral',
          sourcePoint: { x: 10, y: 20 },
          bendPoints: [
            { x: 40, y: 20 },
            { x: 40, y: 90 },
          ],
          targetPoint: { x: 100, y: 90 },
        }),
      ),
    ).toBe('M 10 20 L 40 20 L 40 90 L 100 90');
  });
});

describe('embed fixture', () => {
  it('registers a topology that exercises one-level embed expansion', () => {
    const fixture = resolveFixture('embed');

    expect(fixture.topology.nodes.some((node) => node.kind === 'embed' && !node.parent)).toBe(true);
    expect(fixture.topology.nodes.some((node) => node.kind === 'embed' && node.parent)).toBe(true);
    expect(fixture.topology.edges.some((candidate) => candidate.from === candidate.to)).toBe(true);
    expect(fixture.topology.edges.some((candidate) => candidate.exit === 'embed-final')).toBe(true);
  });
});
