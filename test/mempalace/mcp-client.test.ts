import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import type { Argv } from '../../integration/resolve.ts';
import {
  createMcpClient,
  REQUEST_TIMEOUT_MS,
  SHUTDOWN_GRACE_MS,
  IncompatibleCoreError,
  UncertainWriteError,
} from '../../integration/mcp-client.ts';

// ---------------------------------------------------------------------------
// A fake child process: enough of an EventEmitter with stdio to drive every
// spawn/attach/send/parse path without an OS process. The sibling file
// `mcp-client-integration.test.ts` re-proves the same framing against a real
// spawned child, where signals and pipes actually exist.
// ---------------------------------------------------------------------------

interface FakeStream extends EventEmitter {
  setEncoding: (encoding: string) => void;
  destroyed: boolean;
  destroy: () => void;
}

interface FakeChild extends EventEmitter {
  stdout: FakeStream;
  stderr: FakeStream;
  stdin: {
    writes: string[];
    write: (data: string, cb?: (err?: Error) => void) => boolean;
    destroyed: boolean;
    destroy: () => void;
  };
  pid?: number;
  exitCode: number | null;
  signalCode: string | null;
  killed: boolean;
  kill: (signal?: string) => boolean;
  killCalls: string[];
}

function makeFakeStream(): FakeStream {
  const stream = new EventEmitter() as FakeStream;
  stream.setEncoding = () => {};
  stream.destroyed = false;
  stream.destroy = () => {
    stream.destroyed = true;
  };
  return stream;
}

function makeFakeChild(pid = 4321): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = makeFakeStream();
  child.stderr = makeFakeStream();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.killCalls = [];
  const writes: string[] = [];
  child.stdin = {
    writes,
    write: (data: string, cb?: (err?: Error) => void) => {
      writes.push(data);
      cb?.();
      return true;
    },
    destroyed: false,
    destroy: () => {
      child.stdin.destroyed = true;
    },
  };
  child.kill = (signal?: string) => {
    child.killCalls.push(signal ?? 'SIGTERM');
    child.killed = true;
    return true;
  };
  return child;
}

function respond(child: FakeChild, obj: unknown): void {
  child.stdout.emit('data', `${JSON.stringify(obj)}\n`);
}

function initResult(id: unknown): unknown {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-mempalace', version: '3.7.1' },
    },
  };
}

function toolResult(id: unknown): unknown {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } };
}

interface Handlers {
  onInitialize?: (msg: { id: unknown }) => unknown;
  onToolsCall?: (msg: { id: unknown; params: { name: string; arguments: Record<string, unknown> } }) => unknown;
}

/** Parses each JSON-RPC line the client writes and pushes back a canned reply,
 * mirroring the server's line-delimited request/response framing. */
function autoRespond(child: FakeChild, handlers: Handlers = {}): FakeChild {
  const original = child.stdin.write.bind(child.stdin);
  child.stdin.write = (data: string, cb?: (err?: Error) => void) => {
    original(data, cb);
    for (const line of data.split('\n')) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') {
        const reply = handlers.onInitialize ? handlers.onInitialize(msg) : initResult(msg.id);
        if (reply) queueMicrotask(() => respond(child, reply));
      } else if (msg.method === 'tools/call') {
        const reply = handlers.onToolsCall ? handlers.onToolsCall(msg) : toolResult(msg.id);
        if (reply) queueMicrotask(() => respond(child, reply));
      }
      // notifications/initialized deliberately gets no reply.
    }
    return true;
  };
  return child;
}

interface SpawnRecorder {
  spawn: typeof import('node:child_process').spawn;
  calls: number;
}

/** Hands out the given children in order, reusing the last one afterwards, and
 * counts spawns so "at most one retry" is observable rather than assumed. */
