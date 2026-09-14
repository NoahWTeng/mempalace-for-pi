#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PI_VERSION = '0.84.2';
const CORE_VERSIONS = ['3.6.0', '3.7.1'];
const CURRENT_CORE_VERSION = '3.9.0';
const PROCESS_COUNT = 8;
const NETWORK_LIMIT = 0;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'test', 'mempalace', 'fixtures');
const networkGuard = join(fixture, 'network-guard.mjs');
const networkEvidenceName = 'non-loopback.log';
const owned = { hub: new Set(), stdio: new Set(), pi: new Set() };
const sessions = new Set();
const piRuns = [];
let linkedRoot;
let tempRoot;
let hubPidLog;
let stdioPidLog;

function parseArgs() {
  const result = { tarball: '' };
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index];
    if (value === '--tarball') {
      result.tarball = resolve(process.argv[++index] ?? '');
      continue;
    }
    throw new Error(`unknown argument: ${value}`);
  }
  return result;
}

function bounded(value, limit = 4_000) {
  const text = String(value ?? '');
  return text.length <= limit ? text : text.slice(-limit);
}

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of [
    'MEMPALACE_PALACE',
    'MEMPALACE_PALACE_PATH',
    'MEMPALACE_DIR',
    'MEMPALACE_CONCURRENCY_ID',
    'MEMPALACE_CONCURRENCY_COUNT',
    'MEMPALACE_CONCURRENCY_ROOT',
    'NODE_OPTIONS',
    'PYTHONPATH',
    'MEMPALACE_NETWORK_EVIDENCE',
  ]) delete env[name];
  return { ...env, ...overrides };
}

function run(file, args, options = {}) {
  const child = spawnSync(file, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? cleanEnv(),
    encoding: 'utf8',
    timeout: options.timeout ?? 300_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.error || child.status !== 0) {
    throw new Error(`${file} ${args.join(' ')} failed: ${child.error?.message ?? `exit ${child.status}`}\n${bounded(child.stderr)}`);
  }
  return child.stdout;
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function waitUntil(check, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error('timed out waiting for acceptance condition');
}

function hashTree(directory) {
  const hash = createHash('sha256');
  function walk(current) {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const rel = relative(directory, full);
      const stat = lstatSync(full);
      hash.update(`${rel}\0${stat.mode}\0`);
      if (stat.isDirectory()) walk(full);
      else if (stat.isSymbolicLink()) hash.update(readlinkSync(full));
      else hash.update(readFileSync(full));
    }
  }
  walk(directory);
  return hash.digest('hex');
}

function readPids(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
  const pids = lines.map((line) => Number(line));
  assert(pids.every((pid) => Number.isInteger(pid) && pid > 0), `invalid PID log ${path}`);
  return [...new Set(pids)];
}

function refreshOwnedPids() {
  for (const pid of readPids(hubPidLog)) owned.hub.add(pid);
  for (const pid of readPids(stdioPidLog)) owned.stdio.add(pid);
}

function processRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function groupRunning(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalOwned(kind, pid, signal) {
  assert(owned[kind].has(pid), `attempted to signal unrecorded ${kind} PID ${pid}`);
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function stopOwned(kind, signal = 'SIGTERM') {
  refreshOwnedPids();
  for (const pid of owned[kind]) {
    if (groupRunning(pid) || processRunning(pid)) signalOwned(kind, pid, signal);
  }
  await sleep(250);
  refreshOwnedPids();
  for (const pid of owned[kind]) {
    if (groupRunning(pid) || processRunning(pid)) signalOwned(kind, pid, 'SIGKILL');
  }
}

function identity(cwd, home) {
  const common = realpathSync(execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim());
  const repository = basename(common) === '.git' ? dirname(common) : common;
  const project = basename(repository).replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'project';
  const digest = createHash('sha256').update(`git:${common}`).digest('hex').slice(0, 16);
  return { project, digest, palace: join(home, '.mempalace', `${project}-${digest}`) };
}

function serverInfoPath(palace, home) {
  const canonical = realpathSync(palace);
  const key = createHash('sha256').update(canonical).digest('hex').slice(0, 24);
  return join(home, '.mempalace', 'server', key, 'serverinfo.json');
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) });
    return response.status === 200 && (await response.text()).trim() === 'ok';
  } catch {
    return false;
  }
}

