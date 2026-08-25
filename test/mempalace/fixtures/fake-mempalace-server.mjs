#!/usr/bin/env node
// Deterministic stand-in for the official `mempalace-mcp` server.
//
// It speaks the framing MemPalace's stdio loop uses: line-delimited JSON-RPC
// 2.0, one object per line in each direction, and no response at all for a
// notification. Every answer below is a fixed value so a transport test never
// depends on a real palace, a model, or a clock.
//
// Usage: node fake-mempalace-server.mjs [mode]
//   normal           handshake plus tools/call happy path (default)
//   hang             answers initialize, then never answers tools/call
//   exit-immediately exits before reading anything (a child that is already dead)
//   exit-on-call     answers initialize, then exits the moment a tool is called
//   incompatible     answers initialize as unsupported MemPalace 9.9.9
//   grandchild       normal, but owns a SIGTERM-ignoring child in its process group
//   grandchild-hang  like `grandchild`, but the server itself also ignores SIGTERM
//                    and answers nothing except mempalace_status, so a caller can
//                    learn the group's pids and then strand it on a timeout
//   orphan-hang      answers only status, then lets its server exit on SIGTERM while
//                    its grandchild ignores SIGTERM; escalation must still own it
//   orphan-exit      answers status, then exits by itself while its grandchild stays
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import * as readline from 'node:readline';

const mode = process.argv[2] ?? 'normal';
if (process.env.MEMPALACE_FAKE_PID_FILE) writeFileSync(process.env.MEMPALACE_FAKE_PID_FILE, String(process.pid));

if (mode === 'exit-immediately') {
  process.exit(0);
}

// A grandchild is what makes process-GROUP shutdown observable: signalling only
// the direct child would orphan this one, exactly as signalling `uv` would
// orphan the Python process it launched.
let grandchild = null;
if (mode === 'grandchild' || mode === 'grandchild-hang' || mode === 'orphan-hang' || mode === 'orphan-exit') {
  grandchild = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { stdio: 'ignore' },
  );
}

// A group that survives a polite signal: only an escalation reaches it, and the
// heartbeat keeps the server alive even after its stdin is closed, so the test
// cannot mistake a self-exit for a kill.
if (mode === 'grandchild-hang') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const EXPLORER_MINIMAL = mode === 'explorer-minimal';
const EXPLORER_CREDENTIAL = ['password', 'hunter2'].join('=');
const EXPLORER_ABSOLUTE_SOURCE = ['/opt/private/palace/', 'password', '=', 'hunter2.json'].join('');
const EXPLORER_FILE_URI = ['file:///', 'Users', '/alice/private/notes.md'].join('');
const EXPLORER_UNC_PATH = ['\\\\', 'fileserver', '\\finance\\payroll.xlsx'].join('');

function explorerRow(drawer_id, wing, room, content, source_file, filed_at, chunk_ids) {
  return { drawer_id, wing, room, content, source_file, filed_at, authored_at: filed_at, chunk_ids };
}

const EXPLORER_ROWS = [
  explorerRow(
    'drawer_demo_notes_a1',
    'demo',
    'notes',
    'Adapter boundary decision\nThe explorer reads through one narrow adapter.',
    'docs/notes/adapter.md',
    '2026-08-01T10:00:00Z',
  ),
  explorerRow(
    'drawer_demo_notes_c1',
    'demo',
    'notes',
    'Chunked memory first half and second half.',
    'docs/notes/chunked.md',
    '2026-08-02T10:00:00Z',
    ['drawer_demo_notes_c1_chunk_000000', 'drawer_demo_notes_c1_chunk_000001'],
  ),
  explorerRow(
    'drawer_demo_notes_t1',
    'demo',
    'notes',
    'Twin content that cannot be told apart.',
    'docs/notes/twin.md',
    '2026-08-03T10:00:00Z',
  ),
  explorerRow(
    'drawer_demo_notes_t2',
    'demo',
    'notes',
    'Twin content that cannot be told apart.',
    'docs/notes/twin.md',
    '2026-08-03T10:00:00Z',
  ),
  explorerRow(
    'drawer_demo_notes_u1',
    'demo',
    'notes',
    'Unique note about the tunnel policy.',
    'docs/notes/unique.md',
    '2026-08-04T10:00:00Z',
  ),
  explorerRow(
    'drawer_demo_secrets_s1',
    'demo',
    EXPLORER_FILE_URI,
    `Deployment note: ${EXPLORER_CREDENTIAL} is read from ${EXPLORER_ABSOLUTE_SOURCE}, ${EXPLORER_FILE_URI}, and ${EXPLORER_UNC_PATH}.`,
    EXPLORER_ABSOLUTE_SOURCE,
    '2026-08-05T10:00:00Z',
  ),
  explorerRow(
    'drawer_demo_roomless_r1',
    'demo',
    '',
    'Roomless memory must not reach the explorer.',
    'docs/notes/roomless.md',
    '2026-08-05T09:30:00Z',
  ),
  explorerRow(
    'drawer_other_notes_x1',
    'other',
    'notes',
    'Cross project leak candidate.',
    'docs/notes/leak.md',
    '2026-08-06T10:00:00Z',
  ),
];

