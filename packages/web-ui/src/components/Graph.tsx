import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { select } from 'd3-selection';
import { zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import type { Topology } from '../types/topology.js';
import {
  buildFocusableEdges,
  buildGraphLegendItems,
  type EdgeFocusState,
  type EdgeTooltipLabelContext,
  type FocusableEdge,
} from './graphInteraction.js';
import { GraphLayoutView } from './GraphLayoutView.js';
import {
  EDGE_TOOLTIP_OFFSET,
  TOOLBAR_ZOOM_FACTOR,
  buildEdgeLabelRenderItems,
  clampGraphTooltipPoint,
  clearGraphSelectionFromCanvasClick,
  createGraphZoomBehavior,
  createLayoutRequestController,
  edgeGroupTooltipText,
  edgePathD,
  firedEdgeIdsForLastTransition,
  fitGraphTransform,
  focusableEdgesForNodeFocus,
  graphTransformAttribute,
  paintOrderedEdges,
  pruneExpandedEmbedIds,
  pruneSelectedNodeId,
  renderableEdges,
  runLayout,
  sameSet,
  scaleGraphBy,
  selfLoopKindClass,
  selfLoopPath,
  setGraphTransform,
  startGraphLayoutRequest,
  visibleSelectableNodeIdsForLayout,
  type EdgePathRenderItem,
  type EdgeTooltipState,
  type GraphHistoryEntry,
  type GraphPointerPoint,
  type Layout,
  type LayoutRequestController,
} from './GraphInternals.js';
import { GraphLegend } from './GraphLegend.js';
import { GraphToolbar } from './GraphToolbar.js';

type Props = {
  topology: Topology;
  activeStateId: string | null;
  history: GraphHistoryEntry[];
  awaitsOwner: boolean;
  isTerminal: boolean;
  onNodeClick?: (id: string) => void;
  onSelectionClear?: () => void;
};

type EdgeHoverSource = Pick<
  FocusableEdge,
  'id' | 'kind' | 'exit' | 'routeFrom' | 'routeTo' | 'originalFrom' | 'originalTo'
>;

type GraphState = {
  layout: Layout | null;
  expandedEmbedIds: Set<string>;
  selectedNodeId: string | null;
  hoveredEdgeId: string | null;
  hoveredEdgeIds: Set<string>;
  edgeTooltip: EdgeTooltipState | null;
  viewTransform: ZoomTransform;
};

type GraphAction =
  | { type: 'layoutReady'; layout: Layout }
  | { type: 'pruneExpandedEmbedIds'; topology: Topology }
  | { type: 'setViewTransform'; transform: ZoomTransform }
  | { type: 'toggleExpandedEmbed'; id: string }
  | { type: 'selectNode'; id: string | null }
  | { type: 'pruneSelectedNode'; visibleNodeIds: ReadonlySet<string> }
  | {
      type: 'showEdgeTooltip';
      hoveredEdgeId: string;
      hoveredEdgeIds: Set<string>;
      edgeTooltip: EdgeTooltipState;
    }
  | { type: 'moveEdgeTooltip'; point: GraphPointerPoint }
  | { type: 'hideEdgeTooltip' };

function initialGraphState(): GraphState {
  return {
    layout: null,
    expandedEmbedIds: new Set(),
    selectedNodeId: null,
    hoveredEdgeId: null,
    hoveredEdgeIds: new Set(),
    edgeTooltip: null,
    viewTransform: zoomIdentity.translate(40, 40),
  };
}

function graphReducer(state: GraphState, action: GraphAction): GraphState {
  switch (action.type) {
    case 'layoutReady':
      return { ...state, layout: action.layout };
    case 'pruneExpandedEmbedIds': {
      const pruned = pruneExpandedEmbedIds(state.expandedEmbedIds, action.topology);
      return sameSet(state.expandedEmbedIds, pruned)
        ? state
        : { ...state, expandedEmbedIds: pruned };
    }
    case 'setViewTransform':
      return { ...state, viewTransform: action.transform };
    case 'toggleExpandedEmbed': {
      const expandedEmbedIds = new Set(state.expandedEmbedIds);
      if (expandedEmbedIds.has(action.id)) expandedEmbedIds.delete(action.id);
      else expandedEmbedIds.add(action.id);
      return { ...state, expandedEmbedIds };
    }
    case 'selectNode':
      return state.selectedNodeId === action.id ? state : { ...state, selectedNodeId: action.id };
    case 'pruneSelectedNode': {
      const selectedNodeId = pruneSelectedNodeId(state.selectedNodeId, action.visibleNodeIds);
      return selectedNodeId === state.selectedNodeId ? state : { ...state, selectedNodeId };
    }
    case 'showEdgeTooltip':
      return {
        ...state,
        hoveredEdgeId: action.hoveredEdgeId,
        hoveredEdgeIds: action.hoveredEdgeIds,
        edgeTooltip: action.edgeTooltip,
      };
    case 'moveEdgeTooltip':
      if (!state.edgeTooltip) return state;
      if (state.edgeTooltip.x === action.point.x && state.edgeTooltip.y === action.point.y) {
        return state;
      }
      return {
        ...state,
        edgeTooltip: { ...state.edgeTooltip, x: action.point.x, y: action.point.y },
      };
    case 'hideEdgeTooltip':
      if (!state.hoveredEdgeId && state.hoveredEdgeIds.size === 0 && !state.edgeTooltip)
        return state;
      return {
        ...state,
        hoveredEdgeId: null,
        hoveredEdgeIds: new Set(),
        edgeTooltip: null,
      };
  }
}

export function Graph({
  topology,
  activeStateId,
  history,
  awaitsOwner,
  isTerminal,
  onNodeClick,
  onSelectionClear,
}: Props) {
  const [state, dispatch] = useReducer(graphReducer, undefined, initialGraphState);
  const { layout, expandedEmbedIds, hoveredEdgeId, hoveredEdgeIds, edgeTooltip, viewTransform } =
    state;
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const canvasPointerStartRef = useRef<GraphPointerPoint | null>(null);
  const zoomBehaviorRef = useGraphZoom(svgRef, dispatch);
  const fittedRef = useRef(false);
  const layoutRequests = useLayoutRequestController();

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
    dispatch({ type: 'pruneExpandedEmbedIds', topology });
  }, [topology]);

  useEffect(() => {
    return startGraphLayoutRequest({
      topology,
      expandedEmbedIds: effectiveExpandedEmbedIds,
      activeStateId,
      visitedNodeIds,
      requests: layoutRequests,
      layoutRunner: runLayout,
      onLayout: (nextLayout) => dispatch({ type: 'layoutReady', layout: nextLayout }),
      onWarning: (message) => console.warn('Graph layout warning', message),
      onError: (err) => console.error('ELK layout failed', err),
    });
  }, [activeStateId, effectiveExpandedEmbedIds, layoutRequests, topology, visitedNodeIds]);

  useInitialGraphFit({ layout, containerRef, svgRef, zoomBehaviorRef, fittedRef });

  const edges = useMemo(() => (layout ? renderableEdges(layout.edges) : []), [layout]);
  const nodeById = useMemo(
    () => new Map((layout?.nodes ?? []).map((node) => [node.id, node])),
    [layout],
  );
  const edgePathItems = useMemo<EdgePathRenderItem[]>(() => {
    if (!layout) return [];
    const items: EdgePathRenderItem[] = [];
    for (const edge of edges) {
      items.push({
        ...edge,
        edge,
        kindClass: null,
        pathId: `edge-path-${edge.id}`,
        d: edgePathD(edge),
      });
    }
    for (const edge of layout.selfLoops) {
      const node = nodeById.get(edge.from);
      if (!node) continue;
      items.push({
        ...edge,
        edge,
        kindClass: selfLoopKindClass(edge),
        pathId: `edge-path-self-${edge.id}`,
        d: selfLoopPath(node).d,
      });
    }
    return items;
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
  const visibleSelectableNodeIds = useMemo(
    () => visibleSelectableNodeIdsForLayout(layout),
    [layout],
  );
  const selectedNodeId = useMemo(
    () => pruneSelectedNodeId(state.selectedNodeId, visibleSelectableNodeIds),
    [state.selectedNodeId, visibleSelectableNodeIds],
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
  const paintedEdgePathItems = useMemo(
    () => paintOrderedEdges(edgePathItems, firedEdgeIds),
    [edgePathItems, firedEdgeIds],
  );
  const edgeLabelItems = useMemo(
    () => buildEdgeLabelRenderItems(edges, nodeById),
    [edges, nodeById],
  );

  useEffect(() => {
    dispatch({ type: 'pruneSelectedNode', visibleNodeIds: visibleSelectableNodeIds });
  }, [visibleSelectableNodeIds]);

  function refit() {
    if (!layout || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const transform = fitGraphTransform(layout, rect);
    if (svgRef.current && zoomBehaviorRef.current) {
      setGraphTransform(svgRef.current, zoomBehaviorRef.current, transform);
    } else {
      dispatch({ type: 'setViewTransform', transform });
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
    dispatch({ type: 'toggleExpandedEmbed', id });
  }

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
    hoverEdges: ReadonlyArray<EdgeHoverSource>,
  ) {
    const point = tooltipPoint(event);
    dispatch({
      type: 'showEdgeTooltip',
      hoveredEdgeId: hoverId,
      hoveredEdgeIds: new Set(hoverEdges.map((edge) => edge.id)),
      edgeTooltip: {
        content: edgeGroupTooltipText(hoverEdges, edgeTooltipLabelContext),
        x: point.x,
        y: point.y,
      },
    });
  }

  function handleEdgePointerMove(event: ReactPointerEvent) {
    dispatch({ type: 'moveEdgeTooltip', point: tooltipPoint(event) });
  }

  function handleEdgePointerLeave() {
    dispatch({ type: 'hideEdgeTooltip' });
  }

  function handleNodeClick(event: ReactMouseEvent<SVGGElement>, id: string) {
    event.stopPropagation();
    dispatch({ type: 'selectNode', id });
    onNodeClick?.(id);
  }

  function handleGraphPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    canvasPointerStartRef.current = { x: event.clientX, y: event.clientY };
  }

  function clearSelection() {
    dispatch({ type: 'selectNode', id: null });
    onSelectionClear?.();
  }

  function handleGraphClick(event: ReactMouseEvent<SVGSVGElement>) {
    const pointerStart = canvasPointerStartRef.current;
    canvasPointerStartRef.current = null;
    clearGraphSelectionFromCanvasClick({
      target: event.target,
      pointerStart,
      pointerEnd: {
        x: event.clientX,
        y: event.clientY,
      },
      clearLocalSelection: () => dispatch({ type: 'selectNode', id: null }),
      onSelectionClear,
    });
  }

  function handleGraphKeyDown(event: ReactKeyboardEvent<SVGSVGElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    clearSelection();
  }

  return (
    <GraphSurface
      containerRef={containerRef}
      svgRef={svgRef}
      nodeCount={layout?.nodes.length ?? null}
      edgeCount={edges.length}
      viewTransform={viewTransform}
      layout={layout}
      nodeById={nodeById}
      history={history}
      activeStateId={activeStateId}
      awaitsOwner={awaitsOwner}
      isTerminal={isTerminal}
      visitedNodeIds={visitedNodeIds}
      firedEdgeIds={firedEdgeIds}
      paintedEdgePathItems={paintedEdgePathItems}
      edgeLabelItems={edgeLabelItems}
      edgeTooltipLabelContext={edgeTooltipLabelContext}
      focusState={focusState}
      hoveredEdgeIds={hoveredEdgeIds}
      nodeFocusEdges={nodeFocusEdges}
      edgeTooltip={edgeTooltip}
      legendItems={legendItems}
      onZoomIn={zoomIn}
      onZoomOut={zoomOut}
      onRefit={refit}
      onGraphPointerDown={handleGraphPointerDown}
      onGraphClick={handleGraphClick}
      onGraphKeyDown={handleGraphKeyDown}
      onToggleExpandedEmbed={toggleExpandedEmbed}
      onEdgePointerEnter={handleEdgePointerEnter}
      onEdgePointerMove={handleEdgePointerMove}
      onEdgePointerLeave={handleEdgePointerLeave}
      onNodeClick={handleNodeClick}
    />
  );
}

function useLayoutRequestController(): LayoutRequestController {
  const layoutRequestsRef = useRef<LayoutRequestController | null>(null);
  if (layoutRequestsRef.current === null) {
    layoutRequestsRef.current = createLayoutRequestController();
  }
  return layoutRequestsRef.current;
}

function useGraphZoom(
  svgRef: RefObject<SVGSVGElement>,
  dispatch: Dispatch<GraphAction>,
): RefObject<ZoomBehavior<SVGSVGElement, unknown> | null> {
  const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const behavior = createGraphZoomBehavior((transform) =>
      dispatch({ type: 'setViewTransform', transform }),
    );
    zoomBehaviorRef.current = behavior;
    select<SVGSVGElement, unknown>(svg).call(behavior);
    return () => {
      select(svg).on('.zoom', null);
      if (zoomBehaviorRef.current === behavior) zoomBehaviorRef.current = null;
    };
  }, [dispatch, svgRef]);
  return zoomBehaviorRef;
}