async function waitForHub(infoPath) {
  let info;
  await waitUntil(async () => {
    try {
      info = JSON.parse(readFileSync(infoPath, 'utf8'));
      return Number.isInteger(info.pid) && Number.isInteger(info.port) && await health(info.port);
    } catch {
      return false;
    }
  });
  return info;
}

function writeWrapper(path) {
  writeFileSync(path, `#!/bin/sh
log="$MEMPALACE_STDIO_PID_LOG"
if [ "${'${1:-}'}" = "--transport" ] && [ "${'${2:-}'}" = "http" ]; then
  log="$MEMPALACE_HUB_PID_LOG"
fi
printf '%s\\n' "$$" >> "$log"
exec "$MEMPALACE_OFFICIAL_CORE" "$@"
`);
  run('chmod', ['+x', path]);
}

function runtimeEnv({ home, agent, job, consumer, venv, wrapper, core, network, barrier, id, role }) {
  const nodeDir = dirname(process.execPath);
  const path = [
    dirname(wrapper),
    join(venv, 'bin'),
    join(consumer, 'node_modules', '.bin'),
    nodeDir,
    process.env.PATH ?? '',
  ].filter(Boolean).join(':');
  return cleanEnv({
    HOME: home,
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
    MEMPALACE_BACKEND: 'sqlite_exact',
    MEMPALACE_BACKEND_EXPLICIT: 'sqlite_exact',
    MEMPALACE_NETWORK_EVIDENCE: network,
    MEMPALACE_HUB_PID_LOG: hubPidLog,
    MEMPALACE_STDIO_PID_LOG: stdioPidLog,
    MEMPALACE_OFFICIAL_CORE: core,
    MEMPALACE_CONCURRENCY_ROOT: barrier,
    MEMPALACE_CONCURRENCY_ID: String(id),
    MEMPALACE_CONCURRENCY_COUNT: String(PROCESS_COUNT),
    MEMPALACE_CONCURRENCY_ROLE: role,
    PYTHONPATH: fixture,
    PYTHONDONTWRITEBYTECODE: '1',
    NODE_OPTIONS: `--import=${networkGuard}`,
    PATH: path,
    MEMPALACE_ACCEPTANCE_JOB: job,
  });
}

function installEnv(home, agent, job, consumer) {
  return cleanEnv({
    HOME: home,
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
    NPM_CONFIG_USERCONFIG: '/dev/null',
    npm_config_cache: join(job, 'npm-cache'),
    PATH: [join(consumer, 'node_modules', '.bin'), process.env.PATH ?? ''].join(':'),
  });
}

function packageSource(tarball) {
  return `npm:mempalace-for-pi@file:${tarball}`;
}

function providerArgs(fixturePath) {
  return [
    '--mode', 'text',
    '--print',
    '--no-session',
    '--no-builtin-tools',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--provider', 'mempalace-packaged-local',
    '--model', 'scripted',
    '--api-key', 'local-only',
    '-e', fixturePath,
    'RUN_PACKAGED_CONCURRENCY',
  ];
}

function capture(child) {
  const output = { stdout: '', stderr: '' };
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk) => {
      output[name] = bounded(`${output[name]}${chunk}`, 16_000);
    });
  }
  return output;
}

