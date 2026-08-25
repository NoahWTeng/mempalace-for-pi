import { addGraphExpansion, createRequestGate, createState, displayGraph, displayRelationships, graphLayout, present, relationshipLabel, selectMemory } from './model.js';

const form = document.querySelector('#search-form');
const search = document.querySelector('#search');
const status = document.querySelector('#status');
const title = document.querySelector('#index-title');
const indexNote = document.querySelector('#index-note');
const memoryList = document.querySelector('#memory-list');
const details = document.querySelector('#details');
const filter = document.querySelector('#relationship-filter');
const categoryFilter = document.querySelector('#relationship-category-filter');
const directionFilter = document.querySelector('#direction-filter');
const temporalStatusFilter = document.querySelector('#temporal-status-filter');
const roomFilter = document.querySelector('#room-filter');
const dateFromFilter = document.querySelector('#date-from-filter');
const dateToFilter = document.querySelector('#date-to-filter');
const relationshipNote = document.querySelector('#relationship-note');
const incomingList = document.querySelector('#incoming-list');
const outgoingList = document.querySelector('#outgoing-list');
const relationshipsSection = document.querySelector('.relationships');
const svgNamespace = 'http://www.w3.org/2000/svg';
const graphPanel = element('section', undefined, 'graph-panel');
graphPanel.hidden = true;
relationshipsSection.before(graphPanel);
const token = new URLSearchParams(location.hash.slice(1)).get('token') || location.hash.slice(1);
const requests = createRequestGate();
let state = createState();

if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);

