import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

function argument(name) {
  const index = process.argv.indexOf(name);
  assert(index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), `${name} requires a value`);
  return process.argv[index + 1];
}
const packageDir = resolve(argument('--package-dir'));
const coreBin = resolve(argument('--mempalace-bin'));
const version = argument('--mempalace-version');
const palace = resolve(argument('--palace'));
const networkEvidence = resolve(argument('--network-evidence'));
const phase = argument('--phase');
const createRecords = process.argv.includes('--create-records');
assert(['3.6.0', '3.7.1'].includes(version));
assert.equal(
  execFileSync(join(dirname(coreBin), 'mempalace'), ['--version'], { encoding: 'utf8' }).trim(),
  `MemPalace ${version}`,
);

process.env.MEMPALACE_PALACE = palace;
process.env.MEMPALACE_BACKEND = 'sqlite_exact';
process.env.MEMPALACE_BACKEND_EXPLICIT = 'sqlite_exact';
process.env.MEMPALACE_NETWORK_EVIDENCE = networkEvidence;
process.env.MEMPALACE_HANDOFF = '1';

const [{ default: register }, { createExtension }] = await Promise.all([
  import(pathToFileURL(join(packageDir, 'extensions/index.ts')).href),
  import(pathToFileURL(join(packageDir, 'integration/extension.ts')).href),
]);
assert.equal(typeof register, 'function');

