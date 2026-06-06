import ELK from 'elkjs/lib/elk.bundled.js';

import type { VizNode } from '../types/topology.js';
import {
  type GraphLayoutEdge,
  type GraphLayoutModel,
  type GraphLayoutScope,
  type GraphLayoutWarning,
} from './graphLayoutModel.js';

type ElkLayoutOptions = Record<string, string>;
type ElkPoint = { x: number; y: number };
type ElkLabel = {
  id?: string;
  text?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  layoutOptions?: ElkLayoutOptions;
};
type ElkPort = {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  layoutOptions?: ElkLayoutOptions;
};
type ElkEdgeSection = {
  id: string;
  startPoint: ElkPoint;
  endPoint: ElkPoint;
  bendPoints?: ElkPoint[];
};
type ElkEdge = {
  id: string;
  sources: string[];
  targets: string[];
  layoutOptions?: ElkLayoutOptions;
  labels?: ElkLabel[];
  sections?: ElkEdgeSection[];
  container?: string;
};
type ElkNode = {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  labels?: ElkLabel[];
  layoutOptions?: ElkLayoutOptions;
  children?: ElkNode[];
  ports?: ElkPort[];
  edges?: ElkEdge[];
};

type LayerConstraintMode = 'first-last' | 'separate';

export type GraphElkProbeResults = {
  layerConstraints: {
    mode: LayerConstraintMode;
    firstLast: GraphElkProbeStatus;
    separate: GraphElkProbeStatus;
  };
  fixedPorts: {
    useFixedPorts: boolean;
    multiEdge: GraphElkProbeStatus;
    mixedForwardBackward: GraphElkProbeStatus;
  };
  edgeLabels: {
    useElkLabels: boolean;
    status: GraphElkProbeStatus;
  };
};

export type GraphElkProbeStatus = {
  ok: boolean;
  message: string;
};

export type GraphElkWarning =
  | GraphLayoutWarning
  | {
      code: 'elk-probe';
      nodeId?: string;
      message: string;
    };

export type LaidOutNode = VizNode & {
  x: number;
  y: number;
  width: number;
  height: number;
  scopeId: string;
  isExpandedEmbedHost: boolean;
  isCollapsedEmbedHost: boolean;
  activeDescendant: boolean;
  visitedDescendant: boolean;
};

export type LaidOutEdge = GraphLayoutEdge & {
  bendPoints: ElkPoint[];
  sourcePoint: ElkPoint;
  targetPoint: ElkPoint;
  labelPoint?: ElkPoint;
};

export type CompoundRegion = {
  id: string;
  scopeId: string;
  parentScopeId: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  labelBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type GraphElkLayout = {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  selfLoops: GraphLayoutEdge[];
  compoundRegions: CompoundRegion[];
  warnings: GraphElkWarning[];
  probeResults: GraphElkProbeResults;
  width: number;
  height: number;
};

export type BuildElkGraphOptions = {
  layerConstraintMode?: LayerConstraintMode;
  useFixedPorts?: boolean;
  useElkLabels?: boolean;
};

export type ElkGraphBuild = {
  graph: ElkNode;
  edgeContainerById: Map<string, string>;
};

const elk = new ELK();

const NODE_PAD = 24;
const NODE_HEIGHT = 56;
const NODE_MIN_W = 150;
const NODE_MAX_W = 260;
const PASSIVE_NODE_MIN_W = 96;
const PASSIVE_NODE_MAX_W = 210;
const EDGE_LABEL_HEIGHT = 16;
const COMPOUND_LABEL_HEIGHT = 18;
const COMPOUND_PADDING_TOP = 40;
const COMPOUND_PADDING_X = 28;
const COMPOUND_PADDING_BOTTOM = 28;
const ROOT_SCOPE_ID = 'root';
const PORT_SIZE = 2;

const BASE_LAYOUT_OPTIONS: ElkLayoutOptions = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.layered.spacing.nodeNodeBetweenLayers': '72',
  'elk.spacing.nodeNode': '40',
  'elk.spacing.edgeNode': '24',
  'elk.spacing.edgeEdge': '16',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
};

const MAIN_SPINE_LAYOUT_OPTIONS: ElkLayoutOptions = {
  'org.eclipse.elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'org.eclipse.elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
  'org.eclipse.elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',
  'org.eclipse.elk.layered.feedbackEdges': 'true',
  'org.eclipse.elk.layered.nodePlacement.favorStraightEdges': 'true',
};
const MAIN_FORWARD_STRAIGHTNESS_PRIORITY = '100';

