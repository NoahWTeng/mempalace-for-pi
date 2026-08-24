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
        serverInfo: { name: 'fake-mempalace', version: mode === 'incompatible' ? '9.9.9' : '3.7.1' },
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
