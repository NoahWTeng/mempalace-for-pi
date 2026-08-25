import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { addGraphExpansion, createGraph, createRequestGate, createState, displayGraph, displayRelationships, graphLayout, selectMemory } from '../../integration/explorer/assets/model.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const asset = (name) => readFile(join(root, 'integration', 'explorer', 'assets', name), 'utf8');

const seed = { id: 'seed', title: 'Seed memory', preview: 'A retained context.', room: 'notes', source: { label: 'notes.md' }, recordedAt: null, authoredAt: null, chunks: 2, evidence: 1 };
const target = { id: 'target', title: 'Related memory', preview: 'A nearby record.', room: 'notes', source: { label: 'notes.md' }, recordedAt: null, authoredAt: null, chunks: 1, evidence: 0 };

test('the initial state has an explicit unavailable recent page', () => {
  const state = createState();

  assert.equal(state.recent, null);
  assert.equal(state.details, null);
  assert.equal(state.neighborhood, null);
});

test('a selected seed stays pinned when memory filters exclude it without restoring excluded neighbours', () => {
  const related = { ...target, room: 'decisions', recordedAt: '2026-08-10T00:00:00Z' };
  const selected = selectMemory(createState(), seed, {
    seed,
    relationships: [{ category: 'structural', kind: 'same-source', direction: 'outgoing', target: related, temporalStatus: 'unknown', confidence: null, validFrom: null, validTo: null, provenance: 'unavailable' }],
    available: 1,
    displayed: 1,
    omitted: 0,
    knowledgeGraph: 'unavailable',
  });
  const filters = { ...selected.filters, room: 'decisions' };
  const filtered = displayRelationships({ ...selected, filters });

  assert.equal(filtered.seed.pinned, true);
  assert.deepEqual(filtered.relationships.map((relationship) => relationship.target.id), [target.id]);
  assert.equal(filtered.filtered, false);
});

test('relationship filters cover category, direction, temporal status, organization, and date range', () => {
  const matching = { ...target, room: 'decisions', recordedAt: '2026-08-10T00:00:00Z' };
  const excluded = { ...target, id: 'excluded', room: 'notes', recordedAt: '2026-07-31T00:00:00Z' };
  const selected = selectMemory(createState(), seed, {
    seed,
    relationships: [
      { category: 'temporal', kind: 'supersedes', direction: 'incoming', target: matching, temporalStatus: 'current', confidence: null, validFrom: null, validTo: null, provenance: 'available' },
      { category: 'structural', kind: 'same-room', direction: 'undirected', target: excluded, temporalStatus: 'unknown', confidence: null, validFrom: null, validTo: null, provenance: 'unavailable' },
    ],
    available: 2,
    displayed: 2,
    omitted: 0,
    knowledgeGraph: 'unavailable',
  });
  const filters = { direction: 'incoming', category: 'temporal', temporalStatus: 'current', room: 'decisions', from: '2026-08-01', to: '2026-08-31' };
  const filtered = displayRelationships({ ...selected, filters });

  assert.deepEqual(filtered.relationships.map((relationship) => relationship.target.id), [target.id]);
  assert.equal(filtered.filtered, true);
});

test('request gate rejects stale responses', () => {
  const requests = createRequestGate();
  const first = requests.begin();
  const second = requests.begin();

  assert.equal(requests.isCurrent(first), false);
  assert.equal(requests.isCurrent(second), true);
});

test('graph expansion is deterministic, bounded, and leaves the selected memory intact', () => {
  const relationships = Array.from({ length: 125 }, (_, index) => ({
    category: 'structural',
    kind: 'same-source',
    direction: 'undirected',
    target: { ...target, id: `target-${125 - index}` },
    temporalStatus: 'unknown',
    confidence: null,
    validFrom: null,
    validTo: null,
    provenance: 'unavailable',
  }));
  const neighborhood = { seed, relationships, available: 125, displayed: 125, omitted: 0, knowledgeGraph: 'unavailable' };
  const expansion = (batch) => {
    const batchRelationships = Array.from({ length: 30 }, (_, index) => ({
      ...relationships[index],
      target: { ...target, id: `expanded-${batch}-${index}` },
    }));
    return { seed: target, relationships: batchRelationships, available: 30, displayed: 30, omitted: 0, knowledgeGraph: 'unavailable' };
  };
  const state = selectMemory(createState(), seed, neighborhood);
  const graph = createGraph(state);
  const expanded = addGraphExpansion({ ...state, graph }, expansion(0), 'target-1');

  assert.equal(graph.nodes.length, 26);
  assert.equal(expanded.graph.nodes.length, 51);
  assert.ok(expanded.graph.nodes.length <= 100);
  assert.equal(expanded.graph.lastExpansion.displayed, 25);
  assert.equal(expanded.graph.lastExpansion.available, 30);
  assert.deepEqual(expanded.graph.summary, { available: 155, displayed: 50, omitted: 105 });
  assert.equal(expanded.selected.id, seed.id);
  assert.deepEqual(expanded.graph.expandedIds, ['target-1']);
  assert.ok(expanded.graph.relationships.slice(25).every((relationship) => relationship.graphSourceId === 'target-1'));
  assert.deepEqual(graphLayout(expanded.graph), graphLayout(expanded.graph));

  let bounded = expanded;
  for (let index = 1; index < 5; index += 1) {
    const before = bounded.graph.nodes.length;
    bounded = addGraphExpansion(bounded, expansion(index), `target-${index + 1}`);
    assert.ok(bounded.graph.nodes.length - before <= 25);
  }
  assert.equal(bounded.graph.nodes.length, 100);
});

