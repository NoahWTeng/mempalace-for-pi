import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
// @ts-expect-error Pi exposes this package to extensions; it is nested under the pinned host here.
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';

const expectedTools = ['palace_diary', 'palace_save', 'palace_search', 'palace_status'];
const finding = 'packaged-pi-fresh-record';
const diary = 'packaged Pi diary entry';
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function waitFor(path: string): void {
  const deadline = Date.now() + 120_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    Atomics.wait(waitBuffer, 0, 0, 25);
  }
}

function mark(root: string, name: string, id: number): void {
  writeFileSync(join(root, `${name}-${id}`), `${process.pid}\n`);
}

function waitForAll(root: string, name: string, count: number): void {
  for (let id = 0; id < count; id += 1) waitFor(join(root, `${name}-${id}`));
}

function concurrencyConfig(): { id: number; count: number; root: string } | null {
  const rawId = process.env.MEMPALACE_CONCURRENCY_ID;
  if (rawId === undefined) return null;
  const id = Number(rawId);
  const count = Number(process.env.MEMPALACE_CONCURRENCY_COUNT ?? '8');
  const root = process.env.MEMPALACE_CONCURRENCY_ROOT;
  if (!Number.isInteger(id) || !Number.isInteger(count) || count !== 8 || id < 0 || id >= count || !root) {
    throw new Error('invalid packaged concurrency configuration');
  }
  mkdirSync(root, { recursive: true });
  return { id, count, root };
}

function runConcurrency(pi: ExtensionAPI, config: { id: number; count: number; root: string }): void {
  const { id, count, root } = config;
  const words = [
    'amber orchard telescope',
    'cobalt river lantern',
    'crimson meadow compass',
    'jade harbor violin',
    'ivory canyon kettle',
    'ochre valley camera',
    'violet glacier engine',
    'silver prairie notebook',
  ];
  const unique = Array.from({ length: count }, (_, index) =>
    `task1249-stable-key-${index} ${words[index]} ${'x'.repeat(index + 3)}`,
  );
  const duplicate = 'task1249-identical-stable-duplicate-anchor';
  const calls = [
    ['palace_save', { content: unique[id], wing: 'task1249', room: 'concurrency', source_file: 'task1249-concurrency' }],
    ...unique.map((content) => ['palace_search', { query: content, wing: 'task1249', limit: 20 }]),
    ['palace_save', { content: duplicate, wing: 'task1249', room: 'concurrency', source_file: 'task1249-concurrency' }],
    ['palace_diary', { action: 'write', agent_name: 'task1249', content: `task1249-diary-${id}`, topic: 'concurrency', wing: 'task1249' }],
    ...(id === 0 ? [] : [['palace_status', {}]]),
  ] as const;
  const faux = fauxProvider({
    models: [{ id: 'scripted', name: 'Packaged MemPalace concurrency acceptance', input: ['text'] }],
    provider: 'mempalace-packaged-local',
  });
  let step = 0;
  faux.setResponses(Array.from({ length: 40 }, () => (context: {
    tools?: Array<{ name: string }>;
    messages?: Array<{ role?: string; isError?: boolean; content?: unknown }>;
  }) => {
    const names = (context.tools ?? []).map(({ name }) => name).sort();
    if (names.join(',') !== expectedTools.join(',')) {
      throw new Error(`packaged Pi loaded unexpected tools: ${names.join(',')} ${JSON.stringify(context.tools)}`);
    }
    if (!existsSync(join(root, `started-${id}`))) {
      mark(root, 'started', id);
      waitForAll(root, 'started', count);
    }
    const last = context.messages?.at(-1);
    const completed = calls[step - 1]?.[0];
    if (last?.role === 'toolResult') {
      const result = JSON.stringify(last.content);
      if (last.isError || /"success":false|"error":/u.test(result)) {
        throw new Error(`packaged concurrency tool failed: ${result}`);
      }
      if (completed === 'palace_search') {
        const searched = unique[step - 2];
        if (!searched || !result.includes(searched)) throw new Error(`search lost exact key: ${result}`);
      }
      if (completed === 'palace_status' && !/total_drawers|wings/u.test(result)) {
        throw new Error(`status lacks palace semantics: ${result}`);
      }
      if (completed === 'palace_save' && step === 1) {
        mark(root, 'saved', id);
        waitForAll(root, 'saved', count);
      }
      if (completed === 'palace_search' && step === count + 1) {
        mark(root, 'retrieved', id);
        waitForAll(root, 'retrieved', count);
      }
      if (completed === 'palace_save' && step === count + 2) {
        mark(root, 'duplicate', id);
        waitForAll(root, 'duplicate', count);
        if (id > 0) waitFor(join(root, `diary-${id - 1}`));
      }
      if (completed === 'palace_diary') {
        mark(root, 'diary', id);
        mark(root, 'ready', id);
      }
      if (completed === 'palace_status') mark(root, 'recovered', id);
    }
    const next = calls[step++];
    if (next?.[0] === 'palace_status' && id > 0) waitFor(join(root, `release-${id}`));
    if (next) return fauxAssistantMessage(fauxToolCall(next[0], next[1], { id: `concurrency-${id}-${step}` }), { stopReason: 'toolUse' });
    return fauxAssistantMessage(`PACKAGED_PROVIDER_PASS ${JSON.stringify({ concurrency: true, id })}`, { stopReason: 'stop' });
  }));
  pi.registerProvider(faux.provider);
}