let probeResultsPromise: Promise<GraphElkProbeResults> | null = null;

function leafOf(path: string): string {
  return path.split('.').pop() ?? path;
}

function nodeWidth(node: VizNode): number {
  if (node.kind === 'terminal') return 140;
  const label = formatNodeLabel(node);
  const w = label.length * 9 + NODE_PAD * 2;
  if (node.kind === 'passive') {
    return Math.max(PASSIVE_NODE_MIN_W, Math.min(PASSIVE_NODE_MAX_W, w));
  }
  return Math.max(NODE_MIN_W, Math.min(NODE_MAX_W, w));
}

function nodeHeight(node: VizNode): number {
  if (node.kind === 'passive') return 28;
  return NODE_HEIGHT;
}

function formatNodeLabel(node: Pick<VizNode, 'label' | 'kind'>): string {
  return leafOf(node.label);
}

export const formatNodeLabelForTest = formatNodeLabel;

export function buildElkGraphForTest(
  model: GraphLayoutModel,
  options: BuildElkGraphOptions = {},
): ElkGraphBuild {
  return buildElkGraph(model, {
    layerConstraintMode: options.layerConstraintMode ?? 'first-last',
    useFixedPorts: options.useFixedPorts ?? false,
    useElkLabels: options.useElkLabels ?? false,
  });
}

export async function probeGraphElkCapabilitiesForTest(): Promise<GraphElkProbeResults> {
  return probeGraphElkCapabilities();
}

export async function runGraphElkLayout(model: GraphLayoutModel): Promise<GraphElkLayout> {
  const probes = await probeGraphElkCapabilities();
  const warnings = probeWarnings(probes);
  const buildOptions: Required<BuildElkGraphOptions> = {
    layerConstraintMode: probes.layerConstraints.mode,
    useFixedPorts: probes.fixedPorts.useFixedPorts,
    useElkLabels: probes.edgeLabels.useElkLabels,
  };

  try {
    return normalizeLayout(model, await layoutBuild(model, buildOptions), probes, [
      ...model.warnings,
      ...warnings,
    ]);
  } catch (err) {
    if (buildOptions.layerConstraintMode === 'separate' || !isLayerConstraintError(err)) {
      throw err;
    }
    try {
      return normalizeLayout(
        model,
        await layoutBuild(model, { ...buildOptions, layerConstraintMode: 'separate' }),
        {
          ...probes,
          layerConstraints: { ...probes.layerConstraints, mode: 'separate' },
        },
        [
          ...model.warnings,
          ...warnings,
          {
            code: 'elk-probe',
            message:
              'ELK rejected FIRST/LAST for this graph; retried with FIRST_SEPARATE/LAST_SEPARATE.',
          },
        ],
      );
    } catch (fallbackErr) {
      throw new Error(
        `ELK rejected both documented layer-constraint modes: ${errorMessage(fallbackErr)}`,
        { cause: fallbackErr },
      );
    }
  }
}

async function layoutBuild(
  model: GraphLayoutModel,
  options: Required<BuildElkGraphOptions>,
): Promise<{ out: ElkNode; edgeContainerById: Map<string, string> }> {
  const build = buildElkGraph(model, options);
  const out = (await elk.layout(build.graph)) as ElkNode;
  return { out, edgeContainerById: build.edgeContainerById };
}

function buildElkGraph(
  model: GraphLayoutModel,
  options: Required<BuildElkGraphOptions>,
): ElkGraphBuild {
  const scopesByHost = new Map<string | null, GraphLayoutScope>();
  const scopesById = new Map<string, GraphLayoutScope>();
  for (const scope of model.scopes) {
    scopesByHost.set(scope.hostId, scope);
    scopesById.set(scope.id, scope);
  }

  const nodeById = new Map<string, ElkNode>();
  const edgeContainerById = new Map<string, string>();
  const expandedHostIds = new Set<string>();
  for (const scope of model.scopes) {
    if (isString(scope.hostId)) expandedHostIds.add(scope.hostId);
  }
  const hasExpandedCompound = expandedHostIds.size > 0;

  const rootScope = scopesById.get(ROOT_SCOPE_ID);
  if (!rootScope) {
    throw new Error('Graph layout model is missing the root scope.');
  }

  const root: ElkNode = {
    id: ROOT_SCOPE_ID,
    layoutOptions: {
      ...BASE_LAYOUT_OPTIONS,
      ...mainSpineLayoutOptions(rootScope),
      ...(hasExpandedCompound ? { 'org.eclipse.elk.hierarchyHandling': 'INCLUDE_CHILDREN' } : {}),
    },
    children: rootScope.orderedNodeIds.map((nodeId) =>
      buildElkNode(nodeId, rootScope, {
        model,
        scopesByHost,
        nodeById,
        edgeContainerById,
        expandedHostIds,
        options,
      }),
    ),
    edges: [],
  };

  addScopeEdges(root, rootScope, model, nodeById, edgeContainerById, options);
  return { graph: root, edgeContainerById };
}

