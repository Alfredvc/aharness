import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { zoomIdentity } from 'd3-zoom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Topology } from '../types/topology.js';
import { resolveFixture } from '../fixtures/registry.js';
import { formatNodeLabelForTest, graphInternalsForTest } from './Graph.js';
import type { GraphElkLayout, LaidOutEdge, LaidOutNode } from './graphElk.js';
import {
  buildFocusableEdges,
  buildGraphLegendItems,
  edgeEndpointRole,
  edgeFocusClassName,
  edgeTooltipText,
  nodeFocusClassName,
  type EdgeFocusState,
} from './graphInteraction.js';

const {
  EmbedToggleControl,
  buildEdgeLabelRenderItems,
  classifyFiredEdge,
  createGraphZoomBehavior,
  createLayoutRequestController,
  clampGraphTooltipPoint,
  clearGraphSelectionFromCanvasClick,
  edgeClassName,
  edgeGroupInteractionClassName,
  edgeGroupTooltipText,
  edgeInteractionClassName,
  edgePathD,
  selfLoopKindClass,
  fallbackEdgeLabelPoint,
  fitGraphTransform,
  focusableEdgesForNodeFocus,
  firedEdgeIdsForLastTransition,
  graphTransformAttribute,
  GraphLegend,
  handleEmbedToggleClick,
  nodeClassName,
  paintOrderedEdges,
  pointerMovedBeyondThreshold,
  pruneSelectedNodeId,
  pruneExpandedEmbedIds,
  renderableEdges,
  shouldClearGraphSelection,
  startGraphLayoutRequest,
  stopEmbedTogglePointerEvent,
  truncateEdgeLabel,
} = graphInternalsForTest;

const componentCss = readFileSync(new URL('./components.css', import.meta.url), 'utf8');

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

function cssRuleBody(selector: string): string {
  const normalizedSelector = selector.replace(/\s+/gu, ' ').trim();
  const rulePattern = /([^{}]+)\{([^{}]*)\}/gu;

  for (const match of componentCss.matchAll(rulePattern)) {
    const selectors = match[1]
      .split(',')
      .map((candidate) => candidate.replace(/\s+/gu, ' ').trim());
    if (selectors.includes(normalizedSelector)) return match[2];
  }

  throw new Error(`Missing CSS rule for ${selector}`);
}

