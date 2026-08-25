import { createState, displayRelationships, present, relationshipLabel, selectMemory } from './model.js';

const form = document.querySelector('#search-form');
const search = document.querySelector('#search');
const status = document.querySelector('#status');
const title = document.querySelector('#index-title');
const indexNote = document.querySelector('#index-note');
const memoryList = document.querySelector('#memory-list');
const details = document.querySelector('#details');
const filter = document.querySelector('#relationship-filter');
const directionFilter = document.querySelector('#direction-filter');
const relationshipNote = document.querySelector('#relationship-note');
const incomingList = document.querySelector('#incoming-list');
const outgoingList = document.querySelector('#outgoing-list');
const token = new URLSearchParams(location.hash.slice(1)).get('token') || location.hash.slice(1);
let state = createState();

if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);

function element(name, text, className) {
  const node = document.createElement(name);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
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
  evidence.append(element('p', state.details.evidence > 0 ? `${state.details.evidence} additional stored chunk${state.details.evidence === 1 ? '' : 's'} retained as evidence.` : 'No additional stored chunks are available.'));
  details.append(evidence);
}

function relationshipRow(relationship) {
  const row = element('li', undefined, 'relationship');
  row.append(element('strong', relationshipLabel(relationship)));
  row.append(element('p', `Direction: ${present(relationship.direction)}. Provenance: ${present(relationship.provenance)}. Temporal status: ${present(relationship.temporalStatus)}.`));
  row.append(element('p', `Recorded confidence: ${present(relationship.confidence)}. Valid from: ${present(relationship.validFrom)}. Valid to: ${present(relationship.validTo)}.`));
  if (relationship.target?.id) row.append(memoryButton(relationship.target, 'Open related memory'));
  else row.append(element('p', 'Related memory unavailable.', 'state-note'));
  return row;
}

function renderRelationships() {
  incomingList.replaceChildren();
  outgoingList.replaceChildren();
  if (!state.neighborhood) {
    filter.disabled = true;
    relationshipNote.textContent = state.selected ? 'Selected memory relationships are unavailable.' : 'Select a memory to see relationships.';
    return;
  }
  filter.disabled = false;
  const display = displayRelationships(state);
  const relationships = display.relationships;
  const incoming = relationships.filter((relationship) => relationship.direction === 'incoming');
  const outgoing = relationships.filter((relationship) => relationship.direction !== 'incoming');
  for (const relationship of incoming) incomingList.append(relationshipRow(relationship));
  for (const relationship of outgoing) outgoingList.append(relationshipRow(relationship));
  if (display.seed?.pinned) {
    const pinned = element('p', 'Selected memory is pinned outside the active filter.', 'pinned');
    relationshipNote.replaceChildren(pinned);
  } else if (relationships.length === 0) {
    relationshipNote.textContent = 'No relationships match this filter. Structural, recorded, and temporal data may be unavailable.';
  } else {
    const page = state.neighborhood;
    relationshipNote.textContent = `${page.displayed} of ${page.available} relationships shown; ${page.omitted} truncated. Knowledge graph data: ${present(page.knowledgeGraph)}.`;
  }
}

function render() {
  renderIndex();
  renderDetails();
  renderRelationships();
}

async function choose(memory) {
  if (!memory?.id) return;
  state = { ...state, selected: memory, details: null, neighborhood: null };
  render();
  setStatus('Loading selected memory and its relationships.');
  try {
    const [record, neighborhood] = await Promise.all([
      api(`/api/details?id=${encodeURIComponent(memory.id)}`),
      api(`/api/neighborhood?id=${encodeURIComponent(memory.id)}&visible=1`),
    ]);
    if (!record || !neighborhood) throw new Error('Memory data is unavailable.');
    state = selectMemory(state, record, neighborhood);
    render();
    setStatus(`Selected ${record.title || 'memory'}.`);
  } catch (error) {
    setStatus(error.message);
  }
}

async function recent() {
  setStatus('Loading recent memories.');
  try {
    state = createState();
    state.recent = await api('/api/recent');
    render();
    setStatus(countNote(state.recent, 'recent memories'));
  } catch (error) {
    state = createState();
    render();
    setStatus(error.message);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = search.value.trim();
  if (!query) return recent();
  state = { ...createState(), mode: 'search', query };
  render();
  setStatus('Searching memory.');
  try {
    const page = await api(`/api/search?query=${encodeURIComponent(query)}`);
    state = { ...createState(), mode: 'search', query, resultPage: page, results: page.hits ?? [] };
    render();
    setStatus(page.hits?.length ? countNote({ ...page, displayed: page.hits.length }, 'results') : 'No matching memories found.');
  } catch (error) {
    setStatus(error.message);
  }
});

form.addEventListener('reset', () => queueMicrotask(recent));
directionFilter.addEventListener('change', () => {
  state = { ...state, filters: { direction: directionFilter.value } };
  renderRelationships();
});

recent();
