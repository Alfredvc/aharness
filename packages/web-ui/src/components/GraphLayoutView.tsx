import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { formatNodeLabelForTest as formatNodeLabel, type LaidOutNode } from './graphElk.js';
import type { EdgeFocusState, EdgeTooltipLabelContext, FocusableEdge } from './graphInteraction.js';
import { nodeFocusClassName } from './graphInteraction.js';
import { EdgeLabelAt } from './GraphEdgeLabelAt.js';
import { EdgePulse } from './GraphEdgePulse.js';
import { EmbedToggleControl } from './GraphEmbedToggleControl.js';
import {
  EDGE_HIT_STROKE_WIDTH,
  classifyFiredEdge,
  edgeClassName,
  edgeGroupInteractionClassName,
  edgeGroupTooltipText,
  edgeInteractionClassName,
  edgePathClassName,
  hasTransition,
  joinClassNames,
  nodeClassName,
  selfLoopKindClass,
  selfLoopPath,
  truncateEdgeLabel,
  type EdgeLabelRenderItem,
  type EdgePathRenderItem,
  type GraphHistoryEntry,
  type Layout,
} from './GraphInternals.js';

type EdgeHoverSource = Pick<
  FocusableEdge,
  'id' | 'kind' | 'exit' | 'routeFrom' | 'routeTo' | 'originalFrom' | 'originalTo'
>;

export function GraphLayoutView({
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
  onToggleExpandedEmbed,
  onEdgePointerEnter,
  onEdgePointerMove,
  onEdgePointerLeave,
  onNodeClick,
}: {
  layout: Layout | null;
  nodeById: ReadonlyMap<string, LaidOutNode>;
  history: ReadonlyArray<GraphHistoryEntry>;
  activeStateId: string | null;
  awaitsOwner: boolean;
  isTerminal: boolean;
  visitedNodeIds: ReadonlySet<string>;
  firedEdgeIds: ReadonlySet<string>;
  paintedEdgePathItems: ReadonlyArray<EdgePathRenderItem>;
  edgeLabelItems: ReadonlyArray<EdgeLabelRenderItem>;
  edgeTooltipLabelContext: EdgeTooltipLabelContext;
  focusState: EdgeFocusState;
  hoveredEdgeIds: ReadonlySet<string>;
  nodeFocusEdges: ReadonlyArray<FocusableEdge>;
  onToggleExpandedEmbed: (id: string) => void;
  onEdgePointerEnter: (
    event: ReactPointerEvent,
    hoverId: string,
    hoverEdges: ReadonlyArray<EdgeHoverSource>,
  ) => void;
  onEdgePointerMove: (event: ReactPointerEvent) => void;
  onEdgePointerLeave: () => void;
  onNodeClick: (event: ReactMouseEvent<SVGGElement>, id: string) => void;
}) {
  if (!layout) return null;

  return (
    <>
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
            onToggle={() => onToggleExpandedEmbed(region.id)}
          />
        </g>
      ))}
      {paintedEdgePathItems.map((item) => {
        const e = item.edge;
        const fired = classifyFiredEdge(e, firedEdgeIds);
        const isVisited = hasTransition(history, e.originalFrom, e.originalTo) && fired === 'none';
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
              onPointerEnter={(event) => onEdgePointerEnter(event, e.id, [e])}
              onPointerMove={onEdgePointerMove}
              onPointerLeave={onEdgePointerLeave}
            >
              <title>{tooltip}</title>
            </path>
            {fired === 'exact' ? (
              <EdgePulse key={`pulse-${history.length}`} pathId={item.pathId} />
            ) : null}
          </g>
        );
      })}
      {edgeLabelItems.map((item) => {
        const fired = classifyFiredEdge(item.edge, firedEdgeIds);
        const isVisited =
          hasTransition(history, item.edge.originalFrom, item.edge.originalTo) && fired === 'none';
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
              onPointerEnter={(event) => onEdgePointerEnter(event, hoverId, item.edges)}
              onPointerMove={onEdgePointerMove}
              onPointerLeave={onEdgePointerLeave}
            />
          </g>
        );
      })}
      {layout.selfLoops.map((e) => {
        const node = nodeById.get(e.from);
        if (!node) return null;
        const fired = classifyFiredEdge(e, firedEdgeIds);
        const isVisited = hasTransition(history, e.originalFrom, e.originalTo) && fired === 'none';
        const { labelX, labelY } = selfLoopPath(node);
        const tooltip = edgeGroupTooltipText([e], edgeTooltipLabelContext);
        const label = `↻ ${truncateEdgeLabel(e.exit, e.labelWidth - 12)}`;
        return (
          <g
            key={`l-${e.id}`}
            className={joinClassNames(
              edgeClassName(e, fired, isVisited, selfLoopKindClass(e)),
              edgeInteractionClassName(e, focusState, hoveredEdgeIds),
            )}
            aria-label={tooltip}
            onPointerEnter={(event) => onEdgePointerEnter(event, e.id, [e])}
            onPointerMove={onEdgePointerMove}
            onPointerLeave={onEdgePointerLeave}
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
      <GraphNodes
        nodes={layout.nodes}
        activeStateId={activeStateId}
        visitedNodeIds={visitedNodeIds}
        awaitsOwner={awaitsOwner}
        isTerminal={isTerminal}
        focusState={focusState}
        nodeFocusEdges={nodeFocusEdges}
        onToggleExpandedEmbed={onToggleExpandedEmbed}
        onNodeClick={onNodeClick}
      />
    </>
  );
}

function GraphNodes({
  nodes,
  activeStateId,
  visitedNodeIds,
  awaitsOwner,
  isTerminal,
  focusState,
  nodeFocusEdges,
  onToggleExpandedEmbed,
  onNodeClick,
}: {
  nodes: ReadonlyArray<LaidOutNode>;
  activeStateId: string | null;
  visitedNodeIds: ReadonlySet<string>;
  awaitsOwner: boolean;
  isTerminal: boolean;
  focusState: EdgeFocusState;
  nodeFocusEdges: ReadonlyArray<FocusableEdge>;
  onToggleExpandedEmbed: (id: string) => void;
  onNodeClick: (event: ReactMouseEvent<SVGGElement>, id: string) => void;
}) {
  return (
    <>
      {nodes.map((n) => {
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
            onClick={(event) => onNodeClick(event, n.id)}
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
                <path className="embed-host-glyph" d="M 11 10 H 18 V 15 H 25 M 18 10 V 6 H 25" />
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
            <text className="node-label" x={n.width / 2} y={n.height / 2 + 5} textAnchor="middle">
              {formatNodeLabel(n)}
            </text>
            {n.isCollapsedEmbedHost ? (
              <EmbedToggleControl
                x={n.width - 30}
                y={8}
                label={formatNodeLabel(n)}
                expanded={false}
                onToggle={() => onToggleExpandedEmbed(n.id)}
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
  );
}
