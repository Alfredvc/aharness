import type { Topology, VizEdge, VizNode } from '../types/topology.js';

export type GraphLayoutWarning = {
  code: 'missing-embed-entry';
  nodeId: string;
  message: string;
};

export type GraphFeedbackClass =
  | 'forward'
  | 'lateral'
  | 'feedback'
  | 'cycle-forward'
  | 'cycle-feedback';

export type GraphLayoutRole =
  | 'primary'
  | 'branch'
  | 'feedback'
  | 'auxiliary'
  | 'resume'
  | 'terminal';

export type GraphRankPolicy = 'rank-defining' | 'rank-neutral' | 'rank-helper';

export type GraphLabelPolicy = 'default-visible' | 'hover-focus-visible' | 'grouped-summary';

export type GraphMainRole = 'forward' | 'feedback' | 'side' | 'none';

export type GraphMainSpine = {
  mainNodeIds: string[];
  forwardEdgeIds: string[];
  feedbackEdgeIds: string[];
  sideEdgeIds: string[];
};

export type GraphLayoutNodeGroup =
  | 'main'
  | 'repair'
  | 'recovery'
  | 'resume'
  | 'terminal'
  | 'embed'
  | 'unreachable';

export type GraphLayoutEdge = VizEdge & {
  semanticId: string;
  scopeId: string;
  originalFrom: string;
  originalTo: string;
  rankFrom: string;
  rankTo: string;
  routeFrom: string;
  routeTo: string;
  isRankOnly: boolean;
  isVisible: boolean;
  feedbackClass: GraphFeedbackClass;
  layoutRole: GraphLayoutRole;
  rankPolicy: GraphRankPolicy;
  labelPolicy: GraphLabelPolicy;
  mainRole: GraphMainRole;
  parallelGroupKey: string;
  parallelIndex: number;
  parallelTotal: number;
  labelWidth: number;
  edgeIndex: number;
};

export type GraphLayoutRank = {
  reachable: boolean;
  rank: number | null;
  componentId: number | null;
};

export type GraphLayoutScope = {
  id: string;
  hostId: string | null;
  semanticEntryId: string | null;
  entryNodeId: string | null;
  nodeIds: string[];
  orderedNodeIds: string[];
  nodeGroups: Map<string, GraphLayoutNodeGroup>;
  mainSpine: GraphMainSpine;
  orderingEdges: GraphLayoutEdge[];
  linearEdges: GraphLayoutEdge[];
  selfLoops: GraphLayoutEdge[];
  reachableNodeIds: string[];
  localSinkTerminalIds: string[];
  ranks: Map<string, GraphLayoutRank>;
};

export type GraphHierarchyNode = {
  id: string;
  parentId: string | null;
  entryId: string | null;
  childIds: string[];
};

export type GraphLayoutNodeMetadata = {
  isCollapsedEmbedHost: boolean;
  activeDescendant: boolean;
  visitedDescendant: boolean;
};

export type GraphLayoutModel = {
  nodeIndex: Map<string, number>;
  edgeIndex: Map<string, number>;
  nodesById: Map<string, VizNode>;
  hierarchy: Map<string, GraphHierarchyNode>;
  scopes: GraphLayoutScope[];
  warnings: GraphLayoutWarning[];
  invalidEdges: VizEdge[];
  visibleNodes: VizNode[];
  visibleNodeMetadata: Map<string, GraphLayoutNodeMetadata>;
  orderingEdges: GraphLayoutEdge[];
  nodePlacementEdges: GraphLayoutEdge[];
  renderEdges: GraphLayoutEdge[];
  layoutEdges: GraphLayoutEdge[];
  visibleEdges: GraphLayoutEdge[];
  selfLoops: GraphLayoutEdge[];
};

const ROOT_SCOPE_ID = 'root';

export type BuildGraphLayoutModelOptions = {
  activeStateId?: string | null;
  visitedNodeIds?: ReadonlySet<string>;
};

export function buildGraphLayoutModel(
  topology: Topology,
  expandedEmbedIds: ReadonlySet<string>,
  options: BuildGraphLayoutModelOptions = {},
): GraphLayoutModel {
  const nodeIndex = new Map(topology.nodes.map((node, index) => [node.id, index]));
  const edgeIndex = new Map(topology.edges.map((edge, index) => [edge.id, index]));
  const nodesById = new Map(topology.nodes.map((node) => [node.id, node]));
  const validEdges = topology.edges.filter(
    (edge) => nodesById.has(edge.from) && nodesById.has(edge.to),
  );
  const invalidEdges = topology.edges.filter(
    (edge) => !nodesById.has(edge.from) || !nodesById.has(edge.to),
  );
  const hierarchy = buildHierarchy(topology.nodes, nodesById);
  const warnings: GraphLayoutWarning[] = [];
  const effectiveExpandedEmbedIds = new Set<string>();

  for (const id of expandedEmbedIds) {
    const node = nodesById.get(id);
    if (!node || node.kind !== 'embed') continue;
    if (!node.entry) {
      warnings.push({
        code: 'missing-embed-entry',
        nodeId: id,
        message: `Embed node "${id}" is expanded but does not define an entry; rendering it collapsed.`,
      });
      continue;
    }
    effectiveExpandedEmbedIds.add(id);
  }

  const expandedVisibleHostIds: string[] = [];
  for (const node of topology.nodes) {
    if (
      effectiveExpandedEmbedIds.has(node.id) &&
      isExpandedHostVisible(node.id, effectiveExpandedEmbedIds, hierarchy, nodesById)
    ) {
      expandedVisibleHostIds.push(node.id);
    }
  }
  const scopeHosts = [null, ...expandedVisibleHostIds];
  const baseScopes = scopeHosts.map((hostId) =>
    buildBaseScope(hostId, topology, nodesById, hierarchy),
  );
  const visibleNodeIdSet = new Set(baseScopes.flatMap((scope) => scope.nodeIds));
  const scopes = baseScopes.map((baseScope) =>
    buildScope({
      baseScope,
      nodesById,
      nodeIndex,
      edgeIndex,
      validEdges,
      hierarchy,
      visibleNodeIdSet,
    }),
  );
  const visibleNodes = scopes.flatMap((scope) =>
    scope.orderedNodeIds
      .map((id) => nodesById.get(id))
      .filter((node): node is VizNode => Boolean(node)),
  );
  const visibleNodeMetadata = buildVisibleNodeMetadata({
    visibleNodeIds: visibleNodes.map((node) => node.id),
    visibleNodeIdSet,
    effectiveExpandedEmbedIds,
    nodesById,
    hierarchy,
    activeStateId: options.activeStateId ?? null,
    visitedNodeIds: options.visitedNodeIds ?? new Set(),
  });
  const nodePlacementEdges = assignParallelGroups(
    scopes.flatMap((scope) => scope.linearEdges),
    edgeIndex,
  );
  const renderEdges = nodePlacementEdges.filter((edge) => edge.isVisible && !edge.isRankOnly);
  const orderingEdges = scopes.flatMap((scope) => scope.orderingEdges);
  const selfLoops = scopes.flatMap((scope) => scope.selfLoops);

  return {
    nodeIndex,
    edgeIndex,
    nodesById,
    hierarchy,
    scopes,
    warnings,
    invalidEdges,
    visibleNodes,
    visibleNodeMetadata,
    orderingEdges,
    nodePlacementEdges,
    renderEdges,
    layoutEdges: nodePlacementEdges,
    visibleEdges: renderEdges,
    selfLoops,
  };
}

