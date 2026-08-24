import assert from 'node:assert/strict';
import test from 'node:test';

import { IncompatibleCoreError, type McpClient } from '../../integration/mcp-client.ts';
import { createLifecycle } from '../../integration/lifecycle.ts';
import type { Launcher, PalaceResolution } from '../../integration/resolve.ts';

const launcher: Launcher = { mode: 'path', mempalaceMcpBin: '/test/mempalace-mcp' };
const palace: PalaceResolution = {
  palacePath: '/test/palace',
  source: 'identity',
  identity: { project: 'demo', digest: '0123456789abcdef', source: 'path' },
};

function client(overrides: Partial<McpClient> = {}): McpClient {
  return {
    callReadTool: async () => null,
    callWriteTool: async () => null,
    shutdown: async () => {},
    isAlive: () => false,
    ...overrides,
  };
}

// Recall is opt-in. A project that never asks for it must produce exactly the
// bytes it produced before recall existed, and must not reach the core between
// turns at all.
test('recall stays off by default, leaving the turn byte-identical and read-free', async () => {
  let recalls = 0;
  const lifecycle = createLifecycle({
    enabled: true,
    launcher,
    palace,
    cwd: '/test/project',
    createClient: () => client(),
    capture: async () => 'SNAPSHOT',
    captureRecall: async () => {
      recalls += 1;
      return 'RECALL';
    },
  });

  await lifecycle.sessionStart();
  const turn = await lifecycle.beforeAgentStart('SYSTEM', 'why did we rename?');

  assert.equal(turn?.systemPrompt, 'SYSTEM\n\nSNAPSHOT');
  assert.equal(recalls, 0);
});

// The stable snapshot has to stay ahead of the prompt-dependent block: every
// byte before the first difference is what a provider can still cache.
test('enabled recall appends this turn\'s hits after the stable snapshot', async () => {
  const seen: Array<{ prompt: string; project: string }> = [];
  const lifecycle = createLifecycle({
    enabled: true,
    launcher,
    palace,
    cwd: '/test/project',
    recall: true,
    createClient: () => client(),
    capture: async () => 'SNAPSHOT',
    captureRecall: async (_client, options) => {
      seen.push({ prompt: options.prompt, project: options.project });
      return `RECALL(${options.prompt})`;
    },
  });

  await lifecycle.sessionStart();
  const first = await lifecycle.beforeAgentStart('SYSTEM', 'why did we rename?');
  const second = await lifecycle.beforeAgentStart('SYSTEM', 'and what about npm?');

  assert.equal(first?.systemPrompt, 'SYSTEM\n\nSNAPSHOT\n\nRECALL(why did we rename?)');
  assert.equal(second?.systemPrompt, 'SYSTEM\n\nSNAPSHOT\n\nRECALL(and what about npm?)');
  assert.deepEqual(seen, [
    { prompt: 'why did we rename?', project: 'demo' },
    { prompt: 'and what about npm?', project: 'demo' },
  ]);
});

test('a turn whose recall finds nothing keeps exactly the snapshot', async () => {
  const lifecycle = createLifecycle({
    enabled: true,
    launcher,
    palace,
    cwd: '/test/project',
    recall: true,
    createClient: () => client(),
    capture: async () => 'SNAPSHOT',
    captureRecall: async () => undefined,
  });

  await lifecycle.sessionStart();
  assert.equal((await lifecycle.beforeAgentStart('SYSTEM', 'anything'))?.systemPrompt, 'SYSTEM\n\nSNAPSHOT');
});

// A palace that never answered the wake-up is not worth re-asking every turn.
test('recall is skipped entirely when the session never captured a snapshot', async () => {
  let recalls = 0;
  const lifecycle = createLifecycle({
    enabled: true,
    launcher,
    palace,
    cwd: '/test/project',
    recall: true,
    createClient: () => client(),
    capture: async () => { throw new Error('palace down'); },
    captureRecall: async () => {
      recalls += 1;
      return 'RECALL';
    },
    onWarning: () => {},
  });

  await lifecycle.sessionStart();
  assert.equal(await lifecycle.beforeAgentStart('SYSTEM', 'anything'), undefined);
  assert.equal(recalls, 0);
});

