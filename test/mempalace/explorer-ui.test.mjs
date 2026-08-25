import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createState, displayRelationships, selectMemory } from '../../integration/explorer/assets/model.js';

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

test('a selected seed stays pinned when filters exclude it without restoring excluded neighbours', () => {
  const selected = selectMemory(createState(), seed, {
    seed,
    relationships: [{ category: 'structural', kind: 'same-source', direction: 'outgoing', target, temporalStatus: 'unknown', confidence: null, validFrom: null, validTo: null, provenance: 'unavailable' }],
    available: 1,
    displayed: 1,
    omitted: 0,
    knowledgeGraph: 'unavailable',
  });
  const filtered = displayRelationships({ ...selected, filters: { direction: 'incoming' } });

  assert.equal(filtered.seed.pinned, true);
  assert.deepEqual(filtered.relationships, []);
  assert.equal(filtered.filtered, true);
});

test('semantic shell and browser behavior keep untrusted values inert and use the required transport', async () => {
  const [html, app, css] = await Promise.all(['index.html', 'app.js', 'styles.css'].map(asset));

  assert.match(html, /<main/u);
  assert.match(html, /<label[^>]*for="search"/u);
  assert.match(html, /role="status"/u);
  assert.match(html, /<button[^>]*type="reset"/u);
  assert.doesNotMatch(html, /<svg\b/u);
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|outerHTML/u);
  assert.match(app, /\/api\/recent/u);
  assert.match(app, /\/api\/search\?query=/u);
  assert.match(app, /\/api\/details\?id=/u);
  assert.match(app, /\/api\/neighborhood\?id=.*visible=/u);
  assert.match(app, /Authorization/u);
  assert.match(app, /history\.replaceState/u);
  assert.match(app, /setAttribute\('aria-current'/u);
  assert.match(app, /Selected memory details are unavailable/u);
  assert.match(app, /form\.addEventListener\('reset'/u);
  assert.match(css, /:focus-visible/u);
  assert.match(css, /prefers-reduced-motion/u);
});