function isExpandedHostVisible(
  hostId: string,
  expandedEmbedIds: ReadonlySet<string>,
  hierarchy: ReadonlyMap<string, GraphHierarchyNode>,
  nodesById: ReadonlyMap<string, VizNode>,
): boolean {
  let parentId = hierarchy.get(hostId)?.parentId ?? null;
  while (parentId) {
    const parent = nodesById.get(parentId);
    if (parent?.kind === 'embed' && !expandedEmbedIds.has(parentId)) return false;
    parentId = hierarchy.get(parentId)?.parentId ?? null;
  }
  return true;
}

function buildHierarchy(
  nodes: ReadonlyArray<VizNode>,
  nodesById: ReadonlyMap<string, VizNode>,
): Map<string, GraphHierarchyNode> {
  const hierarchy = new Map<string, GraphHierarchyNode>();
  for (const node of nodes) {
    hierarchy.set(node.id, {
      id: node.id,
      parentId: node.parent && nodesById.has(node.parent) ? node.parent : null,
      entryId: node.kind === 'embed' ? (node.entry ?? null) : null,
      childIds: [],
    });
  }
  for (const node of nodes) {
    const parentId = hierarchy.get(node.id)?.parentId ?? null;
    if (parentId) hierarchy.get(parentId)?.childIds.push(node.id);
  }
  return hierarchy;
}

type GraphLayoutBaseScope = Pick<
  GraphLayoutScope,
  'id' | 'hostId' | 'semanticEntryId' | 'entryNodeId' | 'nodeIds'
>;

function buildBaseScope(
  hostId: string | null,
  topology: Topology,
  nodesById: ReadonlyMap<string, VizNode>,
  hierarchy: ReadonlyMap<string, GraphHierarchyNode>,
): GraphLayoutBaseScope {
  const id = hostId ?? ROOT_SCOPE_ID;
  const visibleNodeIds: string[] = [];
  for (const node of topology.nodes) {
    if ((hostId === null ? !node.parent : node.parent === hostId) && nodesById.has(node.id)) {
      visibleNodeIds.push(node.id);
    }
  }
  const semanticEntryId =
    hostId === null ? topology.initial : (nodesById.get(hostId)?.entry ?? null);
  const entryNodeId = semanticEntryId
    ? resolveVisibleChildInScope(semanticEntryId, hostId, hierarchy)
    : null;

  return {
    id,
    hostId,
    semanticEntryId,
    entryNodeId: visibleNodeIds.includes(entryNodeId ?? '') ? entryNodeId : null,
    nodeIds: visibleNodeIds,
  };
}

function buildScope(args: {
  baseScope: GraphLayoutBaseScope;
  nodesById: ReadonlyMap<string, VizNode>;
  nodeIndex: ReadonlyMap<string, number>;
  edgeIndex: ReadonlyMap<string, number>;
  validEdges: VizEdge[];
  hierarchy: ReadonlyMap<string, GraphHierarchyNode>;
  visibleNodeIdSet: ReadonlySet<string>;
}): GraphLayoutScope {
  const { baseScope, nodesById, nodeIndex, edgeIndex, validEdges, hierarchy, visibleNodeIdSet } =
    args;
  const visibleNodeSet = new Set(baseScope.nodeIds);
  const scopeEdges: GraphLayoutEdge[] = [];
  const scopeSelfLoops: GraphLayoutEdge[] = [];
  for (const edge of validEdges) {
    const from = resolveVisibleChildInScope(edge.from, baseScope.hostId, hierarchy);
    const to = resolveVisibleChildInScope(edge.to, baseScope.hostId, hierarchy);
    if (!from || !to) continue;
    if (!visibleNodeSet.has(from) || !visibleNodeSet.has(to)) continue;
    if (from === to) {
      if (edge.from === edge.to && visibleNodeIdSet.has(edge.from)) {
        scopeSelfLoops.push(
          projectEdge({
            edge,
            rankFrom: from,
            rankTo: to,
            routeFrom: edge.from,
            routeTo: edge.to,
            scopeId: baseScope.id,
            edgeIndex,
            isRankOnly: false,
            isVisible: true,
          }),
        );
      }
      continue;
    }
    const routeFrom = visibleNodeIdSet.has(edge.from) ? edge.from : from;
    const routeTo = visibleNodeIdSet.has(edge.to) ? edge.to : to;
    scopeEdges.push(
      projectEdge({
        edge,
        rankFrom: from,
        rankTo: to,
        routeFrom,
        routeTo,
        scopeId: baseScope.id,
        edgeIndex,
        isRankOnly: false,
        isVisible: routeFrom !== routeTo,
      }),
    );
    if (routeFrom !== from || routeTo !== to) {
      scopeEdges.push(
        projectEdge({
          edge,
          rankFrom: from,
          rankTo: to,
          routeFrom: from,
          routeTo: to,
          scopeId: baseScope.id,
          edgeIndex,
          isRankOnly: true,
          isVisible: false,
        }),
      );
    }
  }

  sortEdges(scopeEdges, edgeIndex);
  sortEdges(scopeSelfLoops, edgeIndex);
  const explicitMainNodeIds = new Set(
    baseScope.nodeIds.filter((nodeId) => nodesById.get(nodeId)?.main === true),
  );
  const mainSpine = buildMainSpine({
    nodeIds: baseScope.nodeIds,
    entryNodeId: baseScope.entryNodeId,
    edges: scopeEdges,
    selfLoops: scopeSelfLoops,
    explicitMainNodeIds,
    nodeIndex,
    edgeIndex,
  });
  const mainRoleEdges = applyMainSpineRoles(scopeEdges, mainSpine);
  const mainRoleSelfLoops = applyMainSpineRoles(scopeSelfLoops, mainSpine);
  const edgeSemantics = buildEdgeSemanticContext(mainRoleEdges, nodesById, explicitMainNodeIds);
  const initialSemanticEdges = mainRoleEdges.map((edge) =>
    classifyEdgeSemantics(edge, edgeSemantics, nodesById),
  );
  const initialRanking = rankScope({
    nodeIds: baseScope.nodeIds,
    entryNodeId: baseScope.entryNodeId,
    linearEdges: initialSemanticEdges.filter(isOrderingEdge),
    nodesById,
    nodeIndex,
  });
  const feedbackClassifiedEdges = initialSemanticEdges.map((edge) =>
    classifyEdgeSemantics(
      classifyFeedback(edge, initialRanking.ranks, nodeIndex, baseScope.nodeIds),
      edgeSemantics,
      nodesById,
    ),
  );
  const finalEdgeSemantics = {
    ...edgeSemantics,
    sidePathFeedbackEdgeIds: buildSidePathFeedbackEdgeIds(feedbackClassifiedEdges, edgeSemantics),
  };
  const semanticEdges = feedbackClassifiedEdges.map((edge) =>
    classifyEdgeSemantics(edge, finalEdgeSemantics, nodesById),
  );
  const rankingInputEdges = semanticEdges.filter(isOrderingEdge);
  const ranking = rankScope({
    nodeIds: baseScope.nodeIds,
    entryNodeId: baseScope.entryNodeId,
    linearEdges: rankingInputEdges,
    terminalEdges: semanticEdges.filter((edge) => edge.isVisible && !edge.isRankOnly),
    nodesById,
    nodeIndex,
  });
  const classifiedEdges = semanticEdges.map((edge) =>
    classifyEdgeSemantics(
      classifyFeedback(edge, ranking.ranks, nodeIndex, baseScope.nodeIds),
      finalEdgeSemantics,
      nodesById,
    ),
  );
  const nodeGroups = buildNodeGroups({
    nodeIds: baseScope.nodeIds,
    edges: classifiedEdges,
    ranks: ranking.ranks,
    nodesById,
    explicitMainNodeIds,
  });
  const orderedNodeIds = orderScopeNodes({
    nodeIds: baseScope.nodeIds,
    entryNodeId: baseScope.entryNodeId,
    ranks: ranking.ranks,
    nodeGroups,
    nodeIndex,
  });
  const orderingEdges = classifiedEdges
    .filter(isOrderingEdge)
    .sort(compareRankedEdges(ranking.ranks, orderedNodeIds, edgeIndex));
  const linearEdges = classifiedEdges.sort(
    compareRankedEdges(ranking.ranks, orderedNodeIds, edgeIndex),
  );

  return {
    id: baseScope.id,
    hostId: baseScope.hostId,
    semanticEntryId: baseScope.semanticEntryId,
    entryNodeId: baseScope.entryNodeId,
    nodeIds: baseScope.nodeIds,
    orderedNodeIds,
    nodeGroups,
    mainSpine,
    orderingEdges,
    linearEdges,
    selfLoops: mainRoleSelfLoops,
    reachableNodeIds: ranking.reachableNodeIds,
    localSinkTerminalIds: ranking.localSinkTerminalIds,
    ranks: ranking.ranks,
  };
}

