import type { VizNode } from '../types/topology.js';
import type { LaidOutEdge, LaidOutNode } from './graphElk.js';

export type EdgeEndpointRole = 'none' | 'source' | 'target' | 'self';

export type EdgeFocusState = {
  selectedNodeId: string | null;
  hoveredEdgeId: string | null;
};

export type LegendItem = {
  id: string;
  label: string;
  swatch: string;
};

type FocusableEdgeInput = Pick<
  LaidOutEdge,
  | 'id'
  | 'semanticId'
  | 'from'
  | 'to'
  | 'originalFrom'
  | 'originalTo'
  | 'routeFrom'
  | 'routeTo'
  | 'exit'
  | 'kind'
  | 'feedbackClass'
  | 'layoutRole'
  | 'mainRole'
>;

export type FocusableEdgeKind = 'elk-edge' | 'self-loop';

export type FocusableEdge = FocusableEdgeInput & {
  focusableKind: FocusableEdgeKind;
};

type FocusableEdgeShape = Pick<FocusableEdge, 'id' | 'routeFrom' | 'routeTo'>;

type LabelNode = Pick<VizNode, 'id' | 'label' | 'kind' | 'outcome'>;

type NodeLabelCollection = ReadonlyArray<LabelNode> | ReadonlyMap<string, LabelNode>;

export type EdgeTooltipLabelContext = {
  visibleNodes?: NodeLabelCollection;
  topologyNodes?: NodeLabelCollection;
  labelForNodeId?: (nodeId: string) => string | null | undefined;
};

export type GraphLegendNode = Pick<
  LaidOutNode,
  | 'id'
  | 'kind'
  | 'isCollapsedEmbedHost'
  | 'isExpandedEmbedHost'
  | 'activeDescendant'
  | 'visitedDescendant'
  | 'outcome'
>;

export type GraphLegendEdge = Pick<
  FocusableEdge,
  'id' | 'semanticId' | 'routeFrom' | 'routeTo' | 'feedbackClass' | 'layoutRole' | 'mainRole'
>;

export type BuildGraphLegendItemsInput = {
  nodes: ReadonlyArray<GraphLegendNode>;
  edges: ReadonlyArray<GraphLegendEdge>;
  selfLoops?: ReadonlyArray<GraphLegendEdge>;
  firedEdgeIds?: ReadonlySet<string>;
  activeStateId?: string | null;
  awaitsOwner?: boolean;
  selectedNodeId?: string | null;
};

const LEGEND_DEFINITIONS: Record<string, LegendItem> = {
  currentState: {
    id: 'current-state',
    label: 'current state',
    swatch: 'sw-node sw-active',
  },
  waitingOwner: {
    id: 'waiting-owner',
    label: 'waiting for owner',
    swatch: 'sw-node sw-awaits',
  },
  selectedState: {
    id: 'selected-state',
    label: 'selected state',
    swatch: 'sw-node selected',
  },
  lastTransition: {
    id: 'last-transition',
    label: 'last transition',
    swatch: 'sw-edge sw-edge-fired',
  },
  possibleLastTransition: {
    id: 'possible-last-transition',
    label: 'possible last transition',
    swatch: 'sw-edge sw-edge-candidate',
  },
  mainPath: {
    id: 'main-path',
    label: 'main path',
    swatch: 'sw-edge sw-edge-main-forward',
  },
  sidePath: {
    id: 'side-control-path',
    label: 'side/control path',
    swatch: 'sw-edge sw-edge-control',
  },
  loopBackEdge: {
    id: 'loop-back-edge',
    label: 'loop/back edge',
    swatch: 'sw-edge sw-edge-main-feedback',
  },
  collapsedEmbed: {
    id: 'collapsed-embedded-fsm',
    label: 'collapsed embedded FSM',
    swatch: 'sw-node sw-collapsed-embed',
  },
  expandedEmbed: {
    id: 'expanded-embedded-fsm',
    label: 'expanded embedded FSM',
    swatch: 'sw-region',
  },
  hiddenChildActivity: {
    id: 'hidden-child-activity',
    label: 'hidden child activity',
    swatch: 'sw-node sw-descendant',
  },
  finalState: {
    id: 'final-state',
    label: 'final state',
    swatch: 'sw-node sw-final',
  },
};