function element(name, text, className) {
  const node = document.createElement(name);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function svgElement(name, text, className) {
  const node = document.createElementNS(svgNamespace, name);
  if (text !== undefined) node.textContent = text;
  if (className) node.setAttribute('class', className);
  return node;
}

function api(path) {
  return fetch(path, { headers: { Authorization: `Bearer ${token}` } }).then(async (response) => {
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Authorization required.' : 'Memory data is unavailable.');
    return response.json();
  });
}

function setStatus(message) {
  status.textContent = message;
}

function countNote(page, name) {
  if (page.available === 0) return `No ${name} are available.`;
  if (page.omitted > 0) return `${page.displayed} of ${page.available} ${name} shown; ${page.omitted} truncated.`;
  return `${page.displayed} ${name} shown.`;
}

function memoryButton(memory, label) {
  const button = element('button', undefined, 'memory-button');
  button.type = 'button';
  if (memory.id === state.selected?.id) button.setAttribute('aria-current', 'true');
  button.append(element('strong', memory.title || 'Untitled memory'));
  button.append(element('span', memory.preview || 'unavailable', 'preview'));
  button.append(element('span', label || `${present(memory.recordedAt)} · ${present(memory.source?.label)}`, 'meta'));
  button.addEventListener('click', () => choose(memory));
  return button;
}

function renderIndex() {
  const page = state.mode === 'search' ? state.resultPage : state.recent;
  const memories = state.mode === 'search' ? page?.hits ?? [] : page?.memories ?? [];
  title.textContent = state.mode === 'search' ? 'Search results' : 'Recent memories';
  memoryList.replaceChildren();
  for (const memory of memories) {
    const row = element('li');
    if (memory.id === state.selected?.id) row.className = 'is-selected';
    if (memory.resolved === false) {
      row.append(element('p', 'This result cannot be opened because its record could not be resolved.', 'state-note'));
      row.append(element('strong', memory.title || 'Unresolved memory'));
      row.append(element('span', memory.preview || 'unavailable', 'preview'));
    } else {
      row.append(memoryButton(memory));
    }
    memoryList.append(row);
  }
  indexNote.textContent = countNote(page ?? { available: 0, displayed: 0, omitted: 0 }, state.mode === 'search' ? 'results' : 'recent memories');
}

function detailLine(label, value) {
  const row = element('div', undefined, 'detail-line');
  row.append(element('dt', label));
  row.append(element('dd', present(value)));
  return row;
}

function renderDetails() {
  details.replaceChildren();
  if (!state.details) {
    details.className = 'details empty-state';
    details.append(element('p', state.selected ? 'Selected memory details are unavailable.' : 'Select a memory to inspect its content and evidence.'));
    return;
  }
  details.className = 'details';
  details.append(element('h3', state.details.title || 'Untitled memory'));
  details.append(element('p', state.details.content || state.details.preview || 'unavailable', 'memory-content'));
  const metadata = element('dl', undefined, 'metadata');
  metadata.append(detailLine('Room', state.details.room));
  metadata.append(detailLine('Source', state.details.source?.label));
  metadata.append(detailLine('Recorded', state.details.recordedAt));
  metadata.append(detailLine('Authored', state.details.authoredAt));
  metadata.append(detailLine('Temporal status', state.details.temporalStatus));
  details.append(metadata);
  const evidence = element('section', undefined, 'evidence');
  evidence.append(element('h3', 'Evidence'));
  evidence.append(element('p', state.details.evidence > 0 ? `Full content above includes ${state.details.evidence} additional stored chunk${state.details.evidence === 1 ? '' : 's'} retained as evidence.` : 'No additional stored chunks are available.'));
  details.append(evidence);
}

function relationshipRow(relationship, source) {
  const row = element('li', undefined, 'relationship');
  row.append(element('strong', relationshipLabel(relationship)));
  if (source) row.append(element('p', `From: ${source.title || 'Untitled memory'}.`));
  row.append(element('p', `Direction: ${present(relationship.direction)}. Provenance: ${present(relationship.provenance)}. Temporal status: ${present(relationship.temporalStatus)}.`));
  row.append(element('p', `Recorded confidence: ${present(relationship.confidence)}. Valid from: ${present(relationship.validFrom)}. Valid to: ${present(relationship.validTo)}.`));
  if (relationship.target?.id) row.append(memoryButton(relationship.target, 'Open related memory'));
  else row.append(element('p', 'Related memory unavailable.', 'state-note'));
  return row;
}

function syncFilters() {
  categoryFilter.value = state.filters.category;
  directionFilter.value = state.filters.direction;
  temporalStatusFilter.value = state.filters.temporalStatus;
  dateFromFilter.value = state.filters.from;
  dateToFilter.value = state.filters.to;
  const rooms = [...new Set((state.graph?.nodes ?? []).map((node) => node.room).filter(Boolean))].sort();
  const roomOptions = [element('option', 'All rooms'), ...rooms.map((room) => element('option', room))];
  roomOptions[0].value = 'all';
  for (let index = 0; index < rooms.length; index += 1) roomOptions[index + 1].value = rooms[index];
  roomFilter.replaceChildren(...roomOptions);
  roomFilter.value = rooms.includes(state.filters.room) ? state.filters.room : 'all';
}

function renderRelationships() {
  incomingList.replaceChildren();
  outgoingList.replaceChildren();
  syncFilters();
  relationshipNote.className = 'state-note';
  if (!state.neighborhood) {
    filter.disabled = true;
    relationshipNote.textContent = state.selected ? 'Selected memory relationships are unavailable.' : 'Select a memory to see relationships.';
    return;
  }
  filter.disabled = false;
  const display = displayRelationships(state);
  const graph = displayGraph(state);
  const view = state.graph ? graph : display;
  const relationships = view.relationships;
  const sources = new Map(state.graph?.nodes.map((node) => [node.id, node]));
  const incoming = relationships.filter((relationship) => relationship.direction === 'incoming');
  const outgoing = relationships.filter((relationship) => relationship.direction !== 'incoming');
  for (const relationship of incoming) incomingList.append(relationshipRow(relationship, sources.get(relationship.graphSourceId)));
  for (const relationship of outgoing) outgoingList.append(relationshipRow(relationship, sources.get(relationship.graphSourceId)));
  const messages = [];
  if (view.pinned || display.seed?.pinned) {
    messages.push('Selected memory is pinned outside the active filter.');
    relationshipNote.className = 'state-note pinned';
  }
  const page = state.graph?.summary ?? state.neighborhood;
  if (relationships.length === 0) {
    messages.push('No relationships match this filter. Structural, recorded, and temporal data may be unavailable.');
  } else if (view.filtered) {
    messages.push(`${relationships.length} of ${page.displayed} displayed relationships match; ${page.displayed - relationships.length} filtered.`);
  } else {
    messages.push(`${page.displayed} of ${page.available} relationships shown; ${page.omitted} truncated. Knowledge graph data: ${present(state.neighborhood.knowledgeGraph)}.`);
  }
  relationshipNote.textContent = messages.join(' ');
}

function graphNode(node, position) {
  const group = svgElement('g', undefined, `graph-node ${position.shape}${node.id === state.selected?.id ? ' is-selected' : ''}`);
  group.setAttribute('role', 'button');
  group.setAttribute('tabindex', '0');
  group.setAttribute('aria-label', `${position.shape === 'seed' ? 'Selected memory' : 'Related memory'}: ${node.title || 'Untitled memory'}. Open details and relationship evidence.`);
  group.append(svgElement('title', `${position.shape === 'seed' ? 'Selected memory' : 'Related memory'}: ${node.title || 'Untitled memory'}`));
  if (position.shape === 'seed') {
    const shape = svgElement('circle', undefined, 'graph-shape');
    shape.setAttribute('cx', position.x);
    shape.setAttribute('cy', position.y);
    shape.setAttribute('r', '28');
    group.append(shape);
  } else {
    const shape = svgElement('rect', undefined, 'graph-shape');
    shape.setAttribute('x', position.x - 31);
    shape.setAttribute('y', position.y - 17);
    shape.setAttribute('width', '62');
    shape.setAttribute('height', '34');
    group.append(shape);
  }
  const label = svgElement('text', `${position.shape === 'seed' ? 'Selected' : 'Related'}: ${(node.title || 'Untitled memory').slice(0, 18)}`, 'graph-node-label');
  label.setAttribute('x', position.x);
  label.setAttribute('y', position.y + (position.shape === 'seed' ? 42 : 29));
  group.append(label);
  const activate = () => choose(node);
  group.addEventListener('click', activate);
  group.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  });
  return group;
}