function projectEdge(args: {
  edge: VizEdge;
  rankFrom: string;
  rankTo: string;
  routeFrom: string;
  routeTo: string;
  scopeId: string;
  edgeIndex: ReadonlyMap<string, number>;
  isRankOnly: boolean;
  isVisible: boolean;
}): GraphLayoutEdge {
  const { edge, rankFrom, rankTo, routeFrom, routeTo, scopeId, edgeIndex, isRankOnly, isVisible } =
    args;
  const id = isRankOnly ? `${edge.id}::rank:${scopeId}` : edge.id;
  return {
    ...edge,
    id,
    from: routeFrom,
    to: routeTo,
    semanticId: edge.id,
    scopeId,
    rankFrom,
    rankTo,
    routeFrom,
    routeTo,
    originalFrom: edge.from,
    originalTo: edge.to,
    isRankOnly,
    isVisible,
    feedbackClass: 'lateral',
    layoutRole: 'primary',
    rankPolicy: isRankOnly ? 'rank-helper' : 'rank-defining',
    labelPolicy: 'default-visible',
    mainRole: 'none',
    parallelGroupKey: `${routeFrom}\x00${routeTo}`,
    parallelIndex: 0,
    parallelTotal: 1,
    labelWidth: labelWidth(edgeLabelText(edge)),
    edgeIndex: edgeIndex.get(edge.id) ?? Number.MAX_SAFE_INTEGER,
  };
}

function edgeLabelText(edge: Pick<VizEdge, 'exit' | 'branchIndex' | 'branchTotal'>): string {
  const branchSuffix =
    typeof edge.branchIndex === 'number' && typeof edge.branchTotal === 'number'
      ? `#${edge.branchIndex}`
      : '';
  return `${edge.exit}${branchSuffix}`;
}

function labelWidth(label: string): number {
  return Math.max(48, Math.min(150, label.length * 7 + 20));
}

