import { select } from 'd3-selection';
import {
  zoom as d3Zoom,
  zoomIdentity,
  type D3ZoomEvent,
  type ZoomBehavior,
  type ZoomTransform,
} from 'd3-zoom';
import type { Topology } from '../types/topology.js';
import { buildGraphLayoutModel } from './graphLayoutModel.js';
import {
  formatNodeLabelForTest,
  runGraphElkLayout,
  type GraphElkLayout,
  type LaidOutEdge,
  type LaidOutNode,
} from './graphElk.js';
import {
  edgeFocusClassName,
  edgeTooltipText,
  type EdgeFocusState,
  type EdgeTooltipLabelContext,
  type FocusableEdge,
} from './graphInteraction.js';

export type GraphHistoryEntry = {
  from: string | null;
  to: string;
  cause: string;
  at: number;
};

export type Layout = GraphElkLayout;

export type GraphPointerPoint = {
  x: number;
  y: number;
};

export type EdgeTooltipState = {
  content: string;
  x: number;
  y: number;
};

export async function runLayout(
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

export type LayoutRunner = typeof runLayout;

export type LayoutRequestController = {
  next: () => number;
  isCurrent: (id: number) => boolean;
  invalidate: (id: number) => void;
};

export function createLayoutRequestController(): LayoutRequestController {
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

export function startGraphLayoutRequest({
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
  const embedIds = new Set<string>();
  for (const node of topology.nodes) {
    if (node.kind === 'embed') embedIds.add(node.id);
  }
  return embedIds;
}

export function pruneExpandedEmbedIds(
  expandedEmbedIds: ReadonlySet<string>,
  topology: Topology,
): Set<string> {
  const embedIds = topologyEmbedIds(topology);
  const pruned = new Set<string>();
  for (const id of expandedEmbedIds) {
    if (embedIds.has(id)) pruned.add(id);
  }
  return pruned;
}

export function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

export type FiredEdgeState = 'none' | 'exact' | 'candidate';

export function classifyFiredEdge(
  edge: Pick<LaidOutEdge, 'semanticId'>,
  matchingEdgeIds: ReadonlySet<string>,
): FiredEdgeState {
  if (matchingEdgeIds.size === 0) return 'none';
  if (!matchingEdgeIds.has(edge.semanticId)) return 'none';
  return matchingEdgeIds.size === 1 ? 'exact' : 'candidate';
}

export function firedEdgeIdsForLastTransition(
  topology: Topology,
  history: ReadonlyArray<GraphHistoryEntry>,
): Set<string> {
  if (history.length === 0) return new Set();
  const last = history[history.length - 1];
  if (!last.from) return new Set();
  const ids = new Set<string>();
  for (const edge of topology.edges) {
    if (edge.from === last.from && edge.to === last.to) ids.add(edge.id);
  }
  return ids;
}

export function hasTransition(
  history: ReadonlyArray<GraphHistoryEntry>,
  from: string,
  to: string,
): boolean {
  return history.some((entry) => entry.from === from && entry.to === to);
}

export function renderableEdges(edges: ReadonlyArray<LaidOutEdge>): LaidOutEdge[] {
  return edges.filter((edge) => !edge.isRankOnly);
}

export function edgeClassName(
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

export type EdgePaintInput = Pick<
  LaidOutEdge,
  'id' | 'semanticId' | 'feedbackClass' | 'layoutRole' | 'mainRole'
>;

export type EdgePathRenderItem = EdgePaintInput & {
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

export function paintOrderedEdges<T extends EdgePaintInput>(
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

export function edgePathClassName(
  item: EdgePathRenderItem,
  fired: FiredEdgeState,
  visited: boolean,
) {
  return item.kindClass
    ? edgeClassName(item.edge, fired, visited, item.kindClass)
    : edgeClassName(item.edge, fired, visited);
}

export function truncateEdgeLabel(label: string, labelWidth: number): string {
  const maxChars = Math.max(1, Math.floor((labelWidth - 20) / 7));
  if (label.length <= maxChars) return label;
  if (maxChars <= 1) return '…';
  return `${label.slice(0, maxChars - 1)}…`;
}

function edgeLabelWidth(label: string): number {
  return Math.max(48, Math.min(150, label.length * 7 + 20));
}

export type EdgeLabelNode = Pick<LaidOutNode, 'id' | 'label' | 'kind' | 'outcome'>;

export type EdgeLabelRenderItem = {
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
  if (edge.kind === 'choice') return true;
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
  const points: Array<{ x: number; y: number }> = [];
  for (const edge of edges) {
    const point = edgeLabelPoint(edge);
    if (point) points.push(point);
  }
  if (points.length === 0) return null;
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

export function buildEdgeLabelRenderItems(
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

export type EmbedToggleClickEvent = {
  stopPropagation: () => void;
};

export type EmbedTogglePointerEvent = {
  stopPropagation: () => void;
};

export function handleEmbedToggleClick(event: EmbedToggleClickEvent, onToggle: () => void) {
  event.stopPropagation();
  onToggle();
}

export function stopEmbedTogglePointerEvent(event: EmbedTogglePointerEvent) {
  event.stopPropagation();
}

export function edgePathD(e: LaidOutEdge): string {
  const pts = [e.sourcePoint, ...e.bendPoints, e.targetPoint];
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
}

export function selfLoopPath(node: LaidOutNode): { d: string; labelX: number; labelY: number } {
  const top = node.y;
  const xR = node.x + node.width - 14;
  const xL = node.x + 14;
  const arcTop = top - 36;
  const d = `M ${xR} ${top} C ${xR + 30} ${arcTop}, ${xL - 30} ${arcTop}, ${xL} ${top}`;
  return { d, labelX: node.x + node.width / 2, labelY: arcTop + 4 };
}

export type NodeClassState = {
  activeStateId: string | null;
  visitedNodeIds: ReadonlySet<string>;
  awaitsOwner: boolean;
  isTerminal: boolean;
};

export function nodeClassName(
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
export const TOOLBAR_ZOOM_FACTOR = 1.2;
export const EDGE_HIT_STROKE_WIDTH = 18;
export const EDGE_TOOLTIP_OFFSET = 12;
const EDGE_TOOLTIP_MAX_WIDTH = 320;
const SELECTION_CLEAR_DRAG_THRESHOLD = 4;

function graphViewportExtent(this: SVGSVGElement): [[number, number], [number, number]] {
  const rect = this.getBoundingClientRect();
  return [
    [0, 0],
    [Math.max(1, rect.width), Math.max(1, rect.height)],
  ];
}

export function createGraphZoomBehavior(
  onTransform: (transform: ZoomTransform) => void,
): ZoomBehavior<SVGSVGElement, unknown> {
  return d3Zoom<SVGSVGElement, unknown>()
    .scaleExtent([MIN_ZOOM, MAX_ZOOM])
    .extent(graphViewportExtent)
    .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => onTransform(event.transform));
}

export function graphTransformAttribute(transform: ZoomTransform): string {
  return transform.toString();
}

export function fitGraphTransform(
  layout: Layout,
  rect: { width: number; height: number },
): ZoomTransform {
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

export function setGraphTransform(
  svg: SVGSVGElement,
  behavior: ZoomBehavior<SVGSVGElement, unknown>,
  transform: ZoomTransform,
) {
  behavior.transform(select<SVGSVGElement, unknown>(svg), transform);
}

export function scaleGraphBy(
  svg: SVGSVGElement,
  behavior: ZoomBehavior<SVGSVGElement, unknown>,
  factor: number,
) {
  behavior.scaleBy(select<SVGSVGElement, unknown>(svg), factor);
}

export function joinClassNames(...classNames: Array<string | false | null | undefined>): string {
  return classNames.filter(Boolean).join(' ');
}

export function selfLoopKindClass(edge: Pick<LaidOutEdge, 'kind'>): string {
  return joinClassNames('edge-self', `edge-${edge.kind}`);
}

export function edgeInteractionClassName(
  edge: Pick<FocusableEdge, 'id' | 'routeFrom' | 'routeTo'>,
  focus: EdgeFocusState,
  hoveredEdgeIds: ReadonlySet<string>,
): string {
  return edgeFocusClassName(edge, {
    selectedNodeId: focus.selectedNodeId,
    hoveredEdgeId: hoveredEdgeIds.has(edge.id) ? edge.id : focus.hoveredEdgeId,
  });
}

export function edgeGroupInteractionClassName(
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

export function focusableEdgesForNodeFocus(
  focusableEdges: ReadonlyArray<FocusableEdge>,
  hoveredEdgeId: string | null,
  hoveredEdgeIds: ReadonlySet<string>,
): FocusableEdge[] {
  if (!hoveredEdgeId || hoveredEdgeIds.size === 0 || hoveredEdgeIds.has(hoveredEdgeId)) {
    return [...focusableEdges];
  }
  const edges = [...focusableEdges];
  for (const edge of focusableEdges) {
    if (hoveredEdgeIds.has(edge.id)) edges.push({ ...edge, id: hoveredEdgeId });
  }
  return edges;
}

export function edgeGroupTooltipText(
  edges: ReadonlyArray<
    Pick<FocusableEdge, 'kind' | 'exit' | 'routeFrom' | 'routeTo' | 'originalFrom' | 'originalTo'>
  >,
  labelContext: EdgeTooltipLabelContext,
): string {
  const tooltips = [...new Set(edges.map((edge) => edgeTooltipText(edge, labelContext)))];
  if (edges.length <= 1) return tooltips[0] ?? '';
  return `summary: ${edges.length} transitions | ${tooltips.join(' || ')}`;
}

export function pruneSelectedNodeId(
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

export function clampGraphTooltipPoint(
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

function shouldClearGraphSelection(input: {
  target: EventTarget | null;
  pointerStart: GraphPointerPoint | null;
  pointerEnd: GraphPointerPoint;
}): boolean {
  if (isGraphInteractionTarget(input.target)) return false;
  return !pointerMovedBeyondThreshold(input.pointerStart, input.pointerEnd);
}

export function clearGraphSelectionFromCanvasClick(input: {
  target: EventTarget | null;
  pointerStart: GraphPointerPoint | null;
  pointerEnd: GraphPointerPoint;
  clearLocalSelection: () => void;
  onSelectionClear?: () => void;
}): boolean {
  if (!shouldClearGraphSelection(input)) return false;
  input.clearLocalSelection();
  input.onSelectionClear?.();
  return true;
}

export function visibleSelectableNodeIdsForLayout(layout: Layout | null): Set<string> {
  const ids = new Set<string>();
  for (const node of layout?.nodes ?? []) {
    if (!node.isExpandedEmbedHost) ids.add(node.id);
  }
  return ids;
}

function fallbackEdgeLabelPoint(edge: LaidOutEdge): { x: number; y: number } | null {
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

export const graphInternalsForTest = {
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
};

export { formatNodeLabelForTest };