test('active lifecycle captures exactly once across concurrent start and reload, then reuses identical bytes', async () => {
  let captures = 0;
  let releasesCapture!: () => void;
  const held = new Promise<void>((resolve) => {
    releasesCapture = resolve;
  });
  const lifecycle = createLifecycle({
    enabled: true,
    launcher,
    palace,
    cwd: '/test/project',
    createClient: () => client(),
    capture: async () => {
      captures += 1;
      await held;
      return '<mempalace-wakeup trust="untrusted-data" encoding="json">\n{"data":"first"}\n</mempalace-wakeup>';
    },
  });

  const start = lifecycle.sessionStart();
  const reload = lifecycle.sessionStart();
  assert.equal(captures, 1, 'reload must join the in-flight capture');
  releasesCapture();
  await Promise.all([start, reload]);
  await lifecycle.sessionStart();
  assert.equal(captures, 1);

  const first = await lifecycle.beforeAgentStart('SYSTEM');
  const later = await lifecycle.beforeAgentStart('SYSTEM');
  assert.deepEqual(later, first);
  assert.equal(first?.systemPrompt, 'SYSTEM\n\n<mempalace-wakeup trust="untrusted-data" encoding="json">\n{"data":"first"}\n</mempalace-wakeup>');
  assert.equal(lifecycle.status().state, 'operational');
});

test('disabled lifecycle is fully inert and does not construct a client or start capture work', async () => {
  let clients = 0;
  let captures = 0;
  const lifecycle = createLifecycle({
    enabled: false,
    launcher,
    palace,
    cwd: '/test/project',
    createClient: () => {
      clients += 1;
      return client();
    },
    capture: async () => {
      captures += 1;
      return 'unexpected';
    },
  });

  await lifecycle.sessionStart();
  assert.equal(clients, 0);
  assert.equal(captures, 0);
  assert.equal(await lifecycle.beforeAgentStart('SYSTEM'), undefined);
  assert.deepEqual(lifecycle.status(), { state: 'disabled', project: 'demo' });
});

test('unavailable launcher is inert and creates no process or background work', async () => {
  let clients = 0;
  const lifecycle = createLifecycle({
    enabled: true,
    launcher: { mode: 'inert' },
    palace,
    cwd: '/test/project',
    createClient: () => {
      clients += 1;
      return client();
    },
  });

  await lifecycle.sessionStart();
  assert.equal(clients, 0);
  assert.equal(lifecycle.status().state, 'inert');
});

test('every lifecycle handler contains capture and shutdown failures', async () => {
  const warnings: string[] = [];
  const lifecycle = createLifecycle({
    enabled: true,
    launcher,
    palace,
    cwd: '/test/project',
    createClient: () => client({ shutdown: async () => { throw new Error('shutdown failed'); } }),
    capture: async () => { throw new Error('read failed'); },
    onWarning: (message) => {
      warnings.push(message);
      throw new Error('broken notifier');
    },
  });

  await assert.doesNotReject(lifecycle.sessionStart());
  await assert.doesNotReject(() => lifecycle.beforeAgentStart('SYSTEM'));
  await assert.doesNotReject(lifecycle.shutdown());
  assert.equal(lifecycle.status().state, 'degraded');
  assert.equal(warnings.length, 1);
});

test('an incompatible core is represented explicitly with one exact actionable warning', async () => {
  const warnings: string[] = [];
  const lifecycle = createLifecycle({
    enabled: true,
    launcher,
    palace,
    cwd: '/test/project',
    createClient: () => client(),
    capture: async () => { throw new IncompatibleCoreError('9.9.9'); },
    onWarning: (message) => warnings.push(message),
  });

  await lifecycle.sessionStart();
  assert.equal(lifecycle.status().state, 'incompatible');
  assert.deepEqual(warnings, [
    'Incompatible MemPalace 9.9.9; install MemPalace 3.6.0 or 3.7.1. No memory tool was dispatched.',
  ]);
});

test('shutdown owns the lazily created MCP client and completes within five seconds', async () => {
  let shutdowns = 0;
  const lifecycle = createLifecycle({
    enabled: true,
    launcher,
    palace,
    cwd: '/test/project',
    createClient: () => client({ shutdown: async () => { shutdowns += 1; } }),
    capture: async () => '',
  });

  assert.equal(shutdowns, 0);
  await lifecycle.sessionStart();
  const started = Date.now();
  await lifecycle.shutdown();
  assert.equal(shutdowns, 1);
  assert.ok(Date.now() - started < 5000);
  assert.equal(lifecycle.status().state, 'closed');
  await lifecycle.shutdown();
  assert.equal(shutdowns, 1, 'shutdown is idempotent');
});

test('shutdown during capture cannot resurrect the lifecycle or publish late memory', async () => {
  let releaseCapture!: (snapshot: string) => void;
  const heldCapture = new Promise<string>((resolve) => {
    releaseCapture = resolve;
  });
  const lifecycle = createLifecycle({
    enabled: true,
    launcher,
    palace,
    cwd: '/test/project',
    createClient: () => client(),
    capture: () => heldCapture,
  });

  const starting = lifecycle.sessionStart();
  await lifecycle.shutdown();
  releaseCapture('late snapshot');
  await starting;

  assert.equal(lifecycle.status().state, 'closed');
  assert.equal(await lifecycle.beforeAgentStart('SYSTEM'), undefined);
});