function buildMainSpine(args: {
  nodeIds: ReadonlyArray<string>;
  entryNodeId: string | null;
  edges: ReadonlyArray<GraphLayoutEdge>;
  selfLoops: ReadonlyArray<GraphLayoutEdge>;
  explicitMainNodeIds: ReadonlySet<string>;
  nodeIndex: ReadonlyMap<string, number>;
  edgeIndex: ReadonlyMap<string, number>;
}): GraphMainSpine {
  const { nodeIds, entryNodeId, edges, selfLoops, explicitMainNodeIds, nodeIndex, edgeIndex } =
    args;
  const stableNodeOrder = compareNodeIds(nodeIndex);
  const mainNodeIds = nodeIds.filter((nodeId) => explicitMainNodeIds.has(nodeId));
  mainNodeIds.sort(stableNodeOrder);

  if (mainNodeIds.length === 0) return emptyMainSpine();

  const mainNodeSet = new Set(mainNodeIds);
  const mainEdges = edges.filter((edge) => isVisibleMainToMainEdge(edge, mainNodeSet));
  const mainSelfLoops = selfLoops.filter((edge) => isVisibleMainToMainEdge(edge, mainNodeSet));
  mainEdges.sort(compareEdges(edgeIndex));
  mainSelfLoops.sort(compareEdges(edgeIndex));

  const components = tarjan(mainNodeIds, [...mainEdges, ...mainSelfLoops]).map((component) =>
    component.sort(stableNodeOrder),
  );
  const componentByNode = new Map<string, number>();
  components.forEach((component, componentId) => {
    for (const nodeId of component) componentByNode.set(nodeId, componentId);
  });

  const componentOutgoing = new Map<number, GraphLayoutEdge[]>();
  for (const edge of mainEdges) {
    const fromComponent = componentByNode.get(edge.rankFrom);
    const toComponent = componentByNode.get(edge.rankTo);
    if (fromComponent === undefined || toComponent === undefined || fromComponent === toComponent) {
      continue;
    }
    const outgoing = componentOutgoing.get(fromComponent) ?? [];
    outgoing.push(edge);
    componentOutgoing.set(fromComponent, outgoing);
  }
  for (const outgoing of componentOutgoing.values()) outgoing.sort(compareEdges(edgeIndex));

  const componentOrder = orderMainComponents({
    components,
    componentByNode,
    componentOutgoing,
    entryNodeId,
    nodeIndex,
  });
  const outgoingBySource = new Map<string, GraphLayoutEdge[]>();
  for (const edge of mainEdges) {
    const outgoing = outgoingBySource.get(edge.rankFrom) ?? [];
    outgoing.push(edge);
    outgoingBySource.set(edge.rankFrom, outgoing);
  }
  for (const outgoing of outgoingBySource.values()) outgoing.sort(compareEdges(edgeIndex));

  const selectedMainNodeIds: string[] = [];
  const selectedNodeIds = new Set<string>();
  const forwardEdgeIds: string[] = [];

  function visitNode(nodeId: string) {
    if (selectedNodeIds.has(nodeId)) return;
    selectedNodeIds.add(nodeId);
    selectedMainNodeIds.push(nodeId);

    for (const edge of outgoingBySource.get(nodeId) ?? []) {
      if (edge.rankFrom === edge.rankTo || selectedNodeIds.has(edge.rankTo)) continue;
      forwardEdgeIds.push(edge.id);
      visitNode(edge.rankTo);
    }
  }

  for (const componentId of componentOrder.componentIds) {
    const component = components[componentId] ?? [];
    const seedNodeId = componentOrder.seedNodeByComponent.get(componentId) ?? component[0];
    if (seedNodeId) visitNode(seedNodeId);
    for (const nodeId of component) visitNode(nodeId);
  }
  for (const nodeId of mainNodeIds) visitNode(nodeId);

  const orderByNode = new Map(selectedMainNodeIds.map((nodeId, index) => [nodeId, index]));
  const forwardEdgeIdSet = new Set(forwardEdgeIds);
  const feedbackEdgeIds: string[] = [];
  for (const edge of mainEdges) {
    if (forwardEdgeIdSet.has(edge.id)) continue;
    const fromComponent = componentByNode.get(edge.rankFrom);
    const toComponent = componentByNode.get(edge.rankTo);
    const sameMultiNodeComponent =
      fromComponent !== undefined &&
      fromComponent === toComponent &&
      (components[fromComponent]?.length ?? 0) > 1;
    const fromOrder = orderByNode.get(edge.rankFrom) ?? Number.MAX_SAFE_INTEGER;
    const toOrder = orderByNode.get(edge.rankTo) ?? Number.MAX_SAFE_INTEGER;
    if (edge.rankFrom === edge.rankTo || sameMultiNodeComponent || toOrder <= fromOrder) {
      feedbackEdgeIds.push(edge.id);
    }
  }
  const feedbackEdgeIdSet = new Set(feedbackEdgeIds);
  for (const edge of mainSelfLoops) {
    if (feedbackEdgeIdSet.has(edge.id)) continue;
    feedbackEdgeIdSet.add(edge.id);
    feedbackEdgeIds.push(edge.id);
  }

  const sideEdges: GraphLayoutEdge[] = [];
  for (const edge of edges) {
    if (
      edge.isVisible &&
      !edge.isRankOnly &&
      mainNodeSet.has(edge.rankFrom) !== mainNodeSet.has(edge.rankTo)
    ) {
      sideEdges.push(edge);
    }
  }
  sideEdges.sort(compareEdges(edgeIndex));
  const sideEdgeIds = sideEdges.map((edge) => edge.id);

  return {
    mainNodeIds: selectedMainNodeIds,
    forwardEdgeIds,
    feedbackEdgeIds,
    sideEdgeIds,
  };
}

function emptyMainSpine(): GraphMainSpine {
  return {
    mainNodeIds: [],
    forwardEdgeIds: [],
    feedbackEdgeIds: [],
    sideEdgeIds: [],
  };
}

function orderMainComponents(args: {
  components: ReadonlyArray<ReadonlyArray<string>>;
  componentByNode: ReadonlyMap<string, number>;
  componentOutgoing: ReadonlyMap<number, ReadonlyArray<GraphLayoutEdge>>;
  entryNodeId: string | null;
  nodeIndex: ReadonlyMap<string, number>;
}): { componentIds: number[]; seedNodeByComponent: Map<number, string> } {
  const { components, componentByNode, componentOutgoing, entryNodeId, nodeIndex } = args;
  const componentIdsByTopology = components
    .map((_, componentId) => componentId)
    .sort(
      (a, b) =>
        componentMinNodeIndex(components[a] ?? [], nodeIndex) -
        componentMinNodeIndex(components[b] ?? [], nodeIndex),
    );
  const seedNodeByComponent = new Map<number, string>();
  const componentIds: number[] = [];
  const visited = new Set<number>();

  function visitComponent(componentId: number) {
    if (visited.has(componentId)) return;
    visited.add(componentId);
    componentIds.push(componentId);

    for (const edge of componentOutgoing.get(componentId) ?? []) {
      const targetComponent = componentByNode.get(edge.rankTo);
      if (targetComponent === undefined || targetComponent === componentId) continue;
      if (!seedNodeByComponent.has(targetComponent)) {
        seedNodeByComponent.set(targetComponent, edge.rankTo);
      }
      visitComponent(targetComponent);
    }
  }

  const entryComponent = entryNodeId ? componentByNode.get(entryNodeId) : undefined;
  if (entryNodeId && entryComponent !== undefined) {
    seedNodeByComponent.set(entryComponent, entryNodeId);
    visitComponent(entryComponent);
  }
  for (const componentId of componentIdsByTopology) visitComponent(componentId);

  return { componentIds, seedNodeByComponent };
}

function componentMinNodeIndex(
  nodeIds: ReadonlyArray<string>,
  nodeIndex: ReadonlyMap<string, number>,
): number {
  return nodeIds.reduce(
    (min, nodeId) => Math.min(min, nodeIndex.get(nodeId) ?? Number.MAX_SAFE_INTEGER),
    Number.MAX_SAFE_INTEGER,
  );
}

function isVisibleMainToMainEdge(edge: GraphLayoutEdge, mainNodeSet: ReadonlySet<string>): boolean {
  return (
    edge.isVisible &&
    !edge.isRankOnly &&
    mainNodeSet.has(edge.rankFrom) &&
    mainNodeSet.has(edge.rankTo)
  );
}

function applyMainSpineRoles(
  edges: ReadonlyArray<GraphLayoutEdge>,
  mainSpine: GraphMainSpine,
): GraphLayoutEdge[] {
  const forwardEdgeIds = new Set(mainSpine.forwardEdgeIds);
  const feedbackEdgeIds = new Set(mainSpine.feedbackEdgeIds);
  const sideEdgeIds = new Set(mainSpine.sideEdgeIds);
  return edges.map((edge) => ({
    ...edge,
    mainRole: forwardEdgeIds.has(edge.id)
      ? 'forward'
      : feedbackEdgeIds.has(edge.id)
        ? 'feedback'
        : sideEdgeIds.has(edge.id)
          ? 'side'
          : 'none',
  }));
}

function compareNodeIds(nodeIndex: ReadonlyMap<string, number>) {
  return (a: string, b: string): number => {
    const indexDelta =
      (nodeIndex.get(a) ?? Number.MAX_SAFE_INTEGER) - (nodeIndex.get(b) ?? Number.MAX_SAFE_INTEGER);
    if (indexDelta !== 0) return indexDelta;
    return a.localeCompare(b);
  };
}

