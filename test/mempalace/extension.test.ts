import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';

import { createExtension } from '../../integration/extension.ts';
import type { McpClient } from '../../integration/mcp-client.ts';
import type { Launcher, PalaceResolution } from '../../integration/resolve.ts';

type Handler = (event: any, context: any) => unknown;
type AnyTool = ToolDefinition<any, any, any>;
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const registered: AnyTool[] = [];
  const tools: string[] = [];
  const commands: string[] = [];
  const pi = {
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool: AnyTool) { registered.push(tool); tools.push(tool.name); },
    registerCommand(name: string) { commands.push(name); },
  } as unknown as ExtensionAPI;
  return { pi, handlers, registered, tools, commands };
}
function fakeClient(): McpClient {
  return {
    callReadTool: async () => ({}), callWriteTool: async () => ({}),
    shutdown: async () => {}, isAlive: () => false,
  };
}
const launcher: Launcher = { mode: 'path', mempalaceMcpBin: '/test/mempalace-mcp' };
const palace: PalaceResolution = {
  palacePath: '/test/palace', source: 'identity',
  identity: { project: 'demo', digest: '0123456789abcdef', source: 'path' },
};
const active = {
  env: {}, cwd: '/repo',
  resolveLauncher: () => launcher,
  resolvePalace: () => palace,
  createMcpClient: () => fakeClient(),
  captureWakeUp: async () => '',
};

const scratchDirs: string[] = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** A real project directory, optionally carrying one project document. */
function projectDir(document?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mempalace-extension-'));
  scratchDirs.push(dir);
  if (document !== undefined) {
    mkdirSync(join(dir, '.pi'), { recursive: true });
    writeFileSync(join(dir, '.pi', 'mempalace.json'), document);
  }
  return dir;
}

interface FakeContext {
  cwd: string;
  ui: { notify: (message: string) => void };
  isProjectTrusted?: () => boolean;
}
function hostContext(options: {
  notices?: string[];
  trusted?: boolean;
  cwd?: string;
  trustCalls?: { count: number };
} = {}): FakeContext {
  const notices = options.notices ?? [];
  const context: FakeContext = {
    cwd: options.cwd ?? '/repo',
    ui: { notify: (message: string) => notices.push(message) },
  };
  if (options.trusted !== undefined) {
    context.isProjectTrusted = () => {
      if (options.trustCalls) options.trustCalls.count += 1;
      return options.trusted!;
    };
  }
  return context;
}

async function sessionStart(host: ReturnType<typeof fakePi>, context: FakeContext): Promise<void> {
  await host.handlers.get('session_start')![0]!({}, context);
}
async function execute(tool: AnyTool, parameters: unknown) {
  return tool.execute('call-1', parameters, undefined, undefined, {} as never);
}
const EAGER_EVENTS = [
  'before_agent_start', 'session_before_compact', 'session_shutdown', 'session_start',
];

test('disabled extension is silent and process-free', () => {
  const host = fakePi();
  let clients = 0;
  const handle = createExtension(host.pi, {
    ...active, enabled: false,
    createMcpClient: () => { clients += 1; return fakeClient(); },
  });
  assert.equal(handle.active, false);
  assert.equal(handle.reason, 'disabled');
  assert.equal(clients, 0);
  assert.equal(host.handlers.size, 0);
  assert.deepEqual(host.tools, []);
});

test('missing core stays process-free and emits one actionable explanation when context exists', async () => {
  const host = fakePi();
  let clients = 0;
  const notices: string[] = [];
  const handle = createExtension(host.pi, {
    ...active, resolveLauncher: () => ({ mode: 'inert' }),
    createMcpClient: () => { clients += 1; return fakeClient(); },
  });
  assert.deepEqual([...host.handlers.keys()].sort(), EAGER_EVENTS);
  const context = hostContext({ notices, trusted: true });
  await sessionStart(host, context);
  await sessionStart(host, context);
  assert.equal(handle.active, false);
  assert.equal(handle.reason, 'inert');
  assert.equal(clients, 0);
  assert.deepEqual(host.tools, []);
  assert.deepEqual(host.commands, []);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /Install MemPalace 3\.6\.0 or 3\.7\.1/u);
  assert.doesNotMatch(notices[0]!, /\/Users\/|\/home\//u);
});

