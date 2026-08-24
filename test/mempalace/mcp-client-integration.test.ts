import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createMcpClient, IncompatibleCoreError, UncertainWriteError } from '../../integration/mcp-client.ts';
import { mcpServerArgv, resolveLauncher } from '../../integration/resolve.ts';

// These tests drive a REAL spawned child over REAL pipes, because the unit
// tests' in-process fake cannot prove the things that only an operating system
// has: line framing across pipe boundaries, stderr staying out of the protocol
// channel, and a process group actually dying.
const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, 'fixtures', 'fake-mempalace-server.mjs');
const BIN = join(here, 'fixtures', 'fake-mempalace-bin.mjs');

const scratch = mkdtempSync(join(tmpdir(), 'mempalace-transport-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function argvFor(mode = 'normal') {
  return () => ({ cmd: process.execPath, args: [SERVER, mode] });
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('a fake incompatible core is terminated immediately after negotiation', async () => {
  const pidFile = join(scratch, 'incompatible.pid');
  const previous = process.env.MEMPALACE_FAKE_PID_FILE;
  process.env.MEMPALACE_FAKE_PID_FILE = pidFile;
  const client = createMcpClient(argvFor('incompatible'), process.cwd());
  try {
    await assert.rejects(client.callReadTool('mempalace_status', {}), IncompatibleCoreError);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const started = Date.now();
    while (isRunning(pid) && Date.now() - started < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(client.isAlive(), false);
    assert.ok(!isRunning(pid), 'the incompatible core must not outlive rejection');
  } finally {
    if (previous === undefined) delete process.env.MEMPALACE_FAKE_PID_FILE;
    else process.env.MEMPALACE_FAKE_PID_FILE = previous;
    await client.shutdown();
  }
});

test('a real child completes the handshake and answers a tool call over stdio', async () => {
  const client = createMcpClient(argvFor(), process.cwd());
  try {
    const status = (await client.callReadTool('mempalace_status', {})) as Record<string, unknown>;
    assert.equal(status.total_drawers, 3);
    assert.deepEqual(status.wings, { demo: 3 });
  } finally {
    await client.shutdown();
  }
});

test('a PATH-resolved launcher reaches the server it resolved', async () => {
  const bin = join(scratch, 'bin');
  mkdirSync(bin, { recursive: true });
  copyFileSync(BIN, join(bin, 'mempalace-mcp'));
  copyFileSync(SERVER, join(bin, 'fake-mempalace-server.mjs'));
  chmodSync(join(bin, 'mempalace-mcp'), 0o755);

  const launcher = resolveLauncher({ PATH: bin }, { platform: process.platform });
  assert.equal(launcher.mode, 'path');

  const client = createMcpClient(() => mcpServerArgv(launcher, join(scratch, 'palace')), process.cwd());
  try {
    const echoed = (await client.callReadTool('mempalace_search', { query: 'q' })) as Record<string, unknown>;
    assert.equal(echoed.echoed, 'mempalace_search');
  } finally {
    await client.shutdown();
  }
});

test('a real writer-lease refusal is surfaced verbatim and stays a definite outcome', async () => {
  const client = createMcpClient(argvFor(), process.cwd());
  try {
    await assert.rejects(
      client.callWriteTool('mempalace_add_drawer', { wing: '__refuse__', room: 'r', content: 'c' }),
      (err: Error) => {
        assert.ok(!(err instanceof UncertainWriteError));
        assert.equal(err.message, 'Peer MCP writer active; this server is read-only for mutating tools');
        return true;
      },
    );
  } finally {
    await client.shutdown();
  }
});

test('a read against a child that exits immediately recovers once, then fails clearly', async () => {
  const client = createMcpClient(argvFor('exit-immediately'), process.cwd());
  try {
    await assert.rejects(client.callReadTool('mempalace_status', {}), /mempalace_status/);
  } finally {
    await client.shutdown();
  }
});

test('a real child that never answers produces a per-request timeout on a read', async () => {
  const client = createMcpClient(argvFor('hang'), process.cwd(), { requestTimeoutMs: 500 });
  try {
    await assert.rejects(client.callReadTool('mempalace_status', {}), /timed out/);
  } finally {
    await client.shutdown();
  }
});

test('a real child that dies after dispatch makes the write uncertain, never repeated', async () => {
  const client = createMcpClient(argvFor('exit-on-call'), process.cwd());
  try {
    await assert.rejects(
      client.callWriteTool('mempalace_add_drawer', { wing: 'w', room: 'r', content: 'c' }),
      (err: Error) => err instanceof UncertainWriteError,
    );
  } finally {
    await client.shutdown();
  }
});

test('a stranded child group that ignores SIGTERM is escalated and released', async () => {
  const client = createMcpClient(argvFor('grandchild-hang'), process.cwd(), {
    requestTimeoutMs: 300,
    shutdownGraceMs: 500,
  });
  const status = (await client.callReadTool('mempalace_status', {})) as Record<string, number>;
  const serverPid = status.server_pid!;
  const grandchildPid = status.grandchild_pid!;
  assert.ok(isRunning(serverPid) && isRunning(grandchildPid), 'the fixture must own a live process group');

  const started = Date.now();
  // A timeout discards the child mid-session: the group ignores SIGTERM, so
  // only a bounded escalation stops it leaking for the rest of the session.
  await assert.rejects(client.callReadTool('mempalace_search', { query: 'q' }), /timed out/u);

  let elapsed = 0;
  while ((isRunning(serverPid) || isRunning(grandchildPid)) && elapsed < 5_000) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    elapsed = Date.now() - started;
  }

  try {
    assert.ok(!isRunning(serverPid), `the discarded MCP child survived ${elapsed}ms`);
    assert.ok(!isRunning(grandchildPid), `an owned grandchild survived the discard by ${elapsed}ms`);
  } finally {
    for (const pid of [grandchildPid, serverPid]) {
      if (isRunning(pid)) process.kill(pid, 'SIGKILL');
    }
    await client.shutdown();
  }
});

test('discard escalation still owns a grandchild after the group leader exits', async () => {
  const client = createMcpClient(argvFor('orphan-hang'), process.cwd(), {
    requestTimeoutMs: 300,
    shutdownGraceMs: 500,
  });
  const status = (await client.callReadTool('mempalace_status', {})) as Record<string, number>;
  const serverPid = status.server_pid!;
  const grandchildPid = status.grandchild_pid!;

  try {
    await assert.rejects(client.callReadTool('mempalace_search', { query: 'q' }), /timed out/u);
    const started = Date.now();
    while (isRunning(grandchildPid) && Date.now() - started < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(!isRunning(serverPid), 'the group leader should accept SIGTERM');
    assert.ok(!isRunning(grandchildPid), 'the SIGTERM-ignoring grandchild must receive escalated SIGKILL');
  } finally {
    for (const pid of [grandchildPid, serverPid]) {
      if (isRunning(pid)) process.kill(pid, 'SIGKILL');
    }
    await client.shutdown();
  }
});

test('a self-exiting group leader cannot orphan its grandchild or stdio', async () => {
  const client = createMcpClient(argvFor('orphan-exit'), process.cwd(), { shutdownGraceMs: 500 });
  const status = (await client.callReadTool('mempalace_status', {})) as Record<string, number>;
  const serverPid = status.server_pid!;
  const grandchildPid = status.grandchild_pid!;

  try {
    const started = Date.now();
    while ((isRunning(serverPid) || isRunning(grandchildPid)) && Date.now() - started < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(!isRunning(serverPid), 'the fixture group leader should exit by itself');
    assert.ok(!isRunning(grandchildPid), 'the self-exited leader must not orphan its grandchild');
  } finally {
    for (const pid of [grandchildPid, serverPid]) {
      if (isRunning(pid)) process.kill(pid, 'SIGKILL');
    }
    await client.shutdown();
  }
});

test('shutdown releases the owned child process group within 5 seconds', async () => {
  const client = createMcpClient(argvFor('grandchild'), process.cwd());
  const status = (await client.callReadTool('mempalace_status', {})) as Record<string, number>;
  const serverPid = status.server_pid!;
  const grandchildPid = status.grandchild_pid!;

  assert.ok(isRunning(serverPid) && isRunning(grandchildPid), 'the fixture must own a live process group');

  const started = Date.now();
  await client.shutdown();

  // The grandchild ignores SIGTERM on purpose: only a group-wide escalation
  // reaches it, and signalling the direct child alone would orphan it.
  let elapsed = 0;
  while ((isRunning(serverPid) || isRunning(grandchildPid)) && elapsed < 5_000) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    elapsed = Date.now() - started;
  }

  try {
    assert.ok(!isRunning(serverPid), `the MCP child outlived shutdown by ${elapsed}ms`);
    assert.ok(!isRunning(grandchildPid), `an owned grandchild outlived shutdown by ${elapsed}ms`);
    assert.ok(Date.now() - started < 5_000, 'every owned resource must be released within 5 seconds');
  } finally {
    // Only ever the exact pids this test created.
    for (const pid of [grandchildPid, serverPid]) {
      if (isRunning(pid)) process.kill(pid, 'SIGKILL');
    }
  }
});