export default function packagedProvider(pi: ExtensionAPI): void {
  const concurrency = concurrencyConfig();
  if (concurrency) {
    runConcurrency(pi, concurrency);
    return;
  }
  const faux = fauxProvider({
    models: [{ id: 'scripted', name: 'Packaged MemPalace acceptance', input: ['text'] }],
    provider: 'mempalace-packaged-local',
  });
  let step = 0;
  const disabled = process.env.MEMPALACE_PROVIDER_EXPECT_DISABLED === '1';
  const incompatible = process.env.MEMPALACE_PROVIDER_EXPECT_INCOMPATIBLE === '1';
  const verifyOnly = process.env.MEMPALACE_PROVIDER_VERIFY_ONLY === '1';
  const calls = disabled || incompatible ? [] : verifyOnly ? [
    ['palace_search', { query: 'packaged pi fresh record', wing: 'acceptance', limit: 5 }],
    ['palace_diary', { action: 'read', agent_name: 'pi', wing: 'acceptance', last_n: 20 }],
    ['palace_status', {}],
  ] as const : [
    ['palace_save', { content: finding, wing: 'acceptance', room: 'journey', source_file: 'packaged-acceptance' }],
    ['palace_diary', { action: 'write', agent_name: 'pi', content: diary, topic: 'acceptance', wing: 'acceptance' }],
    ['palace_search', { query: 'packaged pi fresh record', wing: 'acceptance', limit: 5 }],
    ['palace_diary', { action: 'read', agent_name: 'pi', wing: 'acceptance', last_n: 20 }],
    ['palace_status', {}],
    ['palace_save', { content: finding, wing: 'acceptance', room: 'journey', source_file: 'packaged-acceptance' }],
  ] as const;
  faux.setResponses(Array.from({ length: 12 }, () => (context: {
    tools?: Array<{ name: string }>;
    messages?: Array<{ role?: string; isError?: boolean; content?: unknown }>;
  }) => {
    const names = (context.tools ?? []).map(({ name }) => name).sort();
    const last = context.messages?.at(-1);
    if (last?.role === 'toolResult') {
      const result = JSON.stringify(last.content);
      if (last.isError || /"success":false|"error"/u.test(result)) {
        throw new Error(`packaged tool failed: ${result}`);
      }
      const completed = calls[step - 1]?.[0];
      if (completed === 'palace_search' && !result.includes(finding)) throw new Error(`search lost exact finding: ${result}`);
      if (completed === 'palace_diary' && ((verifyOnly && step === 2) || (!verifyOnly && step === 4)) && !result.includes(diary)) {
        throw new Error(`diary read lost exact entry: ${result}`);
      }
      if (completed === 'palace_status' && !/total_drawers|wings/u.test(result)) throw new Error(`status lacks palace semantics: ${result}`);
      if (completed === 'palace_save' && step === calls.length && !/duplicate found/u.test(result)) {
        throw new Error(`duplicate result lacks existing-record evidence: ${result}`);
      }
    }
    const wanted = disabled ? [] : expectedTools;
    if (names.join(',') !== wanted.join(',')) {
      throw new Error(`packaged Pi loaded unexpected tools: ${names.join(',')}`);
    }
    const next = calls[step++];
    if (next) return fauxAssistantMessage(fauxToolCall(next[0], next[1], { id: `packaged-${step}` }), { stopReason: 'toolUse' });
    return fauxAssistantMessage(`PACKAGED_PROVIDER_PASS ${JSON.stringify({ tools: names, disabled, incompatible, verifyOnly })}`, { stopReason: 'stop' });
  }));
  pi.registerProvider(faux.provider);
}