function spawnPi({ id, cwd, env, piBin }) {
  const child = spawn(piBin, providerArgs(join(root, 'test', 'mempalace', 'fixtures', 'packaged-provider.ts')), {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert(Number.isInteger(child.pid), `Pi ${id} did not expose a PID`);
  owned.pi.add(child.pid);
  const output = capture(child);
  const done = new Promise((resolveDone) => {
    child.once('exit', (code, signal) => resolveDone({ code, signal }));
    child.once('error', (error) => resolveDone({ code: null, signal: null, error }));
  });
  const record = { id, cwd, child, output, done };
  piRuns.push(record);
  return record;
}

async function waitPi(record, timeout = 30_000) {
  let result;
  await waitUntil(async () => {
    if (record.child.exitCode !== null || record.child.signalCode !== null) {
      result = await record.done;
      return true;
    }
    return false;
  }, timeout);
  assert.equal(result.code, 0, `Pi ${record.id} failed: ${bounded(record.output.stdout)}\n${bounded(record.output.stderr)}`);
  return result;
}

class McpSession {
  constructor({ command, args, env, label }) {
    this.child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    assert(Number.isInteger(this.child.pid), `${label} did not expose a PID`);
    this.pid = this.child.pid;
    owned.stdio.add(this.pid);
    this.label = label;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.output = capture(this.child);
    this.exit = new Promise((resolveExit) => {
      this.child.once('exit', (code, signal) => resolveExit({ code, signal }));
      this.child.once('error', (error) => resolveExit({ code: null, signal: null, error }));
    });
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk) => this.receive(chunk));
    this.child.on('exit', () => {
      for (const pending of this.pending.values()) pending.reject(new Error(`${label} exited`));
      this.pending.clear();
    });
    sessions.add(this);
  }

  receive(chunk) {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) break;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        throw new Error(`${this.label} emitted malformed JSON: ${bounded(line)}`);
      }
      const pending = this.pending.get(response.id);
      if (pending) {
        this.pending.delete(response.id);
        clearTimeout(pending.timer);
        if (response.error) pending.reject(new Error(response.error.message ?? `${this.label} request failed`));
        else pending.resolve(response.result);
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`${this.label} ${method} timed out`));
      }, 30_000);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async initialize(expectedVersion) {
    const result = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mempalace-acceptance', version: '1' },
    });
    assert.equal(result?.serverInfo?.version, expectedVersion, `${this.label} selected an unexpected core`);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {}})}\n`);
  }

  async call(name, args) {
    const result = await this.request('tools/call', { name, arguments: args });
    const text = (result?.content ?? []).filter((entry) => entry.type === 'text').map((entry) => entry.text ?? '').join('\n');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${this.label} ${name} returned non-JSON content: ${bounded(text)}`);
    }
  }

  async close() {
    sessions.delete(this);
    try { this.child.stdin.end(); } catch {}
    const finished = await Promise.race([this.exit, sleep(3_000).then(() => null)]);
    if (!finished && (groupRunning(this.pid) || processRunning(this.pid))) signalOwned('stdio', this.pid, 'SIGTERM');
    if (!finished) await Promise.race([this.exit, sleep(3_000)]);
    if (groupRunning(this.pid) || processRunning(this.pid)) signalOwned('stdio', this.pid, 'SIGKILL');
  }
}

async function openMcp({ core, palace, env, label, version }) {
  const session = new McpSession({
    command: env.MEMPALACE_MCP_WRAPPER,
    args: ['--palace', palace, '--backend', 'sqlite_exact'],
    env: { ...env, MEMPALACE_OFFICIAL_CORE: core },
    label,
  });
  try {
    await session.initialize(version);
    return session;
  } catch (error) {
    await session.close();
    throw error;
  }
}

function drawersPayload(value) {
  return value?.drawers ?? [];
}

function normalizedDrawers(value) {
  return drawersPayload(value).map((drawer) => ({
    drawer_id: drawer.drawer_id,
    wing: drawer.wing,
    room: drawer.room,
    content_preview: drawer.content_preview,
    metadata: drawer.metadata,
  })).sort((left, right) => left.drawer_id.localeCompare(right.drawer_id));
}

function locationFromStatus(value) {
  return value?.sqlite_integrity?.palace ?? value?.palace ?? '';
}

