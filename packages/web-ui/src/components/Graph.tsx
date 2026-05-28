import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { select } from 'd3-selection';
import {
  zoom as d3Zoom,
  zoomIdentity,
  type D3ZoomEvent,
  type ZoomBehavior,
  type ZoomTransform,
} from 'd3-zoom';
import type { Topology } from '../types/topology';
import { buildGraphLayoutModel } from './graphLayoutModel.js';
import {
  formatNodeLabelForTest as formatNodeLabel,
  runGraphElkLayout,
  type GraphElkLayout,
  type LaidOutEdge,
  type LaidOutNode,
} from './graphElk.js';
import {
  buildFocusableEdges,
  buildGraphLegendItems,
  edgeFocusClassName,
  edgeTooltipText,
  nodeFocusClassName,
  type EdgeFocusState,
  type EdgeTooltipLabelContext,
  type FocusableEdge,
  type LegendItem,
} from './graphInteraction.js';

type Props = {
  topology: Topology;
  activeStateId: string | null;
  history: Array<{ from: string | null; to: string; cause: string; at: number }>;
  awaitsOwner: boolean;
  isTerminal: boolean;
  onNodeClick?: (id: string) => void;
};

type Layout = GraphElkLayout;

type GraphPointerPoint = {
  x: number;
  y: number;
};

type EdgeTooltipState = {
  content: string;
  x: number;
  y: number;
};

export { formatNodeLabelForTest } from './graphElk.js';

async function runLayout(
  topology: Topology,
  expandedEmbedIds: ReadonlySet<string>,
  activeStateId: string | null,
  visitedNodeIds: ReadonlySet<string>,
): Promise<Layout> {
  const model = buildGraphLayoutModel(topology, expandedEmbedIds, {
    activeStateId,
    visitedNodeIds,
  });
  return runGraphElkLayout(model);
}

type LayoutRunner = typeof runLayout;

type LayoutRequestController = {
  next: () => number;
  isCurrent: (id: number) => boolean;
  invalidate: (id: number) => void;
};

function createLayoutRequestController(): LayoutRequestController {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
    isCurrent(id) {
      return id === current;
    },
    invalidate(id) {
      if (id === current) current += 1;
    },
  };
}

function startGraphLayoutRequest({
  topology,
  expandedEmbedIds,
  activeStateId,
  visitedNodeIds,
  requests,
  layoutRunner,
  onLayout,
  onWarning,
  onError,
}: {
  topology: Topology;
  expandedEmbedIds: ReadonlySet<string>;
  activeStateId: string | null;
  visitedNodeIds: ReadonlySet<string>;
  requests: LayoutRequestController;
  layoutRunner: LayoutRunner;
  onLayout: (layout: Layout) => void;
  onWarning: (message: string) => void;
  onError: (error: unknown) => void;
}): () => void {
  const requestId = requests.next();
  layoutRunner(topology, expandedEmbedIds, activeStateId, visitedNodeIds)
    .then((nextLayout) => {
      if (!requests.isCurrent(requestId)) return;
      for (const warning of nextLayout.warnings) onWarning(warning.message);
      onLayout(nextLayout);
    })
    .catch((err) => {
      if (!requests.isCurrent(requestId)) return;
      onError(err);
    });
  return () => requests.invalidate(requestId);
}

function topologyEmbedIds(topology: Topology): Set<string> {
  return new Set(topology.nodes.filter((node) => node.kind === 'embed').map((node) => node.id));
}