for (let index = 0; index < 30; index += 1) {
  const suffix = String(index).padStart(2, '0');
  EXPLORER_ROWS.push(
    explorerRow(
      `drawer_demo_hub_h${suffix}`,
      'demo',
      'hub',
      `Hub memory ${suffix} about the shared release runbook.`,
      'docs/hub/runbook.md',
      `2026-07-${suffix === '00' ? '01' : suffix}T09:00:00Z`,
    ),
  );
}

for (let index = 0; index < 150; index += 1) {
  const suffix = String(index).padStart(3, '0');
  const twin = index === 5 || index === 120;
  EXPLORER_ROWS.push(
    explorerRow(
      `drawer_demo_large_l${suffix}`,
      'demo',
      'large',
      index === 0 ? 'Large room seed.' : twin ? 'Large twin content.' : `Large room memory ${suffix} common corpus.`,
      twin ? 'docs/large/twin.md' : `docs/large/${suffix}.md`,
      index === 0 ? '2026-08-05T09:00:00Z' : twin ? '2026-06-01T10:00:00Z' : '2026-06-01T09:00:00Z',
    ),
  );
}

function explorerPreview(content) {
  return content.length > 200 ? `${content.slice(0, 200)}...` : content;
}

function explorerMetadata(row) {
  const metadata = {
    wing: row.wing,
    room: row.room,
    source_file: basename(row.source_file),
    filed_at: row.filed_at,
  };
  if (!EXPLORER_MINIMAL) {
    metadata.authored_at = row.authored_at;
    metadata.added_by = 'fake-mempalace';
  }
  if (row.chunk_ids) {
    metadata.chunks = row.chunk_ids.length;
    metadata.chunk_ids = row.chunk_ids;
  }
  return metadata;
}

function explorerSummary(row) {
  const summary = {
    drawer_id: row.drawer_id,
    wing: row.wing,
    room: row.room,
    content_preview: explorerPreview(row.content),
    metadata: explorerMetadata(row),
  };
  if (row.chunk_ids) {
    summary.chunks = row.chunk_ids.length;
    summary.chunk_ids = row.chunk_ids;
  }
  return summary;
}

function explorerListDrawers(args) {
  const limit = Math.max(1, Math.min(Number(args.limit ?? 20), 100));
  const offset = Math.max(0, Number(args.offset ?? 0));
  const matched = EXPLORER_ROWS.filter(
    (row) => (!args.wing || row.wing === args.wing) && (!args.room || row.room === args.room),
  );
  const page = matched.slice(offset, offset + limit).map(explorerSummary);
  const payload = { drawers: page, offset, limit };
  if (!EXPLORER_MINIMAL) {
    payload.total = matched.length;
    payload.count = page.length;
  }
  return payload;
}

function explorerGetDrawer(args) {
  const row = EXPLORER_ROWS.find((candidate) => candidate.drawer_id === args.drawer_id);
  if (!row) return { error: `Drawer not found: ${args.drawer_id}` };
  const payload = {
    drawer_id: row.drawer_id,
    content: row.content,
    wing: row.wing,
    room: row.room,
    metadata: explorerMetadata(row),
  };
  if (row.chunk_ids) {
    payload.chunks = row.chunk_ids.length;
    payload.chunk_ids = row.chunk_ids;
  }
  return payload;
}