function buildElkNode(
  nodeId: string,
  scope: GraphLayoutScope,
  context: {
    model: GraphLayoutModel;
    scopesByHost: ReadonlyMap<string | null, GraphLayoutScope>;
    nodeById: Map<string, ElkNode>;
    edgeContainerById: Map<string, string>;
    expandedHostIds: ReadonlySet<string>;
    options: Required<BuildElkGraphOptions>;
  },
): ElkNode {
  const { model, scopesByHost, nodeById, edgeContainerById, expandedHostIds, options } = context;
  const node = model.nodesById.get(nodeId);
  if (!node) throw new Error(`Missing node "${nodeId}" while building ELK graph.`);

  const layoutOptions = layerConstraintOptions(nodeId, scope, options.layerConstraintMode);
  const childScope = scopesByHost.get(nodeId);
  const isExpandedHost = expandedHostIds.has(nodeId) && childScope;
  const leafWidth = nodeWidth(node);
  const leafHeight = nodeHeight(node);
  const mainPorts =
    !options.useFixedPorts || isExpandedHost
      ? []
      : mainSpinePortsForNode({
          nodeId: node.id,
          scope,
          width: leafWidth,
          height: leafHeight,
          expandedHostIds,
        });
  const elkNode: ElkNode = isExpandedHost
    ? {
        id: node.id,
        layoutOptions: {
          ...layoutOptions,
          ...mainSpineLayoutOptions(childScope),
          'org.eclipse.elk.padding': `[top=${COMPOUND_PADDING_TOP},left=${COMPOUND_PADDING_X},bottom=${COMPOUND_PADDING_BOTTOM},right=${COMPOUND_PADDING_X}]`,
          'org.eclipse.elk.nodeLabels.placement': 'INSIDE H_CENTER V_TOP',
        },
        labels: [
          {
            id: `${node.id}:label`,
            text: formatNodeLabel(node),
            width: Math.max(64, nodeWidth(node) - NODE_PAD),
            height: COMPOUND_LABEL_HEIGHT,
          },
        ],
        children: childScope.orderedNodeIds.map((childId) =>
          buildElkNode(childId, childScope, context),
        ),
        edges: [],
      }
    : {
        id: node.id,
        width: leafWidth,
        height: leafHeight,
        layoutOptions:
          mainPorts.length === 0
            ? layoutOptions
            : {
                ...layoutOptions,
                'org.eclipse.elk.portConstraints': 'FIXED_POS',
              },
        ports: mainPorts.length === 0 ? undefined : mainPorts,
      };

  nodeById.set(node.id, elkNode);
  if (isExpandedHost) {
    addScopeEdges(elkNode, childScope, model, nodeById, edgeContainerById, options);
  }
  return elkNode;
}

function addScopeEdges(
  elkContainer: ElkNode,
  scope: GraphLayoutScope,
  model: GraphLayoutModel,
  nodeById: Map<string, ElkNode>,
  edgeContainerById: Map<string, string>,
  options: Required<BuildElkGraphOptions>,
) {
  const edges = model.nodePlacementEdges.filter((edge) => edge.scopeId === scope.id);
  if (edges.length === 0) return;
  elkContainer.edges ??= [];
  for (const edge of edges) {
    const elkEdge = buildElkEdge(edge, scope, nodeById, options);
    elkContainer.edges.push(elkEdge);
    edgeContainerById.set(edge.id, scope.hostId ?? ROOT_SCOPE_ID);
  }
}

