import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import test from 'node:test';

import type { Launcher } from '../../integration/resolve.ts';
import { createHub, HubUnavailableError, serverInfoPath, type HubRegistration } from '../../integration/hub.ts';

const launcher: Launcher = {
  mode: 'path',
  mempalaceMcpBin: '/opt/mempalace-mcp',
  mempalaceBin: '/opt/mempalace',
};

const palacePath = '/tmp/palace-one';

test('Hub discovery uses the upstream per-palace server registry path', () => {
  assert.equal(
    serverInfoPath('/palace-one', '/tmp/mempalace-home'),
    '/tmp/mempalace-home/.mempalace/server/78c34b7fa5ad9f3c713d318c/serverinfo.json',
  );
});

function registration(overrides: Partial<HubRegistration> = {}): HubRegistration {
  return {
    pid: 1234,
    host: '127.0.0.1',
    port: 43123,
    scheme: 'http',
    read_only: false,
    palace_path: palacePath,
    ...overrides,
  };
}

test('a healthy writable registration is reused without starting a Hub', async () => {
  let spawns = 0;
  const hub = createHub({
    launcher,
    palacePath,
    deps: {
      readRegistration: () => registration(),
      isPidAlive: () => true,
      health: async () => true,
      spawn: () => {
        spawns += 1;
        throw new Error('must not spawn');
      },
    },
  });

  const found = await hub.ensureHub();

  assert.deepEqual(found, registration());
  assert.equal(spawns, 0);
});

test('missing launcher argv fails closed with HubUnavailableError', async () => {
  const hub = createHub({ launcher: { mode: 'inert' }, palacePath, deps: { homeDir: '/tmp/mempalace-home' } });

  await assert.rejects(
    hub.ensureHub(),
    (error: unknown) => error instanceof HubUnavailableError && /no matching MemPalace MCP executable/u.test(error.message),
  );
});

test('Hub spawn failures fail closed with HubUnavailableError', async () => {
  const hub = createHub({
    launcher,
    palacePath,
    deps: {
      readRegistration: () => null,
      isPidAlive: () => false,
      health: async () => false,
      spawn: () => { throw new Error('spawn denied'); },
    },
  });

  await assert.rejects(
    hub.ensureHub(),
    (error: unknown) => error instanceof HubUnavailableError && /Hub start failed: spawn denied/u.test(error.message),
  );
});

test('Hub startup timeout fails closed with HubUnavailableError', async () => {
  const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  const hub = createHub({
    launcher,
    palacePath,
    deps: {
      readRegistration: () => null,
      isPidAlive: () => false,
      health: async () => false,
      spawn: () => ({ pid: 4321, unref: () => {} }),
      sleep,
      pollIntervalMs: 1,
      startTimeoutMs: 2,
    },
  });

  await assert.rejects(
    hub.ensureHub(),
    (error: unknown) => error instanceof HubUnavailableError && /did not become ready/u.test(error.message),
  );
});