function focusableEdgeFromLaidOutEdge(edge: FocusableEdgeInput): FocusableEdge {
  return toFocusableEdge(edge, 'elk-edge');
}

function focusableEdgeFromSelfLoop(edge: FocusableEdgeInput): FocusableEdge {
  return toFocusableEdge(edge, 'self-loop');
}

export function buildFocusableEdges({
  edges,
  selfLoops = [],
}: {
  edges: ReadonlyArray<FocusableEdgeInput>;
  selfLoops?: ReadonlyArray<FocusableEdgeInput>;
}): FocusableEdge[] {
  return [
    ...edges.map((edge) => focusableEdgeFromLaidOutEdge(edge)),
    ...selfLoops.map((edge) => focusableEdgeFromSelfLoop(edge)),
  ];
}

export function edgeEndpointRole(
  edge: Pick<FocusableEdge, 'routeFrom' | 'routeTo'>,
  nodeId: string,
): EdgeEndpointRole {
  const isSource = edge.routeFrom === nodeId;
  const isTarget = edge.routeTo === nodeId;
  if (isSource && isTarget) return 'self';
  if (isSource) return 'source';
  if (isTarget) return 'target';
  return 'none';
}

export function edgeFocusClassName(edge: FocusableEdgeShape, focus: EdgeFocusState): string {
  const classes: string[] = [];
  if (focus.hoveredEdgeId === edge.id) classes.push('edge-hovered');

  const selectedRole = focus.selectedNodeId ? edgeEndpointRole(edge, focus.selectedNodeId) : 'none';
  if (selectedRole !== 'none') classes.push(`edge-selected-${selectedRole}`);

  if (hasFocus(focus) && classes.length === 0) classes.push('edge-dimmed');
  return classes.join(' ');
}

export function nodeFocusClassName(
  nodeId: string,
  focus: EdgeFocusState,
  focusableEdges: ReadonlyArray<FocusableEdgeShape>,
): string {
  const state = {
    selected: focus.selectedNodeId === nodeId,
    source: false,
    target: false,
    self: false,
  };

  for (const edge of focusableEdges) {
    const hovered = focus.hoveredEdgeId === edge.id;
    const connectedToSelection =
      focus.selectedNodeId !== null && edgeEndpointRole(edge, focus.selectedNodeId) !== 'none';
    if (!hovered && !connectedToSelection) continue;

    const role = edgeEndpointRole(edge, nodeId);
    if (role === 'source') state.source = true;
    if (role === 'target') state.target = true;
    if (role === 'self') state.self = true;
  }

  const classes = [
    state.selected ? 'selected' : '',
    state.source ? 'edge-source' : '',
    state.target ? 'edge-target' : '',
    state.self ? 'edge-self' : '',
  ].filter(Boolean);

  if (hasFocus(focus) && classes.length === 0) classes.push('node-dimmed');
  return classes.join(' ');
}

export function edgeTooltipText(
  edge: Pick<
    FocusableEdge,
    'kind' | 'exit' | 'routeFrom' | 'routeTo' | 'originalFrom' | 'originalTo'
  >,
  labelContext: EdgeTooltipLabelContext,
): string {
  const visibleFrom = resolveNodeLabel(edge.routeFrom, labelContext, 'visible');
  const visibleTo = resolveNodeLabel(edge.routeTo, labelContext, 'visible');
  const parts = [
    `kind: ${edge.kind}`,
    `exit: ${edge.exit || '(unnamed)'}`,
    `visible: ${visibleFrom} -> ${visibleTo}`,
  ];

  if (edge.routeFrom !== edge.originalFrom || edge.routeTo !== edge.originalTo) {
    const originalFrom = resolveNodeLabel(edge.originalFrom, labelContext, 'topology');
    const originalTo = resolveNodeLabel(edge.originalTo, labelContext, 'topology');
    parts.push(`original: ${originalFrom} -> ${originalTo}`);
  }

  return parts.join(' | ');
}