function buildElkEdge(
  edge: GraphLayoutEdge,
  scope: GraphLayoutScope,
  nodeById: Map<string, ElkNode>,
  options: Required<BuildElkGraphOptions>,
): ElkEdge {
  let source = edge.routeFrom;
  let target = edge.routeTo;
  if (options.useFixedPorts && canUseScopedPorts(edge, scope, nodeById)) {
    const sourceMainPort = mainSpinePortId(edge.routeFrom, 'source');
    const targetMainPort = mainSpinePortId(edge.routeTo, 'target');
    if (
      edge.mainRole === 'forward' &&
      hasPort(edge.routeFrom, sourceMainPort, nodeById) &&
      hasPort(edge.routeTo, targetMainPort, nodeById)
    ) {
      source = sourceMainPort;
      target = targetMainPort;
    } else if (
      !usesFixedPositionPorts(edge.routeFrom, nodeById) &&
      !usesFixedPositionPorts(edge.routeTo, nodeById)
    ) {
      source = addPort(edge.routeFrom, edge, 'source', nodeById);
      target = addPort(edge.routeTo, edge, 'target', nodeById);
    }
  }
  return {
    id: edge.id,
    sources: [source],
    targets: [target],
    layoutOptions: edgeLayoutOptions(edge),
    labels:
      options.useElkLabels && edge.isVisible && !edge.isRankOnly
        ? [
            {
              id: `${edge.id}:label`,
              text: edge.exit,
              width: edge.labelWidth,
              height: EDGE_LABEL_HEIGHT,
              layoutOptions: { 'org.eclipse.elk.edgeLabels.placement': 'CENTER' },
            },
          ]
        : undefined,
  };
}

function mainSpinePortsForNode(args: {
  nodeId: string;
  scope: GraphLayoutScope;
  width: number;
  height: number;
  expandedHostIds: ReadonlySet<string>;
}): ElkPort[] {
  const { nodeId, scope, width, height, expandedHostIds } = args;
  if (scope.mainSpine.forwardEdgeIds.length === 0) return [];
  const forwardEdgeIds = new Set(scope.mainSpine.forwardEdgeIds);
  const localNodeIds = new Set(scope.nodeIds);
  let needsNorth = false;
  let needsSouth = false;

  for (const edge of scope.linearEdges) {
    if (!forwardEdgeIds.has(edge.id) || edge.isRankOnly || !edge.isVisible) continue;
    if (!localNodeIds.has(edge.routeFrom) || !localNodeIds.has(edge.routeTo)) continue;
    if (expandedHostIds.has(edge.routeFrom) || expandedHostIds.has(edge.routeTo)) continue;
    if (edge.routeFrom === nodeId) needsSouth = true;
    if (edge.routeTo === nodeId) needsNorth = true;
  }

  const ports: ElkPort[] = [];
  if (needsNorth) ports.push(mainSpinePort(nodeId, 'target', width, height));
  if (needsSouth) ports.push(mainSpinePort(nodeId, 'source', width, height));
  return ports;
}

function mainSpinePort(
  nodeId: string,
  role: 'source' | 'target',
  width: number,
  height: number,
): ElkPort {
  const side = role === 'source' ? 'SOUTH' : 'NORTH';
  return {
    id: mainSpinePortId(nodeId, role),
    x: width / 2 - PORT_SIZE / 2,
    y: role === 'source' ? height - PORT_SIZE / 2 : -PORT_SIZE / 2,
    width: PORT_SIZE,
    height: PORT_SIZE,
    layoutOptions: { 'org.eclipse.elk.port.side': side },
  };
}

function mainSpinePortId(nodeId: string, role: 'source' | 'target'): string {
  return `${nodeId}:main:${role === 'source' ? 's' : 'n'}`;
}

function mainSpineLayoutOptions(scope: GraphLayoutScope): ElkLayoutOptions {
  if (scope.mainSpine.mainNodeIds.length === 0) return {};
  return MAIN_SPINE_LAYOUT_OPTIONS;
}

function edgeLayoutOptions(edge: GraphLayoutEdge): ElkLayoutOptions | undefined {
  if (edge.mainRole !== 'forward' || !edge.isVisible || edge.isRankOnly) return undefined;
  return {
    'org.eclipse.elk.layered.priority.straightness': MAIN_FORWARD_STRAIGHTNESS_PRIORITY,
  };
}