function spawnSequence(...children: Array<FakeChild | 'error'>): SpawnRecorder {
  const recorder: SpawnRecorder = { calls: 0, spawn: null as never };
  recorder.spawn = ((_cmd: string, _args: string[]) => {
    const entry = children[Math.min(recorder.calls, children.length - 1)]!;
    recorder.calls += 1;
    if (entry === 'error') {
      const dead = makeFakeChild();
      setTimeout(() => dead.emit('error', new Error('spawn ENOENT')), 0);
      return dead;
    }
    setTimeout(() => entry.emit('spawn'), 0);
    return entry;
  }) as unknown as typeof import('node:child_process').spawn;
  return recorder;
}

function methodsWritten(child: FakeChild): string[] {
  return child.stdin.writes.flatMap((chunk) =>
    chunk
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line).method as string),
  );
}

function toolCalls(child: FakeChild): number {
  return methodsWritten(child).filter((method) => method === 'tools/call').length;
}

const ARGV: () => Argv = () => ({ cmd: 'mempalace-mcp', args: ['--palace', '/palace'] });

function stdioDestroyed(child: FakeChild): boolean {
  return child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed;
}

function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface KillRecorder {
  signals: Array<{ pid: number; signal: string }>;
  processKill: (pid: number, signal: NodeJS.Signals) => void;
}

/** Records group signals instead of sending them. A fake child has a made-up
 * pid, so an uninjected kill would signal whatever real process group happens
 * to own that number on the machine running the suite. */
function killRecorder(onSignal?: (signal: string) => void): KillRecorder {
  const signals: Array<{ pid: number; signal: string }> = [];
  return {
    signals,
    processKill: (pid, signal) => {
      signals.push({ pid, signal });
      onSignal?.(signal);
    },
  };
}

// ---------------------------------------------------------------------------
// Handshake and framing
// ---------------------------------------------------------------------------

test('a tool call performs initialize, the initialized notification, then the call', async () => {
  const child = autoRespond(makeFakeChild());
  const client = createMcpClient(ARGV, '/cwd', { spawn: spawnSequence(child).spawn });

  assert.deepEqual(await client.callReadTool('mempalace_status', {}), { ok: true });
  assert.deepEqual(methodsWritten(child), ['initialize', 'notifications/initialized', 'tools/call']);
});

test('the handshake happens once and is reused by later calls', async () => {
  const child = autoRespond(makeFakeChild());
  const client = createMcpClient(ARGV, '/cwd', { spawn: spawnSequence(child).spawn });

  await client.callReadTool('mempalace_status', {});
  await client.callReadTool('mempalace_search', { query: 'x' });

  assert.equal(methodsWritten(child).filter((method) => method === 'initialize').length, 1);
});

test('an incompatible core stops after negotiation and reports one actionable diagnostic', async () => {
  const child = autoRespond(makeFakeChild(), {
    onInitialize: ({ id }) => ({
      ...(initResult(id) as object),
      result: {
        protocolVersion: '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'mempalace', version: '9.9.9' },
      },
    }),
  });
  const diagnostics: string[] = [];
  const kills = killRecorder();
  const client = createMcpClient(ARGV, '/cwd', {
    spawn: spawnSequence(child).spawn,
    onCompatibilityError: (message) => diagnostics.push(message),
    processKill: kills.processKill,
  });

  await assert.rejects(
    client.callReadTool('mempalace_status', {}),
    (error: unknown) => error instanceof IncompatibleCoreError &&
      /MemPalace 9\.9\.9/u.test(error.message) && /3\.6\.0 or 3\.7\.1/u.test(error.message),
  );
  assert.deepEqual(methodsWritten(child), ['initialize']);
  assert.equal(toolCalls(child), 0);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0]!, /No memory tool was dispatched/u);
  assert.doesNotMatch(diagnostics[0]!, /\/Users\/|\/home\//u);
  assert.equal(client.isAlive(), false, 'a rejected core must be discarded immediately');
  assert.ok(stdioDestroyed(child), 'a rejected core must not retain stdio handles');
  assert.deepEqual(kills.signals, [{ pid: -4321, signal: 'SIGTERM' }]);
});