test('the real health probe dispatches a request before reusing a registration', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const expected = registration({ port: address.port });
    const hub = createHub({
      launcher,
      palacePath,
      deps: {
        readRegistration: () => expected,
        isPidAlive: () => true,
        spawn: () => { throw new Error('must not spawn'); },
      },
    });

    const result = await Promise.race([
      hub.ensureHub(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);

    assert.deepEqual(result, expected);
    assert.equal(requests, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('a streaming 200 health response is bounded by wall-clock time', async () => {
  const sockets = new Set<Socket>();
  const intervals = new Set<ReturnType<typeof setInterval>>();
  let responseCloses = 0;
  let responseClosed!: () => void;
  const responseClosedPromise = new Promise<void>((resolve) => { responseClosed = resolve; });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('ok');
    const interval = setInterval(() => response.write(' '), 25);
    intervals.add(interval);
    response.once('close', () => {
      responseCloses += 1;
      responseClosed();
      clearInterval(interval);
      intervals.delete(interval);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  let pending: Promise<HubRegistration> | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const expected = registration({ port: address.port });
    const hub = createHub({
      launcher,
      palacePath,
      deps: {
        readRegistration: () => expected,
        isPidAlive: () => true,
        spawn: () => { throw new Error('must not spawn'); },
      },
    });
    pending = hub.ensureHub();
    const startedAt = Date.now();
    const timeout = Symbol('timeout');
    const result = await Promise.race([
      pending.then(() => 'settled', () => 'settled'),
      new Promise<typeof timeout>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(timeout), 5_000);
      }),
    ]);

    assert.notEqual(result, timeout, 'streaming health response remained unresolved');
    assert.ok(Date.now() - startedAt < 3_000, 'health probe exceeded its wall-clock bound');
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    for (const interval of intervals) clearInterval(interval);
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await responseClosedPromise;
  }
  assert.equal(responseCloses, 1);
});

test('a missing Hub is started with the detached loopback HTTP argv', async () => {
  let current: HubRegistration | null = null;
  let spawnOptions: unknown;
  let unrefs = 0;
  const hub = createHub({
    launcher,
    palacePath,
    deps: {
      readRegistration: () => current,
      isPidAlive: () => true,
      health: async () => true,
      pollIntervalMs: 1,
      startTimeoutMs: 100,
      spawn: (cmd, args, options) => {
        assert.equal(cmd, launcher.mempalaceMcpBin);
        assert.deepEqual(args, [
          '--transport', 'http', '--host', '127.0.0.1', '--port', '0', '--palace', palacePath,
        ]);
        spawnOptions = options;
        current = registration({ pid: 5678, port: 43210 });
        return { pid: 5678, unref: () => { unrefs += 1; } };
      },
    },
  });

  const found = await hub.ensureHub();

  assert.equal(found.pid, 5678);
  assert.deepEqual(spawnOptions, { detached: true, stdio: 'ignore' });
  assert.equal(unrefs, 1);
});

test('dead, stale, malformed, and read-only registrations are replaced by one writable Hub', async () => {
  const cases: Array<{ name: string; initial: unknown; alive: (pid: number) => boolean; healthy: (info: HubRegistration) => Promise<boolean> }> = [
    { name: 'dead', initial: registration({ pid: 1 }), alive: (pid) => pid !== 1, healthy: async () => true },
    { name: 'stale', initial: registration(), alive: () => true, healthy: async (info) => info.pid !== 1234 },
    { name: 'malformed', initial: { pid: 'not-a-pid' }, alive: () => true, healthy: async () => true },
    { name: 'read-only', initial: registration({ read_only: true }), alive: () => true, healthy: async () => true },
  ];

  for (const item of cases) {
    let current: unknown = item.initial;
    let spawns = 0;
    const hub = createHub({
      launcher,
      palacePath,
      deps: {
        readRegistration: () => current,
        isPidAlive: item.alive,
        health: item.healthy,
        pollIntervalMs: 1,
        startTimeoutMs: 100,
        spawn: () => {
          spawns += 1;
          current = registration({ pid: 9000 + spawns });
          return { pid: 9000 + spawns, unref: () => {} };
        },
      },
    });

    const found = await hub.ensureHub();

    assert.equal(found.read_only, false, item.name);
    assert.equal(spawns, 1, item.name);
  }
});

test('wildcard registrations are replaced rather than reused', async () => {
  for (const host of ['0.0.0.0', '::', '[::]']) {
    let current: unknown = registration({ host });
    let spawns = 0;
    const hub = createHub({
      launcher,
      palacePath,
      deps: {
        readRegistration: () => current,
        isPidAlive: () => true,
        health: async () => true,
        pollIntervalMs: 1,
        startTimeoutMs: 100,
        spawn: () => {
          spawns += 1;
          current = registration({ pid: 9000 + spawns });
          return { pid: 9000 + spawns, unref: () => {} };
        },
      },
    });

    const found = await hub.ensureHub();

    assert.equal(found.host, '127.0.0.1', host);
    assert.equal(spawns, 1, host);
  }
});

test('concurrent cold callers share a start attempt without a JavaScript lock', async () => {
  let current: HubRegistration | null = null;
  let spawns = 0;
  const hub = createHub({
    launcher,
    palacePath,
    deps: {
      readRegistration: () => current,
      isPidAlive: () => true,
      health: async () => true,
      pollIntervalMs: 1,
      startTimeoutMs: 100,
      spawn: () => {
        spawns += 1;
        current = registration({ pid: 7000 });
        return { pid: 7000, unref: () => {} };
      },
    },
  });

  const [first, second] = await Promise.all([hub.ensureHub(), hub.ensureHub()]);

  assert.equal(first.pid, second.pid);
  assert.equal(spawns, 1);
});

test('separate palace runtimes start independent Hub registrations', async () => {
  const started: string[] = [];
  const makeHub = (path: string) => {
    let current: HubRegistration | null = null;
    return createHub({
      launcher,
      palacePath: path,
      deps: {
        readRegistration: () => current,
        isPidAlive: () => true,
        health: async () => true,
        pollIntervalMs: 1,
        startTimeoutMs: 100,
        spawn: (_cmd, args) => {
          started.push(args[args.length - 1]!);
          current = registration({ palace_path: path, pid: 8000 + started.length });
          return { pid: 8000 + started.length, unref: () => {} };
        },
      },
    });
  };

  await Promise.all([makeHub('/tmp/palace-a').ensureHub(), makeHub('/tmp/palace-b').ensureHub()]);

  assert.deepEqual(started.sort(), ['/tmp/palace-a', '/tmp/palace-b']);
});