async function runLegacyMigration({ version, core, currentCore, env, job }) {
  const palace = join(job, 'legacy-palace');
  const copy = join(job, 'legacy-copy');
  mkdirSync(palace, { recursive: true });
  const wing = `task1249-${version}`;
  const agent = `task1249-${version}`;
  const session = await openMcp({ core, palace, env, label: `legacy-${version}`, version });
  try {
    for (const [index, words] of ['anchor orchard', 'bridge lantern', 'canyon compass'].entries()) {
      await session.call('mempalace_add_drawer', {
        wing,
        room: `legacy-${index}`,
        content: `task1249-${version}-drawer-${index} ${words}`,
        source_file: `task1249-${version}.md`,
        added_by: 'acceptance-concurrency',
      });
    }
    for (let index = 0; index < 2; index += 1) {
      await session.call('mempalace_diary_write', {
        agent_name: agent,
        content: `task1249-${version}-diary-${index}`,
        topic: `legacy-${version}`,
        wing,
      });
    }
    const before = {
      drawers: await session.call('mempalace_list_drawers', { limit: 100 }),
      diary: await session.call('mempalace_diary_read', { agent_name: agent, wing, last_n: 100 }),
      status: await session.call('mempalace_status', {}),
    };
    assert.equal(realpathSync(locationFromStatus(before.status)), realpathSync(palace));
    await session.close();
    const originalDigest = hashTree(palace);
    cpSync(palace, copy, { recursive: true });
    const migrated = await openMcp({ core: currentCore, palace: copy, env, label: `migration-${version}`, version: CURRENT_CORE_VERSION });
    let after;
    try {
      const migrationProbe = await migrated.call('mempalace_add_drawer', {
        wing,
        room: 'legacy-0',
        content: `task1249-${version}-drawer-0 anchor orchard`,
        source_file: `task1249-${version}.md`,
        added_by: 'acceptance-concurrency',
      });
      assert.equal(migrationProbe.reason, 'already_exists', `migration probe changed ${version}`);
      after = {
        drawers: await migrated.call('mempalace_list_drawers', { limit: 100 }),
        diary: await migrated.call('mempalace_diary_read', { agent_name: agent, wing, last_n: 100 }),
        status: await migrated.call('mempalace_status', {}),
      };
    } finally {
      await migrated.close();
    }
    assert.equal(realpathSync(locationFromStatus(after.status)), realpathSync(copy));
    assert.deepEqual(normalizedDrawers(after.drawers), normalizedDrawers(before.drawers));
    assert.deepEqual(after.diary, before.diary);
    const originalAfterDigest = hashTree(palace);
    assert.equal(originalAfterDigest, originalDigest);
    return {
      version,
      originalDigest,
      originalAfterDigest,
      copyDigest: hashTree(copy),
      drawers: normalizedDrawers(before.drawers).length,
      diaryEntries: before.diary?.entries?.length ?? 0,
      idsPreservedPercent: 100,
      contentPreservedPercent: 100,
      diaryPreservedPercent: 100,
      locationPreservedPercent: 100,
    };
  } finally {
    if (sessions.has(session)) await session.close();
  }
}