test('an incompatible core version is bounded and sanitized before notification', async () => {
  const child = autoRespond(makeFakeChild(), {
    onInitialize: ({ id }) => ({
      ...(initResult(id) as object),
      result: {
        protocolVersion: '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'mempalace', version: `9.9.9\n${'x'.repeat(200)}` },
      },
    }),
  });
  const diagnostics: string[] = [];
  const client = createMcpClient(ARGV, '/cwd', {
    spawn: spawnSequence(child).spawn,
    onCompatibilityError: (message) => diagnostics.push(message),
  });

  await assert.rejects(client.callReadTool('mempalace_status', {}), (error: unknown) =>
    error instanceof IncompatibleCoreError && error.installedVersion === 'unrecognised');
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0]!, /MemPalace unrecognised/u);
  assert.doesNotMatch(diagnostics[0]!, /\n|x{33}/u);
});

test('a response split across two stdout chunks is still parsed', async () => {
  const child = makeFakeChild();
  const client = createMcpClient(ARGV, '/cwd', { spawn: spawnSequence(child).spawn });
  const pending = client.callReadTool('mempalace_status', {});

  await new Promise((resolve) => setTimeout(resolve, 5));
  const line = `${JSON.stringify(initResult(1))}\n`;
  child.stdout.emit('data', line.slice(0, 12));
  child.stdout.emit('data', line.slice(12));
  await new Promise((resolve) => setTimeout(resolve, 5));
  respond(child, toolResult(2));

  assert.deepEqual(await pending, { ok: true });
});

test('unparseable diagnostic output on stdout does not break the call', async () => {
  const child = makeFakeChild();
  const client = createMcpClient(ARGV, '/cwd', { spawn: spawnSequence(child).spawn });
  const pending = client.callReadTool('mempalace_status', {});

  await new Promise((resolve) => setTimeout(resolve, 5));
  child.stdout.emit('data', 'loading embedding model...\n');
  respond(child, initResult(1));
  await new Promise((resolve) => setTimeout(resolve, 5));
  respond(child, toolResult(2));

  assert.deepEqual(await pending, { ok: true });
});

test('non-JSON tool text is returned verbatim rather than discarded', async () => {
  const child = autoRespond(makeFakeChild(), {
    onToolsCall: (msg) => ({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'plain answer' }] } }),
  });
  const client = createMcpClient(ARGV, '/cwd', { spawn: spawnSequence(child).spawn });

  assert.equal(await client.callReadTool('mempalace_status', {}), 'plain answer');
});

// ---------------------------------------------------------------------------
// Cold start under concurrency: one child, one handshake
// ---------------------------------------------------------------------------

test('two cold calls share exactly one child and one handshake, and both resolve', async () => {
  const child = autoRespond(makeFakeChild(71));
  const spare = autoRespond(makeFakeChild(72));
  const spawns = spawnSequence(child, spare);
  const client = createMcpClient(ARGV, '/cwd', { spawn: spawns.spawn });

  const [status, search] = await Promise.all([
    client.callReadTool('mempalace_status', {}),
    client.callReadTool('mempalace_search', { query: 'x' }),
  ]);

  assert.deepEqual(status, { ok: true });
  assert.deepEqual(search, { ok: true });
  assert.equal(spawns.calls, 1, 'a concurrent cold start must not race two children into existence');
  assert.equal(
    methodsWritten(child).filter((method) => method === 'initialize').length,
    1,
    'the second caller must join the in-flight handshake, not start another',
  );
  assert.equal(toolCalls(child), 2, 'both calls belong to the one negotiated child');
  assert.equal(spare.stdin.writes.length, 0, 'no second child may be spawned and then orphaned');
});

