import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createMcpClient, type McpClient } from '../../integration/mcp-client.ts';
import {
  createExplorerAdapter,
  EXPLORER_EXPANSION_LIMIT,
  EXPLORER_RECENT_LIMIT,
  EXPLORER_VISIBLE_LIMIT,
  type ExplorerAdapter,
  type ExplorerMemory,
} from '../../integration/explorer/adapter.ts';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mempalace-server.mjs');
const PROJECT = 'demo';

interface Harness {
  readonly adapter: ExplorerAdapter;
  readonly reads: Array<{ name: string; args: Record<string, unknown> }>;
  readonly writes: string[];
}

const clients: McpClient[] = [];
after(async () => {
  for (const client of clients) await client.shutdown();
});

function harness(mode = 'explorer'): Harness {
  const client = createMcpClient(() => ({ cmd: process.execPath, args: [SERVER, mode] }), process.cwd());
  clients.push(client);
  const reads: Array<{ name: string; args: Record<string, unknown> }> = [];
  const writes: string[] = [];
  const observed: McpClient = {
    callReadTool(name, args = {}) {
      reads.push({ name, args });
      return client.callReadTool(name, args);
    },
    callWriteTool(name) {
      writes.push(name);
      return Promise.reject(new Error(`the explorer attempted a write: ${name}`));
    },
    shutdown: () => client.shutdown(),
    isAlive: () => client.isAlive(),
  };
  return { adapter: createExplorerAdapter(observed, { project: PROJECT }), reads, writes };
}

function adapterWith(read: McpClient['callReadTool']): ExplorerAdapter {
  return createExplorerAdapter(
    {
      callReadTool: read,
      callWriteTool: () => Promise.reject(new Error('unexpected write')),
      shutdown: async () => {},
      isAlive: () => true,
    },
    { project: PROJECT },
  );
}

function byTitle(memories: readonly ExplorerMemory[], fragment: string): ExplorerMemory {
  const found = memories.find((memory) => memory.title.includes(fragment));
  assert.ok(found, `no memory titled like ${fragment}`);
  return found;
}

const READ_TOOLS = ['mempalace_get_drawer', 'mempalace_list_drawers', 'mempalace_search'];

test('every read goes through callReadTool and only through approved core read tools', async () => {
  const { adapter, reads, writes } = harness();
  const recent = await adapter.recent();
  const seed = byTitle(recent.memories, 'Adapter boundary decision');
  await adapter.search('twin');
  await adapter.details(seed.id);
  await adapter.neighborhood(seed.id);

  assert.deepEqual(writes, []);
  assert.ok(reads.length > 0);
  for (const read of reads) {
    assert.ok(READ_TOOLS.includes(read.name), `unapproved read tool: ${read.name}`);
    assert.equal(read.args.wing ?? PROJECT, PROJECT, `read escaped the active project: ${read.name}`);
  }
});

test('landing shows at most ten logical memories, newest first, with the honest total', async () => {
  const { adapter } = harness();
  const page = await adapter.recent();

  assert.equal(page.memories.length, EXPLORER_RECENT_LIMIT);
  assert.equal(page.displayed, EXPLORER_RECENT_LIMIT);
  assert.equal(page.available, 187);
  assert.equal(page.omitted, 177);
  assert.ok(page.memories.every((memory) => !memory.title.includes('Roomless memory')));

  const recorded = page.memories.map((memory) => memory.recordedAt);
  assert.deepEqual(recorded, [...recorded].sort().reverse());
  assert.equal(page.memories[0]?.recordedAt, '2026-08-05T10:00:00Z');
});

test('stored chunks merge into one logical memory that keeps its extra chunks as evidence', async () => {
  const { adapter } = harness();
  const page = await adapter.recent();
  const chunked = byTitle(page.memories, 'Chunked memory');

  assert.equal(page.memories.filter((memory) => memory.title.includes('Chunked memory')).length, 1);
  assert.equal(chunked.chunks, 2);
  assert.equal(chunked.evidence, 1);
  assert.equal(byTitle(page.memories, 'Adapter boundary decision').chunks, 1);
  assert.equal(byTitle(page.memories, 'Adapter boundary decision').evidence, 0);
});