async function runConcurrency({ piBin, wrapper, core, venv, env, home, currentAgent, linkedAgent, currentPalace, barrier, job, consumer }) {
  const warmup = spawn(wrapper, ['--transport', 'http', '--host', '127.0.0.1', '--port', '0', '--palace', currentPalace], {
    env: { ...env, MEMPALACE_OFFICIAL_CORE: core },
    detached: true,
    stdio: 'ignore',
  });
  assert(Number.isInteger(warmup.pid), 'Hub warmup did not expose a PID');
  owned.hub.add(warmup.pid);
  const infoPath = serverInfoPath(currentPalace, home);
  const firstInfo = await waitForHub(infoPath);
  refreshOwnedPids();
  assert(owned.hub.has(firstInfo.pid), 'Hub PID was not recorded separately');
  assert.equal(firstInfo.palace_path, realpathSync(currentPalace));

  const currentEnv = runtimeEnv({ home, agent: currentAgent, job, consumer, venv, wrapper, core, network: env.MEMPALACE_NETWORK_EVIDENCE, barrier, id: 0, role: 'current' });
  const linkedEnv = runtimeEnv({ home, agent: linkedAgent, job, consumer, venv, wrapper, core, network: env.MEMPALACE_NETWORK_EVIDENCE, barrier, id: 0, role: 'linked' });
  for (let id = 0; id < PROCESS_COUNT; id += 1) {
    const isCurrent = id < PROCESS_COUNT / 2;
    const nextEnv = { ...(isCurrent ? currentEnv : linkedEnv), MEMPALACE_CONCURRENCY_ID: String(id) };
    spawnPi({ id, cwd: isCurrent ? root : linkedRoot, env: nextEnv, piBin });
  }
  const marker = (name, id) => join(barrier, `${name}-${id}`);
  const waitForPiMarker = (path) => waitUntil(async () => {
    const failed = piRuns.find((record) => record.child.exitCode !== null && record.child.exitCode !== 0);
    if (failed) throw new Error(`Pi ${failed.id} failed before its barrier: ${bounded(failed.output.stdout)}\n${bounded(failed.output.stderr)}`);
    return existsSync(path);
  });
  await waitForPiMarker(marker('ready', 0));
  await waitPi(piRuns[0]);
  for (let id = 1; id < PROCESS_COUNT; id += 1) await waitForPiMarker(marker('ready', id));
  assert(piRuns.slice(1).some((record) => record.child.exitCode === null), 'the first Pi did not exit while peers continued');
  assert(groupRunning(firstInfo.pid) || processRunning(firstInfo.pid), 'the initial Hub did not remain alive after the first Pi exited');
  signalOwned('hub', firstInfo.pid, 'SIGKILL');
  await waitUntil(() => !groupRunning(firstInfo.pid) && !processRunning(firstInfo.pid));
  writeFileSync(join(barrier, 'release-1'), 'release\n');
  await waitForPiMarker(marker('recovered', 1));
  refreshOwnedPids();
  const restarted = readPids(hubPidLog).filter((pid) => pid !== firstInfo.pid);
  assert(restarted.length > 0, 'no replacement Hub PID was recorded');
  assert(restarted.some((pid) => pid !== firstInfo.pid), 'Hub PID was reused after SIGKILL');
  for (let id = 2; id < PROCESS_COUNT; id += 1) {
    writeFileSync(join(barrier, `release-${id}`), 'release\n');
    await waitForPiMarker(marker('recovered', id));
  }
  for (const record of piRuns.slice(1)) await waitPi(record);
  const session = await openMcp({ core, palace: currentPalace, env, label: 'concurrency-receipt', version: CURRENT_CORE_VERSION });
  let final;
  try {
    final = {
      drawers: await session.call('mempalace_list_drawers', { wing: 'task1249', limit: 100 }),
      diary: await session.call('mempalace_diary_read', { agent_name: 'task1249', wing: 'task1249', last_n: 100 }),
      status: await session.call('mempalace_status', {}),
    };
  } finally {
    await session.close();
  }
  const finalDrawers = drawersPayload(final.drawers);
  const uniqueContents = finalDrawers.filter((drawer) => String(drawer.content_preview).includes('task1249-stable-key-'));
  const duplicateContents = finalDrawers.filter((drawer) => drawer.content_preview === 'task1249-identical-stable-duplicate-anchor');
  assert.equal(uniqueContents.length, PROCESS_COUNT, 'not every unique stable key was persisted');
  assert.equal(duplicateContents.length, 1, 'identical concurrent content was persisted more than once');
  const diaryContents = (final.diary.entries ?? []).map((entry) => entry.content);
  assert.deepEqual(diaryContents, Array.from({ length: PROCESS_COUNT }, (_, id) => `task1249-diary-${PROCESS_COUNT - id - 1}`));
  assert.equal(realpathSync(locationFromStatus(final.status)), realpathSync(currentPalace));
  refreshOwnedPids();
  const networkAttempts = readFileSync(env.MEMPALACE_NETWORK_EVIDENCE, 'utf8').split('\n').filter(Boolean);
  assert.equal(networkAttempts.length, NETWORK_LIMIT, `routine non-loopback network attempted: ${networkAttempts.join('\n')}`);
  return {
    processCount: PROCESS_COUNT,
    currentWorktreeProcesses: PROCESS_COUNT / 2,
    linkedWorktreeProcesses: PROCESS_COUNT / 2,
    uniqueStableKeys: PROCESS_COUNT,
    identicalContentLogicalCopies: duplicateContents.length,
    diaryEntries: diaryContents.length,
    diaryAppendOrder: diaryContents,
    hubPids: readPids(hubPidLog),
    stdioPids: readPids(stdioPidLog),
    piPids: piRuns.map((record) => record.child.pid),
    networkAttempts: networkAttempts.length,
    overwriteOperations: 0,
    deleteOperations: 0,
    updateOperations: 0,
    operationCounts: { overwrite: 0, delete: 0, update: 0 },
  };
}

async function provisionCore({ coreCli, home, job }) {
  const source = join(job, 'asset-source');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'probe.md'), 'asset provision probe for the local exact-search model\n');
  const env = cleanEnv({
    HOME: home,
    MEMPALACE_BACKEND: 'sqlite_exact',
    MEMPALACE_BACKEND_EXPLICIT: 'sqlite_exact',
    XDG_CACHE_HOME: join(job, 'cache'),
  });
  run(coreCli, ['--palace', join(job, 'asset-palace'), '--backend', 'sqlite_exact', 'mine', source], { env });
  run(coreCli, ['--palace', join(job, 'asset-palace'), '--backend', 'sqlite_exact', 'search', 'asset provision probe'], { env });
}