function canUseScopedPorts(
  edge: GraphLayoutEdge,
  scope: GraphLayoutScope,
  nodeById: ReadonlyMap<string, ElkNode>,
): boolean {
  const localNodeIds = new Set(scope.nodeIds);
  const source = nodeById.get(edge.routeFrom);
  const target = nodeById.get(edge.routeTo);
  return (
    localNodeIds.has(edge.routeFrom) &&
    localNodeIds.has(edge.routeTo) &&
    !source?.children?.length &&
    !target?.children?.length
  );
}

function hasPort(nodeId: string, portId: string, nodeById: ReadonlyMap<string, ElkNode>): boolean {
  return Boolean(nodeById.get(nodeId)?.ports?.some((port) => port.id === portId));
}

function usesFixedPositionPorts(nodeId: string, nodeById: ReadonlyMap<string, ElkNode>): boolean {
  return nodeById.get(nodeId)?.layoutOptions?.['org.eclipse.elk.portConstraints'] === 'FIXED_POS';
}

function addPort(
  nodeId: string,
  edge: GraphLayoutEdge,
  role: 'source' | 'target',
  nodeById: Map<string, ElkNode>,
): string {
  const node = nodeById.get(nodeId);
  if (!node) return nodeId;
  const portId = `${nodeId}:${edge.id}:${role}`;
  const feedback = edge.feedbackClass === 'feedback' || edge.feedbackClass === 'cycle-feedback';
  const side = role === 'source' ? (feedback ? 'NORTH' : 'SOUTH') : feedback ? 'SOUTH' : 'NORTH';
  node.layoutOptions = {
    ...(node.layoutOptions ?? {}),
    'org.eclipse.elk.portConstraints': 'FIXED_SIDE',
  };
  node.ports ??= [];
  node.ports.push({
    id: portId,
    width: 2,
    height: 2,
    layoutOptions: { 'org.eclipse.elk.port.side': side },
  });
  return portId;
}

function layerConstraintOptions(
  nodeId: string,
  scope: GraphLayoutScope,
  mode: LayerConstraintMode,
): ElkLayoutOptions {
  const constraint =
    nodeId === scope.entryNodeId
      ? mode === 'separate'
        ? 'FIRST_SEPARATE'
        : 'FIRST'
      : scope.localSinkTerminalIds.includes(nodeId)
        ? mode === 'separate'
          ? 'LAST_SEPARATE'
          : 'LAST'
        : null;
  return constraint ? { 'org.eclipse.elk.layered.layering.layerConstraint': constraint } : {};
}