function host() {
  const handlers = new Map();
  const tools = [];
  return {
    handlers,
    tools,
    pi: {
      on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      registerTool(tool) { tools.push(tool); },
    },
  };
}
// The host, not the package, decides whether the project document may be read.
// This harness stands in for a host that has already made that decision, so it
// states it explicitly on every context it hands to the extension.
const projectTrusted = !process.argv.includes('--untrusted-project');
function context(notices = []) {
  return {
    cwd: process.cwd(),
    isProjectTrusted: () => projectTrusted,
    ui: { notify: (message) => notices.push(message) },
  };
}
async function execute(tool, parameters) {
  return tool.execute('acceptance', parameters, new AbortController().signal, () => {}, context());
}
function processGroupMembers(pid) {
  try {
    return execFileSync('ps', ['-o', 'pid=', '-g', String(pid)], { encoding: 'utf8' })
      .trim().split(/\s+/u).filter(Boolean).map(Number);
  } catch {
    return [pid];
  }
}
function running(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function groupRunning(pid) {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}
function stable(value) {
  return JSON.parse(JSON.stringify(value));
}

const baselineHandles = new Set(process._getActiveHandles());
const baselineRequests = new Set(process._getActiveRequests());
const loaded = host();
const handle = createExtension(loaded.pi, { handoff: true });
// Composition waits for a trusted session start. Before that event the
// extension has read no project document, created no client, and registered no
// tool, so the runtime is asserted only after the event that produces it.
assert.equal(handle.active, false, 'the extension composed before any session started');
assert.deepEqual(loaded.tools, [], 'a tool was registered before any session started');
const notices = [];
await loaded.handlers.get('session_start')[0]({}, context(notices));
assert.equal(handle.active, true, 'a trusted session start did not compose the runtime');
assert.deepEqual(loaded.tools.map(({ name }) => name).sort(), [
  'palace_diary', 'palace_save', 'palace_search', 'palace_status',
]);
assert.equal(handle.status().state, 'operational', `unexpected lifecycle state: ${JSON.stringify(handle.status())}`);
// Pi awaits every `before_agent_start` handler, so this one is awaited here too:
// reading `.systemPrompt` off the unresolved promise would assert nothing.
const wakeOne = await loaded.handlers.get('before_agent_start')[0](
  { systemPrompt: 'base', prompt: 'what did we decide about the packaged provider?' }, context(),
);
const wakeTwo = await loaded.handlers.get('before_agent_start')[0](
  { systemPrompt: 'base', prompt: 'an entirely different question about wings' }, context(),
);
assert.match(wakeOne.systemPrompt, /<mempalace-wakeup/u);
assert.deepEqual(wakeTwo, wakeOne, 'wake-up changed bytes during one session');
// Recall is opt-in and this session never asked for it, so two different
// prompts must still produce identical bytes and no retrieval block at all.
assert.equal(
  wakeOne.systemPrompt.includes('<mempalace-recall'), false,
  'recall injected a block without being enabled',
);
assert.deepEqual(notices, []);

const byName = Object.fromEntries(loaded.tools.map((tool) => [tool.name, tool]));
const finding = 'packaged-provider-exactly-once';
const diaryEntry = 'packaged diary entry';
const handoffText = 'exact opt-in handoff record';
let concurrentWriteCount = 0;
if (createRecords) {
  const saves = await Promise.all([
    execute(byName.palace_save, { content: finding, wing: 'acceptance', room: 'journey', source_file: 'packaged-acceptance' }),
    execute(byName.palace_save, { content: finding, wing: 'acceptance', room: 'journey', source_file: 'packaged-acceptance' }),
  ]);
  concurrentWriteCount = saves.filter((result) => !/duplicate found/u.test(result.content[0].text)).length;
  assert.equal(concurrentWriteCount, 1, 'concurrent same-content save did not produce exactly one write');
  await execute(byName.palace_diary, {
    action: 'write', agent_name: 'pi', content: diaryEntry, topic: 'acceptance', wing: 'acceptance',
  });
  await loaded.handlers.get('session_before_compact')[0]({
    type: 'session_before_compact', preparation: {}, reason: 'manual', willRetry: false,
    signal: new AbortController().signal,
    branchEntries: [{ type: 'message', message: { role: 'user', content: handoffText } }],
  }, context());
}

const search = await execute(byName.palace_search, {
  query: 'packaged provider exactly once', wing: 'acceptance', limit: 5,
});
const diary = await execute(byName.palace_diary, {
  action: 'read', agent_name: 'pi', wing: 'acceptance', last_n: 20,
});
const handoffDiary = await execute(byName.palace_diary, {
  action: 'read', agent_name: 'mempalace-pi', wing: handle.status().project, last_n: 20,
});
const status = await execute(byName.palace_status, {});
const searchText = JSON.stringify(search.details);
const diaryText = JSON.stringify(diary.details);
const handoffTextResult = JSON.stringify(handoffDiary.details);
assert.ok(searchText.includes(finding), `search omitted exact finding: ${searchText}`);
assert.ok(searchText.includes('packaged-acceptance'), `search omitted exact source: ${searchText}`);
assert.ok(diaryText.includes(diaryEntry), `diary omitted exact entry: ${diaryText}`);
assert.ok(handoffTextResult.includes(handoffText) && handoffTextResult.includes('compact-handoff'), `diary omitted exact handoff: ${handoffTextResult}`);
assert.equal(typeof status.details.total_drawers, 'number');

const duplicate = await execute(byName.palace_save, {
  content: finding, wing: 'acceptance', room: 'journey', source_file: 'packaged-acceptance',
});
assert.match(duplicate.content[0].text, /duplicate found/u);
const duplicateText = JSON.stringify(duplicate.details);
const ids = [...searchText.matchAll(/"(?:id|drawer_id)":"([^"]+)"/gu)].map((match) => match[1]);
if (ids.length > 0) assert.ok(ids.some((id) => duplicateText.includes(id)), 'duplicate did not reference stable existing ID');

const corePid = Number(readFileSync(process.env.MEMPALACE_CORE_PID_FILE, 'utf8'));
assert.ok(Number.isInteger(corePid) && running(corePid));
const ownedPids = processGroupMembers(corePid);
const started = performance.now();
await loaded.handlers.get('session_shutdown')[0]({}, context());
while ((groupRunning(corePid) || ownedPids.some(running)) && performance.now() - started < 5_000) {
  await new Promise((done) => setTimeout(done, 25));
}
const shutdownMs = performance.now() - started;
assert.ok(shutdownMs < 5_000, `shutdown exceeded 5 seconds: ${shutdownMs}ms`);
assert.equal(handle.status().state, 'closed');
assert.equal(groupRunning(corePid), false, 'official MCP process group survived shutdown');
assert.deepEqual(ownedPids.filter(running), [], 'official MCP descendants survived shutdown');
await new Promise((done) => setTimeout(done, 50));
const ownedHandlesAfterShutdown = process._getActiveHandles().filter((entry) => !baselineHandles.has(entry));
const ownedRequestsAfterShutdown = process._getActiveRequests().filter((entry) => !baselineRequests.has(entry));
assert.deepEqual(ownedHandlesAfterShutdown, []);
assert.deepEqual(ownedRequestsAfterShutdown, []);

const nonLoopbackAttempts = readFileSync(networkEvidence, 'utf8').trim().split('\n').filter(Boolean);
assert.deepEqual(nonLoopbackAttempts, []);
const packageVersion = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version;
process.stdout.write(`${JSON.stringify({
  phase,
  importedFrom: 'installed-package-copy',
  packageVersion,
  syntheticPredecessor: packageVersion === '0.0.9',
  version,
  palaceIdentity: createHash('sha256').update(palace).digest('hex'),
  snapshot: { search: stable(search.details), diary: stable(diary.details), handoff: stable(handoffDiary.details), totalDrawers: status.details.total_drawers },
  concurrentWriteCount,
  wakeByteIdentical: true,
  handoffExact: true,
  nonLoopbackAttempts: 0,
  shutdownMs,
  officialProcessGroupGone: true,
  officialDescendantsGone: true,
  ownedHandlesAfterShutdown: 0,
  ownedRequestsAfterShutdown: 0,
})}\n`);