function resolveVisibleChildInScope(
  nodeId: string,
  scopeHostId: string | null,
  hierarchy: ReadonlyMap<string, GraphHierarchyNode>,
): string | null {
  const path = pathFromRoot(nodeId, hierarchy);
  if (path.length === 0) return null;
  if (scopeHostId === null) {
    return path[0] ?? null;
  }
  const hostIndex = path.indexOf(scopeHostId);
  if (hostIndex === -1) return null;
  const directChild = path[hostIndex + 1];
  if (!directChild) return null;
  return directChild;
}

function pathFromRoot(
  nodeId: string,
  hierarchy: ReadonlyMap<string, GraphHierarchyNode>,
): string[] {
  if (!hierarchy.has(nodeId)) return [];
  const reversed: string[] = [];
  const seen = new Set<string>();
  let current: string | null = nodeId;
  while (current) {
    if (seen.has(current)) return [];
    seen.add(current);
    reversed.push(current);
    current = hierarchy.get(current)?.parentId ?? null;
  }
  return reversed.reverse();
}

function rankScope(args: {
  nodeIds: string[];
  entryNodeId: string | null;
  linearEdges: GraphLayoutEdge[];
  terminalEdges?: GraphLayoutEdge[];
  nodesById: ReadonlyMap<string, VizNode>;
  nodeIndex: ReadonlyMap<string, number>;
}): {
  orderedNodeIds: string[];
  reachableNodeIds: string[];
  localSinkTerminalIds: string[];
  ranks: Map<string, GraphLayoutRank>;
} {
  const {
    nodeIds,
    entryNodeId,
    linearEdges,
    terminalEdges = linearEdges,
    nodesById,
    nodeIndex,
  } = args;
  const nodeSet = new Set(nodeIds);
  const reachable = computeReachable(entryNodeId, linearEdges, nodeSet);
  const terminalReachable = computeReachable(entryNodeId, terminalEdges, nodeSet);
  const reachableNodeIds = nodeIds.filter((id) => reachable.has(id));
  const components = tarjan(reachableNodeIds, linearEdges);
  const componentRank = rankComponents(components, linearEdges, entryNodeId);
  const componentByNode = new Map<string, number>();
  components.forEach((component, componentId) => {
    for (const nodeId of component) componentByNode.set(nodeId, componentId);
  });

  const ranks = new Map<string, GraphLayoutRank>();
  for (const nodeId of nodeIds) {
    const componentId = componentByNode.get(nodeId) ?? null;
    ranks.set(nodeId, {
      reachable: reachable.has(nodeId),
      rank: componentId === null ? null : (componentRank.get(componentId) ?? null),
      componentId,
    });
  }

  const outgoing = new Set<string>();
  for (const edge of linearEdges) {
    if (terminalReachable.has(edge.rankFrom)) outgoing.add(edge.rankFrom);
  }
  const localSinkTerminalIds = nodeIds.filter((nodeId) => {
    const node = nodesById.get(nodeId);
    return node?.kind === 'terminal' && terminalReachable.has(nodeId) && !outgoing.has(nodeId);
  });

  const orderedNodeIds = Array.from(nodeIds).sort((a, b) =>
    compareRankedNodes(a, b, entryNodeId, ranks, nodeIndex),
  );

  return {
    orderedNodeIds,
    reachableNodeIds,
    localSinkTerminalIds,
    ranks,
  };
}

function computeReachable(
  entryNodeId: string | null,
  linearEdges: GraphLayoutEdge[],
  nodeSet: ReadonlySet<string>,
): Set<string> {
  const reachable = new Set<string>();
  if (!entryNodeId || !nodeSet.has(entryNodeId)) return reachable;
  const outgoing = new Map<string, string[]>();
  for (const edge of linearEdges) {
    if (!nodeSet.has(edge.rankFrom) || !nodeSet.has(edge.rankTo)) continue;
    const targets = outgoing.get(edge.rankFrom) ?? [];
    targets.push(edge.rankTo);
    outgoing.set(edge.rankFrom, targets);
  }
  const queue = [entryNodeId];
  reachable.add(entryNodeId);
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i];
    for (const target of outgoing.get(current) ?? []) {
      if (reachable.has(target)) continue;
      reachable.add(target);
      queue.push(target);
    }
  }
  return reachable;
}

function tarjan(nodeIds: string[], linearEdges: GraphLayoutEdge[]): string[][] {
  const nodeSet = new Set(nodeIds);
  const outgoing = new Map<string, string[]>();
  for (const edge of linearEdges) {
    if (!nodeSet.has(edge.rankFrom) || !nodeSet.has(edge.rankTo)) continue;
    const targets = outgoing.get(edge.rankFrom) ?? [];
    targets.push(edge.rankTo);
    outgoing.set(edge.rankFrom, targets);
  }

  let nextIndex = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  function strongConnect(nodeId: string) {
    index.set(nodeId, nextIndex);
    lowlink.set(nodeId, nextIndex);
    nextIndex += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const target of outgoing.get(nodeId) ?? []) {
      if (!index.has(target)) {
        strongConnect(target);
        lowlink.set(nodeId, Math.min(lowlink.get(nodeId)!, lowlink.get(target)!));
      } else if (onStack.has(target)) {
        lowlink.set(nodeId, Math.min(lowlink.get(nodeId)!, index.get(target)!));
      }
    }

    if (lowlink.get(nodeId) !== index.get(nodeId)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === nodeId) break;
    }
    components.push(component);
  }

  for (const nodeId of nodeIds) {
    if (!index.has(nodeId)) strongConnect(nodeId);
  }

  return components;
}

function rankComponents(
  components: string[][],
  linearEdges: GraphLayoutEdge[],
  entryNodeId: string | null,
): Map<number, number> {
  const componentByNode = new Map<string, number>();
  components.forEach((component, componentId) => {
    for (const nodeId of component) componentByNode.set(nodeId, componentId);
  });
  const entryComponent = entryNodeId ? componentByNode.get(entryNodeId) : undefined;
  const ranks = new Map<number, number>();
  if (entryComponent === undefined) return ranks;
  ranks.set(entryComponent, 0);

  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of linearEdges) {
      const fromComponent = componentByNode.get(edge.rankFrom);
      const toComponent = componentByNode.get(edge.rankTo);
      if (
        fromComponent === undefined ||
        toComponent === undefined ||
        fromComponent === toComponent
      ) {
        continue;
      }
      const fromRank = ranks.get(fromComponent);
      if (fromRank === undefined) continue;
      const nextRank = fromRank + 1;
      if ((ranks.get(toComponent) ?? -1) < nextRank) {
        ranks.set(toComponent, nextRank);
        changed = true;
      }
    }
  }
  return ranks;
}