export function buildGraphLegendItems(input: BuildGraphLegendItemsInput): LegendItem[] {
  const items: LegendItem[] = [];
  const visibleNodeIds = new Set(input.nodes.map((node) => node.id));
  const edges = [...input.edges, ...(input.selfLoops ?? [])];
  const firedEdgeIds = input.firedEdgeIds ?? new Set<string>();

  const add = (item: LegendItem) => items.push({ ...item });

  if (input.activeStateId && visibleNodeIds.has(input.activeStateId)) {
    add(LEGEND_DEFINITIONS.currentState);
    if (input.awaitsOwner) add(LEGEND_DEFINITIONS.waitingOwner);
  }

  if (input.selectedNodeId && visibleNodeIds.has(input.selectedNodeId)) {
    add(LEGEND_DEFINITIONS.selectedState);
  }

  const visibleFiredEdges = edges.filter((edge) => firedEdgeIds.has(edge.semanticId));
  if (visibleFiredEdges.length > 0) {
    add(
      firedEdgeIds.size === 1
        ? LEGEND_DEFINITIONS.lastTransition
        : LEGEND_DEFINITIONS.possibleLastTransition,
    );
  }

  if (edges.some((edge) => edge.mainRole === 'forward')) add(LEGEND_DEFINITIONS.mainPath);
  if (
    edges.some(
      (edge) =>
        edge.mainRole === 'side' ||
        edge.layoutRole === 'auxiliary' ||
        edge.layoutRole === 'resume' ||
        edge.layoutRole === 'terminal',
    )
  ) {
    add(LEGEND_DEFINITIONS.sidePath);
  }
  if (
    edges.some(
      (edge) =>
        edge.routeFrom === edge.routeTo ||
        edge.mainRole === 'feedback' ||
        edge.feedbackClass === 'feedback' ||
        edge.feedbackClass === 'cycle-feedback',
    )
  ) {
    add(LEGEND_DEFINITIONS.loopBackEdge);
  }

  if (input.nodes.some((node) => node.isCollapsedEmbedHost)) add(LEGEND_DEFINITIONS.collapsedEmbed);
  if (input.nodes.some((node) => node.isExpandedEmbedHost)) add(LEGEND_DEFINITIONS.expandedEmbed);
  if (
    input.nodes.some(
      (node) => node.isCollapsedEmbedHost && (node.activeDescendant || node.visitedDescendant),
    )
  ) {
    add(LEGEND_DEFINITIONS.hiddenChildActivity);
  }
  if (input.nodes.some((node) => node.kind === 'terminal')) add(LEGEND_DEFINITIONS.finalState);

  return items;
}

function toFocusableEdge(
  edge: FocusableEdgeInput,
  focusableKind: FocusableEdgeKind,
): FocusableEdge {
  return {
    id: edge.id,
    semanticId: edge.semanticId,
    from: edge.from,
    to: edge.to,
    originalFrom: edge.originalFrom,
    originalTo: edge.originalTo,
    routeFrom: edge.routeFrom,
    routeTo: edge.routeTo,
    exit: edge.exit,
    kind: edge.kind,
    feedbackClass: edge.feedbackClass,
    layoutRole: edge.layoutRole,
    mainRole: edge.mainRole,
    focusableKind,
  };
}

function hasFocus(focus: EdgeFocusState): boolean {
  return focus.hoveredEdgeId !== null || focus.selectedNodeId !== null;
}

function resolveNodeLabel(
  nodeId: string,
  context: EdgeTooltipLabelContext,
  preference: 'visible' | 'topology',
): string {
  const resolved = context.labelForNodeId?.(nodeId);
  if (resolved) return resolved;

  const sources =
    preference === 'visible'
      ? [context.visibleNodes, context.topologyNodes]
      : [context.topologyNodes, context.visibleNodes];
  for (const source of sources) {
    const node = findNode(source, nodeId);
    if (node) return leafOfLabel(node.label || node.id);
  }
  return nodeId;
}

function findNode(source: NodeLabelCollection | undefined, nodeId: string): LabelNode | null {
  if (!source) return null;
  if (typeof (source as ReadonlyMap<string, LabelNode>).get === 'function') {
    return (source as ReadonlyMap<string, LabelNode>).get(nodeId) ?? null;
  }
  return (source as ReadonlyArray<LabelNode>).find((node) => node.id === nodeId) ?? null;
}

function leafOfLabel(label: string): string {
  return label.split('.').pop() ?? label;
}