function normalizeLayout(
  model: GraphLayoutModel,
  layout: { out: ElkNode; edgeContainerById: Map<string, string> },
  probeResults: GraphElkProbeResults,
  warnings: GraphElkWarning[],
): GraphElkLayout {
  const { out, edgeContainerById } = layout;
  const nodes: LaidOutNode[] = [];
  const compoundRegions: CompoundRegion[] = [];
  const edgeById = new Map(model.layoutEdges.map((edge) => [edge.id, edge]));
  const visibleEdgeIds = new Set(model.visibleEdges.map((edge) => edge.id));
  const outputEdges = new Map<string, ElkEdge>();
  const containerOffsetById = new Map<string, ElkPoint>([[ROOT_SCOPE_ID, { x: 0, y: 0 }]]);
  const scopeIdByNode = scopeIdByNodeId(model);
  const childScopeIds = new Set<string>();
  for (const scope of model.scopes) {
    if (isString(scope.hostId)) childScopeIds.add(scope.hostId);
  }

  function visitNode(node: ElkNode, parentOffset: ElkPoint, parentScopeId: string) {
    const abs = {
      x: parentOffset.x + (node.x ?? 0),
      y: parentOffset.y + (node.y ?? 0),
    };
    containerOffsetById.set(node.id, abs);

    const source = model.nodesById.get(node.id);
    const nodeScopeId = scopeIdByNode.get(node.id) ?? parentScopeId;
    if (source) {
      const metadata = model.visibleNodeMetadata.get(node.id);
      nodes.push({
        ...source,
        x: abs.x,
        y: abs.y,
        width: node.width ?? nodeWidth(source),
        height: node.height ?? nodeHeight(source),
        scopeId: nodeScopeId,
        isExpandedEmbedHost: childScopeIds.has(node.id),
        isCollapsedEmbedHost: metadata?.isCollapsedEmbedHost ?? false,
        activeDescendant: metadata?.activeDescendant ?? false,
        visitedDescendant: metadata?.visitedDescendant ?? false,
      });
      if (childScopeIds.has(node.id)) {
        const label = node.labels?.[0];
        compoundRegions.push({
          id: node.id,
          scopeId: node.id,
          parentScopeId: nodeScopeId,
          label: label?.text ?? formatNodeLabel(source),
          x: abs.x,
          y: abs.y,
          width: node.width ?? nodeWidth(source),
          height: node.height ?? nodeHeight(source),
          labelBounds: {
            x: abs.x + (label?.x ?? COMPOUND_PADDING_X),
            y: abs.y + (label?.y ?? 6),
            width: label?.width ?? nodeWidth(source),
            height: label?.height ?? COMPOUND_LABEL_HEIGHT,
          },
        });
      }
    }

    for (const edge of node.edges ?? []) outputEdges.set(edge.id, edge);
    for (const child of node.children ?? []) {
      visitNode(child, abs, childScopeIds.has(node.id) ? node.id : parentScopeId);
    }
  }

  for (const edge of out.edges ?? []) outputEdges.set(edge.id, edge);
  for (const child of out.children ?? []) visitNode(child, { x: 0, y: 0 }, ROOT_SCOPE_ID);

  const edges: LaidOutEdge[] = [];
  for (const [edgeId, edge] of outputEdges) {
    if (!visibleEdgeIds.has(edgeId)) continue;
    const def = edgeById.get(edgeId);
    if (!def) continue;
    const section = edge.sections?.[0];
    if (!section) continue;
    const containerId = edgeContainerById.get(edgeId) ?? edge.container ?? ROOT_SCOPE_ID;
    const offset = containerOffsetById.get(containerId) ?? { x: 0, y: 0 };
    edges.push({
      ...def,
      sourcePoint: addPoint(section.startPoint, offset),
      targetPoint: addPoint(section.endPoint, offset),
      bendPoints: (section.bendPoints ?? []).map((point) => addPoint(point, offset)),
      labelPoint: normalizeEdgeLabel(edge.labels?.[0], offset),
    });
  }

  edges.sort((a, b) => a.edgeIndex - b.edgeIndex || a.id.localeCompare(b.id));

  return {
    nodes,
    edges,
    selfLoops: model.selfLoops,
    compoundRegions,
    warnings,
    probeResults,
    width: out.width ?? 800,
    height: out.height ?? 600,
  };
}

function normalizeEdgeLabel(label: ElkLabel | undefined, offset: ElkPoint): ElkPoint | undefined {
  if (label?.x === undefined || label.y === undefined) return undefined;
  return {
    x: offset.x + label.x + (label.width ?? 0) / 2,
    y: offset.y + label.y + (label.height ?? 0) / 2,
  };
}

function addPoint(point: ElkPoint, offset: ElkPoint): ElkPoint {
  return { x: point.x + offset.x, y: point.y + offset.y };
}

function scopeIdByNodeId(model: GraphLayoutModel): Map<string, string> {
  const scopeIdByNode = new Map<string, string>();
  for (const scope of model.scopes) {
    for (const nodeId of scope.orderedNodeIds) scopeIdByNode.set(nodeId, scope.id);
  }
  return scopeIdByNode;
}

async function probeGraphElkCapabilities(): Promise<GraphElkProbeResults> {
  probeResultsPromise ??= runProbes();
  return probeResultsPromise;
}

async function runProbes(): Promise<GraphElkProbeResults> {
  const layerConstraints = await probeLayerConstraints();
  if (!layerConstraints.firstLast.ok && !layerConstraints.separate.ok) {
    throw new Error(
      `ELK rejected FIRST/LAST and FIRST_SEPARATE/LAST_SEPARATE probes: ${layerConstraints.firstLast.message}; ${layerConstraints.separate.message}`,
    );
  }
  const [multiEdge, mixedForwardBackward, edgeLabel] = await Promise.all([
    probeFixedPorts('multi-edge', multiEdgeProbeGraph),
    probeFixedPorts('mixed-forward-backward', mixedForwardBackwardProbeGraph),
    probeEdgeLabels(),
  ]);
  return {
    layerConstraints: {
      mode: layerConstraints.firstLast.ok ? 'first-last' : 'separate',
      firstLast: layerConstraints.firstLast,
      separate: layerConstraints.separate,
    },
    fixedPorts: {
      useFixedPorts: multiEdge.ok && mixedForwardBackward.ok,
      multiEdge,
      mixedForwardBackward,
    },
    edgeLabels: {
      useElkLabels: edgeLabel.ok,
      status: edgeLabel,
    },
  };
}