function renderGraph() {
  graphPanel.replaceChildren();
  if (!state.graph) {
    graphPanel.hidden = true;
    return;
  }
  graphPanel.hidden = false;
  const heading = element('div', undefined, 'section-heading compact');
  heading.append(element('p', 'Map', 'eyebrow'));
  heading.append(element('h2', 'Neighborhood map'));
  graphPanel.append(heading);
  const controls = element('div', undefined, 'graph-controls');
  const collapse = element('button', state.graphCollapsed ? 'Expand map' : 'Collapse map', 'quiet');
  collapse.type = 'button';
  collapse.setAttribute('aria-expanded', String(!state.graphCollapsed));
  collapse.addEventListener('click', () => {
    state = { ...state, graphCollapsed: !state.graphCollapsed };
    renderGraph();
  });
  controls.append(collapse);
  const expandable = state.graph.nodes.some((node) => node.id !== state.graph.root.id && !state.graph.expandedIds.includes(node.id));
  if (!state.graphCollapsed && state.graph.nodes.length < 100 && expandable) {
    const expand = element('button', 'Expand map', 'quiet');
    expand.type = 'button';
    expand.addEventListener('click', expandGraph);
    controls.append(expand);
  }
  graphPanel.append(controls);
  const page = state.graph.lastExpansion;
  graphPanel.append(element('p', `Map expansion: ${page.displayed} of ${page.available} relationships shown; ${page.omitted} omitted. ${state.graph.nodes.length} of 100 memories displayed.`, 'state-note'));
  if (state.graphCollapsed) return;
  const display = displayGraph(state);
  const diagram = document.createElementNS(svgNamespace, 'svg');
  diagram.setAttribute('class', 'memory-graph');
  diagram.setAttribute('viewBox', '0 0 1000 560');
  diagram.setAttribute('role', 'group');
  diagram.setAttribute('aria-labelledby', 'graph-title graph-description');
  diagram.append(svgElement('title', 'Neighborhood map', undefined));
  diagram.lastChild.id = 'graph-title';
  diagram.append(svgElement('desc', 'Circle: selected memory. Rectangle: related memory. Lines are recorded relationships listed below with the same evidence.', undefined));
  diagram.lastChild.id = 'graph-description';
  const positions = new Map(graphLayout(state.graph).map((position) => [position.id, position]));
  for (const relationship of display.relationships) {
    const sourcePosition = positions.get(relationship.graphSourceId);
    const targetPosition = positions.get(relationship.target?.id);
    if (!sourcePosition || !targetPosition) continue;
    const edge = svgElement('line', undefined, 'graph-edge');
    edge.setAttribute('x1', sourcePosition.x);
    edge.setAttribute('y1', sourcePosition.y);
    edge.setAttribute('x2', targetPosition.x);
    edge.setAttribute('y2', targetPosition.y);
    diagram.append(edge);
    const label = svgElement('text', relationshipLabel(relationship), 'graph-edge-label');
    label.setAttribute('x', (sourcePosition.x + targetPosition.x) / 2);
    label.setAttribute('y', (sourcePosition.y + targetPosition.y) / 2);
    diagram.append(label);
  }
  for (const node of display.nodes) diagram.append(graphNode(node, positions.get(node.id)));
  graphPanel.append(diagram);
  graphPanel.append(element('p', 'Circle means selected memory. Rectangle means related memory. Lines use the same relationship labels and evidence as the semantic list below.', 'graph-key'));
}