test('a cold-start failure is shared by both callers and the next call starts fresh', async () => {
  const healthy = autoRespond(makeFakeChild(73));
  const spawns = spawnSequence('error', 'error', healthy);
  const client = createMcpClient(ARGV, '/cwd', { spawn: spawns.spawn });

  const results = await Promise.allSettled([
    client.callReadTool('mempalace_status', {}),
    client.callReadTool('mempalace_search', { query: 'x' }),
  ]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);

  // Two failed reads recover once each; a shared attempt must still leave the
  // client usable rather than latched onto a dead promise.
  assert.deepEqual(await client.callReadTool('mempalace_status', {}), { ok: true });
});

// ---------------------------------------------------------------------------
// Framing state belongs to one child only
// ---------------------------------------------------------------------------

test('a partial line left by a dead child is never prepended to the replacement response', async () => {
  const dead = makeFakeChild(81);
  const healthy = autoRespond(makeFakeChild(82));
  const spawns = spawnSequence(dead, healthy);
  const logs: string[] = [];
  const client = createMcpClient(ARGV, '/cwd', {
    spawn: spawns.spawn,
    requestTimeoutMs: 250,
    onLog: (message) => logs.push(message),
  });

  const pending = client.callReadTool('mempalace_status', {});
  await tick();
  // A truncated frame: the child died mid-line, so the newline never arrived.
  dead.stdout.emit('data', '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"vers');
  dead.exitCode = 1;
  dead.emit('exit', 1, null);

  assert.deepEqual(await pending, { ok: true });
  assert.equal(spawns.calls, 2);
  assert.deepEqual(
    logs.filter((message) => /unparseable/u.test(message)),
    [],
    "the replacement child's own frames must parse cleanly",
  );
});

test('newline-free stdout above the cap rejects pending work and discards the child', { timeout: 3_000 }, async () => {
  const child = autoRespond(makeFakeChild(91), { onToolsCall: () => null });
  const spawns = spawnSequence(child);
  const kills = killRecorder();
  const client = createMcpClient(ARGV, '/cwd', {
    spawn: spawns.spawn,
    maxStdoutBufferBytes: 1_024,
    // Far beyond the test budget: only the buffer cap can end this call.
    requestTimeoutMs: 60_000,
    processKill: kills.processKill,
  });

  const pending = client.callWriteTool('mempalace_add_drawer', { content: 'c' });
  await tick();
  for (let i = 0; i < 8; i += 1) child.stdout.emit('data', 'x'.repeat(512));

  await assert.rejects(pending, (err: Error) => {
    assert.ok(err instanceof UncertainWriteError, `expected UncertainWriteError, got ${err.constructor.name}`);
    assert.match(err.message, /1024|stdout/u);
    return true;
  });
  assert.ok(stdioDestroyed(child), 'a child flooding stdout must be released, not held open');
  assert.equal(spawns.calls, 1, 'an uncertain write never respawns to try again');
  assert.deepEqual(kills.signals, [{ pid: -91, signal: 'SIGTERM' }]);
});

test('stdout cap counts UTF-8 bytes rather than JavaScript code units', { timeout: 3_000 }, async () => {
  const child = autoRespond(makeFakeChild(93), { onToolsCall: () => null });
  const client = createMcpClient(ARGV, '/cwd', {
    spawn: spawnSequence(child).spawn,
    maxStdoutBufferBytes: 1_024,
    requestTimeoutMs: 60_000,
    processKill: killRecorder().processKill,
  });

  const pending = client.callWriteTool('mempalace_add_drawer', { content: 'c' });
  await tick();
  child.stdout.emit('data', '🙂'.repeat(300));

  await assert.rejects(pending, (error: Error) => {
    assert.ok(error instanceof UncertainWriteError);
    assert.match(error.message, /1024|stdout/u);
    return true;
  });
});