test('a search hit resolves to a logical memory when room, source, timestamps and content agree', async () => {
  const { adapter } = harness();
  const recent = await adapter.recent();
  const expected = byTitle(recent.memories, 'Adapter boundary decision');

  const page = await adapter.search('adapter boundary');
  assert.equal(page.hits.length, 1);
  const [hit] = page.hits;
  assert.equal(hit?.resolved, true);
  assert.equal(hit?.id, expected.id);
  assert.equal(page.unresolved, 0);
});

test('a hit whose text is one stored chunk still resolves to the merged logical memory', async () => {
  const { adapter } = harness();
  const page = await adapter.search('chunked');

  assert.equal(page.hits.length, 1);
  assert.equal(page.hits[0]?.resolved, true);
  assert.equal(page.hits[0]?.chunks, 2);
  assert.equal(page.hits[0]?.evidence, 1);
});

test('an ambiguous hit stays unresolved instead of guessing a logical memory', async () => {
  const { adapter } = harness();
  const page = await adapter.search('cannot be told apart');

  assert.equal(page.hits.length, 2);
  assert.equal(page.unresolved, 2);
  for (const hit of page.hits) {
    assert.equal(hit.resolved, false);
    assert.equal(hit.id, null);
    assert.match(hit.preview, /Twin content/u);
  }
});

test('identity resolution fails closed when the room page is truncated', async () => {
  const { adapter } = harness();
  const page = await adapter.search('large twin');

  assert.equal(page.hits.length, 2);
  assert.equal(page.unresolved, 2);
  assert.ok(page.hits.every((hit) => hit.id === null));
});

test('a full raw page remains truncated after invalid rows are filtered', async () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    drawer_id: `drawer_demo_notes_${index}`,
    wing: PROJECT,
    room: index === 99 ? '' : 'notes',
    content_preview: index === 0 ? 'Filtered-page target.' : `Other memory ${index}.`,
    metadata: {
      wing: PROJECT,
      room: index === 99 ? '' : 'notes',
      source_file: index === 0 ? 'target.md' : `${index}.md`,
      filed_at: '2026-08-01T00:00:00Z',
    },
  }));
  const adapter = adapterWith(async (name) => name === 'mempalace_search'
    ? {
        results: [{
          text: 'Filtered-page target.',
          wing: PROJECT,
          room: 'notes',
          source_file: 'target.md',
          created_at: '2026-08-01T00:00:00Z',
        }],
      }
    : { drawers: rows });

  const page = await adapter.search('filtered-page');
  assert.equal(page.hits[0]?.resolved, false);
  assert.equal(page.hits[0]?.id, null);
});

test('search reports core truncation without exposing dropped project data', async () => {
  const { adapter } = harness();
  const page = await adapter.search('common corpus');

  assert.equal(page.available, 147);
  assert.equal(page.displayed, 100);
  assert.equal(page.omitted, 47);
  assert.equal(page.unresolved, 100);
});

test('search counts every omitted result when a truncated page contains foreign hits', async () => {
  const results = Array.from({ length: 100 }, (_, index) => ({
    text: `Result ${index}`,
    wing: index < 60 ? PROJECT : 'other',
    room: 'notes',
    source_file: `${index}.md`,
    created_at: '2026-08-01T00:00:00Z',
  }));
  const adapter = adapterWith(async (name) => name === 'mempalace_search'
    ? { results, total_before_filter: 500 }
    : { drawers: [] });

  const page = await adapter.search('result');
  assert.equal(page.available, 500);
  assert.equal(page.displayed, 60);
  assert.equal(page.omitted, 440);
});

test('a hit from another project is dropped even when the core ignores the wing filter', async () => {
  const { adapter } = harness();
  const page = await adapter.search('leak');

  assert.deepEqual(page.hits, []);
  assert.equal(page.available, 1);
  assert.equal(page.omitted, 1);
  assert.doesNotMatch(JSON.stringify(page), /leak candidate/u);
});

test('a hit without project authority is dropped instead of exposed as unresolved', async () => {
  const { adapter } = harness();
  const page = await adapter.search('wingless leak');

  assert.deepEqual(page.hits, []);
  assert.equal(page.available, 1);
  assert.equal(page.omitted, 1);
  assert.doesNotMatch(JSON.stringify(page), /leak candidate/u);
});

test('one-sided authored provenance cannot resolve a sparse stored memory', async () => {
  const { adapter } = harness('explorer-minimal');
  const page = await adapter.search('authored mismatch');

  assert.equal(page.hits.length, 1);
  assert.equal(page.hits[0]?.resolved, false);
  assert.equal(page.hits[0]?.id, null);
});

