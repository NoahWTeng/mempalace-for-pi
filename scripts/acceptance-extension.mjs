import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(manifest.name, 'mempalace-for-pi');

const EXPLORER_PROJECT = 'demo';
const EXPLORER_QUERY = 'runbook';
const EXPLORER_CORES = [
  { version: '3.6.0', mode: 'explorer-minimal' },
  { version: '3.7.1', mode: 'explorer' },
];
const FAKE_CORE = fileURLToPath(new URL('../test/mempalace/fixtures/fake-mempalace-server.mjs', import.meta.url));

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return;
  const value = process.argv[index + 1];
  assert(value && !value.startsWith('--'), `${name} requires a value`);
  return value;
}
for (let index = 2; index < process.argv.length; index++) {
  const value = process.argv[index];
  if (value === '--smoke' || value === '--full' || value === '--explorer') continue;
  assert(value === '--runs' || value === '--tarball' || value === '--mempalace-version', `unknown argument: ${value}`);
  index++;
}
assert(
  process.argv.includes('--smoke') || process.argv.includes('--full') || process.argv.includes('--explorer'),
  'use --smoke or --full',
);
const args = [];
for (const name of ['--tarball', '--mempalace-version']) {
  const value = argument(name);
  if (value) args.push(name, value);
}

function packedCandidate(destination) {
  const declared = argument('--tarball');
  if (declared) return resolve(declared);
  const packed = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], {
    encoding: 'utf8',
  });
  assert.equal(packed.status, 0, `npm pack exited ${packed.status}`);
  return join(destination, JSON.parse(packed.stdout)[0].filename);
}

function extractCandidate(tarball, destination) {
  const extracted = spawnSync('tar', ['-xzf', tarball, '-C', destination], { stdio: 'inherit' });
  assert.equal(extracted.status, 0, `tar exited ${extracted.status}`);
  return join(destination, 'package');
}

async function explorerJourney(packageRoot, core) {
  const load = (relative) => import(pathToFileURL(join(packageRoot, relative)).href);
  const { createMcpClient } = await load('integration/mcp-client.ts');
  const { createExplorerAdapter } = await load('integration/explorer/adapter.ts');
  const { createExplorerHost, EXPLORER_COMMAND_NAME } = await load('integration/explorer/command.ts');
  assert.equal(EXPLORER_COMMAND_NAME, 'palace-explore', 'the packaged command is not /palace-explore');

  const client = createMcpClient(() => ({ cmd: process.execPath, args: [FAKE_CORE, core.mode] }), process.cwd());
  const writes = [];
  const readOnly = {
    callReadTool: (name, toolArguments) => client.callReadTool(name, toolArguments),
    callWriteTool: (name) => {
      writes.push(name);
      return Promise.reject(new Error(`the packaged explorer attempted a write: ${name}`));
    },
    shutdown: () => client.shutdown(),
    isAlive: () => client.isAlive(),
  };
  const opened = [];
  const host = createExplorerHost({
    createAdapter: () => createExplorerAdapter(readOnly, { project: EXPLORER_PROJECT }),
    openBrowser: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
  });

  try {
    await host.command.handler('', { ui: { notify: () => {} } });
    assert.equal(opened.length, 1, 'the packaged command opened no explorer');
    const opening = new URL(opened[0]);
    const origin = `${opening.protocol}//${opening.host}`;
    assert.equal(opening.hostname, '127.0.0.1', 'the packaged explorer left the loopback boundary');
    const token = new URLSearchParams(opening.hash.slice(1)).get('token');
    assert.match(token ?? '', /^[a-f0-9]{64}$/u, 'the packaged explorer issued no session token');

    const api = async (path) => {
      const answer = await fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(answer.status, 200, `${path} answered ${answer.status}`);
      return answer.json();
    };

    const shell = await fetch(`${origin}/`);
    assert.equal(shell.status, 200, 'the packaged explorer served no application shell');
    assert.match(await shell.text(), /id="search-form"/u, 'the packaged assets are missing from the candidate');

    const unauthorized = await fetch(`${origin}/api/recent`);
    assert.equal(unauthorized.status, 401, 'the packaged explorer served memory without authorization');

    const recent = await api('/api/recent');
    assert.ok(recent.memories.length > 0, 'the packaged explorer listed no recent memories');

    const results = await api(`/api/search?query=${EXPLORER_QUERY}`);
    const hit = results.hits.find((candidate) => candidate.resolved === true);
    assert.ok(hit?.id, `the packaged explorer resolved no result for ${EXPLORER_QUERY}`);

    const details = await api(`/api/details?id=${encodeURIComponent(hit.id)}`);
    assert.equal(details.id, hit.id, 'details answered for another memory');
    assert.ok(details.content.length > 0, 'the selected memory carried no content');

    const neighborhood = await api(`/api/neighborhood?id=${encodeURIComponent(hit.id)}&visible=26`);
    assert.equal(neighborhood.seed.id, hit.id, 'the neighborhood answered for another memory');
    assert.ok(neighborhood.displayed > 0, 'the neighborhood displayed no relationship');
    assert.equal(neighborhood.knowledgeGraph, 'unavailable');
    assert.ok(
      neighborhood.relationships.every((relationship) => relationship.category === 'structural'),
      'the packaged explorer presented a relationship the core never recorded',
    );

    assert.deepEqual(writes, [], 'the packaged explorer attempted a write');
    process.stdout.write(
      `Packaged explorer journey: PASS MemPalace ${core.version} `
      + `(search -> select -> details -> neighborhood, ${neighborhood.displayed} of ${neighborhood.available} relationships)\n`,
    );
  } finally {
    await host.close();
    await client.shutdown();
  }
}

async function refuseUnsupportedCore(packageRoot) {
  const { createMcpClient } = await import(pathToFileURL(join(packageRoot, 'integration/mcp-client.ts')).href);
  const client = createMcpClient(() => ({ cmd: process.execPath, args: [FAKE_CORE, 'incompatible'] }), process.cwd());
  try {
    await assert.rejects(
      client.callReadTool('mempalace_list_drawers', { wing: EXPLORER_PROJECT }),
      'the packaged explorer read an unsupported core',
    );
  } finally {
    await client.shutdown();
  }
}

async function packagedExplorerJourney() {
  const workspace = mkdtempSync(join(tmpdir(), 'mempalace-packaged-explorer-'));
  try {
    const packageRoot = extractCandidate(packedCandidate(workspace), workspace);
    for (const core of EXPLORER_CORES) await explorerJourney(packageRoot, core);
    await refuseUnsupportedCore(packageRoot);
    process.stdout.write(
      `Packaged explorer: PASS (MemPalace ${EXPLORER_CORES.map((core) => core.version).join(', ')})\n`,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

if (process.argv.includes('--smoke') || process.argv.includes('--full')) {
  const runs = Number(argument('--runs') ?? '1');
  assert(Number.isInteger(runs) && runs > 0, '--runs must be a positive integer');
  for (let run = 0; run < runs; run++) {
    const result = spawnSync('bash', ['scripts/gate-packaged.sh', ...args], { stdio: 'inherit' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `packaged acceptance exited ${result.status}`);
  }
  process.stdout.write(`Packaged Pi E2E: PASS (${runs} run${runs === 1 ? '' : 's'})\n`);
}

if (process.argv.includes('--explorer')) await packagedExplorerJourney();