type GraphEdgeSemanticContext = {
  auxiliaryFanInEdgeIds: ReadonlySet<string>;
  resumeFanOutEdgeIds: ReadonlySet<string>;
  sidePathFeedbackEdgeIds: ReadonlySet<string>;
  explicitMainNodeIds: ReadonlySet<string>;
  outgoingCountBySource: ReadonlyMap<string, number>;
};

const HIGH_CARDINALITY_ALWAYS_FAN_OUT = 4;

function buildEdgeSemanticContext(
  edges: ReadonlyArray<GraphLayoutEdge>,
  nodesById: ReadonlyMap<string, VizNode>,
  explicitMainNodeIds: ReadonlySet<string>,
): GraphEdgeSemanticContext {
  const visibleEdges = edges.filter((edge) => edge.isVisible && !edge.isRankOnly);
  const fanInGroups = new Map<string, { sources: Set<string>; edgeIds: string[] }>();
  const outgoingBySource = new Map<string, Set<string>>();
  const alwaysFanOutBySource = new Map<string, { targets: Set<string>; edgeIds: string[] }>();

  for (const edge of visibleEdges) {
    const fanInKey = `${edge.exit}\x00${edge.rankTo}`;
    const fanInGroup = fanInGroups.get(fanInKey) ?? { sources: new Set<string>(), edgeIds: [] };
    fanInGroup.sources.add(edge.rankFrom);
    fanInGroup.edgeIds.push(edge.id);
    fanInGroups.set(fanInKey, fanInGroup);

    const outgoing = outgoingBySource.get(edge.rankFrom) ?? new Set<string>();
    outgoing.add(edge.rankTo);
    outgoingBySource.set(edge.rankFrom, outgoing);

    if (edge.kind === 'always') {
      const fanOut = alwaysFanOutBySource.get(edge.rankFrom) ?? {
        targets: new Set<string>(),
        edgeIds: [],
      };
      fanOut.targets.add(edge.rankTo);
      fanOut.edgeIds.push(edge.id);
      alwaysFanOutBySource.set(edge.rankFrom, fanOut);
    }
  }

  const auxiliaryFanInEdgeIds = new Set<string>();
  for (const group of fanInGroups.values()) {
    if (group.sources.size <= 1) continue;
    for (const edgeId of group.edgeIds) auxiliaryFanInEdgeIds.add(edgeId);
  }

  const resumeFanOutEdgeIds = new Set<string>();
  for (const [sourceId, group] of alwaysFanOutBySource) {
    const sourceNode = nodesById.get(sourceId);
    const passiveControlFanOut =
      sourceNode?.kind === 'passive' &&
      group.targets.size >= Math.max(2, HIGH_CARDINALITY_ALWAYS_FAN_OUT - 1);
    if (!passiveControlFanOut) continue;
    for (const edgeId of group.edgeIds) resumeFanOutEdgeIds.add(edgeId);
  }

  return {
    auxiliaryFanInEdgeIds,
    resumeFanOutEdgeIds,
    sidePathFeedbackEdgeIds: new Set(),
    explicitMainNodeIds,
    outgoingCountBySource: new Map(
      [...outgoingBySource].map(([sourceId, targets]) => [sourceId, targets.size]),
    ),
  };
}

function buildSidePathFeedbackEdgeIds(
  edges: ReadonlyArray<GraphLayoutEdge>,
  context: GraphEdgeSemanticContext,
): Set<string> {
  const branchTargetIds = new Set<string>();
  for (const edge of edges) {
    if (edge.isVisible && !edge.isRankOnly && isBranchEdge(edge, context)) {
      branchTargetIds.add(edge.rankTo);
    }
  }

  const structuralOutgoingBySource = new Map<string, GraphLayoutEdge[]>();
  for (const edge of edges) {
    if (!edge.isVisible || edge.isRankOnly) continue;
    if (edge.layoutRole === 'auxiliary' || edge.layoutRole === 'resume') continue;
    if (edge.feedbackClass === 'feedback' || edge.feedbackClass === 'cycle-feedback') continue;
    const outgoing = structuralOutgoingBySource.get(edge.rankFrom) ?? [];
    outgoing.push(edge);
    structuralOutgoingBySource.set(edge.rankFrom, outgoing);
  }

  const sidePathFeedbackEdgeIds = new Set<string>();
  for (const edge of edges) {
    if (edge.feedbackClass !== 'feedback' && edge.feedbackClass !== 'cycle-feedback') continue;
    if (!branchTargetIds.has(edge.rankFrom)) continue;
    if ((structuralOutgoingBySource.get(edge.rankFrom) ?? []).length > 0) continue;
    sidePathFeedbackEdgeIds.add(edge.id);
  }
  return sidePathFeedbackEdgeIds;
}

function classifyFeedback(
  edge: GraphLayoutEdge,
  ranks: ReadonlyMap<string, GraphLayoutRank>,
  nodeIndex: ReadonlyMap<string, number>,
  scopeNodeIds: string[],
): GraphLayoutEdge {
  const fromRank = ranks.get(edge.rankFrom);
  const toRank = ranks.get(edge.rankTo);
  let feedbackClass: GraphFeedbackClass = 'lateral';

  if (
    fromRank?.componentId !== null &&
    fromRank?.componentId !== undefined &&
    toRank?.componentId !== null &&
    toRank?.componentId !== undefined
  ) {
    if (fromRank.componentId === toRank.componentId) {
      const componentSize = scopeNodeIds.filter(
        (nodeId) => ranks.get(nodeId)?.componentId === fromRank.componentId,
      ).length;
      if (componentSize > 1) {
        const fromOrder = nodeIndex.get(edge.rankFrom) ?? Number.MAX_SAFE_INTEGER;
        const toOrder = nodeIndex.get(edge.rankTo) ?? Number.MAX_SAFE_INTEGER;
        feedbackClass = toOrder > fromOrder ? 'cycle-forward' : 'cycle-feedback';
      }
    } else if (fromRank.rank !== null && toRank.rank !== null) {
      if (fromRank.rank < toRank.rank) feedbackClass = 'forward';
      else if (fromRank.rank > toRank.rank) feedbackClass = 'feedback';
    }
  }

  return { ...edge, feedbackClass };
}