async function probeLayerConstraints(): Promise<{
  firstLast: GraphElkProbeStatus;
  separate: GraphElkProbeStatus;
}> {
  return {
    firstLast: await runProbeGraph(() => compoundBoundaryProbeGraph('FIRST', 'LAST')),
    separate: await runProbeGraph(() =>
      compoundBoundaryProbeGraph('FIRST_SEPARATE', 'LAST_SEPARATE'),
    ),
  };
}

async function probeFixedPorts(
  name: string,
  fixture: (useFixedPorts: boolean) => ElkNode,
): Promise<GraphElkProbeStatus> {
  try {
    const nodeToNode = (await elk.layout(fixture(false))) as ElkNode;
    const fixedPorts = (await elk.layout(fixture(true))) as ElkNode;
    const nodeScore = routeScore(nodeToNode);
    const portScore = routeScore(fixedPorts);
    const ok = portScore <= nodeScore;
    return {
      ok,
      message: ok
        ? `${name}: fixed-side ports preserved routing score ${portScore} <= ${nodeScore}.`
        : `${name}: fixed-side ports worsened routing score ${portScore} > ${nodeScore}.`,
    };
  } catch (err) {
    return { ok: false, message: `${name}: ${errorMessage(err)}` };
  }
}

async function probeEdgeLabels(): Promise<GraphElkProbeStatus> {
  try {
    const out = (await elk.layout(edgeLabelProbeGraph())) as ElkNode;
    const edge = out.edges?.find((candidate) => candidate.id === 'labelled');
    const label = edge?.labels?.[0];
    const ok =
      Boolean(edge?.sections?.[0]) &&
      typeof label?.x === 'number' &&
      typeof label?.y === 'number' &&
      typeof label?.width === 'number' &&
      typeof label?.height === 'number';
    return {
      ok,
      message: ok
        ? 'edge-label: ELK returned label bounds.'
        : 'edge-label: ELK did not return usable label bounds.',
    };
  } catch (err) {
    return { ok: false, message: `edge-label: ${errorMessage(err)}` };
  }
}