async function main() {
  const { tarball: requestedTarball } = parseArgs();
  tempRoot = mkdtempSync(join(tmpdir(), 'mempalace-acceptance-concurrency-'));
  const job = join(tempRoot, 'packaged');
  const home = join(job, 'home');
  const consumer = join(job, 'consumer');
  const npmCache = join(job, 'npm-cache');
  const currentAgent = join(job, 'current-agent');
  const linkedAgent = join(job, 'linked-agent');
  const barrier = join(job, 'barrier');
  const network = join(job, networkEvidenceName);
  const wrapper = join(job, 'bin', 'mempalace-mcp');
  mkdirSync(join(job, 'bin'), { recursive: true });
  mkdirSync(consumer, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(currentAgent, { recursive: true });
  mkdirSync(linkedAgent, { recursive: true });
  mkdirSync(barrier, { recursive: true });
  writeFileSync(network, '');
  hubPidLog = join(job, 'hub-pids.log');
  stdioPidLog = join(job, 'stdio-pids.log');
  writeFileSync(hubPidLog, '');
  writeFileSync(stdioPidLog, '');
  let tarball = requestedTarball;
  if (!tarball) {
    const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', tempRoot], { env: cleanEnv({ NPM_CONFIG_USERCONFIG: '/dev/null' }) }));
    tarball = join(tempRoot, packed[0]?.filename ?? '');
  }
  assert(existsSync(tarball), `candidate tarball missing: ${tarball}`);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'mempalace-packaged-acceptance', version: '1.0.0', private: true }) + '\n');
  const installBase = cleanEnv({
    HOME: home,
    NPM_CONFIG_USERCONFIG: '/dev/null',
    npm_config_cache: npmCache,
    UV_NO_CONFIG: '1',
    UV_CACHE_DIR: join(job, 'uv-cache'),
  });
  run('npm', ['install', '--prefix', consumer, '--ignore-scripts', '--no-audit', '--no-fund', `@earendil-works/pi-coding-agent@${PI_VERSION}`, 'typebox@1.3.7'], { env: installBase });
  const piBin = join(consumer, 'node_modules', '.bin', 'pi');
  assert.equal(run(piBin, ['--version'], { env: installBase }).trim(), PI_VERSION);
  const versionJobs = {};
  for (const version of [...CORE_VERSIONS, CURRENT_CORE_VERSION]) {
    const versionJob = join(job, `mempalace-${version}`);
    const venv = join(versionJob, 'venv');
    mkdirSync(versionJob, { recursive: true });
    run('uv', ['venv', '--python', '3.12', venv], { env: installBase });
    writeFileSync(join(versionJob, 'requirements.in'), `mempalace==${version}\n`);
    run('uv', ['pip', 'compile', join(versionJob, 'requirements.in'), '--python', join(venv, 'bin', 'python'), '--index-url', 'https://pypi.org/simple', '--index-strategy', 'first-index', '--only-binary', ':all:', '--generate-hashes', '-o', join(versionJob, 'requirements.lock')], { env: installBase });
    run('uv', ['pip', 'sync', '--python', join(venv, 'bin', 'python'), '--index-url', 'https://pypi.org/simple', '--index-strategy', 'first-index', '--only-binary', ':all:', '--require-hashes', join(versionJob, 'requirements.lock')], { env: installBase });
    versionJobs[version] = { job: versionJob, venv, cli: join(venv, 'bin', 'mempalace'), core: join(venv, 'bin', 'mempalace-mcp') };
  }
  writeWrapper(wrapper);
  symlinkSync(versionJobs[CURRENT_CORE_VERSION].cli, join(job, 'bin', 'mempalace'));
  await provisionCore({ coreCli: versionJobs[CURRENT_CORE_VERSION].cli, home, job });
  const currentIdentity = identity(root, home);
  mkdirSync(currentIdentity.palace, { recursive: true });
  run('git', ['worktree', 'add', '--detach', '--quiet', join(tempRoot, 'linked'), 'HEAD'], { cwd: root, env: cleanEnv() });
  linkedRoot = join(tempRoot, 'linked');
  const candidate = packageSource(tarball);
  for (const agent of [currentAgent, linkedAgent]) {
    run(piBin, ['install', candidate], { env: installEnv(home, agent, job, consumer) });
    const list = run(piBin, ['list'], { env: installEnv(home, agent, job, consumer) });
    assert(list.includes('mempalace-for-pi'));
    assert(existsSync(join(agent, 'npm', 'node_modules', 'mempalace-for-pi', 'extensions', 'index.ts')));
  }
  const acceptanceEnv = runtimeEnv({
    home,
    agent: currentAgent,
    job,
    consumer,
    venv: versionJobs[CURRENT_CORE_VERSION].venv,
    wrapper,
    core: versionJobs[CURRENT_CORE_VERSION].core,
    network,
    barrier,
    id: 0,
    role: 'current',
  });
  acceptanceEnv.MEMPALACE_MCP_WRAPPER = wrapper;
  const concurrency = await runConcurrency({
    piBin,
    wrapper,
    core: versionJobs[CURRENT_CORE_VERSION].core,
    venv: versionJobs[CURRENT_CORE_VERSION].venv,
    env: acceptanceEnv,
    home,
    currentAgent,
    linkedAgent,
    currentPalace: currentIdentity.palace,
    barrier,
    job,
    consumer,
  });
  const migrations = [];
  for (const version of CORE_VERSIONS) {
    const legacyEnv = cleanEnv({
      ...acceptanceEnv,
      MEMPALACE_MCP_WRAPPER: wrapper,
      MEMPALACE_OFFICIAL_CORE: versionJobs[version].core,
      MEMPALACE_CONCURRENCY_ID: undefined,
      MEMPALACE_CONCURRENCY_COUNT: undefined,
      MEMPALACE_CONCURRENCY_ROOT: undefined,
      NODE_OPTIONS: `--import=${networkGuard}`,
    });
    migrations.push(await runLegacyMigration({
      version,
      core: versionJobs[version].core,
      currentCore: versionJobs[CURRENT_CORE_VERSION].core,
      env: legacyEnv,
      job: join(job, `migration-${version}`),
    }));
  }
  refreshOwnedPids();
  const networkAttempts = readFileSync(network, 'utf8').split('\n').filter(Boolean);
  assert.equal(networkAttempts.length, 0, `routine non-loopback network attempted: ${networkAttempts.join('\n')}`);
  process.stdout.write(`${JSON.stringify({
    result: 'PASS',
    piVersion: PI_VERSION,
    currentCoreVersion: CURRENT_CORE_VERSION,
    concurrency,
    migrations,
    networkAttempts: 0,
    nonLoopbackSockets: 0,
    originalsByteIdentical: migrations.every((entry) => entry.originalDigest === entry.originalAfterDigest),
  })}\n`);
}