function classifyEdgeSemantics(
  edge: GraphLayoutEdge,
  context: GraphEdgeSemanticContext,
  nodesById: ReadonlyMap<string, VizNode>,
): GraphLayoutEdge {
  if (edge.isRankOnly) {
    return {
      ...edge,
      layoutRole: 'auxiliary',
      rankPolicy: 'rank-helper',
      labelPolicy: 'hover-focus-visible',
    };
  }

  const targetNode = nodesById.get(edge.rankTo);
  if (targetNode?.kind === 'terminal' && isBranchEdge(edge, context)) {
    return withExplicitMainRank(
      {
        ...edge,
        layoutRole: 'terminal',
        rankPolicy: 'rank-defining',
        labelPolicy: 'default-visible',
      },
      context,
      nodesById,
    );
  }

  if (context.resumeFanOutEdgeIds.has(edge.id)) {
    return withExplicitMainRank(
      {
        ...edge,
        layoutRole: 'resume',
        rankPolicy: 'rank-neutral',
        labelPolicy: 'grouped-summary',
      },
      context,
      nodesById,
    );
  }

  if (context.auxiliaryFanInEdgeIds.has(edge.id)) {
    return withExplicitMainRank(
      {
        ...edge,
        layoutRole: 'auxiliary',
        rankPolicy: 'rank-neutral',
        labelPolicy: 'grouped-summary',
      },
      context,
      nodesById,
    );
  }

  if (edge.feedbackClass === 'feedback' || edge.feedbackClass === 'cycle-feedback') {
    return withExplicitMainRank(
      {
        ...edge,
        layoutRole: 'feedback',
        rankPolicy: context.sidePathFeedbackEdgeIds.has(edge.id) ? 'rank-neutral' : 'rank-defining',
        labelPolicy: 'hover-focus-visible',
      },
      context,
      nodesById,
    );
  }

  if (isBranchEdge(edge, context)) {
    return withExplicitMainRank(
      {
        ...edge,
        layoutRole: 'branch',
        rankPolicy: 'rank-defining',
        labelPolicy: 'default-visible',
      },
      context,
      nodesById,
    );
  }

  return withExplicitMainRank(
    {
      ...edge,
      layoutRole: 'primary',
      rankPolicy: 'rank-defining',
      labelPolicy: 'default-visible',
    },
    context,
    nodesById,
  );
}

function withExplicitMainRank(
  edge: GraphLayoutEdge,
  context: GraphEdgeSemanticContext,
  nodesById: ReadonlyMap<string, VizNode>,
): GraphLayoutEdge {
  if (edge.isRankOnly || context.explicitMainNodeIds.size === 0) return edge;
  if (edge.mainRole !== 'forward') return { ...edge, rankPolicy: 'rank-neutral' };

  const targetNode = nodesById.get(edge.rankTo);
  return {
    ...edge,
    layoutRole: targetNode?.kind === 'terminal' ? 'terminal' : 'primary',
    rankPolicy: 'rank-defining',
    labelPolicy: 'default-visible',
  };
}

function isBranchEdge(
  edge: Pick<GraphLayoutEdge, 'branchTotal' | 'rankFrom'>,
  context: GraphEdgeSemanticContext,
): boolean {
  return (
    (typeof edge.branchTotal === 'number' && edge.branchTotal > 1) ||
    (context.outgoingCountBySource.get(edge.rankFrom) ?? 0) > 1
  );
}

function isOrderingEdge(edge: GraphLayoutEdge): boolean {
  return edge.rankPolicy === 'rank-defining';
}

function buildNodeGroups(args: {
  nodeIds: ReadonlyArray<string>;
  edges: ReadonlyArray<GraphLayoutEdge>;
  ranks: ReadonlyMap<string, GraphLayoutRank>;
  nodesById: ReadonlyMap<string, VizNode>;
  explicitMainNodeIds: ReadonlySet<string>;
}): Map<string, GraphLayoutNodeGroup> {
  const { nodeIds, edges, ranks, nodesById, explicitMainNodeIds } = args;
  const recoveryNodeIds = new Set<string>();
  const resumeNodeIds = new Set<string>();
  const repairNodeIds = new Set<string>();

  for (const edge of edges) {
    if (edge.layoutRole === 'auxiliary' && edge.isVisible && !edge.isRankOnly) {
      recoveryNodeIds.add(edge.rankTo);
    }
    if (edge.layoutRole === 'resume' && edge.isVisible && !edge.isRankOnly) {
      resumeNodeIds.add(edge.rankFrom);
    }
    if (edge.layoutRole === 'feedback') {
      repairNodeIds.add(edge.rankFrom);
    }
  }

  const groups = new Map<string, GraphLayoutNodeGroup>();
  for (const nodeId of nodeIds) {
    const node = nodesById.get(nodeId);
    const rank = ranks.get(nodeId);
    let group: GraphLayoutNodeGroup = 'main';

    if (explicitMainNodeIds.has(nodeId)) {
      group = 'main';
    } else if (!rank?.reachable && !recoveryNodeIds.has(nodeId) && !resumeNodeIds.has(nodeId)) {
      group = 'unreachable';
    } else if (resumeNodeIds.has(nodeId)) {
      group = 'resume';
    } else if (recoveryNodeIds.has(nodeId)) {
      group = 'recovery';
    } else if (node?.kind === 'terminal') {
      group = 'terminal';
    } else if (repairNodeIds.has(nodeId)) {
      group = 'repair';
    } else if (node?.kind === 'embed') {
      group = 'embed';
    }

    groups.set(nodeId, group);
  }
  return groups;
}

function orderScopeNodes(args: {
  nodeIds: ReadonlyArray<string>;
  entryNodeId: string | null;
  ranks: ReadonlyMap<string, GraphLayoutRank>;
  nodeGroups: ReadonlyMap<string, GraphLayoutNodeGroup>;
  nodeIndex: ReadonlyMap<string, number>;
}): string[] {
  const { nodeIds, entryNodeId, ranks, nodeGroups, nodeIndex } = args;
  return Array.from(nodeIds).sort((a, b) =>
    compareGroupedNodes(a, b, entryNodeId, ranks, nodeGroups, nodeIndex),
  );
}

function compareGroupedNodes(
  a: string,
  b: string,
  entryNodeId: string | null,
  ranks: ReadonlyMap<string, GraphLayoutRank>,
  nodeGroups: ReadonlyMap<string, GraphLayoutNodeGroup>,
  nodeIndex: ReadonlyMap<string, number>,
): number {
  if (a === entryNodeId && b !== entryNodeId) return -1;
  if (b === entryNodeId && a !== entryNodeId) return 1;

  const aGroup = nodeGroups.get(a) ?? 'main';
  const bGroup = nodeGroups.get(b) ?? 'main';
  const aBucket = nodeGroupBucket(aGroup);
  const bBucket = nodeGroupBucket(bGroup);
  if (aBucket !== bBucket) return aBucket - bBucket;

  const aRank = ranks.get(a);
  const bRank = ranks.get(b);
  if (aRank?.reachable && bRank?.reachable) {
    const rankDelta = (aRank.rank ?? 0) - (bRank.rank ?? 0);
    if (rankDelta !== 0) return rankDelta;
  }

  const laneDelta = nodeGroupLane(aGroup) - nodeGroupLane(bGroup);
  if (laneDelta !== 0) return laneDelta;

  return (
    (nodeIndex.get(a) ?? Number.MAX_SAFE_INTEGER) - (nodeIndex.get(b) ?? Number.MAX_SAFE_INTEGER)
  );
}

function nodeGroupBucket(group: GraphLayoutNodeGroup): number {
  switch (group) {
    case 'main':
    case 'repair':
    case 'embed':
      return 0;
    case 'recovery':
    case 'resume':
      return 1;
    case 'terminal':
      return 2;
    case 'unreachable':
      return 3;
  }
}