test('a bounded flood does not disturb a well-formed response', async () => {
  const child = autoRespond(makeFakeChild(92));
  const client = createMcpClient(ARGV, '/cwd', {
    spawn: spawnSequence(child).spawn,
    maxStdoutBufferBytes: 1_024,
  });

  await client.callReadTool('mempalace_status', {});
  // 900 chars of noise, then a newline: under the cap, so nothing is discarded.
  child.stdout.emit('data', `${'n'.repeat(900)}\n`);
  assert.deepEqual(await client.callReadTool('mempalace_search', { query: 'x' }), { ok: true });
});

// ---------------------------------------------------------------------------
// Reads: at most one recovery attempt
// ---------------------------------------------------------------------------

test('an interrupted read is retried exactly once and then succeeds', async () => {
  const dead = makeFakeChild(11);
  const healthy = autoRespond(makeFakeChild(12));
  const spawns = spawnSequence(dead, healthy);
  const client = createMcpClient(ARGV, '/cwd', { spawn: spawns.spawn });

  const pending = client.callReadTool('mempalace_status', {});
  await new Promise((resolve) => setTimeout(resolve, 5));
  dead.exitCode = 1;
  dead.emit('exit', 1, null);

  assert.deepEqual(await pending, { ok: true });
  assert.equal(spawns.calls, 2, 'exactly one recovery attempt');
  assert.equal(toolCalls(healthy), 1);
});

test('a read that fails twice surfaces one final error and is not retried again', async () => {
  const first = makeFakeChild(21);
  const second = makeFakeChild(22);
  const spawns = spawnSequence(first, second);
  const client = createMcpClient(ARGV, '/cwd', { spawn: spawns.spawn });

  const pending = client.callReadTool('mempalace_status', {});
  await new Promise((resolve) => setTimeout(resolve, 5));
  first.exitCode = 1;
  first.emit('exit', 1, null);
  await new Promise((resolve) => setTimeout(resolve, 5));
  second.exitCode = 1;
  second.emit('exit', 1, null);

  await assert.rejects(pending, /mempalace_status/);
  assert.equal(spawns.calls, 2, 'a read recovers at most once');
});

test('a read that cannot be launched at all reports one actionable failure', async () => {
  const spawns = spawnSequence('error');
  const client = createMcpClient(ARGV, '/cwd', { spawn: spawns.spawn });

  await assert.rejects(client.callReadTool('mempalace_status', {}), /mempalace-mcp/);
  assert.equal(spawns.calls, 2);
});

test('an inert launcher fails the read without spawning anything', async () => {
  const spawns = spawnSequence(makeFakeChild());
  const client = createMcpClient(() => null, '/cwd', { spawn: spawns.spawn });

  await assert.rejects(client.callReadTool('mempalace_status', {}), /launcher/);
  assert.equal(spawns.calls, 0);
});

test('a refusal answered by the server is surfaced verbatim and never retried', async () => {
  const child = autoRespond(makeFakeChild(), {
    onToolsCall: (msg) => ({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32001, message: 'Peer MCP writer active; this server is read-only for mutating tools' },
    }),
  });
  const spawns = spawnSequence(child);
  const client = createMcpClient(ARGV, '/cwd', { spawn: spawns.spawn });

  await assert.rejects(
    client.callReadTool('mempalace_search', {}),
    (err: Error) => err.message === 'Peer MCP writer active; this server is read-only for mutating tools',
  );
  assert.equal(spawns.calls, 1);
  assert.equal(toolCalls(child), 1);
});

test('a read that times out is not retried and the stuck child is released', async () => {
  const child = autoRespond(makeFakeChild(31), { onToolsCall: () => null });
  const spawns = spawnSequence(child);
  const client = createMcpClient(ARGV, '/cwd', {
    spawn: spawns.spawn,
    requestTimeoutMs: 20,
    processKill: killRecorder().processKill,
  });

  await assert.rejects(client.callReadTool('mempalace_status', {}), /timed out/);
  assert.equal(spawns.calls, 1, 'a timeout has an unknown outcome; it is not an interrupted read');
  assert.ok(stdioDestroyed(child), 'an unresponsive child must not keep pipes open');
});