test('user-visible answers carry no absolute path, credential, raw provenance or reversible handle', async () => {
  const { adapter } = harness();
  const recent = await adapter.recent();
  const search = await adapter.search('deployment');
  const secrets = byTitle(recent.memories, 'Deployment note');
  const details = await adapter.details(secrets.id);
  const neighborhood = await adapter.neighborhood(secrets.id);
  const serialized = JSON.stringify({ details, neighborhood, recent, search });

  assert.doesNotMatch(serialized, /\/opt\/private/u);
  assert.doesNotMatch(serialized, /\/Users\/alice/u);
  assert.doesNotMatch(serialized, /fileserver|finance|hunter2/u);
  assert.doesNotMatch(serialized, /drawer_/u);
  for (const raw of ['source_path', 'chunk_ids', 'matched_via', 'closet_boost', 'added_by', 'parent_drawer_id']) {
    assert.ok(!serialized.includes(raw), `raw core field reached a user-visible answer: ${raw}`);
  }
  assert.equal(secrets.room, '[redacted path]');
  assert.equal(secrets.source.scope, 'label');
  assert.equal(secrets.source.label, '[redacted credential]');
});

test('non-project URI sources are reduced to safe labels', async () => {
  const row = {
    drawer_id: 'drawer_demo_notes_uri',
    wing: PROJECT,
    room: 'notes',
    content_preview: 'Remote source reference.',
    metadata: { wing: PROJECT, room: 'notes', source_file: 'file://fileserver/private/note.md', filed_at: '2026-08-01T00:00:00Z' },
  };
  const adapter = adapterWith(async () => ({ drawers: [row], total: 1 }));
  const page = await adapter.recent();

  assert.deepEqual(page.memories[0]?.source, { scope: 'label', label: 'note.md' });
  assert.doesNotMatch(JSON.stringify(page), /file:|fileserver/u);
});

test('memory handles are opaque per adapter, so they cannot be reversed into stored identity', async () => {
  const first = await harness().adapter.recent();
  const second = await harness().adapter.recent();
  const firstTitles = first.memories.map((memory) => memory.title);

  assert.deepEqual(second.memories.map((memory) => memory.title), firstTitles);
  assert.notDeepEqual(second.memories.map((memory) => memory.id), first.memories.map((memory) => memory.id));
  for (const memory of first.memories) assert.match(memory.id, /^[0-9a-f]{32}$/u);
});

test('details returns the full logical content and refuses a handle it never issued', async () => {
  const { adapter } = harness();
  const recent = await adapter.recent();
  const chunked = byTitle(recent.memories, 'Chunked memory');

  const details = await adapter.details(chunked.id);
  assert.equal(details?.id, chunked.id);
  assert.equal(details?.content, 'Chunked memory first half and second half.');
  assert.equal(details?.chunks, 2);
  assert.equal(await adapter.details('f'.repeat(32)), null);
  assert.equal(await adapter.neighborhood('f'.repeat(32)), null);
});

test('one expansion adds at most twenty-five neighbours and reports what it omitted', async () => {
  const { adapter } = harness();
  const recent = await adapter.recent();
  const hub = byTitle(recent.memories, 'Hub memory');

  const neighborhood = await adapter.neighborhood(hub.id);
  assert.equal(neighborhood?.available, 29);
  assert.equal(neighborhood?.displayed, EXPLORER_EXPANSION_LIMIT);
  assert.equal(neighborhood?.omitted, 4);
  assert.equal(neighborhood?.relationships.length, EXPLORER_EXPANSION_LIMIT);
});

test('an expansion never pushes the visible neighbourhood past its hard cap', async () => {
  const { adapter } = harness();
  const recent = await adapter.recent();
  const hub = byTitle(recent.memories, 'Hub memory');

  const nearCap = await adapter.neighborhood(hub.id, { visible: EXPLORER_VISIBLE_LIMIT - 5 });
  assert.equal(nearCap?.displayed, 5);
  assert.equal(nearCap?.omitted, 24);

  const atCap = await adapter.neighborhood(hub.id, { visible: EXPLORER_VISIBLE_LIMIT });
  assert.equal(atCap?.displayed, 0);
  assert.equal(atCap?.omitted, 29);
  assert.deepEqual(atCap?.relationships, []);
});