function explorerHit(row, text, rank) {
  const hit = {
    text,
    wing: row.wing,
    room: row.room,
    source_file: basename(row.source_file),
    created_at: row.filed_at,
    similarity: Number((0.9 - rank * 0.05).toFixed(3)),
    distance: Number((0.1 + rank * 0.05).toFixed(4)),
  };
  if (!EXPLORER_MINIMAL) {
    hit.source_path = row.source_file;
    hit.authored_at = row.authored_at;
    hit.effective_distance = hit.distance;
    hit.closet_boost = 0;
    hit.matched_via = 'drawer';
  }
  return hit;
}

function explorerSearch(args) {
  const query = String(args.query ?? '').toLowerCase();
  const limit = Math.max(1, Math.min(Number(args.limit ?? 5), 100));
  if (query === 'wingless leak') {
    const row = EXPLORER_ROWS.find((candidate) => candidate.wing === 'other');
    const hit = explorerHit(row, row.content, 0);
    delete hit.wing;
    return { query: args.query, results: [hit] };
  }
  if (query === 'authored mismatch') {
    const row = EXPLORER_ROWS.find((candidate) => candidate.drawer_id === 'drawer_demo_notes_a1');
    const hit = explorerHit(row, row.content, 0);
    hit.authored_at = '2026-08-09T10:00:00Z';
    return { query: args.query, results: [hit] };
  }
  const scoped = query === 'leak'
    ? EXPLORER_ROWS
    : EXPLORER_ROWS.filter((row) => !args.wing || row.wing === args.wing);
  const matched = scoped.filter((row) => row.content.toLowerCase().includes(query));
  const results = matched.slice(0, limit).map((row, rank) => {
    const text = row.chunk_ids ? row.content.slice(0, 25) : row.content;
    return explorerHit(row, text, rank);
  });
  return {
    query: args.query,
    filters: { wing: args.wing ?? null, room: args.room ?? null, source_file: null },
    total_before_filter: matched.length,
    results,
  };
}

function explorerTool(name, args) {
  if (name === 'mempalace_list_drawers') return explorerListDrawers(args);
  if (name === 'mempalace_get_drawer') return explorerGetDrawer(args);
  if (name === 'mempalace_search') return explorerSearch(args);
  if (name === 'mempalace_kg_query') {
    if (EXPLORER_MINIMAL) return { error: `Unknown tool: ${name}` };
    return { entity: args.entity, as_of: args.as_of ?? null, facts: [], count: 0 };
  }
  if (name === 'mempalace_follow_tunnels') return [];
  if (name === 'mempalace_list_hallways') return [];
  return null;
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  // MemPalace's embedder warnings land on stderr. Writing here proves diagnostic
  // noise never leaks into the stdout JSON-RPC channel.
  process.stderr.write(`fake-mempalace: received ${msg.method}\n`);

  if (typeof msg.method === 'string' && msg.method.startsWith('notifications/')) return;

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'fake-mempalace',
          version: mode === 'incompatible' ? '9.9.9' : EXPLORER_MINIMAL ? '3.6.0' : '3.7.1',
        },
      },
    });
    return;
  }

  if (msg.method === 'tools/call') {
    if (mode === 'hang') return; // never respond, so the caller must time out
    if (mode === 'exit-on-call') process.exit(1); // dispatched, outcome unknowable

    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};

    if ((mode === 'grandchild-hang' || mode === 'orphan-hang') && name !== 'mempalace_status') return;

    if (name === 'mempalace_add_drawer' && args.wing === '__refuse__') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: -32001,
          message: 'Peer MCP writer active; this server is read-only for mutating tools',
        },
      });
      return;
    }

    if (mode.startsWith('explorer')) {
      const explorerResult = explorerTool(name, args);
      if (explorerResult !== null) {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: JSON.stringify(explorerResult) }] },
        });
        return;
      }
    }

    if (name === 'mempalace_status') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                total_drawers: 3,
                wings: { demo: 3 },
                server_pid: process.pid,
                grandchild_pid: grandchild?.pid ?? null,
              }),
            },
          ],
        },
      });
      if (mode === 'orphan-exit') setTimeout(() => process.exit(0), 25);
      return;
    }

    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: JSON.stringify({ echoed: name, args }) }] },
    });
    return;
  }

  send({
    jsonrpc: '2.0',
    id: msg.id ?? null,
    error: { code: -32601, message: `Unknown method: ${msg.method}` },
  });
});
