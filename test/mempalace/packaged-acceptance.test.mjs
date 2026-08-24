import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('packaged gate declares the exact supported matrix and real Pi lifecycle', () => {
  const gate = read('scripts/gate-packaged.sh');
  assert.match(gate, /PI_VERSION="0\.84\.2"/u);
  assert.match(gate, /MEMPALACE_VERSIONS=\("3\.6\.0" "3\.7\.1"\)/u);
  assert.match(gate, /packaged-real-provider\.mjs/u);
  for (const command of [' install ', ' list', ' remove ']) assert.ok(gate.includes(command), `missing Pi lifecycle command: ${command}`);
  assert.doesNotMatch(gate, /-e "\$package_dir/u, 'installed integration must be package-discovered, never force-loaded');
  assert.match(gate, /MEMPALACE_PROVIDER_EXPECT_DISABLED/u);
  assert.match(gate, /unset UV_EXTRA_INDEX_URL UV_INDEX UV_INDEX_URL UV_DEFAULT_INDEX UV_FIND_LINKS/u);
  assert.match(gate, /--index-strategy first-index/u);
  assert.match(gate, /PYTHONDONTWRITEBYTECODE=1/u, 'acceptance must not dirty the verified source tree');
  assert.match(gate, /synthetic-predecessor-0\.0\.9/u);
  assert.match(gate, /assert_snapshot/u);
});

// The project document is released by the host, not by the package, so the
// packaged journey has to install the candidate the way a project installs it,
// state a trust decision either way, and record every phase it proved. Each
// phase name below is also a lifecycle entry in the recorded matrix evidence,
// so a cell cannot claim a journey the gate never ran.
const PROJECT_JOURNEY_PHASES = [
  'project-local-install',
  'project-json-palace',
  'restart',
  'env-override',
  'project-json-disabled',
  'project-json-invalid',
  'untrusted-json-unread',
  'project-remove',
  'project-reinstall',
];

test('packaged gate installs project-locally and exercises the JSON contract', () => {
  const gate = read('scripts/gate-packaged.sh');
  assert.ok(gate.includes('install -l'), 'the candidate must be installed project-locally');
  assert.ok(gate.includes('.pi/mempalace.json'), 'the gate must write the project document');
  assert.ok(gate.includes('--approve'), 'the gate must grant an explicit project trust decision');
  assert.ok(gate.includes('--no-approve'), 'the gate must also refuse project trust explicitly');
  assert.match(gate, /"palace": "~\//u, 'the declared palace must use the portable home-relative form');
  for (const phase of PROJECT_JOURNEY_PHASES) {
    assert.ok(gate.includes(phase), `missing recorded journey phase: ${phase}`);
  }
});

test('packaged gate proves an unusable document exposes no tool and no process', () => {
  const gate = read('scripts/gate-packaged.sh');
  assert.match(gate, /assert_no_core_started/u, 'a refused document must be checked for a started core');
  assert.ok(
    (gate.match(/assert_no_core_started/gu) ?? []).length >= 4,
    'every disabled and invalid document run must assert that nothing started',
  );
  assert.match(gate, /project_digest/u, 'the declared palace must be digested across refusals');
});

// Composition now waits for a trusted `session_start`, so a harness that reads
// the runtime before firing that event is asserting a state the extension no
// longer reaches eagerly. The ordering is the contract.
test('the packaged real provider composes only after a trusted session start', () => {
  const provider = read('test/mempalace/packaged-real-provider.mjs');
  const sessionStart = provider.indexOf("handlers.get('session_start')");
  assert.ok(sessionStart > 0, 'the harness must fire session_start');
  const inert = provider.indexOf('handle.active, false');
  assert.ok(
    inert > 0 && inert < sessionStart,
    'the harness must first prove nothing was composed before the session started',
  );
  assert.ok(
    provider.indexOf('handle.active, true') > sessionStart,
    'the runtime must not be asserted before the trusted session start',
  );
  assert.ok(
    provider.indexOf("'palace_diary', 'palace_save'") > sessionStart,
    'the tool set must not be asserted before the trusted session start',
  );
  assert.match(provider, /isProjectTrusted/u, 'the harness must state the trust decision it grants');
});

test('CI pairs Pi 0.84.2 with both supported MemPalace versions', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /pi-version:\s*\[0\.84\.2\]/u);
  assert.match(workflow, /mempalace-version:\s*\[3\.6\.0, 3\.7\.1\]/u);
  assert.match(workflow, /gate-release\.sh[\s\S]*--mempalace-version/u);
});