test('palace resolution failure is inert with one actionable path-free notice', async () => {
  const host = fakePi();
  const notices: string[] = [];
  const handle = createExtension(host.pi, {
    ...active,
    resolvePalace: () => { throw new Error('/private/palace denied'); },
  });
  const context = hostContext({ notices, trusted: true });
  await sessionStart(host, context);
  await sessionStart(host, context);
  assert.equal(handle.active, false);
  assert.deepEqual(host.tools, []);
  assert.deepEqual(notices, [
    'MemPalace palace selection failed. Check MEMPALACE_PALACE and project access, then restart Pi.',
  ]);
  assert.doesNotMatch(notices[0]!, /\/private\/|\/Users\/|\/home\//u);
});

test('healthy-core wake-up warning is forwarded and deduplicated by message class', async () => {
  const host = fakePi();
  const notices: string[] = [];
  createExtension(host.pi, {
    ...active,
    captureWakeUp: async () => { throw new Error('capture failed'); },
  });
  const context = hostContext({ notices, trusted: true });
  await sessionStart(host, context);
  await sessionStart(host, context);
  assert.deepEqual(notices, ['MemPalace wake-up unavailable; continuing without recalled memory.']);
});

test('tools and client appear only at session start, exactly once across repeated starts', async () => {
  const host = fakePi();
  let clients = 0;
  const handle = createExtension(host.pi, {
    ...active,
    createMcpClient: () => { clients += 1; return fakeClient(); },
  });
  assert.equal(handle.active, false);
  assert.equal(handle.reason, 'pending');
  assert.deepEqual(host.tools, []);
  assert.equal(clients, 0);
  assert.deepEqual([...host.handlers.keys()].sort(), EAGER_EVENTS);
  for (const name of EAGER_EVENTS) assert.equal(host.handlers.get(name)?.length, 1);

  const context = hostContext({ trusted: true });
  await sessionStart(host, context);
  await sessionStart(host, context);
  await sessionStart(host, context);
  assert.equal(handle.active, true);
  assert.equal(handle.reason, undefined);
  assert.equal(clients, 1);
  assert.deepEqual(host.tools.sort(), ['palace_diary', 'palace_save', 'palace_search', 'palace_status']);
  assert.deepEqual(host.commands, []);
});

test('event wrappers registered before initialization are harmless no-ops', async () => {
  const host = fakePi();
  let clients = 0;
  const handle = createExtension(host.pi, {
    ...active, handoff: true,
    createMcpClient: () => { clients += 1; return fakeClient(); },
  });
  const context = hostContext({ trusted: true });
  assert.equal(await host.handlers.get('before_agent_start')![0]!({ systemPrompt: 'base' }, context), undefined);
  await host.handlers.get('session_before_compact')![0]!(
    { branchEntries: [], reason: 'manual', willRetry: false }, context,
  );
  await host.handlers.get('session_shutdown')![0]!({}, context);
  assert.equal(clients, 0);
  assert.deepEqual(host.tools, []);
  assert.equal(handle.active, false);
});

test('untrusted context never reads the project document', async () => {
  const cwd = projectDir('{"version": 99, "surprise": true}');
  const host = fakePi();
  const notices: string[] = [];
  const trustCalls = { count: 0 };
  const handle = createExtension(host.pi, { ...active, cwd });
  await sessionStart(host, hostContext({ notices, trusted: false, cwd, trustCalls }));
  assert.equal(trustCalls.count, 1, 'trust must be consulted before any project read');
  assert.equal(handle.active, true, 'an untrusted project falls back to environment and defaults');
  assert.deepEqual(notices, [], 'an unread document cannot produce a validation notice');
  assert.equal(host.tools.length, 4);
});

test('a context without a trust decision is treated as untrusted', async () => {
  const cwd = projectDir('{"version": 99}');
  const host = fakePi();
  const notices: string[] = [];
  const handle = createExtension(host.pi, { ...active, cwd });
  await sessionStart(host, hostContext({ notices, cwd }));
  assert.equal(handle.active, true);
  assert.deepEqual(notices, []);
});

test('trusted session start consumes the validated project document', async () => {
  const document = { version: 1, readOnly: true, handoff: true };
  const cwd = projectDir(JSON.stringify(document));
  const host = fakePi();
  let writes = 0;
  let seenConfig: unknown = 'never-called';
  createExtension(host.pi, {
    ...active, cwd,
    resolvePalace: (_env, _cwd, deps) => { seenConfig = deps?.config; return palace; },
    createMcpClient: () => ({ ...fakeClient(), callWriteTool: async () => { writes += 1; return {}; } }),
  });
  await sessionStart(host, hostContext({ trusted: true, cwd }));
  assert.deepEqual(seenConfig, document, 'the validated document must reach palace resolution');

  const save = host.registered.find(({ name }) => name === 'palace_save')!;
  await assert.rejects(
    execute(save, { content: 'a finding', wing: 'backend', room: 'decisions' }),
    /read-only/iu,
    'a declared readOnly must reach the shared write gate',
  );
  assert.equal(writes, 0);
});

test('a project document declaring handoff arms the eagerly registered compact wrapper', async () => {
  const enabledCwd = projectDir(JSON.stringify({ version: 1, handoff: true }));
  const defaultCwd = projectDir(JSON.stringify({ version: 1 }));
  const compact = { branchEntries: [], reason: 'manual', willRetry: false };

  const counts: number[] = [];
  for (const cwd of [defaultCwd, enabledCwd]) {
    const host = fakePi();
    let writes = 0;
    createExtension(host.pi, {
      ...active, cwd,
      createMcpClient: () => ({ ...fakeClient(), callWriteTool: async () => { writes += 1; return {}; } }),
    });
    await sessionStart(host, hostContext({ trusted: true, cwd }));
    await host.handlers.get('session_before_compact')![0]!(compact, hostContext({ trusted: true, cwd }));
    counts.push(writes);
  }
  assert.deepEqual(counts, [0, 1], 'handoff must stay opt-in and must honour the project document');
});

test('a project document declaring disabled yields zero tools, clients and notices', async () => {
  const cwd = projectDir(JSON.stringify({ version: 1, disabled: true }));
  const host = fakePi();
  let clients = 0;
  const notices: string[] = [];
  const handle = createExtension(host.pi, {
    ...active, cwd,
    createMcpClient: () => { clients += 1; return fakeClient(); },
  });
  await sessionStart(host, hostContext({ notices, trusted: true, cwd }));
  await sessionStart(host, hostContext({ notices, trusted: true, cwd }));
  assert.equal(handle.active, false);
  assert.equal(handle.reason, 'disabled');
  assert.equal(clients, 0);
  assert.deepEqual(host.tools, []);
  assert.deepEqual(notices, []);
});

test('an invalid project document refuses with zero surface and one bounded path-safe notice', async () => {
  const cwd = projectDir('{"version": 1, "palace": 5}');
  const host = fakePi();
  let clients = 0;
  const notices: string[] = [];
  const handle = createExtension(host.pi, {
    ...active, cwd,
    createMcpClient: () => { clients += 1; return fakeClient(); },
  });
  await sessionStart(host, hostContext({ notices, trusted: true, cwd }));
  await sessionStart(host, hostContext({ notices, trusted: true, cwd }));
  assert.equal(handle.active, false);
  assert.equal(handle.reason, 'misconfigured');
  assert.equal(clients, 0);
  assert.deepEqual(host.tools, []);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /\.pi\/mempalace\.json/u);
  assert.match(notices[0]!, /"palace" must be a non-empty path string\./u);
  assert.ok(notices[0]!.length <= 300, `notice is unbounded: ${notices[0]!.length}`);
  assert.equal(notices[0]!.includes(cwd), false, 'a notice must never carry a machine path');
  assert.doesNotMatch(notices[0]!, /\/Users\/|\/private\/|\/home\//u);
});

test('status reports the document as the palace source without the resolved path', async () => {
  const cwd = projectDir(JSON.stringify({ version: 1, palace: './palace' }));
  const host = fakePi();
  createExtension(host.pi, {
    ...active, cwd,
    resolvePalace: () => ({ ...palace, source: 'project-config' as const }),
  });
  await sessionStart(host, hostContext({ trusted: true, cwd }));

  const status = host.registered.find(({ name }) => name === 'palace_status')!;
  const result = await execute(status, {});
  const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
  assert.deepEqual(JSON.parse(text).configuration, {
    palace: 'project-config', readOnly: 'default', handoff: 'default',
    disabled: 'default', recall: 'default', rooms: 'default',
  });
  assert.equal(text.includes(palace.palacePath), false, 'the resolved palace path must never appear');
  assert.equal(text.includes('./palace'), false, 'a declared palace value must never appear');
  assert.equal(text.includes(cwd), false);
});

test('explicit host options still outrank the project document', async () => {
  const cwd = projectDir(JSON.stringify({ version: 1, disabled: true, readOnly: true }));
  const host = fakePi();
  let writes = 0;
  const handle = createExtension(host.pi, {
    ...active, cwd, enabled: true, readOnly: false,
    createMcpClient: () => ({ ...fakeClient(), callWriteTool: async () => { writes += 1; return {}; } }),
  });
  await sessionStart(host, hostContext({ trusted: true, cwd }));
  assert.equal(handle.active, true);
  const diary = host.registered.find(({ name }) => name === 'palace_diary')!;
  await execute(diary, { action: 'write', agent_name: 'pi', content: 'checkpoint' });
  assert.equal(writes, 1);
});