function pruneExpandedEmbedIds(
  expandedEmbedIds: ReadonlySet<string>,
  topology: Topology,
): Set<string> {
  const embedIds = topologyEmbedIds(topology);
  return new Set([...expandedEmbedIds].filter((id) => embedIds.has(id)));
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

type FiredEdgeState = 'none' | 'exact' | 'candidate';

function classifyFiredEdge(
  edge: Pick<LaidOutEdge, 'semanticId'>,
  matchingEdgeIds: ReadonlySet<string>,
): FiredEdgeState {
  if (matchingEdgeIds.size === 0) return 'none';
  if (!matchingEdgeIds.has(edge.semanticId)) return 'none';
  return matchingEdgeIds.size === 1 ? 'exact' : 'candidate';
}

function firedEdgeIdsForLastTransition(topology: Topology, history: Props['history']): Set<string> {
  if (history.length === 0) return new Set();
  const last = history[history.length - 1];
  if (!last.from) return new Set();
  return new Set(
    topology.edges
      .filter((edge) => edge.from === last.from && edge.to === last.to)
      .map((edge) => edge.id),
  );
}

function hasTransition(history: Props['history'], from: string, to: string): boolean {
  return history.some((entry) => entry.from === from && entry.to === to);
}

function renderableEdges(edges: ReadonlyArray<LaidOutEdge>): LaidOutEdge[] {
  return edges.filter((edge) => !edge.isRankOnly);
}

function edgeClassName(
  edge: Pick<
    LaidOutEdge,
    'kind' | 'feedbackClass' | 'layoutRole' | 'rankPolicy' | 'labelPolicy' | 'mainRole'
  >,
  fired: FiredEdgeState,
  visited: boolean,
  kindClass = `edge-${edge.kind}`,
): string {
  return [
    'edge',
    kindClass,
    `edge-role-${edge.layoutRole}`,
    `rank-${edge.rankPolicy}`,
    `label-${edge.labelPolicy}`,
    `feedback-${edge.feedbackClass}`,
    edge.mainRole === 'none' ? '' : `main-${edge.mainRole}`,
    fired === 'exact' ? 'fired' : '',
    fired === 'candidate' ? 'candidate-fired' : '',
    visited ? 'visited' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

type EdgePaintInput = Pick<
  LaidOutEdge,
  'id' | 'semanticId' | 'feedbackClass' | 'layoutRole' | 'mainRole'
>;

type EdgePathRenderItem = EdgePaintInput & {
  edge: LaidOutEdge | Layout['selfLoops'][number];
  kindClass: string | null;
  pathId: string;
  d: string;
};

function edgePaintPriority(edge: EdgePaintInput, fired: FiredEdgeState): number {
  if (fired === 'exact') return 60;
  if (fired === 'candidate') return 50;
  if (edge.mainRole === 'forward') return 40;
  if (edge.mainRole === 'feedback') return 35;
  if (edge.feedbackClass === 'feedback' || edge.feedbackClass === 'cycle-feedback') return 30;
  if (
    edge.layoutRole === 'primary' ||
    edge.layoutRole === 'branch' ||
    edge.layoutRole === 'terminal'
  ) {
    return 20;
  }
  return 10;
}

function paintOrderedEdges<T extends EdgePaintInput>(
  edges: ReadonlyArray<T>,
  matchingEdgeIds: ReadonlySet<string> = new Set<string>(),
): T[] {
  return edges
    .map((edge, index) => ({ edge, index }))
    .sort((a, b) => {
      const aPriority = edgePaintPriority(a.edge, classifyFiredEdge(a.edge, matchingEdgeIds));
      const bPriority = edgePaintPriority(b.edge, classifyFiredEdge(b.edge, matchingEdgeIds));
      if (aPriority !== bPriority) return aPriority - bPriority;
      return a.index - b.index;
    })
    .map(({ edge }) => edge);
}

function edgePathClassName(item: EdgePathRenderItem, fired: FiredEdgeState, visited: boolean) {
  return item.kindClass
    ? edgeClassName(item.edge, fired, visited, item.kindClass)
    : edgeClassName(item.edge, fired, visited);
}

function truncateEdgeLabel(label: string, labelWidth: number): string {
  const maxChars = Math.max(1, Math.floor((labelWidth - 20) / 7));
  if (label.length <= maxChars) return label;
  if (maxChars <= 1) return '…';
  return `${label.slice(0, maxChars - 1)}…`;
}

function edgeLabelWidth(label: string): number {
  return Math.max(48, Math.min(150, label.length * 7 + 20));
}

type EdgeLabelNode = Pick<LaidOutNode, 'id' | 'label' | 'kind' | 'outcome'>;

type EdgeLabelRenderItem = {
  key: string;
  edge: LaidOutEdge;
  edges: LaidOutEdge[];
  x: number;
  y: number;
  label: string;
  title: string;
  width: number;
  grouped: boolean;
};

function edgeRawLabel(edge: Pick<LaidOutEdge, 'exit' | 'branchIndex' | 'branchTotal'>): string {
  const branchSuffix =
    typeof edge.branchIndex === 'number' && typeof edge.branchTotal === 'number'
      ? `#${edge.branchIndex}`
      : '';
  return `${edge.exit}${branchSuffix}`;
}

function edgeTitleText(edge: Pick<LaidOutEdge, 'exit' | 'branchIndex' | 'branchTotal'>): string {
  return edgeRawLabel(edge);
}

function leafOfLabel(label: string): string {
  return label.split('.').pop() ?? label;
}

function edgeTargetLabel(edge: LaidOutEdge, nodesById: ReadonlyMap<string, EdgeLabelNode>): string {
  const target =
    nodesById.get(edge.routeTo) ??
    nodesById.get(edge.to) ??
    nodesById.get(edge.rankTo) ??
    nodesById.get(edge.originalTo);
  if (!target) return '';
  if (target.kind === 'terminal' && target.outcome) return target.outcome;
  return leafOfLabel(target.label || target.id);
}

function visibleEdgeLabel(
  edge: LaidOutEdge,
  nodesById: ReadonlyMap<string, EdgeLabelNode>,
): string {
  const fallback = edgeTargetLabel(edge, nodesById);
  if (typeof edge.branchIndex === 'number' && typeof edge.branchTotal === 'number' && fallback) {
    return fallback;
  }
  return edge.exit || fallback || edgeRawLabel(edge);
}

function shouldDrawIndividualEdgeLabel(edge: LaidOutEdge): boolean {
  if (edge.labelPolicy !== 'default-visible') return false;
  return (
    edge.layoutRole === 'branch' ||
    edge.layoutRole === 'terminal' ||
    edge.parallelTotal > 1 ||
    (typeof edge.branchTotal === 'number' && edge.branchTotal > 1)
  );
}

function edgeSummaryGroupKey(edge: LaidOutEdge, label: string): string {
  const anchor = edge.layoutRole === 'resume' ? edge.rankFrom : edge.rankTo;
  return [edge.scopeId, edge.layoutRole, anchor, label].join('\x00');
}

function edgeLabelPoint(edge: LaidOutEdge): { x: number; y: number } | null {
  if (edge.labelPoint) return edge.labelPoint;
  return fallbackEdgeLabelPoint(edge);
}

function averageEdgeLabelPoint(edges: ReadonlyArray<LaidOutEdge>): { x: number; y: number } | null {
  const points = edges
    .map(edgeLabelPoint)
    .filter((point): point is { x: number; y: number } => Boolean(point));
  if (points.length === 0) return null;
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function buildEdgeLabelRenderItems(
  edges: ReadonlyArray<LaidOutEdge>,
  nodesById: ReadonlyMap<string, EdgeLabelNode>,
): EdgeLabelRenderItem[] {
  const grouped = new Map<string, { label: string; edges: LaidOutEdge[] }>();
  const items: EdgeLabelRenderItem[] = [];

  for (const edge of edges) {
    const label = visibleEdgeLabel(edge, nodesById);
    if (edge.labelPolicy === 'grouped-summary') {
      const key = edgeSummaryGroupKey(edge, label);
      const group = grouped.get(key) ?? { label, edges: [] };
      group.edges.push(edge);
      grouped.set(key, group);
      continue;
    }

    if (!shouldDrawIndividualEdgeLabel(edge)) continue;
    const point = edgeLabelPoint(edge);
    if (!point) continue;
    items.push({
      key: edge.id,
      edge,
      edges: [edge],
      x: point.x,
      y: point.y,
      label,
      title: edgeTitleText(edge),
      width: edge.labelWidth,
      grouped: false,
    });
  }

  for (const [key, group] of grouped) {
    const point = averageEdgeLabelPoint(group.edges);
    if (!point) continue;
    const label = group.edges.length > 1 ? `${group.label} x${group.edges.length}` : group.label;
    items.push({
      key,
      edge: group.edges[0],
      edges: group.edges,
      x: point.x,
      y: point.y,
      label,
      title: [...new Set(group.edges.map(edgeTitleText))].join(', '),
      width: edgeLabelWidth(label),
      grouped: true,
    });
  }

  return items;
}

type EmbedToggleClickEvent = {
  stopPropagation: () => void;
};

type EmbedTogglePointerEvent = {
  stopPropagation: () => void;
};

function handleEmbedToggleClick(event: EmbedToggleClickEvent, onToggle: () => void) {
  event.stopPropagation();
  onToggle();
}

function stopEmbedTogglePointerEvent(event: EmbedTogglePointerEvent) {
  event.stopPropagation();
}

function edgePathD(e: LaidOutEdge): string {
  const pts = [e.sourcePoint, ...e.bendPoints, e.targetPoint];
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
}

function selfLoopPath(node: LaidOutNode): { d: string; labelX: number; labelY: number } {
  // Arc above the node: out the top-right, curl up and around, back to top-left.
  const top = node.y;
  const xR = node.x + node.width - 14;
  const xL = node.x + 14;
  const arcTop = top - 36;
  const d = `M ${xR} ${top} C ${xR + 30} ${arcTop}, ${xL - 30} ${arcTop}, ${xL} ${top}`;
  return { d, labelX: node.x + node.width / 2, labelY: arcTop + 4 };
}

type NodeClassState = {
  activeStateId: string | null;
  visitedNodeIds: ReadonlySet<string>;
  awaitsOwner: boolean;
  isTerminal: boolean;
};

function nodeClassName(
  node: Pick<
    LaidOutNode,
    | 'id'
    | 'kind'
    | 'isCollapsedEmbedHost'
    | 'activeDescendant'
    | 'visitedDescendant'
    | 'outcome'
    | 'main'
  >,
  state: NodeClassState,
): string {
  const isActive = node.id === state.activeStateId;
  const isVisited = state.visitedNodeIds.has(node.id);
  return [
    'node',
    `node-${node.kind}`,
    node.main ? 'main' : '',
    node.isCollapsedEmbedHost ? 'collapsed-embed' : '',
    isActive ? 'active' : '',
    isVisited && !isActive ? 'visited' : '',
    !isVisited && !isActive ? 'unvisited' : '',
    node.activeDescendant ? 'active-descendant' : '',
    node.visitedDescendant ? 'visited-descendant' : '',
    isActive && state.awaitsOwner ? 'awaits' : '',
    isActive && state.isTerminal ? 'terminal-flash' : '',
    node.outcome === 'success' ? 'success' : '',
    node.outcome === 'failure' ? 'failure' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

const FIT_PADDING = 40;
const FIT_MARGIN = 0.92;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.4;
const TOOLBAR_ZOOM_FACTOR = 1.2;
const EDGE_HIT_STROKE_WIDTH = 18;
const EDGE_TOOLTIP_OFFSET = 12;
const EDGE_TOOLTIP_MAX_WIDTH = 320;
const SELECTION_CLEAR_DRAG_THRESHOLD = 4;

function graphViewportExtent(this: SVGSVGElement): [[number, number], [number, number]] {
  const rect = this.getBoundingClientRect();
  return [
    [0, 0],
    [Math.max(1, rect.width), Math.max(1, rect.height)],
  ];
}

function createGraphZoomBehavior(
  onTransform: (transform: ZoomTransform) => void,
): ZoomBehavior<SVGSVGElement, unknown> {
  return d3Zoom<SVGSVGElement, unknown>()
    .scaleExtent([MIN_ZOOM, MAX_ZOOM])
    .extent(graphViewportExtent)
    .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => onTransform(event.transform));
}

function graphTransformAttribute(transform: ZoomTransform): string {
  return transform.toString();
}

function fitGraphTransform(layout: Layout, rect: { width: number; height: number }): ZoomTransform {
  // Self-loops arc 36px above their node; include in fit bounds.
  const minX = -8;
  const minY = -44;
  const w = layout.width - minX + FIT_PADDING;
  const h = layout.height - minY + FIT_PADDING;
  const availW = Math.max(1, rect.width - FIT_PADDING * 2);
  const availH = Math.max(1, rect.height - FIT_PADDING * 2);
  const zoom = Math.min(availW / w, availH / h, 1) * FIT_MARGIN;
  const pan = {
    x: rect.width / 2 - ((minX + layout.width) / 2) * zoom,
    y: rect.height / 2 - ((minY + layout.height) / 2) * zoom,
  };
  return zoomIdentity.translate(pan.x, pan.y).scale(zoom);
}

function setGraphTransform(
  svg: SVGSVGElement,
  behavior: ZoomBehavior<SVGSVGElement, unknown>,
  transform: ZoomTransform,
) {
  behavior.transform(select<SVGSVGElement, unknown>(svg), transform);
}

function scaleGraphBy(
  svg: SVGSVGElement,
  behavior: ZoomBehavior<SVGSVGElement, unknown>,
  factor: number,
) {
  behavior.scaleBy(select<SVGSVGElement, unknown>(svg), factor);
}

function joinClassNames(...classNames: Array<string | false | null | undefined>): string {
  return classNames.filter(Boolean).join(' ');
}

function edgeInteractionClassName(
  edge: Pick<FocusableEdge, 'id' | 'routeFrom' | 'routeTo'>,
  focus: EdgeFocusState,
  hoveredEdgeIds: ReadonlySet<string>,
): string {
  return edgeFocusClassName(edge, {
    selectedNodeId: focus.selectedNodeId,
    hoveredEdgeId: hoveredEdgeIds.has(edge.id) ? edge.id : focus.hoveredEdgeId,
  });
}

function edgeGroupInteractionClassName(
  edges: ReadonlyArray<Pick<FocusableEdge, 'id' | 'routeFrom' | 'routeTo'>>,
  focus: EdgeFocusState,
  hoveredEdgeIds: ReadonlySet<string>,
): string {
  const classes = new Set<string>();
  for (const edge of edges) {
    for (const className of edgeInteractionClassName(edge, focus, hoveredEdgeIds).split(' ')) {
      if (className) classes.add(className);
    }
  }
  if (classes.size > 1) classes.delete('edge-dimmed');
  return [...classes].join(' ');
}

function focusableEdgesForNodeFocus(
  focusableEdges: ReadonlyArray<FocusableEdge>,
  hoveredEdgeId: string | null,
  hoveredEdgeIds: ReadonlySet<string>,
): FocusableEdge[] {
  if (!hoveredEdgeId || hoveredEdgeIds.size === 0 || hoveredEdgeIds.has(hoveredEdgeId)) {
    return [...focusableEdges];
  }
  return [
    ...focusableEdges,
    ...focusableEdges
      .filter((edge) => hoveredEdgeIds.has(edge.id))
      .map((edge) => ({ ...edge, id: hoveredEdgeId })),
  ];
}

function edgeGroupTooltipText(
  edges: ReadonlyArray<
    Pick<FocusableEdge, 'kind' | 'exit' | 'routeFrom' | 'routeTo' | 'originalFrom' | 'originalTo'>
  >,
  labelContext: EdgeTooltipLabelContext,
): string {
  const tooltips = [...new Set(edges.map((edge) => edgeTooltipText(edge, labelContext)))];
  if (edges.length <= 1) return tooltips[0] ?? '';
  return `summary: ${edges.length} transitions | ${tooltips.join(' || ')}`;
}

function pruneSelectedNodeId(
  selectedNodeId: string | null,
  visibleNodeIds: ReadonlySet<string>,
): string | null {
  if (!selectedNodeId) return null;
  return visibleNodeIds.has(selectedNodeId) ? selectedNodeId : null;
}

function pointerMovedBeyondThreshold(
  start: GraphPointerPoint | null,
  end: GraphPointerPoint,
  threshold = SELECTION_CLEAR_DRAG_THRESHOLD,
): boolean {
  if (!start) return false;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return dx * dx + dy * dy > threshold * threshold;
}

function clampGraphTooltipPoint(
  point: GraphPointerPoint,
  bounds: { width: number; height: number },
): GraphPointerPoint {
  const padding = EDGE_TOOLTIP_OFFSET;
  const tooltipWidth = Math.min(EDGE_TOOLTIP_MAX_WIDTH, Math.max(0, bounds.width - padding * 2));
  const maxX = Math.max(padding, bounds.width - tooltipWidth - padding);
  const maxY = Math.max(padding, bounds.height - padding);
  return {
    x: Math.min(Math.max(padding, point.x), maxX),
    y: Math.min(Math.max(padding, point.y), maxY),
  };
}

function isGraphInteractionTarget(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  return Boolean(target.closest('.node, .edge, .edge-hit-area, .edge-label-group, .embed-toggle'));
}

export function Graph({
  topology,
  activeStateId,
  history,
  awaitsOwner,
  isTerminal,
  onNodeClick,
}: Props) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [expandedEmbedIds, setExpandedEmbedIds] = useState<Set<string>>(() => new Set());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [hoveredEdgeIds, setHoveredEdgeIds] = useState<Set<string>>(() => new Set());
  const [edgeTooltip, setEdgeTooltip] = useState<EdgeTooltipState | null>(null);
  const [viewTransform, setViewTransform] = useState<ZoomTransform>(() =>
    zoomIdentity.translate(40, 40),
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const canvasPointerStartRef = useRef<GraphPointerPoint | null>(null);
  const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const fittedRef = useRef(false);
  const layoutRequestsRef = useRef<LayoutRequestController>(createLayoutRequestController());

  const effectiveExpandedEmbedIds = useMemo(
    () => pruneExpandedEmbedIds(expandedEmbedIds, topology),
    [expandedEmbedIds, topology],
  );

  const visitedNodeIds = useMemo(() => {
    const set = new Set<string>();
    for (const h of history) set.add(h.to);
    return set;
  }, [history]);

  const firedEdgeIds = useMemo(
    () => firedEdgeIdsForLastTransition(topology, history),
    [history, topology],
  );

  useEffect(() => {
    fittedRef.current = false;
  }, [topology]);

  useEffect(() => {
    setExpandedEmbedIds((current) => {
      const pruned = pruneExpandedEmbedIds(current, topology);
      return sameSet(current, pruned) ? current : pruned;
    });
  }, [topology]);

  useEffect(() => {
    return startGraphLayoutRequest({
      topology,
      expandedEmbedIds: effectiveExpandedEmbedIds,
      activeStateId,
      visitedNodeIds,
      requests: layoutRequestsRef.current,
      layoutRunner: runLayout,
      onLayout: setLayout,
      onWarning: (message) => console.warn('Graph layout warning', message),
      onError: (err) => console.error('ELK layout failed', err),
    });
  }, [activeStateId, effectiveExpandedEmbedIds, topology, visitedNodeIds]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const behavior = createGraphZoomBehavior(setViewTransform);
    zoomBehaviorRef.current = behavior;
    select<SVGSVGElement, unknown>(svg).call(behavior);
    return () => {
      select(svg).on('.zoom', null);
      if (zoomBehaviorRef.current === behavior) zoomBehaviorRef.current = null;
    };
  }, []);

  // Fit-to-bounds once when layout is ready (and again on container resize).
  useEffect(() => {
    if (!layout || !containerRef.current) return;
    if (fittedRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const transform = fitGraphTransform(layout, rect);
    if (svgRef.current && zoomBehaviorRef.current) {
      setGraphTransform(svgRef.current, zoomBehaviorRef.current, transform);
    } else {
      setViewTransform(transform);
    }
    fittedRef.current = true;
  }, [layout]);

  function refit() {
    if (!layout || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const transform = fitGraphTransform(layout, rect);
    if (svgRef.current && zoomBehaviorRef.current) {
      setGraphTransform(svgRef.current, zoomBehaviorRef.current, transform);
    } else {
      setViewTransform(transform);
    }
  }

  function zoomIn() {
    if (svgRef.current && zoomBehaviorRef.current) {
      scaleGraphBy(svgRef.current, zoomBehaviorRef.current, TOOLBAR_ZOOM_FACTOR);
    }
  }

  function zoomOut() {
    if (svgRef.current && zoomBehaviorRef.current) {
      scaleGraphBy(svgRef.current, zoomBehaviorRef.current, 1 / TOOLBAR_ZOOM_FACTOR);
    }
  }

  function toggleExpandedEmbed(id: string) {
    setExpandedEmbedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const edges = useMemo(() => (layout ? renderableEdges(layout.edges) : []), [layout]);
  const nodeById = useMemo(
    () => new Map((layout?.nodes ?? []).map((node) => [node.id, node])),
    [layout],
  );
  const edgePathItems = useMemo<EdgePathRenderItem[]>(() => {
    if (!layout) return [];
    const edgeItems = edges.map((edge) => ({
      ...edge,
      edge,
      kindClass: null,
      pathId: `edge-path-${edge.id}`,
      d: edgePathD(edge),
    }));
    const selfLoopItems = layout.selfLoops.flatMap((edge) => {
      const node = nodeById.get(edge.from);
      if (!node) return [];
      return [
        {
          ...edge,
          edge,
          kindClass: 'edge-self',
          pathId: `edge-path-self-${edge.id}`,
          d: selfLoopPath(node).d,
        },
      ];
    });
    return [...edgeItems, ...selfLoopItems];
  }, [edges, layout, nodeById]);
  const topologyNodeById = useMemo(
    () => new Map(topology.nodes.map((node) => [node.id, node])),
    [topology],
  );
  const edgeTooltipLabelContext = useMemo<EdgeTooltipLabelContext>(
    () => ({
      visibleNodes: nodeById,
      topologyNodes: topologyNodeById,
    }),
    [nodeById, topologyNodeById],
  );
  const focusableEdges = useMemo(
    () =>
      layout
        ? buildFocusableEdges({
            edges,
            selfLoops: layout.selfLoops,
          })
        : [],
    [edges, layout],
  );
  const legendItems = useMemo(
    () =>
      layout
        ? buildGraphLegendItems({
            nodes: layout.nodes,
            edges,
            selfLoops: layout.selfLoops,
            firedEdgeIds,
            activeStateId,
            awaitsOwner,
            selectedNodeId,
          })
        : [],
    [activeStateId, awaitsOwner, edges, firedEdgeIds, layout, selectedNodeId],
  );
  const focusState = useMemo<EdgeFocusState>(
    () => ({
      selectedNodeId,
      hoveredEdgeId,
    }),
    [hoveredEdgeId, selectedNodeId],
  );
  const nodeFocusEdges = useMemo(
    () => focusableEdgesForNodeFocus(focusableEdges, hoveredEdgeId, hoveredEdgeIds),
    [focusableEdges, hoveredEdgeId, hoveredEdgeIds],
  );
  const visibleSelectableNodeIds = useMemo(
    () =>
      new Set(
        (layout?.nodes ?? []).filter((node) => !node.isExpandedEmbedHost).map((node) => node.id),
      ),
    [layout],
  );
  const paintedEdgePathItems = useMemo(
    () => paintOrderedEdges(edgePathItems, firedEdgeIds),
    [edgePathItems, firedEdgeIds],
  );
  const edgeLabelItems = useMemo(
    () => buildEdgeLabelRenderItems(edges, nodeById),
    [edges, nodeById],
  );

  useEffect(() => {
    setSelectedNodeId((current) => pruneSelectedNodeId(current, visibleSelectableNodeIds));
  }, [visibleSelectableNodeIds]);

  function tooltipPoint(event: ReactPointerEvent): GraphPointerPoint {
    const rect = containerRef.current?.getBoundingClientRect();
    const point = {
      x: event.clientX - (rect?.left ?? 0) + EDGE_TOOLTIP_OFFSET,
      y: event.clientY - (rect?.top ?? 0) + EDGE_TOOLTIP_OFFSET,
    };
    return rect ? clampGraphTooltipPoint(point, rect) : point;
  }

  function handleEdgePointerEnter(
    event: ReactPointerEvent,
    hoverId: string,
    hoverEdges: ReadonlyArray<
      Pick<
        FocusableEdge,
        'id' | 'kind' | 'exit' | 'routeFrom' | 'routeTo' | 'originalFrom' | 'originalTo'
      >
    >,
  ) {
    const point = tooltipPoint(event);
    setHoveredEdgeId(hoverId);
    setHoveredEdgeIds(new Set(hoverEdges.map((edge) => edge.id)));
    setEdgeTooltip({
      content: edgeGroupTooltipText(hoverEdges, edgeTooltipLabelContext),
      x: point.x,
      y: point.y,
    });
  }

  function handleEdgePointerMove(event: ReactPointerEvent) {
    const point = tooltipPoint(event);
    setEdgeTooltip((current) => (current ? { ...current, x: point.x, y: point.y } : current));
  }

  function handleEdgePointerLeave() {
    setHoveredEdgeId(null);
    setHoveredEdgeIds(new Set());
    setEdgeTooltip(null);
  }

  function handleNodeClick(event: ReactMouseEvent<SVGGElement>, id: string) {
    event.stopPropagation();
    setSelectedNodeId(id);
    onNodeClick?.(id);
  }

  function handleGraphPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    canvasPointerStartRef.current = { x: event.clientX, y: event.clientY };
  }

  function handleGraphClick(event: ReactMouseEvent<SVGSVGElement>) {
    const pointerStart = canvasPointerStartRef.current;
    canvasPointerStartRef.current = null;
    if (isGraphInteractionTarget(event.target)) return;
    if (
      pointerMovedBeyondThreshold(pointerStart, {
        x: event.clientX,
        y: event.clientY,
      })
    ) {
      return;
    }
    setSelectedNodeId(null);
  }

  return (
    <div className="graph-root" ref={containerRef}>
      <div className="graph-toolbar">
        <button className="tb-btn" onClick={zoomIn}>
          +
        </button>
        <button className="tb-btn" onClick={zoomOut}>
          −
        </button>
        <button className="tb-btn" onClick={refit} title="Fit the whole FSM in view.">
          fit
        </button>
        <span className="tb-meta">
          {layout ? `${layout.nodes.length} nodes · ${edges.length} edges` : 'laying out…'}
        </span>
      </div>
      <svg
        ref={svgRef}
        className="graph-svg"
        onPointerDown={handleGraphPointerDown}
        onClick={handleGraphClick}
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
          <marker
            id="arrow-active"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--plasma)" />
          </marker>
        </defs>
        <g transform={graphTransformAttribute(viewTransform)}>
          {layout ? (
            <>
              {/* Pass 0: expanded embed regions sit behind scoped edges and nodes. */}
              {layout.compoundRegions.map((region) => (
                <g key={`region-${region.id}`} className="compound-region">
                  <rect
                    x={region.x}
                    y={region.y}
                    width={region.width}
                    height={region.height}
                    rx={8}
                    ry={8}
                    className="compound-region-bg"
                  />
                  <rect
                    className="compound-region-label-bg"
                    x={region.labelBounds.x - 6}
                    y={region.labelBounds.y - 2}
                    width={region.labelBounds.width + 12}
                    height={18}
                    rx={5}
                    ry={5}
                  />
                  <text
                    className="compound-region-label"
                    x={region.labelBounds.x}
                    y={region.labelBounds.y + 13}
                  >
                    {region.label}
                  </text>
                  <EmbedToggleControl
                    x={region.x + region.width - 30}
                    y={region.y + 8}
                    label={region.label}
                    expanded={true}
                    onToggle={() => toggleExpandedEmbed(region.id)}
                  />
                </g>
              ))}
              {/* Pass 1: edge paths (under nodes). */}
              {paintedEdgePathItems.map((item) => {
                const e = item.edge;
                const fired = classifyFiredEdge(e, firedEdgeIds);
                const isVisited =
                  hasTransition(history, e.originalFrom, e.originalTo) && fired === 'none';
                const tooltip = edgeGroupTooltipText([e], edgeTooltipLabelContext);
                return (
                  <g
                    key={`p-${e.id}`}
                    className={joinClassNames(
                      edgePathClassName(item, fired, isVisited),
                      edgeInteractionClassName(e, focusState, hoveredEdgeIds),
                    )}
                  >
                    <title>{tooltip}</title>
                    <path
                      id={item.pathId}
                      d={item.d}
                      markerEnd={fired === 'exact' ? 'url(#arrow-active)' : 'url(#arrow)'}
                    />
                    <path
                      className="edge-hit-area"
                      d={item.d}
                      fill="none"
                      aria-label={tooltip}
                      style={{
                        pointerEvents: 'stroke',
                        stroke: 'transparent',
                        strokeWidth: EDGE_HIT_STROKE_WIDTH,
                      }}
                      onPointerEnter={(event) => handleEdgePointerEnter(event, e.id, [e])}
                      onPointerMove={handleEdgePointerMove}
                      onPointerLeave={handleEdgePointerLeave}
                    >
                      <title>{tooltip}</title>
                    </path>
                    {fired === 'exact' ? (
                      <EdgePulse key={`pulse-${history.length}`} pathId={item.pathId} />
                    ) : null}
                  </g>
                );
              })}
              {/* Pass 2: edge labels stay below nodes so labels never cover node text. */}
              {edgeLabelItems.map((item) => {
                const fired = classifyFiredEdge(item.edge, firedEdgeIds);
                const isVisited =
                  hasTransition(history, item.edge.originalFrom, item.edge.originalTo) &&
                  fired === 'none';
                const tooltip = edgeGroupTooltipText(item.edges, edgeTooltipLabelContext);
                const hoverId = item.grouped ? item.key : item.edge.id;
                return (
                  <g
                    key={`l-${item.key}`}
                    className={joinClassNames(
                      edgeClassName(item.edge, fired, isVisited),
                      edgeGroupInteractionClassName(item.edges, focusState, hoveredEdgeIds),
                    )}
                  >
                    <EdgeLabelAt
                      item={item}
                      title={tooltip}
                      onPointerEnter={(event) => handleEdgePointerEnter(event, hoverId, item.edges)}
                      onPointerMove={handleEdgePointerMove}
                      onPointerLeave={handleEdgePointerLeave}
                    />
                  </g>
                );
              })}
              {layout.selfLoops.map((e) => {
                const node = layout.nodes.find((n) => n.id === e.from);
                if (!node) return null;
                const fired = classifyFiredEdge(e, firedEdgeIds);
                const isVisited =
                  hasTransition(history, e.originalFrom, e.originalTo) && fired === 'none';
                const { labelX, labelY } = selfLoopPath(node);
                const tooltip = edgeGroupTooltipText([e], edgeTooltipLabelContext);
                const label = `↻ ${truncateEdgeLabel(e.exit, e.labelWidth - 12)}`;
                return (
                  <g
                    key={`l-${e.id}`}
                    className={joinClassNames(
                      edgeClassName(e, fired, isVisited, 'edge-self'),
                      edgeInteractionClassName(e, focusState, hoveredEdgeIds),
                    )}
                    aria-label={tooltip}
                    onPointerEnter={(event) => handleEdgePointerEnter(event, e.id, [e])}
                    onPointerMove={handleEdgePointerMove}
                    onPointerLeave={handleEdgePointerLeave}
                  >
                    <rect
                      x={labelX - e.labelWidth / 2}
                      y={labelY - 10}
                      width={e.labelWidth}
                      height={14}
                      rx={7}
                      ry={7}
                      className="edge-label-bg"
                    />
                    <title>{tooltip}</title>
                    <text className="edge-label" x={labelX} y={labelY} textAnchor="middle">
                      {label}
                    </text>
                  </g>
                );
              })}
              {/* Pass 3: nodes mask edge geometry and labels. */}
              {layout.nodes.map((n) => {
                if (n.isExpandedEmbedHost) return null;
                const isActive = n.id === activeStateId;
                const cls = joinClassNames(
                  nodeClassName(n, {
                    activeStateId,
                    visitedNodeIds,
                    awaitsOwner,
                    isTerminal,
                  }),
                  nodeFocusClassName(n.id, focusState, nodeFocusEdges),
                );
                return (
                  <g
                    key={n.id}
                    className={cls}
                    transform={`translate(${n.x},${n.y})`}
                    onClick={(event) => handleNodeClick(event, n.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <rect
                      x={0}
                      y={0}
                      width={n.width}
                      height={n.height}
                      rx={n.kind === 'terminal' ? 24 : 6}
                      ry={n.kind === 'terminal' ? 24 : 6}
                      className="node-shield"
                    />
                    {isActive ? (
                      <>
                        <rect
                          className="halo halo-1"
                          x={-2}
                          y={-2}
                          width={n.width + 4}
                          height={n.height + 4}
                          rx={n.kind === 'terminal' ? 26 : 8}
                          ry={n.kind === 'terminal' ? 26 : 8}
                        />
                        <rect
                          className="halo halo-2"
                          x={-2}
                          y={-2}
                          width={n.width + 4}
                          height={n.height + 4}
                          rx={n.kind === 'terminal' ? 26 : 8}
                          ry={n.kind === 'terminal' ? 26 : 8}
                        />
                      </>
                    ) : null}
                    <rect
                      x={0}
                      y={0}
                      width={n.width}
                      height={n.height}
                      rx={n.kind === 'terminal' ? 24 : 6}
                      ry={n.kind === 'terminal' ? 24 : 6}
                      className="node-rect"
                    />
                    {n.main ? (
                      <rect
                        className="main-node-marker"
                        x={7}
                        y={8}
                        width={4}
                        height={Math.max(10, n.height - 16)}
                        rx={2}
                        ry={2}
                      />
                    ) : null}
                    {n.isCollapsedEmbedHost ? (
                      <>
                        <path
                          className="embed-host-glyph"
                          d="M 11 10 H 18 V 15 H 25 M 18 10 V 6 H 25"
                        />
                        {n.visitedDescendant ? (
                          <circle
                            className="descendant-indicator visited-descendant-indicator"
                            cx={13}
                            cy={n.height - 13}
                            r={5}
                          />
                        ) : null}
                        {n.activeDescendant ? (
                          <circle
                            className="descendant-indicator active-descendant-indicator"
                            cx={13}
                            cy={n.height - 13}
                            r={3}
                          />
                        ) : null}
                      </>
                    ) : null}
                    <text
                      className="node-label"
                      x={n.width / 2}
                      y={n.height / 2 + 5}
                      textAnchor="middle"
                    >
                      {formatNodeLabel(n)}
                    </text>
                    {n.isCollapsedEmbedHost ? (
                      <EmbedToggleControl
                        x={n.width - 30}
                        y={8}
                        label={formatNodeLabel(n)}
                        expanded={false}
                        onToggle={() => toggleExpandedEmbed(n.id)}
                      />
                    ) : null}
                    {n.awaitsOwnerText && !isActive ? (
                      <text className="node-glyph" x={n.width - 12} y={14} textAnchor="end">
                        ◉
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </>
          ) : null}
        </g>
      </svg>
      {edgeTooltip ? (
        <div
          className="graph-edge-tooltip"
          style={{
            left: edgeTooltip.x,
            pointerEvents: 'none',
            position: 'absolute',
            top: edgeTooltip.y,
          }}
        >
          {edgeTooltip.content}
        </div>
      ) : null}
      <GraphLegend items={legendItems} />
    </div>
  );
}

function EmbedToggleControl({
  x,
  y,
  label,
  expanded,
  onToggle,
}: {
  x: number;
  y: number;
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const action = expanded ? 'Collapse' : 'Expand';
  return (
    <foreignObject x={x} y={y} width={24} height={24} className="embed-toggle-host">
      <button
        type="button"
        className="embed-toggle"
        aria-label={`${action} ${label}`}
        onMouseDown={stopEmbedTogglePointerEvent}
        onPointerDown={stopEmbedTogglePointerEvent}
        onClick={(event) => handleEmbedToggleClick(event, onToggle)}
      >
        {expanded ? '−' : '+'}
      </button>
    </foreignObject>
  );
}

function GraphLegend({ items }: { items: LegendItem[] }) {
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem('aharness-ui.legend.open') === 'true';
  });
  function toggle() {
    setOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem('aharness-ui.legend.open', String(next));
      } catch {
        /* localStorage unavailable — collapse state stays in-memory only. */
      }
      return next;
    });
  }
  return (
    <aside className={`legend ${open ? '' : 'collapsed'}`} aria-label="Legend">
      <button className="legend-toggle" type="button" aria-expanded={open} onClick={toggle}>
        <span>legend</span>
        <span className="chev" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? (
        <div className="legend-body">
          {items.map((item) => (
            <div className="legend-row" key={item.id}>
              <LegendSwatch className={item.swatch} />
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

function LegendSwatch({ className }: { className: string }) {
  return (
    <span className={`legend-swatch ${className}`}>
      {className.includes('sw-active') ? (
        <>
          <span className="sw-halo" />
          <span className="sw-halo sw-halo-2" />
        </>
      ) : null}
      {className.includes('sw-collapsed-embed') ? <span className="sw-embed-glyph" /> : null}
      {className.includes('sw-descendant') ? (
        <>
          <span className="sw-descendant-ring" />
          <span className="sw-descendant-dot" />
        </>
      ) : null}
      {className.includes('sw-edge-fired') ? <span className="sw-edge-dot" /> : null}
    </span>
  );
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

// A glowing disc that rides the fired edge once, then fades. Mounted with a
// fresh key on every transition so the animation always plays from start.
function EdgePulse({ pathId }: { pathId: string }) {
  const reduced = usePrefersReducedMotion();
  if (reduced) return null;
  return (
    <circle className="edge-pulse" r={4.5}>
      <animateMotion
        dur="0.9s"
        fill="freeze"
        rotate="auto"
        calcMode="spline"
        keySplines="0.4 0 0.2 1"
        keyTimes="0;1"
      >
        <mpath href={`#${pathId}`} />
      </animateMotion>
      <animate
        attributeName="opacity"
        values="0;1;1;0"
        keyTimes="0;0.12;0.85;1"
        dur="0.9s"
        fill="freeze"
      />
    </circle>
  );
}

function fallbackEdgeLabelPoint(edge: LaidOutEdge): { x: number; y: number } | null {
  // Place label at midpoint of the edge path (between bend points).
  const pts = [edge.sourcePoint, ...edge.bendPoints, edge.targetPoint];
  if (pts.length < 2) return null;
  const mid = Math.floor(pts.length / 2);
  const a = pts[mid - 1];
  const b = pts[mid];
  const baseX = (a.x + b.x) / 2;
  const baseY = (a.y + b.y) / 2;
  if (edge.parallelTotal <= 1) return { x: baseX, y: baseY };

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const offset = (edge.parallelIndex - (edge.parallelTotal - 1) / 2) * 18;
  return {
    x: baseX + (-dy / length) * offset,
    y: baseY + (dx / length) * offset,
  };
}

function EdgeLabelAt({
  item,
  title,
  onPointerEnter,
  onPointerMove,
  onPointerLeave,
}: {
  item: EdgeLabelRenderItem;
  title: string;
  onPointerEnter: (event: ReactPointerEvent<SVGGElement>) => void;
  onPointerMove: (event: ReactPointerEvent<SVGGElement>) => void;
  onPointerLeave: () => void;
}) {
  const label = truncateEdgeLabel(item.label, item.width);
  return (
    <g
      className={`edge-label-group ${item.grouped ? 'summary' : ''}`}
      transform={`translate(${item.x},${item.y})`}
      aria-label={title}
      onPointerEnter={onPointerEnter}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      <rect
        x={-item.width / 2}
        y={-8}
        width={item.width}
        height={16}
        rx={8}
        ry={8}
        className="edge-label-bg"
      />
      <title>{title}</title>
      <text className="edge-label" x={0} y={4} textAnchor="middle">
        {label}
      </text>
    </g>
  );
}

export const graphInternalsForTest = {
  createLayoutRequestController,
  pruneExpandedEmbedIds,
  renderableEdges,
  classifyFiredEdge,
  edgeClassName,
  paintOrderedEdges,
  firedEdgeIdsForLastTransition,
  handleEmbedToggleClick,
  stopEmbedTogglePointerEvent,
  startGraphLayoutRequest,
  fallbackEdgeLabelPoint,
  edgePathD,
  truncateEdgeLabel,
  buildEdgeLabelRenderItems,
  edgeGroupInteractionClassName,
  edgeGroupTooltipText,
  edgeInteractionClassName,
  focusableEdgesForNodeFocus,
  clampGraphTooltipPoint,
  nodeClassName,
  pointerMovedBeyondThreshold,
  pruneSelectedNodeId,
  createGraphZoomBehavior,
  fitGraphTransform,
  graphTransformAttribute,
  GraphLegend,
  EmbedToggleControl,
};
