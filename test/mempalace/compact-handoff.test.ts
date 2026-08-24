import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionContext, SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent';

import {
  HANDOFF_BUDGET_MS,
  LAST_MESSAGE_MAX_CHARS,
  composeHandoffEntry,
  handleCompactHandoff,
  summarizeBranch,
} from '../../integration/compact-handoff.ts';
import type { McpClient } from '../../integration/mcp-client.ts';
import { createWriteSafetyGate, type WriteSafetyGate } from '../../integration/safety.ts';

function user(text: string): any {
  return { type: 'message', message: { role: 'user', content: text } };
}
function assistant(text: string): any {
  return { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}
function event(entries: any[]): SessionBeforeCompactEvent {
  return {
    type: 'session_before_compact', preparation: {} as never, branchEntries: entries,
    reason: 'manual', willRetry: false, signal: new AbortController().signal,
  };
}
function client(write: McpClient['callWriteTool']): McpClient {
  return { callReadTool: async () => null, callWriteTool: write, shutdown: async () => {}, isAlive: () => false };
}

const context = { cwd: '/repo' } as ExtensionContext;

test('branch summary uses only allowlisted message count and last user text', () => {
  const summary = summarizeBranch([
    { type: 'label', secret: 'ignored' } as never,
    user('first'), assistant('private assistant text'), user('last'),
  ]);
  assert.deepEqual(summary, { messageCount: 3, lastUserText: 'last' });
});

test('handoff entry contains only bounded allowlisted fields', () => {
  const entry = composeHandoffEntry({
    project: 'demo', branch: 'main', messageCount: 4,
    lastUserText: 'x'.repeat(LAST_MESSAGE_MAX_CHARS + 100),
    now: new Date('2026-01-01T00:00:00.000Z'),
  });
  assert.deepEqual(Object.keys(JSON.parse(entry)), [
    'timestamp', 'project', 'branch', 'messageCount', 'lastUserText',
  ]);
  assert.equal(JSON.parse(entry).lastUserText.length, LAST_MESSAGE_MAX_CHARS);
});

test('enabled handoff uses the shared safety gate before one write and no model call', async () => {
  const order: string[] = [];
  const writes: Array<{ name: string; args: Record<string, unknown> }> = [];
  const gate: WriteSafetyGate = (candidate) => { order.push(`gate:${candidate.content}`); };
  await handleCompactHandoff(
    event([user('continue the refactor')]), context,
    { client: client(async (name, args = {}) => { order.push(`write:${name}`); writes.push({ name, args }); }), project: 'demo', gate },
    { gitBranch: () => 'main' },
  );
  assert.equal(order.length, 2);
  assert.match(order[0]!, /^gate:/);
  assert.equal(order[1], 'write:mempalace_diary_write');
  assert.equal(writes[0]?.args.topic, 'compact-handoff');
  assert.equal(writes[0]?.args.agent_name, 'mempalace-pi', 'official core requires a path-safe diary agent');
});

test('credential, non-retention marker, and over-limit source reject the whole handoff before write', async () => {
  let writes = 0;
  const rejectingGate: WriteSafetyGate = (candidate) => {
    if (/api_key|\[no-memory\]|x{6001}/.test(candidate.content)) throw new Error('unsafe candidate');
  };
  for (const text of ['api_key=secret', '[no-memory]\ndo not retain', 'x'.repeat(6001)]) {
    await handleCompactHandoff(
      event([user(text)]), context,
      { client: client(async () => { writes += 1; }), project: 'demo', gate: rejectingGate },
      { gitBranch: () => 'main' },
    );
  }
  assert.equal(writes, 0);
});

test('credential-bearing handoff metadata rejects the whole candidate before write', async () => {
  let writes = 0;
  await handleCompactHandoff(
    event([user('ordinary')]), context,
    { client: client(async () => { writes += 1; }), project: 'demo', gate: createWriteSafetyGate() },
    { gitBranch: () => 'token=supersecret' },
  );
  await handleCompactHandoff(
    event([user('ordinary')]), context,
    {
      client: client(async () => { writes += 1; }),
      project: 'demo',
      agentName: 'token=supersecret',
      gate: createWriteSafetyGate(),
    },
    { gitBranch: () => 'main' },
  );
  assert.equal(writes, 0);
});

test('handoff abandons at its budget and does not wait for a hung write', async () => {
  assert.equal(HANDOFF_BUDGET_MS, 15_000);
  const started = Date.now();
  await handleCompactHandoff(
    event([]), context,
    { client: client(() => new Promise(() => {})), project: 'demo', gate: () => {} },
    { gitBranch: () => 'main', budgetMs: 30 },
  );
  assert.ok(Date.now() - started < 300);
});