function nodeGroupLane(group: GraphLayoutNodeGroup): number {
  switch (group) {
    case 'main':
      return 0;
    case 'repair':
      return 1;
    case 'embed':
      return 2;
    case 'recovery':
      return 3;
    case 'resume':
      return 4;
    case 'terminal':
      return 5;
    case 'unreachable':
      return 6;
  }
}

function assignParallelGroups(
  edges: GraphLayoutEdge[],
  edgeIndex: ReadonlyMap<string, number>,
): GraphLayoutEdge[] {
  const groups = new Map<string, GraphLayoutEdge[]>();
  for (const edge of edges) {
    if (!edge.isVisible || edge.isRankOnly) continue;
    const group = groups.get(edge.parallelGroupKey) ?? [];
    group.push(edge);
    groups.set(edge.parallelGroupKey, group);
  }

  const parallel = new Map<string, { index: number; total: number }>();
  for (const group of groups.values()) {
    group.sort(compareEdges(edgeIndex));
    group.forEach((edge, index) => {
      parallel.set(edge.id, { index, total: group.length });
    });
  }

  return edges.map((edge) => {
    const group = parallel.get(edge.id);
    if (!group) return edge;
    return { ...edge, parallelIndex: group.index, parallelTotal: group.total };
  });
}

function buildVisibleNodeMetadata(args: {
  visibleNodeIds: string[];
  visibleNodeIdSet: ReadonlySet<string>;
  effectiveExpandedEmbedIds: ReadonlySet<string>;
  nodesById: ReadonlyMap<string, VizNode>;
  hierarchy: ReadonlyMap<string, GraphHierarchyNode>;
  activeStateId: string | null;
  visitedNodeIds: ReadonlySet<string>;
}): Map<string, GraphLayoutNodeMetadata> {
  const {
    visibleNodeIds,
    visibleNodeIdSet,
    effectiveExpandedEmbedIds,
    nodesById,
    hierarchy,
    activeStateId,
    visitedNodeIds,
  } = args;
  const metadata = new Map<string, GraphLayoutNodeMetadata>();
  for (const nodeId of visibleNodeIds) {
    const node = nodesById.get(nodeId);
    const isCollapsedEmbedHost = node?.kind === 'embed' && !effectiveExpandedEmbedIds.has(nodeId);
    const activeDescendant =
      isCollapsedEmbedHost &&
      activeStateId !== null &&
      !visibleNodeIdSet.has(activeStateId) &&
      isDescendantOf(activeStateId, nodeId, hierarchy);
    metadata.set(nodeId, {
      isCollapsedEmbedHost,
      activeDescendant,
      visitedDescendant:
        isCollapsedEmbedHost &&
        [...visitedNodeIds].some(
          (visitedNodeId) =>
            !visibleNodeIdSet.has(visitedNodeId) &&
            isDescendantOf(visitedNodeId, nodeId, hierarchy),
        ),
    });
  }
  return metadata;
}

function isDescendantOf(
  nodeId: string,
  ancestorId: string,
  hierarchy: ReadonlyMap<string, GraphHierarchyNode>,
): boolean {
  let parentId = hierarchy.get(nodeId)?.parentId ?? null;
  while (parentId) {
    if (parentId === ancestorId) return true;
    parentId = hierarchy.get(parentId)?.parentId ?? null;
  }
  return false;
}

function compareRankedNodes(
  a: string,
  b: string,
  entryNodeId: string | null,
  ranks: ReadonlyMap<string, GraphLayoutRank>,
  nodeIndex: ReadonlyMap<string, number>,
): number {
  if (a === entryNodeId && b !== entryNodeId) return -1;
  if (b === entryNodeId && a !== entryNodeId) return 1;
  const aRank = ranks.get(a);
  const bRank = ranks.get(b);
  if (aRank?.reachable && !bRank?.reachable) return -1;
  if (!aRank?.reachable && bRank?.reachable) return 1;
  if (aRank?.reachable && bRank?.reachable) {
    const rankDelta = (aRank.rank ?? 0) - (bRank.rank ?? 0);
    if (rankDelta !== 0) return rankDelta;
  }
  return (
    (nodeIndex.get(a) ?? Number.MAX_SAFE_INTEGER) - (nodeIndex.get(b) ?? Number.MAX_SAFE_INTEGER)
  );
}

function sortEdges(edges: GraphLayoutEdge[], edgeIndex: ReadonlyMap<string, number>) {
  edges.sort(compareEdges(edgeIndex));
}

function compareRankedEdges(
  ranks: ReadonlyMap<string, GraphLayoutRank>,
  orderedNodeIds: ReadonlyArray<string>,
  edgeIndex: ReadonlyMap<string, number>,
) {
  const order = new Map(orderedNodeIds.map((nodeId, index) => [nodeId, index]));
  return (a: GraphLayoutEdge, b: GraphLayoutEdge): number => {
    const sourceDelta = compareEdgeEndpoint(a.rankFrom, b.rankFrom, ranks, order);
    if (sourceDelta !== 0) return sourceDelta;
    const targetDelta = compareEdgeEndpoint(a.rankTo, b.rankTo, ranks, order);
    if (targetDelta !== 0) return targetDelta;
    const edgeDelta =
      (edgeIndex.get(a.semanticId) ?? Number.MAX_SAFE_INTEGER) -
      (edgeIndex.get(b.semanticId) ?? Number.MAX_SAFE_INTEGER);
    if (edgeDelta !== 0) return edgeDelta;
    if (a.isRankOnly !== b.isRankOnly) return a.isRankOnly ? 1 : -1;
    return a.id.localeCompare(b.id);
  };
}

function compareEdgeEndpoint(
  a: string,
  b: string,
  ranks: ReadonlyMap<string, GraphLayoutRank>,
  order: ReadonlyMap<string, number>,
): number {
  const aRank = ranks.get(a);
  const bRank = ranks.get(b);
  if (aRank?.reachable && !bRank?.reachable) return -1;
  if (!aRank?.reachable && bRank?.reachable) return 1;
  if (aRank?.reachable && bRank?.reachable) {
    const rankDelta = (aRank.rank ?? 0) - (bRank.rank ?? 0);
    if (rankDelta !== 0) return rankDelta;
  }
  return (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER);
}

function compareEdges(edgeIndex: ReadonlyMap<string, number>) {
  return (a: GraphLayoutEdge, b: GraphLayoutEdge): number => {
    const edgeDelta =
      (edgeIndex.get(a.semanticId) ?? Number.MAX_SAFE_INTEGER) -
      (edgeIndex.get(b.semanticId) ?? Number.MAX_SAFE_INTEGER);
    if (edgeDelta !== 0) return edgeDelta;
    if (a.isRankOnly !== b.isRankOnly) return a.isRankOnly ? 1 : -1;
    return a.id.localeCompare(b.id);
  };
}