// ---------------------------------------------------------------------------
// Writes: never repeated once dispatch may have happened
// ---------------------------------------------------------------------------

test('a write that times out reports an uncertain outcome and is never repeated', async () => {
  const child = autoRespond(makeFakeChild(41), { onToolsCall: () => null });
  const spawns = spawnSequence(child);
  const client = createMcpClient(ARGV, '/cwd', {
    spawn: spawns.spawn,
    requestTimeoutMs: 20,
    processKill: killRecorder().processKill,
  });

  await assert.rejects(client.callWriteTool('mempalace_add_drawer', { content: 'c' }), (err: Error) => {
    assert.ok(err instanceof UncertainWriteError, `expected UncertainWriteError, got ${err.constructor.name}`);
    assert.equal((err as UncertainWriteError).toolName, 'mempalace_add_drawer');
    return true;
  });
  assert.equal(toolCalls(child), 1, 'a dispatched write is written exactly once');
  assert.equal(spawns.calls, 1, 'an uncertain write never respawns to try again');
});

test('a child that dies mid-write reports an uncertain outcome instead of retrying', async () => {
  const child = autoRespond(makeFakeChild(42), { onToolsCall: () => null });
  const spawns = spawnSequence(child, autoRespond(makeFakeChild(43)));
  const client = createMcpClient(ARGV, '/cwd', { spawn: spawns.spawn });

  const pending = client.callWriteTool('mempalace_add_drawer', { content: 'c' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  child.exitCode = 1;
  child.emit('exit', 1, null);

  await assert.rejects(pending, (err: Error) => err instanceof UncertainWriteError);
  assert.equal(spawns.calls, 1, 'the write may already have reached storage; it must not be repeated');
});

test('a failed stdin write is uncertain, because the request may be partly on the wire', async () => {
  const child = autoRespond(makeFakeChild(44));
  const original = child.stdin.write.bind(child.stdin);
  child.stdin.write = (data: string, cb?: (err?: Error) => void) => {
    if (data.includes('tools/call')) {
      child.stdin.writes.push(data);
      cb?.(new Error('EPIPE'));
      return false;
    }
    return original(data, cb);
  };
  const client = createMcpClient(ARGV, '/cwd', { spawn: spawnSequence(child).spawn });

  await assert.rejects(
    client.callWriteTool('mempalace_add_drawer', { content: 'c' }),
    (err: Error) => err instanceof UncertainWriteError,
  );
  assert.equal(toolCalls(child), 1);
});

test('a write refused by the server is a definite outcome, not an uncertain one', async () => {
  const child = autoRespond(makeFakeChild(45), {
    onToolsCall: (msg) => ({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32001, message: 'Peer MCP writer active; this server is read-only for mutating tools' },
    }),
  });
  const spawns = spawnSequence(child);
  const client = createMcpClient(ARGV, '/cwd', { spawn: spawns.spawn });

  await assert.rejects(client.callWriteTool('mempalace_add_drawer', { content: 'c' }), (err: Error) => {
    assert.ok(!(err instanceof UncertainWriteError), 'the server answered; the write definitively did not happen');
    assert.equal(err.message, 'Peer MCP writer active; this server is read-only for mutating tools');
    return true;
  });
  assert.equal(toolCalls(child), 1);
});

test('a connection that fails before dispatch is reconnected once and the write proceeds', async () => {
  const healthy = autoRespond(makeFakeChild(47));
  const spawns = spawnSequence('error', healthy);
  const client = createMcpClient(ARGV, '/cwd', { spawn: spawns.spawn });

  assert.deepEqual(await client.callWriteTool('mempalace_add_drawer', { content: 'c' }), { ok: true });
  assert.equal(spawns.calls, 2, 'a connection failure happens before any byte of the write leaves');
  assert.equal(toolCalls(healthy), 1, 'the write is still dispatched exactly once');
});

test('a write that never reaches a server is a definite failure, not an uncertain write', async () => {
  const spawns = spawnSequence('error');
  const client = createMcpClient(ARGV, '/cwd', { spawn: spawns.spawn });

  await assert.rejects(client.callWriteTool('mempalace_add_drawer', { content: 'c' }), (err: Error) => {
    assert.ok(
      !(err instanceof UncertainWriteError),
      'a write that was never dispatched must stay retryable by the user',
    );
    return true;
  });
  assert.equal(spawns.calls, 2);
});

test('a failed handshake is retried once, because a write is not dispatched during it', async () => {
  const refusing = autoRespond(makeFakeChild(48), {
    onInitialize: (msg) => ({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'not ready' } }),
  });
  const healthy = autoRespond(makeFakeChild(49));
  const spawns = spawnSequence(refusing, healthy);
  const client = createMcpClient(ARGV, '/cwd', {
    spawn: spawns.spawn,
    processKill: killRecorder().processKill,
  });

  assert.deepEqual(await client.callWriteTool('mempalace_add_drawer', { content: 'c' }), { ok: true });
  assert.equal(toolCalls(refusing), 0, 'nothing was dispatched to the server that refused the handshake');
  assert.equal(toolCalls(healthy), 1);
});