async function expandGraph() {
  const graph = state.graph;
  const source = graph?.nodes.find((node) => node.id !== graph.root.id && !graph.expandedIds.includes(node.id));
  if (!source?.id) return;
  const request = requests.begin();
  setStatus('Expanding the neighborhood map by up to 25 memories.');
  try {
    const neighborhood = await api(`/api/neighborhood?id=${encodeURIComponent(source.id)}&visible=26`);
    if (!requests.isCurrent(request)) return;
    if (!neighborhood) throw new Error('Memory data is unavailable.');
    state = addGraphExpansion(state, neighborhood, source.id);
    renderGraph();
    renderRelationships();
    setStatus(`Map expansion: ${state.graph.lastExpansion.displayed} of ${state.graph.lastExpansion.available} relationships shown; ${state.graph.lastExpansion.omitted} omitted.`);
  } catch (error) {
    if (requests.isCurrent(request)) setStatus(error.message);
  }
}

function render() {
  renderIndex();
  renderDetails();
  renderGraph();
  renderRelationships();
}

async function choose(memory) {
  if (!memory?.id) return;
  const request = requests.begin();
  state = { ...state, selected: memory, details: null, neighborhood: null, graph: null, graphCollapsed: false };
  render();
  setStatus('Loading selected memory and its relationships.');
  try {
    const [record, neighborhood] = await Promise.all([
      api(`/api/details?id=${encodeURIComponent(memory.id)}`),
      api(`/api/neighborhood?id=${encodeURIComponent(memory.id)}&visible=26`),
    ]);
    if (!requests.isCurrent(request)) return;
    if (!record || !neighborhood) throw new Error('Memory data is unavailable.');
    state = selectMemory(state, record, neighborhood);
    render();
    setStatus(`Selected ${record.title || 'memory'}.`);
  } catch (error) {
    if (requests.isCurrent(request)) setStatus(error.message);
  }
}

async function recent() {
  const request = requests.begin();
  setStatus('Loading recent memories.');
  try {
    state = createState();
    const page = await api('/api/recent');
    if (!requests.isCurrent(request)) return;
    state.recent = page;
    render();
    setStatus(countNote(state.recent, 'recent memories'));
  } catch (error) {
    if (!requests.isCurrent(request)) return;
    state = createState();
    render();
    setStatus(error.message);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = search.value.trim();
  if (!query) return recent();
  const request = requests.begin();
  state = { ...createState(), mode: 'search', query };
  render();
  setStatus('Searching memory.');
  try {
    const page = await api(`/api/search?query=${encodeURIComponent(query)}`);
    if (!requests.isCurrent(request)) return;
    state = { ...createState(), mode: 'search', query, resultPage: page, results: page.hits ?? [] };
    render();
    setStatus(page.hits?.length ? countNote({ ...page, displayed: page.hits.length }, 'results') : 'No matching memories found.');
  } catch (error) {
    if (requests.isCurrent(request)) setStatus(error.message);
  }
});

form.addEventListener('reset', () => queueMicrotask(recent));
function updateFilters() {
  state = {
    ...state,
    filters: {
      category: categoryFilter.value,
      direction: directionFilter.value,
      temporalStatus: temporalStatusFilter.value,
      room: roomFilter.value,
      from: dateFromFilter.value,
      to: dateToFilter.value,
    },
  };
  renderGraph();
  renderRelationships();
}
for (const control of [categoryFilter, directionFilter, temporalStatusFilter, roomFilter, dateFromFilter, dateToFilter]) {
  control.addEventListener('change', updateFilters);
}

recent();