test('a truncated neighborhood reports the full room total and honest omission count', async () => {
  const { adapter } = harness();
  const recent = await adapter.recent();
  const seed = byTitle(recent.memories, 'Large room seed');

  const neighborhood = await adapter.neighborhood(seed.id);
  assert.equal(neighborhood?.available, 149);
  assert.equal(neighborhood?.displayed, EXPLORER_EXPANSION_LIMIT);
  assert.equal(neighborhood?.omitted, 124);
});

test('structural relationships are labelled as structural and unscoped knowledge graph data stays unavailable', async () => {
  const { adapter, reads } = harness();
  const recent = await adapter.recent();
  const twin = byTitle(recent.memories, 'Twin content');

  const neighborhood = await adapter.neighborhood(twin.id);
  assert.equal(neighborhood?.knowledgeGraph, 'unavailable');
  assert.equal(neighborhood?.available, 4);
  assert.equal(neighborhood?.displayed, 4);
  for (const relationship of neighborhood?.relationships ?? []) {
    assert.equal(relationship.category, 'structural');
    assert.equal(relationship.confidence, null);
    assert.equal(relationship.temporalStatus, 'unknown');
    assert.equal(relationship.provenance, 'unavailable');
  }
  const kinds = (neighborhood?.relationships ?? []).map((relationship) => relationship.kind).sort();
  assert.deepEqual(kinds, ['room-co-membership', 'room-co-membership', 'room-co-membership', 'same-source']);
  assert.ok(reads.every((read) => read.name !== 'mempalace_kg_query'));
});

test('transient list failure stays unavailable and is not cached as an empty palace', async () => {
  let calls = 0;
  const adapter = adapterWith(async () => {
    calls += 1;
    throw new Error('temporary read failure');
  });

  await assert.rejects(adapter.recent(), /temporary read failure/u);
  await assert.rejects(adapter.recent(), /temporary read failure/u);
  assert.equal(calls, 2);
});

test('details refuses to present a cached preview when the drawer read fails', async () => {
  const row = {
    drawer_id: 'drawer_demo_notes_f1',
    wing: PROJECT,
    room: 'notes',
    content_preview: 'Preview only...',
    metadata: { wing: PROJECT, room: 'notes', source_file: 'note.md', filed_at: '2026-08-01T00:00:00Z' },
  };
  const adapter = adapterWith(async (name) => {
    if (name === 'mempalace_list_drawers') return { drawers: [row], total: 1 };
    throw new Error('drawer unavailable');
  });
  const page = await adapter.recent();

  await assert.rejects(adapter.details(page.memories[0]?.id ?? ''), /drawer unavailable/u);
});

test('the echoed query is bounded and redacted', async () => {
  const { adapter } = harness();
  const query = `${['/', 'Users', '/alice/private/notes.md'].join('')} ${['/', 'Users'].join('')} ${['password', 'hunter2'].join('=')} ${'x'.repeat(500)}`;
  const page = await adapter.search(query);

  assert.ok(page.query.length <= 200);
  assert.doesNotMatch(page.query, /Users|hunter2/u);
});

test('a core that omits every optional field produces the same stable DTOs', async () => {
  const rich = harness('explorer').adapter;
  const sparse = harness('explorer-minimal').adapter;

  const richPage = await rich.recent();
  const sparsePage = await sparse.recent();
  assert.equal(richPage.available, 187);
  assert.equal(sparsePage.available, 99);
  assert.deepEqual(
    sparsePage.memories.map((memory) => Object.keys(memory).sort()),
    richPage.memories.map((memory) => Object.keys(memory).sort()),
  );
  assert.deepEqual(
    sparsePage.memories.map((memory) => memory.title),
    richPage.memories.map((memory) => memory.title),
  );

  const sparseHit = await sparse.search('adapter boundary');
  assert.equal(sparseHit.hits[0]?.resolved, true);
  assert.equal(sparseHit.hits[0]?.authoredAt, null);

  const hub = byTitle(sparsePage.memories, 'Hub memory');
  const neighborhood = await sparse.neighborhood(hub.id);
  assert.equal(neighborhood?.knowledgeGraph, 'unavailable');
  assert.equal(neighborhood?.displayed, EXPLORER_EXPANSION_LIMIT);
});