test('graph nodes stay unique and filtered edges retain their source memory', () => {
  const first = { category: 'structural', kind: 'same-room', direction: 'undirected', target, provenance: 'room membership' };
  const selected = selectMemory(createState(), seed, {
    seed,
    relationships: [first, { ...first, kind: 'same-source' }],
    available: 2,
    displayed: 2,
    omitted: 0,
    knowledgeGraph: 'unavailable',
  });
  const expanded = addGraphExpansion(selected, {
    seed: target,
    relationships: [{ ...first, kind: 'same-source', direction: 'outgoing', target: { ...target, id: 'leaf' } }],
    available: 1,
    displayed: 1,
    omitted: 0,
    knowledgeGraph: 'unavailable',
  }, target.id);
  const outgoing = displayGraph({ ...expanded, filters: { direction: 'outgoing' } });

  assert.equal(new Set(expanded.graph.nodes.map((node) => node.id)).size, expanded.graph.nodes.length);
  assert.deepEqual(outgoing.nodes.map((node) => node.id).sort(), ['leaf', 'seed', 'target']);
});

test('semantic shell and browser behavior keep untrusted values inert and use the required transport', async () => {
  const [html, app, css] = await Promise.all(['index.html', 'app.js', 'styles.css'].map(asset));

  assert.match(html, /<main/u);
  assert.match(html, /<label[^>]*for="search"/u);
  assert.match(html, /role="status"/u);
  assert.match(html, /<button[^>]*type="reset"/u);
  for (const control of ['relationship-category-filter', 'direction-filter', 'temporal-status-filter', 'room-filter', 'date-from-filter', 'date-to-filter']) {
    assert.match(html, new RegExp(`id="${control}"`, 'u'));
  }
  assert.doesNotMatch(html, /<svg\b/u);
  assert.match(html, /Outgoing and undirected relationships/u);
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|outerHTML/u);
  assert.equal((app.match(/visible=26/gu) ?? []).length, 2);
  assert.doesNotMatch(app, /visible=1(?:\D|$)/u);
  assert.match(app, /createElementNS\(svgNamespace, 'svg'\)/u);
  assert.match(app, /diagram\.setAttribute\('role', 'group'\)/u);
  assert.match(app, /Expand map/u);
  assert.match(app, /Collapse map/u);
  assert.match(app, /addGraphExpansion/u);
  assert.match(app, /relationshipLabel\(relationship\)/u);
  assert.match(app, /relationshipRow\(relationship, source\)/u);
  assert.match(app, /\/api\/recent/u);
  assert.match(app, /\/api\/search\?query=/u);
  assert.match(app, /\/api\/details\?id=/u);
  assert.match(app, /\/api\/neighborhood\?id=.*visible=/u);
  assert.match(app, /Authorization/u);
  assert.match(app, /history\.replaceState/u);
  assert.match(app, /requests\.isCurrent/u);
  assert.match(app, /setAttribute\('aria-current'/u);
  assert.match(app, /Selected memory details are unavailable/u);
  assert.match(app, /Full content above includes/u);
  assert.match(app, /form\.addEventListener\('reset'/u);
  assert.match(css, /\.graph-panel/u);
  assert.match(css, /\.graph-node/u);
  assert.match(css, /:focus-visible[^\n]*var\(--signal-dark\)/u);
  assert.match(css, /@media \(max-width: 48rem\)[^\n]*\.filter-grid[^\n]*grid-template-columns: 1fr/u);
  assert.match(css, /prefers-reduced-motion/u);
  assert.doesNotMatch(css, /@keyframes/u);
  assert.match(css, /animation: none/u);
});