function useInitialGraphFit({
  layout,
  containerRef,
  svgRef,
  zoomBehaviorRef,
  fittedRef,
}: {
  layout: Layout | null;
  containerRef: RefObject<HTMLDivElement>;
  svgRef: RefObject<SVGSVGElement>;
  zoomBehaviorRef: RefObject<ZoomBehavior<SVGSVGElement, unknown> | null>;
  fittedRef: MutableRefObject<boolean>;
}) {
  useEffect(() => {
    if (!layout || !containerRef.current) return;
    if (fittedRef.current) return;
    if (!svgRef.current || !zoomBehaviorRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const transform = fitGraphTransform(layout, rect);
    setGraphTransform(svgRef.current, zoomBehaviorRef.current, transform);
    fittedRef.current = true;
  }, [containerRef, fittedRef, layout, svgRef, zoomBehaviorRef]);
}

type GraphSurfaceProps = {
  containerRef: RefObject<HTMLDivElement>;
  svgRef: RefObject<SVGSVGElement>;
  nodeCount: number | null;
  edgeCount: number;
  viewTransform: ZoomTransform;
  layout: Layout | null;
  nodeById: ReadonlyMap<string, Layout['nodes'][number]>;
  history: GraphHistoryEntry[];
  activeStateId: string | null;
  awaitsOwner: boolean;
  isTerminal: boolean;
  visitedNodeIds: ReadonlySet<string>;
  firedEdgeIds: ReadonlySet<string>;
  paintedEdgePathItems: ReadonlyArray<EdgePathRenderItem>;
  edgeLabelItems: ReturnType<typeof buildEdgeLabelRenderItems>;
  edgeTooltipLabelContext: EdgeTooltipLabelContext;
  focusState: EdgeFocusState;
  hoveredEdgeIds: ReadonlySet<string>;
  nodeFocusEdges: ReadonlyArray<FocusableEdge>;
  edgeTooltip: EdgeTooltipState | null;
  legendItems: ReturnType<typeof buildGraphLegendItems>;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onRefit: () => void;
  onGraphPointerDown: (event: ReactPointerEvent<SVGSVGElement>) => void;
  onGraphClick: (event: ReactMouseEvent<SVGSVGElement>) => void;
  onGraphKeyDown: (event: ReactKeyboardEvent<SVGSVGElement>) => void;
  onToggleExpandedEmbed: (id: string) => void;
  onEdgePointerEnter: (
    event: ReactPointerEvent,
    hoverId: string,
    hoverEdges: ReadonlyArray<EdgeHoverSource>,
  ) => void;
  onEdgePointerMove: (event: ReactPointerEvent) => void;
  onEdgePointerLeave: () => void;
  onNodeClick: (event: ReactMouseEvent<SVGGElement>, id: string) => void;
};

function GraphSurface({
  containerRef,
  svgRef,
  nodeCount,
  edgeCount,
  viewTransform,
  layout,
  nodeById,
  history,
  activeStateId,
  awaitsOwner,
  isTerminal,
  visitedNodeIds,
  firedEdgeIds,
  paintedEdgePathItems,
  edgeLabelItems,
  edgeTooltipLabelContext,
  focusState,
  hoveredEdgeIds,
  nodeFocusEdges,
  edgeTooltip,
  legendItems,
  onZoomIn,
  onZoomOut,
  onRefit,
  onGraphPointerDown,
  onGraphClick,
  onGraphKeyDown,
  onToggleExpandedEmbed,
  onEdgePointerEnter,
  onEdgePointerMove,
  onEdgePointerLeave,
  onNodeClick,
}: GraphSurfaceProps) {
  return (
    <div className="graph-root" ref={containerRef}>
      <GraphToolbar
        nodeCount={nodeCount}
        edgeCount={edgeCount}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onRefit={onRefit}
      />
      <svg
        ref={svgRef}
        className="graph-svg"
        role="button"
        tabIndex={0}
        aria-label="Clear graph selection"
        onPointerDown={onGraphPointerDown}
        onClick={onGraphClick}
        onKeyDown={onGraphKeyDown}
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
          <GraphLayoutView
            layout={layout}
            nodeById={nodeById}
            history={history}
            activeStateId={activeStateId}
            awaitsOwner={awaitsOwner}
            isTerminal={isTerminal}
            visitedNodeIds={visitedNodeIds}
            firedEdgeIds={firedEdgeIds}
            paintedEdgePathItems={paintedEdgePathItems}
            edgeLabelItems={edgeLabelItems}
            edgeTooltipLabelContext={edgeTooltipLabelContext}
            focusState={focusState}
            hoveredEdgeIds={hoveredEdgeIds}
            nodeFocusEdges={nodeFocusEdges}
            onToggleExpandedEmbed={onToggleExpandedEmbed}
            onEdgePointerEnter={onEdgePointerEnter}
            onEdgePointerMove={onEdgePointerMove}
            onEdgePointerLeave={onEdgePointerLeave}
            onNodeClick={onNodeClick}
          />
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