async function runProbeGraph(fixture: () => ElkNode): Promise<GraphElkProbeStatus> {
  try {
    await elk.layout(fixture());
    return { ok: true, message: 'accepted' };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

function compoundBoundaryProbeGraph(first: string, last: string): ElkNode {
  return {
    id: ROOT_SCOPE_ID,
    layoutOptions: {
      ...BASE_LAYOUT_OPTIONS,
      'org.eclipse.elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    },
    children: [
      {
        id: 'parent',
        labels: [{ id: 'parent:label', text: 'parent', width: 80, height: COMPOUND_LABEL_HEIGHT }],
        layoutOptions: {
          'org.eclipse.elk.padding': `[top=${COMPOUND_PADDING_TOP},left=${COMPOUND_PADDING_X},bottom=${COMPOUND_PADDING_BOTTOM},right=${COMPOUND_PADDING_X}]`,
          'org.eclipse.elk.nodeLabels.placement': 'INSIDE H_CENTER V_TOP',
        },
        children: [
          {
            id: 'child.entry',
            width: 120,
            height: 50,
            layoutOptions: { 'org.eclipse.elk.layered.layering.layerConstraint': first },
          },
          {
            id: 'child.final',
            width: 120,
            height: 50,
            layoutOptions: { 'org.eclipse.elk.layered.layering.layerConstraint': last },
          },
        ],
        edges: [{ id: 'inside', sources: ['child.entry'], targets: ['child.final'] }],
      },
      {
        id: 'root.target',
        width: 120,
        height: 50,
        layoutOptions: { 'org.eclipse.elk.layered.layering.layerConstraint': last },
      },
    ],
    edges: [
      { id: 'parent-to-child-entry', sources: ['parent'], targets: ['child.entry'] },
      { id: 'child-final-to-parent-target', sources: ['child.final'], targets: ['root.target'] },
    ],
  };
}

function multiEdgeProbeGraph(useFixedPorts: boolean): ElkNode {
  const graph = baseProbeGraph([
    { id: 'a', width: 100, height: 50 },
    { id: 'b', width: 100, height: 50 },
  ]);
  graph.edges = [
    probeEdge('a-to-b-1', 'a', 'b', useFixedPorts, 'SOUTH', 'NORTH', graph.children!),
    probeEdge('a-to-b-2', 'a', 'b', useFixedPorts, 'SOUTH', 'NORTH', graph.children!),
  ];
  return graph;
}

function mixedForwardBackwardProbeGraph(useFixedPorts: boolean): ElkNode {
  const graph = baseProbeGraph([
    { id: 'a', width: 100, height: 50 },
    { id: 'b', width: 100, height: 50 },
    { id: 'c', width: 100, height: 50 },
  ]);
  graph.edges = [
    probeEdge('forward-a-b', 'a', 'b', useFixedPorts, 'SOUTH', 'NORTH', graph.children!),
    probeEdge('forward-b-c', 'b', 'c', useFixedPorts, 'SOUTH', 'NORTH', graph.children!),
    probeEdge('feedback-c-a', 'c', 'a', useFixedPorts, 'NORTH', 'SOUTH', graph.children!),
  ];
  return graph;
}

function edgeLabelProbeGraph(): ElkNode {
  return {
    id: ROOT_SCOPE_ID,
    layoutOptions: BASE_LAYOUT_OPTIONS,
    children: [
      { id: 'a', width: 100, height: 50 },
      { id: 'b', width: 100, height: 50 },
    ],
    edges: [
      {
        id: 'labelled',
        sources: ['a'],
        targets: ['b'],
        labels: [
          {
            id: 'labelled:label',
            text: 'continue',
            width: 76,
            height: EDGE_LABEL_HEIGHT,
            layoutOptions: { 'org.eclipse.elk.edgeLabels.placement': 'CENTER' },
          },
        ],
      },
    ],
  };
}

function baseProbeGraph(children: ElkNode[]): ElkNode {
  return {
    id: ROOT_SCOPE_ID,
    layoutOptions: BASE_LAYOUT_OPTIONS,
    children,
    edges: [],
  };
}

function probeEdge(
  edgeId: string,
  source: string,
  target: string,
  useFixedPorts: boolean,
  sourceSide: string,
  targetSide: string,
  nodes: ElkNode[],
): ElkEdge {
  if (!useFixedPorts) return { id: edgeId, sources: [source], targets: [target] };
  const sourcePort = `${source}:${edgeId}:source`;
  const targetPort = `${target}:${edgeId}:target`;
  ensureProbePort(nodes, source, sourcePort, sourceSide);
  ensureProbePort(nodes, target, targetPort, targetSide);
  return { id: edgeId, sources: [sourcePort], targets: [targetPort] };
}

function ensureProbePort(nodes: ElkNode[], nodeId: string, portId: string, side: string) {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return;
  node.layoutOptions = {
    ...(node.layoutOptions ?? {}),
    'org.eclipse.elk.portConstraints': 'FIXED_SIDE',
  };
  node.ports ??= [];
  node.ports.push({
    id: portId,
    width: 2,
    height: 2,
    layoutOptions: { 'org.eclipse.elk.port.side': side },
  });
}

function routeScore(graph: ElkNode): number {
  let score = 0;
  function visit(node: ElkNode) {
    for (const edge of node.edges ?? []) {
      for (const section of edge.sections ?? []) {
        score += 1 + (section.bendPoints?.length ?? 0);
      }
    }
    for (const child of node.children ?? []) visit(child);
  }
  visit(graph);
  return score;
}

function probeWarnings(probes: GraphElkProbeResults): GraphElkWarning[] {
  const warnings: GraphElkWarning[] = [];
  if (!probes.fixedPorts.useFixedPorts) {
    warnings.push({
      code: 'elk-probe',
      message: `Using node-to-node routing because fixed-side port probes did not both pass. ${probes.fixedPorts.multiEdge.message} ${probes.fixedPorts.mixedForwardBackward.message}`,
    });
  }
  if (!probes.edgeLabels.useElkLabels) {
    warnings.push({
      code: 'elk-probe',
      message: `Using deterministic SVG label placement because the ELK edge-label probe failed. ${probes.edgeLabels.status.message}`,
    });
  }
  if (probes.layerConstraints.mode === 'separate') {
    warnings.push({
      code: 'elk-probe',
      message: 'Using FIRST_SEPARATE/LAST_SEPARATE because FIRST/LAST was rejected by ELK.',
    });
  }
  return warnings;
}

function isLayerConstraintError(err: unknown): boolean {
  return /layer constraint|FIRST|LAST/i.test(errorMessage(err));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isString(value: string | null): value is string {
  return typeof value === 'string';
}