test('Node and Python guards deny every routine network API family', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'mempalace-network-guard-'));
  try {
    const nodeEvidence = join(scratch, 'node.log');
    const nodeProbe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import net from 'node:net'; import http from 'node:http'; import dns from 'node:dns'; import dgram from 'node:dgram';
      const blocked = [];
      try { net.connect({host:'203.0.113.10',port:80}); } catch { blocked.push('net'); }
      try { http.request({host:'203.0.113.10',port:80}); } catch { blocked.push('http'); }
      try { await fetch('http://203.0.113.10:80'); } catch (error) { if (String(error.cause ?? error).includes('blocked')) blocked.push('fetch'); }
      try { dns.resolve4('example.com',()=>{}); } catch { blocked.push('dns'); }
      const udp=dgram.createSocket('udp4'); try { udp.send('x',53,'203.0.113.10'); } catch { blocked.push('dgram'); } finally { udp.close(); }
      console.log(blocked.sort().join(','));
    `], {
      cwd: new URL('../..', import.meta.url), encoding: 'utf8',
      env: { ...process.env, MEMPALACE_NETWORK_EVIDENCE: nodeEvidence,
        NODE_OPTIONS: `--import=${new URL('fixtures/network-guard.mjs', import.meta.url).pathname}` },
    });
    assert.equal(nodeProbe.status, 0, nodeProbe.stderr);
    assert.equal(nodeProbe.stdout.trim(), 'dgram,dns,fetch,http,net');
    assert.equal(readFileSync(nodeEvidence, 'utf8').trim().split('\n').length, 5);

    const pythonEvidence = join(scratch, 'python.log');
    const pythonProbe = spawnSync('python3', ['-c', `
import socket
s=socket.socket(); assert s.connect_ex(('203.0.113.10', 80)) != 0
for call in [lambda: socket.getaddrinfo('example.com', 443), lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b'x', ('203.0.113.10', 53))]:
  try: call()
  except OSError: pass
  else: raise AssertionError('network call was not denied')
if hasattr(socket.socket, 'sendmsg'):
  receiver=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); sender=socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
  try:
    receiver.bind(('127.0.0.1', 0)); receiver.settimeout(1); sender.connect(receiver.getsockname())
    assert sender.sendmsg([b'ok']) == 2; assert receiver.recvfrom(2)[0] == b'ok'
  finally: sender.close(); receiver.close()
  try: socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendmsg([b'x'], [], 0, ('203.0.113.10', 53))
  except OSError: pass
  else: raise AssertionError('sendmsg was not denied')
`], {
      encoding: 'utf8', env: { ...process.env, MEMPALACE_NETWORK_EVIDENCE: pythonEvidence,
        PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: new URL('fixtures', import.meta.url).pathname },
    });
    assert.equal(pythonProbe.status, 0, pythonProbe.stderr);
    assert.equal(
      existsSync(new URL('fixtures/__pycache__', import.meta.url)),
      false,
      'network probe must not dirty the verified source tree',
    );
    assert.match(readFileSync(pythonEvidence, 'utf8'), /connect_ex[\s\S]*getaddrinfo[\s\S]*sendto[\s\S]*sendmsg/u);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('retired smoke harness cannot return', () => {
  assert.throws(() => read('scripts/smoke-extension.mjs'));
  assert.doesNotMatch(read('scripts/gate-core.sh'), /smoke-extension\.mjs/u);
});