test('an uncertain write names the tool and says the outcome is unknown', async () => {
  const child = autoRespond(makeFakeChild(50), { onToolsCall: () => null });
  const client = createMcpClient(ARGV, '/cwd', {
    spawn: spawnSequence(child).spawn,
    requestTimeoutMs: 20,
    processKill: killRecorder().processKill,
  });

  await assert.rejects(client.callWriteTool('mempalace_add_drawer', { content: 'c' }), (err: Error) => {
    assert.match(err.message, /mempalace_add_drawer/);
    assert.match(err.message, /may have|unknown|uncertain/i);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

test('shutdown signals the whole process group and releases the pipes', async () => {
  const child = autoRespond(makeFakeChild(61));
  const signals: Array<{ pid: number; signal: string }> = [];
  const client = createMcpClient(ARGV, '/cwd', {
    spawn: spawnSequence(child).spawn,
    processKill: (pid, signal) => {
      signals.push({ pid, signal });
      if (signal === 'SIGTERM') {
        child.exitCode = 0;
        queueMicrotask(() => child.emit('exit', 0, null));
      }
    },
  });

  await client.callReadTool('mempalace_status', {});
  await client.shutdown();

  assert.deepEqual(signals, [{ pid: -61, signal: 'SIGTERM' }], 'a negative pid signals the whole group');
  assert.ok(stdioDestroyed(child), 'no owned handle may outlive shutdown');
  assert.equal(client.isAlive(), false);
});

test('shutdown escalates to SIGKILL when the group ignores SIGTERM', async () => {
  const child = autoRespond(makeFakeChild(62));
  const signals: string[] = [];
  const client = createMcpClient(ARGV, '/cwd', {
    spawn: spawnSequence(child).spawn,
    shutdownGraceMs: 20,
    processKill: (_pid, signal) => {
      signals.push(signal);
      if (signal === 'SIGKILL') {
        child.exitCode = null;
        child.signalCode = 'SIGKILL';
        queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
      }
    },
  });

  await client.callReadTool('mempalace_status', {});
  await client.shutdown();

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(stdioDestroyed(child));
});

test('shutdown is terminal even when no child has started', async () => {
  const child = autoRespond(makeFakeChild(63));
  const spawns = spawnSequence(child);
  const client = createMcpClient(ARGV, '/cwd', { spawn: spawns.spawn });

  await client.shutdown();
  await assert.rejects(client.callReadTool('mempalace_status', {}), /shut(?:ting)? down/u);
  assert.equal(spawns.calls, 0, 'a closed client must never spawn');
});

test('shutdown rejects an in-flight read without recovery spawning a new child', async () => {
  const child = autoRespond(makeFakeChild(64), { onToolsCall: () => null });
  const replacement = autoRespond(makeFakeChild(65));
  const spawns = spawnSequence(child, replacement);
  const client = createMcpClient(ARGV, '/cwd', {
    spawn: spawns.spawn,
    processKill: () => {
      child.exitCode = 0;
      queueMicrotask(() => child.emit('exit', 0, null));
    },
  });

  const pending = client.callReadTool('mempalace_status', {});
  await tick();
  const closing = client.shutdown();

  await assert.rejects(pending, /shutting down/u);
  await closing;
  assert.equal(spawns.calls, 1, 'shutdown must not be interpreted as a recoverable connection loss');
  assert.equal(client.isAlive(), false);
});

// ---------------------------------------------------------------------------
// Discarding an unusable child
// ---------------------------------------------------------------------------

test('a discarded child that ignores SIGTERM is escalated to SIGKILL within the grace budget', async () => {
  const child = autoRespond(makeFakeChild(101), { onToolsCall: () => null });
  const kills = killRecorder();
  const client = createMcpClient(ARGV, '/cwd', {
    spawn: spawnSequence(child).spawn,
    requestTimeoutMs: 20,
    shutdownGraceMs: 30,
    processKill: kills.processKill,
  });

  await assert.rejects(client.callReadTool('mempalace_status', {}), /timed out/u);
  assert.deepEqual(kills.signals, [{ pid: -101, signal: 'SIGTERM' }], 'a discard starts polite');
  assert.ok(stdioDestroyed(child), 'our pipe ends are released immediately, not after the grace');

  await tick(120);
  assert.deepEqual(
    kills.signals,
    [{ pid: -101, signal: 'SIGTERM' }, { pid: -101, signal: 'SIGKILL' }],
    'a group that ignores SIGTERM must be killed, not left running',
  );
});

test('a discarded child that exits on SIGTERM is never escalated', async () => {
  const child = autoRespond(makeFakeChild(102), { onToolsCall: () => null });
  const kills = killRecorder((signal) => {
    if (signal === 'SIGTERM') {
      child.exitCode = 0;
      queueMicrotask(() => child.emit('exit', 0, null));
    }
  });
  const client = createMcpClient(ARGV, '/cwd', {
    spawn: spawnSequence(child).spawn,
    requestTimeoutMs: 20,
    shutdownGraceMs: 30,
    processKill: kills.processKill,
  });

  await assert.rejects(client.callReadTool('mempalace_status', {}), /timed out/u);
  await tick(120);
  assert.deepEqual(kills.signals, [{ pid: -102, signal: 'SIGTERM' }]);
});

test('shutdown finishes the escalation of a child discarded earlier', async () => {
  const child = autoRespond(makeFakeChild(103), { onToolsCall: () => null });
  const kills = killRecorder();
  const client = createMcpClient(ARGV, '/cwd', {
    spawn: spawnSequence(child).spawn,
    requestTimeoutMs: 20,
    shutdownGraceMs: 60_000,
    processKill: kills.processKill,
  });

  await assert.rejects(client.callReadTool('mempalace_status', {}), /timed out/u);
  const started = Date.now();
  await client.shutdown();

  assert.ok(Date.now() - started < 5_000, 'shutdown must not wait on a discarded child');
  assert.deepEqual(kills.signals, [{ pid: -103, signal: 'SIGTERM' }, { pid: -103, signal: 'SIGKILL' }]);
});

test('the shutdown budget stays inside the five-second release requirement', () => {
  assert.ok(SHUTDOWN_GRACE_MS + 1_000 < 5_000, 'SIGTERM grace plus the kill backstop must fit in 5s');
  assert.ok(REQUEST_TIMEOUT_MS > 0);
});
