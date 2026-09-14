import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

function executable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
}

function probe() {
  const root = mkdtempSync(join(tmpdir(), 'mempalace-gate-probe-'));
  const bin = join(root, 'bin');
  const log = join(root, 'commands.log');
  mkdirSync(bin);
  executable(join(bin, 'npm'), '#!/bin/sh\nprintf \'npm %s\\n\' "$*" >> "$PROBE_LOG"\nif [ "${PROBE_FAIL_COMMAND:-}" = "$*" ]; then exit 17; fi\n');
  executable(join(bin, 'node'), '#!/bin/sh\nprintf \'node %s\\n\' "$*" >> "$PROBE_LOG"\nif [ "${PROBE_FAIL_COMMAND:-}" = "$*" ]; then exit 19; fi\n');
  return {
    root,
    log,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, PROBE_LOG: log },
  };
}

function runScript(script, args, env) {
  return spawnSync('/bin/bash', [script, ...args], {
    cwd: new URL('../..', import.meta.url), encoding: 'utf8', env,
  });
}

function runNodeScript(script, args, env) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: new URL('../..', import.meta.url), encoding: 'utf8', env,
  });
}

function commands(log) {
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

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

test('CI prepares the verified Pi 0.84.2 and MemPalace 3.9.0 matrix', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /node-version:\s*\[22\.19\.0, 24\.x\]/u);
  assert.match(workflow, /pi-version:\s*\[0\.84\.2\]/u);
  assert.match(workflow, /mempalace-version:\s*\[3\.9\.0\]/u);
  assert.match(workflow, /gate-release\.sh[\s\S]*--mempalace-version/u);
  assert.doesNotMatch(workflow, /linux-arm64:|windows:|win32/u);
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

test('core gate runs static, full, and focused suites with fail-fast propagation', () => {
  const passing = probe();
  try {
    const result = runScript('scripts/gate-core.sh', [], passing.env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(commands(passing.log), [
      'npm run check',
      'npm run check:repository',
      'npm test',
      'node --test --experimental-strip-types test/mempalace/mcp-client.test.ts test/mempalace/mcp-client-integration.test.ts',
    ]);
  } finally {
    rmSync(passing.root, { recursive: true, force: true });
  }

  const failing = probe();
  try {
    const result = runScript('scripts/gate-core.sh', [], {
      ...failing.env, PROBE_FAIL_COMMAND: 'run check:repository',
    });
    assert.equal(result.status, 17);
    assert.deepEqual(commands(failing.log), [
      'npm run check',
      'npm run check:repository',
    ]);
  } finally {
    rmSync(failing.root, { recursive: true, force: true });
  }
});

test('pre-attestation core mode binds the current candidate and checks stale evidence separately', () => {
  const gate = read('scripts/gate-core.sh');
  assert.match(gate, /--pre-attestation/u);
  assert.match(gate, /EXPECTED_CANDIDATE_SHA256/u);
  assert.match(gate, /EXPECTED_SOURCE_COMMIT/u);
  assert.match(gate, /npm test/u);
  assert.match(gate, /unanchored/u);
});

test('concurrency waits for every unique save before the first search', () => {
  const provider = read('test/mempalace/fixtures/packaged-provider.ts');
  const uniqueSave = provider.indexOf("['palace_save', { content: unique[id],");
  const firstSearch = provider.indexOf("...unique.map((content) => ['palace_search',");
  const completion = provider.indexOf("const completed = calls[step - 1]?.[0];", uniqueSave);
  const saved = provider.indexOf("if (completed === 'palace_save' && step === 1)", completion);
  const marker = provider.indexOf("mark(root, 'saved', id);", saved);
  const barrier = provider.indexOf("waitForAll(root, 'saved', count);", marker);
  const dispatch = provider.indexOf('const next = calls[step++];', completion);
  assert.ok(uniqueSave >= 0);
  assert.ok(firstSearch > uniqueSave);
  assert.ok(completion > uniqueSave);
  assert.ok(saved > completion);
  assert.ok(marker > saved);
  assert.ok(barrier > marker);
  assert.ok(dispatch > barrier);
});

test('3.9.0 packaged gate runs the real concurrency and migration acceptance', () => {
  const gate = read('scripts/gate-packaged.sh');
  assert.match(gate, /bash scripts\/gate-core\.sh --pre-attestation/u);
  assert.match(gate, /acceptance-concurrency\.mjs/u);
});

test('3.9.0 packaged gate is safe when no tarball is selected under nounset', () => {
  const gate = read('scripts/gate-packaged.sh');
  assert.doesNotMatch(gate, /\$\{acceptance_args\[@\]\}/u);
});

test('migration acceptance promotes the copied legacy palace before reads', () => {
  const acceptance = read('scripts/acceptance-concurrency.mjs');
  assert.match(acceptance, /migrated\.call\('mempalace_add_drawer'/u);
  assert.match(acceptance, /migrationProbe\.reason, 'already_exists'/u);
});

test('concurrency kills the Hub only after every peer reaches the safe barrier', () => {
  const acceptance = read('scripts/acceptance-concurrency.mjs');
  const barrier = acceptance.indexOf("marker('ready', id)");
  const kill = acceptance.indexOf("signalOwned('hub', firstInfo.pid, 'SIGKILL')");
  assert.ok(barrier >= 0 && barrier < kill);
});

test('packaged gate runs core first and separates the explicit future selector', () => {
  const gate = read('scripts/gate-packaged.sh');
  assert.match(gate, /ACCEPTANCE_VERSIONS/iu);
  assert.match(gate, /3\.9\.0/u);
  assert.match(gate, /bash scripts\/gate-core\.sh/u);
  assert.match(gate, /packaged-real-provider\.mjs/u);
  assert.match(gate, /MEMPALACE_VERSIONS=\("3\.6\.0" "3\.7\.1"\)/u);
  assert.match(read('scripts/gate-community-mempalace.sh'), /--mempalace-version 3\.9\.0 --attested/u);
  assert.match(read('scripts/gate-community-mempalace.sh'), /release:check -- --mempalace-version 3\.9\.0 --attested/u);
  assert.match(read('scripts/gate-release.sh'), /attested=true/u);
  assert.match(read('scripts/gate-release.sh'), /acceptance_args\+=\(--attested\)/u);
  const acceptanceExtension = read('scripts/acceptance-extension.mjs');
  assert.match(acceptanceExtension, /value === '--attested'/u);
  assert.match(acceptanceExtension, /args\.push\('--attested'\)/u);
  const compatibility = read('integration/compatibility.ts');
  assert.doesNotMatch(compatibility, /mempalace: '3\.6\.0', verification: 'verified'/u);
  assert.doesNotMatch(compatibility, /mempalace: '3\.7\.1', verification: 'verified'/u);
  assert.match(compatibility, /mempalace: '3\.9\.0', verification: 'verified'/u);

  const passing = probe();
  executable(join(passing.root, 'bin', 'bash'), '#!/bin/sh\nprintf \'bash %s\\n\' "$*" >> "$PROBE_LOG"\nif [ "$1" = "scripts/gate-core.sh" ]; then exit 23; fi\nexec /bin/bash "$@"\n');
  try {
    const result = runScript('scripts/gate-packaged.sh', [], passing.env);
    assert.equal(result.status, 23);
    assert.deepEqual(commands(passing.log), ['bash scripts/gate-core.sh']);
    rmSync(passing.root, { recursive: true, force: true });
  } finally {
    rmSync(passing.root, { recursive: true, force: true });
  }

  const explicit = probe();
  executable(join(explicit.root, 'bin', 'bash'), '#!/bin/sh\nprintf \'bash %s\\n\' "$*" >> "$PROBE_LOG"\nif [ "$1" = "scripts/gate-core.sh" ]; then exit 23; fi\nexec /bin/bash "$@"\n');
  try {
    const result = runScript('scripts/gate-packaged.sh', ['--mempalace-version', '3.9.0'], explicit.env);
    assert.equal(result.status, 23);
    assert.deepEqual(commands(explicit.log), ['bash scripts/gate-core.sh --pre-attestation']);
  } finally {
    rmSync(explicit.root, { recursive: true, force: true });
  }

  const attested = probe();
  executable(join(attested.root, 'bin', 'bash'), '#!/bin/sh\nprintf \'bash %s\\n\' "$*" >> "$PROBE_LOG"\nif [ "$1" = "scripts/gate-core.sh" ]; then exit 23; fi\nexec /bin/bash "$@"\n');
  try {
    const result = runScript('scripts/gate-packaged.sh', ['--mempalace-version', '3.9.0', '--attested'], attested.env);
    assert.equal(result.status, 23);
    assert.deepEqual(commands(attested.log), ['bash scripts/gate-core.sh']);
  } finally {
    rmSync(attested.root, { recursive: true, force: true });
  }

  const forwarded = probe();
  executable(join(forwarded.root, 'bin', 'bash'), '#!/bin/sh\nprintf \'bash %s\\n\' "$*" >> "$PROBE_LOG"\nif [ "$1" = "scripts/gate-core.sh" ]; then exit 23; fi\nexec /bin/bash "$@"\n');
  try {
    const result = runNodeScript('scripts/acceptance-extension.mjs', [
      '--smoke', '--runs', '1', '--mempalace-version', '3.9.0', '--attested',
    ], forwarded.env);
    assert.equal(result.status, 1);
    assert.deepEqual(commands(forwarded.log), [
      'bash scripts/gate-packaged.sh --mempalace-version 3.9.0 --attested',
      'bash scripts/gate-core.sh',
    ]);
  } finally {
    rmSync(forwarded.root, { recursive: true, force: true });
  }

  const invalidMode = probe();
  executable(join(invalidMode.root, 'bin', 'bash'), '#!/bin/sh\nprintf \'bash %s\\n\' "$*" >> "$PROBE_LOG"\nexec /bin/bash "$@"\n');
  try {
    const result = runNodeScript('scripts/acceptance-extension.mjs', ['--smoke', '--runs', '1', '--attested'], invalidMode.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires --mempalace-version 3\.9\.0/u);
    assert.deepEqual(commands(invalidMode.log), ['bash scripts/gate-packaged.sh --attested']);
  } finally {
    rmSync(invalidMode.root, { recursive: true, force: true });
  }

  const unsupported = probe();
  try {
    const result = runScript('scripts/gate-packaged.sh', ['--mempalace-version', '3.8.0'], unsupported.env);
    assert.equal(result.status, 2);
    assert.deepEqual(commands(unsupported.log), []);
  } finally {
    rmSync(unsupported.root, { recursive: true, force: true });
  }
});

test('retired smoke harness cannot return', () => {
  assert.throws(() => read('scripts/smoke-extension.mjs'));
  assert.doesNotMatch(read('scripts/gate-core.sh'), /smoke-extension\.mjs/u);
});
