export function createState() {
  return {
    query: '',
    recent: null,
    results: [],
    selected: null,
    details: null,
    neighborhood: null,
    filters: { direction: 'all' },
    mode: 'recent',
  };
}

export function selectMemory(state, seed, neighborhood) {
  return { ...state, selected: seed, details: seed, neighborhood };
}

export function displayRelationships(state) {
  const relationships = state.neighborhood?.relationships ?? [];
  const direction = state.filters.direction;
  const visible = direction === 'all' ? relationships : relationships.filter((relationship) => relationship.direction === direction);
  return {
    seed: state.selected ? { memory: state.selected, pinned: direction !== 'all' } : null,
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