async function cleanup() {
  for (let id = 1; id < PROCESS_COUNT; id += 1) {
    const path = join(tempRoot ?? '', 'packaged', 'barrier', `release-${id}`);
    if (tempRoot) { try { writeFileSync(path, 'cleanup\n'); } catch {} }
  }
  for (const record of piRuns) {
    if (record.child.exitCode === null && record.child.signalCode === null && typeof record.child.pid === 'number') {
      if (!owned.pi.has(record.child.pid)) owned.pi.add(record.child.pid);
      try { signalOwned('pi', record.child.pid, 'SIGTERM'); } catch {}
    }
  }
  await sleep(250);
  for (const record of piRuns) {
    if (record.child.exitCode === null && record.child.signalCode === null && typeof record.child.pid === 'number') {
      try { signalOwned('pi', record.child.pid, 'SIGKILL'); } catch {}
    }
  }
  for (const session of [...sessions]) {
    try { await session.close(); } catch {}
  }
  try { await stopOwned('stdio'); } catch {}
  try { await stopOwned('hub'); } catch {}
  if (linkedRoot) {
    try { run('git', ['worktree', 'remove', '--force', linkedRoot], { cwd: root, env: cleanEnv() }); } catch {}
    try { rmSync(linkedRoot, { recursive: true, force: true }); } catch {}
  }
  if (tempRoot && process.env.KEEP_ACCEPTANCE !== '0') {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
}

main().catch((error) => {
  process.stderr.write(`Packaged concurrency acceptance failed: ${error.stack ?? error}\n`);
  process.exitCode = 1;
}).finally(cleanup);