function expectCssRule(selector: string, declarations: string[]) {
  const body = cssRuleBody(selector);
  for (const declaration of declarations) {
    expect(body).toContain(declaration);
  }
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

describe('Graph interaction helpers', () => {
  it('uses visible routed endpoints for edge endpoint roles', () => {
    const rerouted = edge({
      routeFrom: 'visible-source',
      routeTo: 'visible-target',
      originalFrom: 'hidden-source',
      originalTo: 'hidden-target',
    });

    expect(edgeEndpointRole(rerouted, 'visible-source')).toBe('source');
    expect(edgeEndpointRole(rerouted, 'visible-target')).toBe('target');
    expect(edgeEndpointRole(rerouted, 'hidden-source')).toBe('none');
    expect(edgeEndpointRole(rerouted, 'hidden-target')).toBe('none');
  });

  it('classifies self-loops as connected to the selected state', () => {
    const loop = edge({
      from: 'review',
      to: 'review',
      originalFrom: 'review',
      originalTo: 'review',
      routeFrom: 'review',
      routeTo: 'review',
    });

    expect(edgeEndpointRole(loop, 'review')).toBe('self');
    expect(edgeFocusClassName(loop, { selectedNodeId: 'review', hoveredEdgeId: null })).toBe(
      'edge-selected-self',
    );
  });

  it('normalizes rendered ELK edges and manual self-loops into one focusable model', () => {
    const focusableEdges = buildFocusableEdges({
      edges: [edge({ id: 'rendered', semanticId: 'rendered' })],
      selfLoops: [
        edge({
          id: 'manual-loop',
          semanticId: 'manual-loop',
          from: 'review',
          to: 'review',
          originalFrom: 'review',
          originalTo: 'review',
          routeFrom: 'review',
          routeTo: 'review',
        }),
      ],
    });

    expect(focusableEdges).toMatchObject([
      { id: 'rendered', focusableKind: 'elk-edge' },
      { id: 'manual-loop', focusableKind: 'self-loop' },
    ]);
    expect(focusableEdges.map((candidate) => edgeEndpointRole(candidate, 'review'))).toEqual([
      'none',
      'self',
    ]);
  });

  it('lets hovered edge and selected node focus classes coexist with fired classes', () => {
    const candidate = edge({
      id: 'selected-edge',
      routeFrom: 'selected',
      routeTo: 'target',
      mainRole: 'forward',
    });
    const focus: EdgeFocusState = {
      selectedNodeId: 'selected',
      hoveredEdgeId: 'selected-edge',
    };
    const interactionClassName = edgeFocusClassName(candidate, focus);
    const combinedClassName = `${edgeClassName(candidate, 'candidate', false)} ${interactionClassName}`;

    expect(interactionClassName).toBe('edge-hovered edge-selected-source');
    expect(combinedClassName).toContain('candidate-fired');
    expect(combinedClassName).toContain('main-forward');
    expect(combinedClassName).toContain('edge-hovered');
    expect(combinedClassName).toContain('edge-selected-source');
    expect(edgeFocusClassName(edge({ id: 'unrelated' }), focus)).toBe('edge-dimmed');
  });

  it('derives node focus classes from hovered edges and selected-node connected edges', () => {
    const focusableEdges = buildFocusableEdges({
      edges: [
        edge({
          id: 'selected-outgoing',
          routeFrom: 'selected',
          routeTo: 'target',
        }),
      ],
      selfLoops: [
        edge({
          id: 'hovered-loop',
          from: 'loop',
          to: 'loop',
          originalFrom: 'loop',
          originalTo: 'loop',
          routeFrom: 'loop',
          routeTo: 'loop',
        }),
      ],
    });
    const focus: EdgeFocusState = {
      selectedNodeId: 'selected',
      hoveredEdgeId: 'hovered-loop',
    };

    expect(nodeFocusClassName('selected', focus, focusableEdges)).toBe('selected edge-source');
    expect(nodeFocusClassName('target', focus, focusableEdges)).toBe('edge-target');
    expect(nodeFocusClassName('loop', focus, focusableEdges)).toBe('edge-self');
    expect(nodeFocusClassName('unrelated', focus, focusableEdges)).toBe('node-dimmed');
  });

  it('composes grouped-summary hover classes without picking one exact edge', () => {
    const first = edge({
      id: 'plan->recover',
      routeFrom: 'plan',
      routeTo: 'recover',
    });
    const second = edge({
      id: 'execute->recover',
      routeFrom: 'execute',
      routeTo: 'recover',
    });
    const unrelated = edge({
      id: 'done->archive',
      routeFrom: 'done',
      routeTo: 'archive',
    });
    const focus: EdgeFocusState = {
      selectedNodeId: 'execute',
      hoveredEdgeId: 'summary-needs-recovery',
    };
    const hoveredEdgeIds = new Set([first.id, second.id]);
    const focusableEdges = buildFocusableEdges({ edges: [first, second, unrelated] });
    const nodeFocusEdges = focusableEdgesForNodeFocus(
      focusableEdges,
      focus.hoveredEdgeId,
      hoveredEdgeIds,
    );

    expect(edgeInteractionClassName(first, focus, hoveredEdgeIds)).toBe('edge-hovered');
    expect(edgeInteractionClassName(second, focus, hoveredEdgeIds)).toBe(
      'edge-hovered edge-selected-source',
    );
    expect(edgeInteractionClassName(unrelated, focus, hoveredEdgeIds)).toBe('edge-dimmed');
    expect(edgeGroupInteractionClassName([first, second], focus, hoveredEdgeIds)).toBe(
      'edge-hovered edge-selected-source',
    );
    expect(nodeFocusClassName('plan', focus, nodeFocusEdges)).toBe('edge-source');
    expect(nodeFocusClassName('execute', focus, nodeFocusEdges)).toBe('selected edge-source');
    expect(nodeFocusClassName('recover', focus, nodeFocusEdges)).toBe('edge-target');
  });

  it('builds summary tooltip text from every edge in a grouped label', () => {
    const tooltip = edgeGroupTooltipText(
      [
        edge({
          id: 'plan->recover',
          routeFrom: 'plan',
          routeTo: 'recover',
          originalFrom: 'plan',
          originalTo: 'recover',
          exit: 'needsRecovery',
        }),
        edge({
          id: 'execute->recover',
          routeFrom: 'execute',
          routeTo: 'recover',
          originalFrom: 'execute',
          originalTo: 'recover',
          exit: 'needsRecovery',
        }),
      ],
      {
        visibleNodes: [
          labelNode('plan', { label: 'Plan' }),
          labelNode('execute', { label: 'Execute' }),
          labelNode('recover', { label: 'Recover' }),
        ],
      },
    );
    const duplicateTooltip = edgeGroupTooltipText(
      [
        edge({
          id: 'retry:first',
          routeFrom: 'retry',
          routeTo: 'recover',
          originalFrom: 'retry',
          originalTo: 'recover',
          exit: 'again',
        }),
        edge({
          id: 'retry:second',
          routeFrom: 'retry',
          routeTo: 'recover',
          originalFrom: 'retry',
          originalTo: 'recover',
          exit: 'again',
        }),
      ],
      {
        visibleNodes: [
          labelNode('retry', { label: 'Retry' }),
          labelNode('recover', { label: 'Recover' }),
        ],
      },
    );

    expect(tooltip).toContain('summary: 2 transitions');
    expect(tooltip).toContain('visible: Plan -> Recover');
    expect(tooltip).toContain('visible: Execute -> Recover');
    expect(duplicateTooltip).toContain('summary: 2 transitions');
  });

  it('prunes selected state only when it is no longer visible', () => {
    const visible = new Set(['plan', 'execute']);

    expect(pruneSelectedNodeId('plan', visible)).toBe('plan');
    expect(pruneSelectedNodeId('done', visible)).toBeNull();
    expect(pruneSelectedNodeId(null, visible)).toBeNull();
  });

  it('distinguishes blank-canvas clicks from drag movement', () => {
    expect(pointerMovedBeyondThreshold({ x: 0, y: 0 }, { x: 2, y: 2 }, 4)).toBe(false);
    expect(pointerMovedBeyondThreshold({ x: 0, y: 0 }, { x: 5, y: 0 }, 4)).toBe(true);
    expect(pointerMovedBeyondThreshold(null, { x: 20, y: 20 }, 4)).toBe(false);
  });

  it('clears external panel scope for true blank-canvas clicks', () => {
    const clearLocalSelection = vi.fn();
    const onSelectionClear = vi.fn();

    expect(
      clearGraphSelectionFromCanvasClick({
        target: null,
        pointerStart: { x: 0, y: 0 },
        pointerEnd: { x: 1, y: 1 },
        clearLocalSelection,
        onSelectionClear,
      }),
    ).toBe(true);
    expect(clearLocalSelection).toHaveBeenCalledTimes(1);
    expect(onSelectionClear).toHaveBeenCalledTimes(1);
  });

  it('does not clear external panel scope after a canvas drag', () => {
    const onSelectionClear = vi.fn();

    expect(
      clearGraphSelectionFromCanvasClick({
        target: null,
        pointerStart: { x: 0, y: 0 },
        pointerEnd: { x: 8, y: 0 },
        clearLocalSelection: vi.fn(),
        onSelectionClear,
      }),
    ).toBe(false);
    expect(onSelectionClear).not.toHaveBeenCalled();
  });

  it('does not clear external panel scope from node or edge interaction targets', () => {
    class FakeElement {
      closest(selector: string) {
        return selector.includes('.node') ? this : null;
      }
    }
    vi.stubGlobal('Element', FakeElement);
    const node = new FakeElement() as unknown as EventTarget;

    expect(
      shouldClearGraphSelection({
        target: node,
        pointerStart: { x: 0, y: 0 },
        pointerEnd: { x: 1, y: 1 },
      }),
    ).toBe(false);
  });

  it('clamps tooltip positions so right-edge hovers keep readable width', () => {
    expect(clampGraphTooltipPoint({ x: 490, y: 20 }, { width: 500, height: 240 })).toEqual({
      x: 168,
      y: 20,
    });
    expect(clampGraphTooltipPoint({ x: 180, y: 260 }, { width: 200, height: 180 })).toEqual({
      x: 12,
      y: 168,
    });
  });

  it('formats edge tooltips with routed labels and hidden semantic labels only when needed', () => {
    const tooltip = edgeTooltipText(
      edge({
        kind: 'await',
        exit: 'child_done',
        routeFrom: 'host',
        routeTo: 'visible-done',
        originalFrom: 'child-start',
        originalTo: 'child-done',
      }),
      {
        visibleNodes: [
          labelNode('host', { label: 'Collapsed Host', kind: 'embed' }),
          labelNode('visible-done', { label: 'Visible Done' }),
        ],
        topologyNodes: [
          labelNode('child-start', { label: 'Child Start' }),
          labelNode('child-done', { label: 'Child Done' }),
        ],
      },
    );
    const unchangedTooltip = edgeTooltipText(edge(), {
      visibleNodes: [labelNode('a', { label: 'Alpha' }), labelNode('b', { label: 'Beta' })],
      topologyNodes: [],
    });

    expect(tooltip).toContain('kind: await');
    expect(tooltip).toContain('exit: child_done');
    expect(tooltip).toContain('visible: Collapsed Host -> Visible Done');
    expect(tooltip).toContain('original: Child Start -> Child Done');
    expect(unchangedTooltip).toContain('visible: Alpha -> Beta');
    expect(unchangedTooltip).not.toContain('original:');
  });

  it('derives contextual legend rows as plain legend items', () => {
    const items = buildGraphLegendItems({
      nodes: [
        node({ id: 'current' }),
        node({ id: 'selected' }),
        node({
          id: 'collapsed',
          kind: 'embed',
          isCollapsedEmbedHost: true,
          activeDescendant: true,
        }),
        node({ id: 'expanded', kind: 'embed', isExpandedEmbedHost: true }),
        node({ id: 'done', kind: 'terminal', outcome: 'success' }),
      ],
      edges: buildFocusableEdges({
        edges: [
          edge({ id: 'main', semanticId: 'main', mainRole: 'forward' }),
          edge({
            id: 'side',
            semanticId: 'side',
            layoutRole: 'auxiliary',
            mainRole: 'side',
          }),
          edge({
            id: 'feedback',
            semanticId: 'feedback',
            feedbackClass: 'feedback',
            mainRole: 'feedback',
          }),
        ],
      }),
      activeStateId: 'current',
      awaitsOwner: true,
      selectedNodeId: 'selected',
      firedEdgeIds: new Set(['main']),
    });
    const labels = items.map((item) => item.label);

    expect(items[0]).toEqual({
      id: 'current-state',
      label: 'current state',
      swatch: 'sw-node sw-active',
    });
    expect(items.every((item) => Object.keys(item).sort().join(',') === 'id,label,swatch')).toBe(
      true,
    );
    expect(labels).toEqual([
      'current state',
      'waiting for owner',
      'selected state',
      'last transition',
      'main path',
      'side/control path',
      'loop/back edge',
      'collapsed embedded FSM',
      'expanded embedded FSM',
      'hidden child activity',
      'final state',
    ]);
  });

  it('omits selected and fired legend rows when the signal is not visible', () => {
    const labels = buildGraphLegendItems({
      nodes: [node({ id: 'visible' })],
      edges: buildFocusableEdges({
        edges: [edge({ id: 'visible-edge', semanticId: 'visible-edge' })],
      }),
      selectedNodeId: 'missing',
      firedEdgeIds: new Set(['missing-edge']),
    }).map((item) => item.label);

    expect(labels).not.toContain('selected state');
    expect(labels).not.toContain('last transition');
    expect(labels).not.toContain('possible last transition');
  });

  it('derives possible last-transition legend rows for parallel fired candidates', () => {
    const labels = buildGraphLegendItems({
      nodes: [node({ id: 'visible' })],
      edges: buildFocusableEdges({
        edges: [
          edge({ id: 'first', semanticId: 'first' }),
          edge({ id: 'second', semanticId: 'second' }),
        ],
      }),
      firedEdgeIds: new Set(['first', 'second']),
    }).map((item) => item.label);

    expect(labels).toContain('possible last transition');
    expect(labels).not.toContain('last transition');
  });
});

describe('Graph focus styling stylesheet', () => {
  it('keeps edge hit areas invisible, broad, and pointer-owned', () => {
    expectCssRule('.edge .edge-hit-area', [
      'pointer-events: stroke;',
      'cursor: pointer;',
      'stroke: transparent !important;',
      'stroke-width: 14 !important;',
      'animation: none !important;',
    ]);
  });

  it('makes hover and selected edge focus stronger without replacing fired semantics', () => {
    expectCssRule('.edge.edge-hovered:not(.fired):not(.candidate-fired) path:not(.edge-hit-area)', [
      'stroke-width: 2.75;',
      'opacity: 1;',
    ]);
    expectCssRule(
      '.edge.edge-selected-source:not(.fired):not(.candidate-fired) path:not(.edge-hit-area)',
      ['stroke-width: 2.55;', 'opacity: 0.98;'],
    );
    expectCssRule(
      '.edge.edge-selected-target:not(.fired):not(.candidate-fired) path:not(.edge-hit-area)',
      ['stroke-width: 2.15;', 'opacity: 0.88;'],
    );
    expectCssRule(
      '.edge.edge-selected-self:not(.fired):not(.candidate-fired) path:not(.edge-hit-area)',
      ['stroke-width: 2.85;', 'opacity: 1;'],
    );
    expectCssRule('.edge.fired.edge-hovered path:not(.edge-hit-area)', [
      'stroke: var(--plasma);',
      'stroke-width: 2.95;',
    ]);
    expectCssRule('.edge.candidate-fired.edge-hovered path:not(.edge-hit-area)', [
      'stroke: var(--plasma);',
      'stroke-dasharray: 5 4;',
    ]);
  });

  it('dims unrelated graph elements while keeping current and transition signals readable', () => {
    expectCssRule('.edge.edge-dimmed', ['opacity: 0.3;']);
    expectCssRule('.edge.edge-dimmed.fired', ['opacity: 0.86;']);
    expectCssRule('.edge.edge-dimmed.candidate-fired', ['opacity: 0.78;']);
    expectCssRule('.node.node-dimmed', ['opacity: 0.46;']);
    expectCssRule('.node.node-dimmed.active', ['opacity: 0.82;']);
    expectCssRule('.node.node-dimmed.node-terminal', ['opacity: 0.78;']);
    expectCssRule('.node.node-dimmed.awaits', ['opacity: 0.78;']);
  });

  it('styles selected and connected nodes plus constrained pointer-transparent tooltips', () => {
    expectCssRule('.node.selected .node-rect', ['stroke-width: 2.4;']);
    expectCssRule('.node.edge-source .node-rect', ['stroke-width: 2;']);
    expectCssRule('.node.edge-target .node-rect', ['stroke-dasharray: 6 3;']);
    expectCssRule('.node.edge-self .node-rect', ['stroke-width: 2.3;']);
    expectCssRule('.graph-edge-tooltip', [
      'max-width: min(320px, calc(100% - 24px));',
      'overflow-wrap: anywhere;',
      'pointer-events: none;',
    ]);
    expect(cssRuleBody('.graph-edge-tooltip')).not.toContain('right:');
  });

  it('styles choice nodes and edges distinctly', () => {
    expectCssRule('.node-choice .node-rect', [
      'fill: var(--mint-soft);',
      'stroke: var(--mint);',
      'stroke-dasharray: 5 3;',
    ]);
    expectCssRule('.edge.edge-choice:not(.fired):not(.candidate-fired) path', [
      'stroke: var(--mint);',
      'stroke-dasharray: 4 3;',
    ]);
  });

  it('keeps reduced motion disabling animation-only graph affordances', () => {
    expect(componentCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(componentCss).toContain('.edge.fired path,');
    expect(componentCss).toContain('animation: none !important;');
    expect(componentCss).toContain('.edge-pulse,\n  .legend .sw-edge-dot');
    expect(componentCss).toContain('display: none !important;');
  });

  it('styles contextual selected and final-state legend swatches', () => {
    expectCssRule('.sw-node.selected', ['border-width: 2px;', 'background: var(--panel-3);']);
    expectCssRule('.sw-node.sw-final', [
      'border-radius: 6px;',
      'background: linear-gradient(90deg, var(--mint-soft) 0 50%, var(--rose-soft) 50% 100%);',
    ]);
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

  it('adds distinct choice node and edge classes through generic class paths', () => {
    const nodeClasses = nodeClassName(node({ id: 'pick', kind: 'choice' }), {
      activeStateId: null,
      visitedNodeIds: new Set(),
      awaitsOwner: false,
      isTerminal: false,
    });
    const edgeClasses = edgeClassName(edge({ kind: 'choice' }), 'none', false);

    expect(nodeClasses).toContain('node-choice');
    expect(edgeClasses).toContain('edge-choice');
  });

  it('keeps choice self-loops styled as both self-loop and choice edges', () => {
    const kindClass = selfLoopKindClass(edge({ kind: 'choice' }));
    const className = edgeClassName(edge({ kind: 'choice' }), 'none', false, kindClass);

    expect(kindClass).toBe('edge-self edge-choice');
    expect(className).toContain('edge-self');
    expect(className).toContain('edge-choice');
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

  it('renders only the supplied contextual graph legend entries', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => 'true',
      setItem: vi.fn(),
    });

    const markup = renderToStaticMarkup(
      createElement(GraphLegend, {
        items: [
          { id: 'current-state', label: 'current state', swatch: 'sw-node sw-active' },
          { id: 'main-path', label: 'main path', swatch: 'sw-edge sw-edge-main-forward' },
          { id: 'final-state', label: 'final state', swatch: 'sw-node sw-final' },
        ],
      }),
    );

    expect(markup).toContain('current state');
    expect(markup).toContain('main path');
    expect(markup).toContain('final state');
    expect(markup).toContain('sw-node sw-final');
    expect(markup).not.toContain('visited');
    expect(markup).not.toContain('candidate fired');
    expect(markup).not.toContain('collapsed embed');
  });

  it('keeps legend rows hidden when localStorage has the legend collapsed', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => 'false',
      setItem: vi.fn(),
    });

    const markup = renderToStaticMarkup(
      createElement(GraphLegend, {
        items: [{ id: 'current-state', label: 'current state', swatch: 'sw-node sw-active' }],
      }),
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('current state');
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
    expect(labels[0]?.edges.map((candidate) => candidate.id)).toEqual([
      'plan->recover',
      'execute->recover',
      'review->recover',
    ]);
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

  it('draws single primary choice labels from the authored option label', () => {
    const labels = buildEdgeLabelRenderItems(
      [
        edge({
          kind: 'choice',
          exit: 'approve draft',
          layoutRole: 'primary',
          labelPolicy: 'default-visible',
          parallelTotal: 1,
        }),
      ],
      new Map(),
    );

    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      label: 'approve draft',
      title: 'approve draft',
      grouped: false,
    });
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
