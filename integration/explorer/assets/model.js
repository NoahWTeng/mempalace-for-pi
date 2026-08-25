export const GRAPH_NODE_LIMIT = 100;
export const GRAPH_EXPANSION_LIMIT = 25;

export function createState() {
  return {
    query: '',
    recent: null,
    results: [],
    selected: null,
    details: null,
    neighborhood: null,
    graph: null,
    graphCollapsed: false,
    filters: { category: 'all', direction: 'all', temporalStatus: 'all', room: 'all', from: '', to: '' },
    mode: 'recent',
  };
}

export function createRequestGate() {
  let current = 0;
  return {
    begin() {
      current += 1;
      return current;
    },
    isCurrent(request) {
      return request === current;
    },
  };
}

function targetId(relationship) {
  return relationship.target?.id || '';
}

function relationshipKey(relationship) {
  return [relationship.graphSourceId || '', targetId(relationship), relationship.category, relationship.kind, relationship.direction].join('\u0000');
}

function orderedRelationships(relationships) {
  return [...relationships]
    .filter((relationship) => targetId(relationship))
    .sort((left, right) => relationshipKey(left).localeCompare(relationshipKey(right)));
}

function graphPage(page, displayed) {
  return {
    available: page?.available ?? 0,
    displayed,
    omitted: Math.max(0, (page?.available ?? 0) - displayed),
  };
}

function memoryDate(memory) {
  return String(memory?.recordedAt || memory?.authoredAt || '').slice(0, 10);
}

function memoryMatches(memory, filters) {
  if (!memory) return false;
  if (filters.room && filters.room !== 'all' && memory.room !== filters.room) return false;
  const date = memoryDate(memory);
  if (filters.from && (date === '' || date < filters.from)) return false;
  if (filters.to && (date === '' || date > filters.to)) return false;
  return true;
}

function relationshipMatches(relationship, filters) {
  if (filters.category && filters.category !== 'all' && relationship.category !== filters.category) return false;
  if (filters.direction && filters.direction !== 'all' && relationship.direction !== filters.direction) return false;
  if (filters.temporalStatus && filters.temporalStatus !== 'all' && relationship.temporalStatus !== filters.temporalStatus) return false;
  return memoryMatches(relationship.target, filters);
}

export function createGraph(state) {
  const seed = state.selected || state.neighborhood?.seed;
  if (!seed?.id) return null;
  const relationships = orderedRelationships(state.neighborhood?.relationships ?? [])
    .slice(0, GRAPH_EXPANSION_LIMIT)
    .map((relationship) => ({ ...relationship, graphSourceId: seed.id }));
  const nodesById = new Map([[seed.id, seed]]);
  for (const relationship of relationships) nodesById.set(relationship.target.id, relationship.target);
  const nodes = [...nodesById.values()];
  const page = graphPage(state.neighborhood, relationships.length);
  return {
    root: seed,
    nodes,
    relationships,
    expandedIds: [],
    lastExpansion: page,
    summary: page,
  };
}

export function addGraphExpansion(state, neighborhood, sourceId) {
  const graph = state.graph || createGraph(state);
  if (!graph) return state;
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const relationshipKeys = new Set(graph.relationships.map(relationshipKey));
  const remaining = Math.max(0, GRAPH_NODE_LIMIT - graph.nodes.length);
  const source = sourceId || graph.root.id;
  const candidates = orderedRelationships(neighborhood?.relationships ?? [])
    .map((relationship) => ({ ...relationship, graphSourceId: source }))
    .filter((relationship) => !relationshipKeys.has(relationshipKey(relationship)))
    .slice(0, GRAPH_EXPANSION_LIMIT);
  const additions = [];
  const newNodes = [];
  for (const relationship of candidates) {
    const id = targetId(relationship);
    if (!nodeIds.has(id)) {
      if (newNodes.length >= remaining) continue;
      nodeIds.add(id);
      newNodes.push(relationship.target);
    }
    additions.push(relationship);
  }
  const page = graphPage(neighborhood, additions.length);
  return {
    ...state,
    graph: {
      ...graph,
      nodes: [...graph.nodes, ...newNodes],
      relationships: [...graph.relationships, ...additions],
      expandedIds: sourceId ? [...new Set([...graph.expandedIds, sourceId])] : graph.expandedIds,
      lastExpansion: page,
      summary: {
        available: graph.summary.available + page.available,
        displayed: graph.relationships.length + additions.length,
        omitted: graph.summary.omitted + page.omitted,
      },
    },
  };
}

export function graphLayout(graph) {
  if (!graph) return [];
  return graph.nodes.map((node, index) => index === 0
    ? { id: node.id, x: 500, y: 280, shape: 'seed' }
    : { id: node.id, x: 70 + ((index - 1) % 11) * 86, y: 48 + Math.floor((index - 1) / 11) * 58, shape: 'related' });
}

export function displayGraph(state) {
  if (!state.graph) return { nodes: [], relationships: [], pinned: false, filtered: false };
  const nodesById = new Map(state.graph.nodes.map((node) => [node.id, node]));
  const relationships = state.graph.relationships.filter((relationship) => {
    if (!relationshipMatches(relationship, state.filters)) return false;
    const source = nodesById.get(relationship.graphSourceId);
    return relationship.graphSourceId === state.selected?.id || memoryMatches(source, state.filters);
  });
  const visibleIds = new Set([
    state.selected?.id,
    ...relationships.map(targetId),
    ...relationships.map((relationship) => relationship.graphSourceId),
  ]);
  return {
    nodes: state.graph.nodes.filter((node) => visibleIds.has(node.id)),
    relationships,
    pinned: !memoryMatches(state.selected, state.filters),
    filtered: relationships.length !== state.graph.relationships.length,
  };
}

export function selectMemory(state, seed, neighborhood) {
  const selected = { ...state, selected: seed, details: seed, neighborhood, graph: null, graphCollapsed: false };
  return { ...selected, graph: createGraph(selected) };
}

export function displayRelationships(state) {
  const relationships = state.neighborhood?.relationships ?? [];
  const visible = relationships.filter((relationship) => relationshipMatches(relationship, state.filters));
  return {
    seed: state.selected ? { memory: state.selected, pinned: !memoryMatches(state.selected, state.filters) } : null,
    relationships: visible,
    filtered: visible.length !== relationships.length,
  };
}

export function present(value) {
  return value === null || value === undefined || value === '' ? 'unavailable' : String(value);
}

export function relationshipLabel(relationship) {
  return `${present(relationship.category)} relationship · ${present(relationship.kind)}`;
}
