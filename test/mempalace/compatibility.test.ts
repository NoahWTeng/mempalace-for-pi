import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const matrixEvidence = createRequire(import.meta.url)('./matrix-evidence.mjs') as {
  assertMatrixEvidenceBound: (evidence: Record<string, any>, options?: {
    root?: string;
    env?: Record<string, string | undefined>;
  }) => {
    anchored: boolean;
    declared: Array<Record<string, string>>;
  };
  packCandidateDigest: (root: string) => string;
};

function readRepositoryFile(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function readManifest(): Record<string, unknown> {
  return JSON.parse(readRepositoryFile('package.json'));
}

// The filename `npm pack` derives from the manifest: a scope loses its `@` and
// its separator becomes a hyphen. Consumers that hardcode the previous name
// silently stop finding the candidate, so they are checked against this.
function packedTarballName(manifest: Record<string, unknown>): string {
  return `${String(manifest.name).replace(/^@/, '').replace('/', '-')}-${String(manifest.version)}.tgz`;
}

// The declaration module does not exist during RED; loading it lazily keeps the
// manifest, licence, and provenance regressions independently observable.
function loadCompatibility() {
  return import('../../integration/compatibility.ts');
}


test('the manifest carries the public integration identity', () => {
  const manifest = readManifest();
  assert.equal(manifest.name, 'mempalace-for-pi');
  assert.deepEqual(manifest.keywords, ['pi-package', 'pi', 'extension', 'mempalace', 'mcp', 'memory']);
  assert.deepEqual(manifest.repository, {
    type: 'git',
    url: 'git+https://github.com/NoahWTeng/mempalace-for-pi.git',
  });
  assert.equal(manifest.license, 'MIT');
});

// This guard was the inverse until the owner authorised publication: it held
// `private: true` so an accidental `npm publish` could not succeed. Publication
// is now intended, so the same guard pins the identity that gets published —
// wrong name or version reaches the registry once and cannot be taken back.
test('the manifest publishes under exactly the intended identity', () => {
  const manifest = readManifest();
  assert.equal(manifest.private, undefined, 'a private manifest cannot be published');
  assert.equal(manifest.name, 'mempalace-for-pi');
  assert.equal(manifest.version, '1.0.0');
  // Left undefined deliberately: an unscoped package already publishes publicly
  // to the default registry, so the only thing a publishConfig could do here is
  // redirect the release somewhere the reader is not expecting.
  assert.equal(manifest.publishConfig, undefined, 'a publishConfig would redirect the release');
});

test('the lock metadata matches the root manifest', () => {
  const manifest = readManifest();
  const lock = JSON.parse(readRepositoryFile('package-lock.json'));
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].name, manifest.name);
  assert.equal(lock.packages[''].version, manifest.version);
});

test('the package exposes only the public integration after cutover', () => {
  const manifest = readManifest();
  // Exact rather than partial: `pi` is the whole surface Pi loads from this
  // package, so a key added here is a capability shipped to every install. The
  // prompt directory is declared and the extension entry is unchanged; anything
  // else appearing in this object is a widening that was never reviewed.
  assert.deepEqual(manifest.pi, {
    extensions: ['./extensions/index.ts'],
    prompts: ['./prompts'],
  });
  assert.deepEqual(manifest.exports, { '.': './extensions/index.ts' });
});

test('only Pi-bundled packages are declared as peers and nothing is bundled', () => {
  const manifest = readManifest();
  assert.deepEqual(Object.keys(manifest.peerDependencies as object).sort(), [
    '@earendil-works/pi-coding-agent',
    'typebox',
  ]);
  assert.equal(manifest.dependencies, undefined, 'a runtime dependency would bundle a Pi-provided package');
  assert.equal(manifest.optionalDependencies, undefined);
  assert.equal(manifest.bundleDependencies, undefined);
  assert.equal(manifest.bundledDependencies, undefined);
});

test('compatibility declares only the Pi and MemPalace versions Task 6 will verify', async () => {
  const compatibility = await loadCompatibility();
  assert.deepEqual([...compatibility.SUPPORTED_PI_VERSIONS], ['0.84.2']);
  assert.deepEqual([...compatibility.SUPPORTED_MEMPALACE_VERSIONS], ['3.9.0']);
  assert.deepEqual(compatibility.COMPATIBILITY_PAIRINGS, [
    { pi: '0.84.2', mempalace: '3.9.0', verification: 'verified' },
  ]);
});

test('compatibility declares the tested host environment without a Windows claim', async () => {
  const compatibility = await loadCompatibility();
  assert.deepEqual([...compatibility.SUPPORTED_NODE_VERSIONS], ['22.19.0', '24.x']);
  assert.deepEqual([...compatibility.SUPPORTED_PYTHON_VERSIONS], ['3.12']);
  assert.deepEqual([...compatibility.SUPPORTED_PLATFORMS], ['darwin']);
  assert.deepEqual([...compatibility.SUPPORTED_ARCHITECTURES], ['arm64']);
  assert.ok(
    !compatibility.SUPPORTED_PLATFORMS.includes('win32' as never),
    'Windows is untested and must not be claimed',
  );
});

test('every declared version combination has a pairing entry', async () => {
  const compatibility = await loadCompatibility();
  const expected = compatibility.SUPPORTED_PI_VERSIONS.flatMap((pi) =>
    compatibility.SUPPORTED_MEMPALACE_VERSIONS.map((mempalace) => `${pi}+${mempalace}`),
  ).sort();
  const declared = compatibility.COMPATIBILITY_PAIRINGS
    .map((pairing) => `${pairing.pi}+${pairing.mempalace}`)
    .sort();
  assert.deepEqual(
    declared,
    expected,
    'a version list grew without a matching pairing; compatibility must not expand silently',
  );
});

test('CI and the CI gate consume or measure the candidate this manifest packs', () => {
  const expected = packedTarballName(readManifest());
  const workflowCandidates = [...readRepositoryFile('.github/workflows/ci.yml').matchAll(/[A-Za-z0-9@._-]+-\d+\.\d+\.\d+\.tgz/g)]
    .map(([match]) => match);
  assert.ok(workflowCandidates.length > 0, 'the workflow must name the release candidate tarball');
  for (const candidate of workflowCandidates) {
    assert.equal(candidate, expected, 'CI consumes a stale candidate tarball name');
  }
  assert.match(readRepositoryFile('scripts/gate-ci.sh'), /--tarball/u);
  assert.match(readRepositoryFile('scripts/gate-ci.sh'), /shasum -a 256/u);
});

// The release workflow is held to the opposite rule, and deliberately so. The
// matrix jobs above mount one specific artifact by name, so a stale name there
// would silently verify the wrong file. The release workflow instead packs the
// tree it checked out and compares that digest to the attested one, so naming a
// version at all would add a literal that goes stale at the next bump while
// proving nothing the digest comparison does not already prove.
test('the release workflow derives the candidate instead of naming a version', () => {
  const release = readRepositoryFile('.github/workflows/release.yml');
  assert.deepEqual([...release.matchAll(/[A-Za-z0-9@._-]+-\d+\.\d+\.\d+\.tgz/g)].map(([m]) => m), []);
  assert.match(release, /npm pack --pack-destination/u, 'the release must pack the tree it verifies');
  assert.match(release, /candidateSha256/u, 'the release must compare against the attested digest');
});

// The release gate asserts that package.json and both places package-lock.json
// records a version agree with each other. It used to assert they all equalled
// the literal `0.1.0`, which made it impossible to release anything else: a
// correct `npm version` bump updates all three consistently and the gate still
// threw, reporting inconsistent metadata that was in fact consistent. Nothing
// caught it, because the gate is only reached on a release and there had only
// ever been one. The consistency rule is worth keeping; the pin is not.
test('the release gate checks version consistency without pinning a version', () => {
  const gate = readRepositoryFile('scripts/gate-release.sh');
  // Scoped to the block before the argument-handling helpers rather than the
  // whole file: further down the gate legitimately quotes versions in fixtures,
  // and a test that scanned those would fail for the wrong reason. If the marker
  // ever moves, say so instead of quietly widening to the whole file.
  const [consistency] = gate.split('\nexpect_argument_failure()');
  assert.ok(consistency && consistency !== gate, 'the version consistency block was not found');
  assert.deepEqual(
    [...consistency.matchAll(/pkg\.version\s*!==\s*'[^']+'/gu)].map(([match]) => match),
    [],
    'the release gate must not compare the package version against a literal',
  );
  assert.match(consistency, /lock\.version !== pkg\.version/u, 'lock and manifest must still agree');
  assert.match(consistency, /lock\.packages\[''\]\.version !== pkg\.version/u, 'the lock root entry must still agree');

  // The same pin survived in the evidence gate, which is a separate file and was
  // therefore missed when the shell gate was fixed. It only surfaced on the next
  // release, where it threw before recording anything and took three unrelated
  // transcript tests down with it. Both copies are checked here so the variant
  // cannot come back through whichever file is not being looked at.
  const evidenceGate = readRepositoryFile('scripts/release-gate.mjs');
  assert.deepEqual(
    [...evidenceGate.matchAll(/packageJson\.version,\s*'\d+\.\d+\.\d+'/gu)].map(([match]) => match),
    [],
    'the evidence gate must not compare the package version against a literal',
  );
  assert.match(evidenceGate, /lockJson\.version, packageJson\.version/u, 'lock and manifest must still agree');

  // A fourth copy lived past the marker above, in the block that inspects the
  // recorded evidence, so scoping the first assertion to the consistency block
  // hid it — correctly, since the fixtures down there quote versions on purpose.
  // This one is matched by its subject rather than its position: a comparison of
  // the candidate's version against a literal is always the defect, and a JSON
  // fixture that merely contains a version string is never it.
  assert.deepEqual(
    [...gate.matchAll(/evidence\.candidate\.version\s*!==\s*'\d+\.\d+\.\d+'/gu)].map(([match]) => match),
    [],
    'the release gate must not compare the recorded candidate version against a literal',
  );
  assert.match(
    gate,
    /evidence\.candidate\.version !== manifest\.version/u,
    'the recorded candidate must still be required to name the manifest version',
  );
});

// The eight cells each measured one pairing and then nothing joined them up:
// the records were printed to a log the runner discarded, so refreshing the
// committed evidence meant re-running the whole matrix locally and assembling
// the file by hand. A manual step over evidence is exactly where a hand-written
// digest gets in, so the wiring that carries a record from the cell that
// measured it to the file the release gate reads is asserted here rather than
// left to a gate that only runs on a dispatch.
test('every matrix cell persists and uploads the record it measured', () => {
  const workflow = readRepositoryFile('.github/workflows/ci.yml');
  for (const [job, persists] of [
    ['macos-arm64', 'MEMPALACE_MATRIX_EVIDENCE='],
  ] as const) {
    const body = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n {2}[a-z0-9-]+:\n/u)[0];
    assert.ok(body, `matrix job not found: ${job}`);
    assert.ok(body.includes(persists), `${job} does not persist its matrix record`);
    assert.match(body, /name: matrix-evidence-/u, `${job} does not upload its matrix record`);
    // A cell that passes while writing nothing would aggregate as an absent
    // cell, which reads as a smaller matrix rather than as a broken one.
    assert.match(
      body,
      /test -s "\$RUNNER_TEMP\/matrix-evidence\.jsonl"|test -s "\$MEMPALACE_MATRIX_EVIDENCE"/u,
      `${job} does not fail when its record is empty`,
    );
  }
  assert.match(workflow, /aggregate-matrix-evidence\.mjs/u, 'per-cell records are never aggregated');
  // Committing from CI would need `contents: write` in a workflow that also runs
  // fork pull requests. The aggregate is published for a human to commit.
  assert.doesNotMatch(workflow, /git (?:commit|push)/u, 'CI must not write to the repository');
});

// The aggregator decides nothing: it copies measured fields and refuses to write
// unless the records are complete. The size it enforces therefore has to come
// from the declared support surface rather than a number typed into the script —
// a hard-coded cell count would keep the old matrix size after the surface grew,
// which is the defect that pinned the release gate to one version forever.
test('the aggregator derives its expected cells from the declared surface', () => {
  const aggregator = readRepositoryFile('scripts/aggregate-matrix-evidence.mjs');
  assert.match(aggregator, /compatibility\.ts/u, 'the aggregator ignores the declared surface');
  // Comparing a length against zero is an emptiness guard and is wanted. What
  // must not appear is a comparison against a specific expected size, which is
  // the form that silently keeps the old matrix after the surface grows.
  assert.deepEqual(
    [...aggregator.matchAll(/\.length\s*[!=]==?\s*([1-9]\d*)/gu)].map(([match]) => match),
    [],
    'the aggregator pins a cell count instead of deriving it',
  );
  for (const refusal of [
    'ran without EXPECTED_NODE_VERSION',
    'reports outcome',
    'ran against a different',
    'no record for declared cell',
    'duplicate cell',
  ]) {
    assert.ok(aggregator.includes(refusal), `the aggregator lost its "${refusal}" refusal`);
  }
});

test('the CI gate keeps host integrity checks without Linux product execution', () => {
  const workflow = readRepositoryFile('.github/workflows/ci.yml');
  const gate = readRepositoryFile('scripts/gate-ci.sh');
  assert.match(workflow, /quick:[\s\S]*bash scripts\/gate-ci\.sh/u);
  assert.match(workflow, /actionlint_1\.7\.12_linux_amd64\.tar\.gz/u);
  assert.match(workflow, /8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8/u);
  assert.match(gate, /EXPECTED_PLATFORM=.*process\.platform/u);
  assert.doesNotMatch(gate, /docker|run_linux|--linux|linux-arm64|node@sha256/u);
  assert.doesNotMatch(workflow, /linux-arm64:|gate-ci\.sh --linux|docker run/u);
});

test('the CI gate rejects a self-hosted runner', () => {
  const result = runCiGateWithMutation('.github/workflows/ci.yml', (source) => {
    const mutated = source.replace('runs-on: ubuntu-latest', 'runs-on: self-hosted');
    assert.notEqual(mutated, source);
    return mutated;
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /declares a self-hosted runner/u);
});

test('the CI gate rejects an unpinned action', () => {
  const result = runCiGateWithMutation('.github/workflows/ci.yml', (source) => {
    const mutated = source.replace(
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      'actions/checkout@v4',
    );
    assert.notEqual(mutated, source);
    return mutated;
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /action is not SHA-pinned/u);
});

test('the CI gate rejects checkout credential persistence', () => {
  const mutated = runCiGateWithMutation('.github/workflows/ci.yml', (source) => {
    const withoutPersistence = source.replace('          persist-credentials: false\n', '');
    assert.notEqual(withoutPersistence, source);
    return withoutPersistence;
  });
  assert.notEqual(mutated.status, 0);
  assert.match(`${mutated.stdout}\n${mutated.stderr}`, /checkout lacks persist-credentials: false/u);
});

test('the CI gate rejects excessive publication authority', () => {
  const result = runCiGateWithMutation('.github/workflows/release.yml', (source) => {
    const mutated = source.replace(
      '  verify:\n',
      '  verify:\n    permissions:\n      contents: write\n',
    );
    assert.notEqual(mutated, source);
    return mutated;
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /exactly one job may write repository contents/u);
});

// Active verification must observe only the current MemPalace integration. A
// gate that still runs, requires, or typechecks the retired Pi Mnesia runtime
// or its historical benchmarks keeps this repository bound to code it neither
// ships nor supports, and that dependency is invisible while the retired trees
// happen to be present.
const ACTIVE_VERIFICATION_SOURCES = [
  'package.json',
  'tsconfig.json',
  'scripts/release-gate.mjs',
  'scripts/gate-release.sh',
  'scripts/gate-community-mempalace.sh',
  'scripts/gate-core.sh',
  'scripts/gate-packaged.sh',
  'scripts/gate-ci.sh',
  'scripts/aggregate-matrix-evidence.mjs',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
];

function currentMemPalaceSuites(): string[] {
  return readdirSync(join(root, 'test', 'mempalace'))
    .filter((entry) => /\.test\.(?:ts|mjs)$/u.test(entry))
    .map((entry) => `test/mempalace/${entry}`)
    .sort();
}

// The default suite selects its files with shell globs, so the only faithful
// way to ask what it runs is to expand those globs against the working tree.
function expandOperand(operand: string): string[] {
  const separator = operand.lastIndexOf('/');
  const directory = operand.slice(0, separator);
  const pattern = new RegExp(`^${operand
    .slice(separator + 1)
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('[^/]*')}$`, 'u');
  return readdirSync(join(root, directory))
    .filter((entry) => pattern.test(entry))
    .map((entry) => `${directory}/${entry}`);
}

function selectedSuites(command: string): string[] {
  return command
    .split(/\s+/u)
    .filter((token) => token.includes('/') && !token.startsWith('-'))
    .flatMap(expandOperand)
    .sort();
}

// Splitting on the call site keeps the declaration itself out of the sample:
// its body contains no suite path, so it can never satisfy the assertions.
function releaseGateChecks(source: string): string[] {
  return source.split('runCheck(').slice(1).map((rest) => rest.slice(0, rest.indexOf(');')));
}

function withoutMatrixAnchors(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.EXPECTED_CANDIDATE_SHA256;
  delete env.EXPECTED_SOURCE_COMMIT;
  return env;
}

type WorkflowPath = '.github/workflows/ci.yml' | '.github/workflows/release.yml';

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function runCiGateWithMutation(path: WorkflowPath, mutate: (source: string) => string) {
  const sandbox = mkdtempSync(join(tmpdir(), 'mempalace-ci-gate-'));
  try {
    const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
    assert.equal(tracked.status, 0, tracked.stderr);
    for (const file of tracked.stdout.split('\0').filter(Boolean)) {
      const destination = join(sandbox, file);
      mkdirSync(dirname(destination), { recursive: true });
      const source = readRepositoryFile(file);
      writeFileSync(destination, file === path ? mutate(source) : source);
    }

    runGit(sandbox, ['init', '-q']);
    runGit(sandbox, ['config', 'user.name', 'compatibility test']);
    runGit(sandbox, ['config', 'user.email', 'compatibility@example.invalid']);
    runGit(sandbox, ['add', '-A']);
    runGit(sandbox, ['commit', '-qm', 'fixture']);

    const bin = join(sandbox, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'actionlint'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const pathValue = process.env.PATH ? `${bin}:${process.env.PATH}` : bin;
    return spawnSync('bash', ['scripts/gate-ci.sh'], {
      cwd: sandbox,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: join(sandbox, 'home'),
        NPM_CONFIG_USERCONFIG: '/dev/null',
        PATH: pathValue,
        npm_config_cache: join(sandbox, 'npm-cache'),
        npm_config_update_notifier: 'false',
      },
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test('the default suite runs every current MemPalace suite and no retired suite', () => {
  const scripts = readManifest().scripts as Record<string, string | undefined>;
  const command = scripts.test;
  assert.ok(command, 'the manifest must declare a default test script');
  assert.ok(command.includes('--test'), 'the default suite must use the Node test runner');
  assert.ok(
    command.includes('--experimental-strip-types'),
    'the current TypeScript suites need type stripping',
  );
  assert.ok(
    command.includes('--test-concurrency=1'),
    'process-heavy suites must not depend on cross-file scheduling to avoid cancellation',
  );
  assert.deepEqual(
    selectedSuites(command),
    currentMemPalaceSuites(),
    'npm test must run exactly the current test/mempalace suites',
  );
});

test('no active gate runs, requires, or scripts the retired runtime or historical benchmarks', () => {
  assert.equal(
    existsSync(join(root, 'scripts', 'gate-memory-ab.sh')),
    false,
    'the historical A/B gate must not remain runnable',
  );
  for (const path of ACTIVE_VERIFICATION_SOURCES) {
    const source = readRepositoryFile(path);
    assert.doesNotMatch(source, /benchmarks\//u, `${path} still drives historical benchmarks`);
    assert.doesNotMatch(source, /gate-memory-ab/u, `${path} still references the deleted A/B gate`);
    assert.doesNotMatch(
      source,
      /-d (?:src|benchmarks)\b/u,
      `${path} still requires a retired tree to be present`,
    );
  }
});

test('the typecheck scope covers the current integration, entrypoint, and current tests only', () => {
  const shown = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--showConfig'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(shown.status, 0, shown.stderr);
  const resolved: string[] = JSON.parse(shown.stdout).files.map((file: string) => file.replace(/^\.\//u, ''));
  const retired = resolved.filter((file) =>
    file.startsWith('src/') ||
    file === 'extensions/lifecycle.ts' ||
    (file.startsWith('test/') && !file.startsWith('test/mempalace/')));
  assert.deepEqual(retired, [], 'npm run check still typechecks retired code');
  for (const required of [
    'integration/index.ts',
    'extensions/index.ts',
    'test/mempalace/compatibility.test.ts',
  ]) {
    assert.ok(resolved.includes(required), `npm run check must typecheck ${required}`);
  }
});

test('the release gate checks current lifecycle acceptance and still fails closed', () => {
  const lifecycle = releaseGateChecks(readRepositoryFile('scripts/release-gate.mjs'))
    .filter((call) => call.includes('test/mempalace/'));
  assert.equal(lifecycle.length, 1, 'the release gate needs exactly one current lifecycle acceptance check');
  assert.ok(
    lifecycle[0]!.includes("'--test'") && lifecycle[0]!.includes("'--experimental-strip-types'"),
    'the lifecycle acceptance check must run current suites through the Node test runner',
  );
  assert.ok(
    lifecycle[0]!.includes("'test/mempalace/lifecycle.test.ts'"),
    'the lifecycle acceptance check must cover the current lifecycle suite',
  );

  const evidenceDirectory = mkdtempSync(join(tmpdir(), 'mempalace-release-fail-closed-'));
  try {
    const blocked = spawnSync(process.execPath, ['scripts/release-gate.mjs', '--runs', '1'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PI_BINARY: join(evidenceDirectory, 'no-such-pi'), RELEASE_EVIDENCE_DIR: evidenceDirectory },
    });
    assert.notEqual(blocked.status, 0, 'a failed release check must not exit 0');
    const evidence = JSON.parse(readFileSync(join(evidenceDirectory, 'latest.json'), 'utf8'));
    assert.equal(evidence.verdict, 'BLOCKED', 'a failed release check must retain the BLOCKED verdict');
  } finally {
    rmSync(evidenceDirectory, { recursive: true, force: true });
  }
});

test('a failed release check keeps a bounded transcript of its child command', () => {
  const evidenceDirectory = mkdtempSync(join(tmpdir(), 'mempalace-release-diagnostics-'));
  try {
    const marker = 'CHILD_DIAGNOSTIC_TAIL';
    const credential = `ghp_${'Z'.repeat(36)}`;
    const privatePath = ['', 'Users', 'maintainer', 'private', 'cancelled-test.log'].join('/');
    const failing = join(evidenceDirectory, 'failing-pi');
    writeFileSync(
      failing,
      `#!/usr/bin/env node\n` +
        `process.stdout.write('# tests ' + 'A'.repeat(4000) + '\\n');\n` +
        `process.stdout.write('    not ok 17 - nested resource-sensitive cancellation α ${credential} ${privatePath}\\n');\n` +
        `process.stdout.write('# cancelled 1\\n' + 'x'.repeat(20000));\n` +
        `process.stderr.write('${marker}');\nprocess.exit(3);\n`,
      { mode: 0o755 },
    );
    const blocked = spawnSync(process.execPath, ['scripts/release-gate.mjs', '--runs', '1'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...withoutMatrixAnchors(), PI_BINARY: failing, RELEASE_EVIDENCE_DIR: evidenceDirectory },
    });
    assert.notEqual(blocked.status, 0, 'a failed child command must not exit 0');

    const evidence = JSON.parse(readFileSync(join(evidenceDirectory, 'latest.json'), 'utf8'));
    const failed = evidence.checks.find((check: Record<string, unknown>) => check.outcome === 'FAIL');
    assert.ok(failed, 'the failed check must be recorded');
    assert.equal(typeof failed.output, 'string', 'a failed check must retain its child output');
    assert.ok(failed.output.includes(marker), 'the retained output must reach the end of the transcript');
    assert.ok(
      failed.output.includes('not ok 17 - nested resource-sensitive cancellation α'),
      'the retained output must identify an indented failed or cancelled test after noisy output',
    );
    assert.ok(failed.output.includes('# cancelled 1'), 'the retained output must keep exact TAP totals');
    assert.equal(failed.output.includes(credential), false, 'the retained summary leaked a credential');
    assert.equal(failed.output.includes(privatePath), false, 'the retained summary leaked a private path');
    assert.ok(failed.output.length <= 2000, `retained output is unbounded: ${failed.output.length}`);
    assert.ok(failed.output.length < 20000, 'a 20000 character transcript must be truncated');
    assert.ok(evidence.error.includes(marker), 'the recorded error must carry the child transcript');
    assert.ok(
      evidence.error.includes('not ok 17 - nested resource-sensitive cancellation α'),
      'the recorded error must identify the failed or cancelled test',
    );
    assert.equal(evidence.error.includes(credential), false, 'the recorded error leaked a credential');
    assert.equal(evidence.error.includes(privatePath), false, 'the recorded error leaked a private path');
    assert.ok(evidence.error.length <= 2000, `recorded error is unbounded: ${evidence.error.length}`);
  } finally {
    rmSync(evidenceDirectory, { recursive: true, force: true });
  }
});

// The retained transcript is whatever the child printed, and a release check
// runs commands that handle credentials. Evidence files and gate stderr outlive
// the run and are read by people who are not entitled to that material, so the
// transcript is redacted before it is bounded — the diagnostic tail survives,
// the secret does not.
test('a failed release check redacts credentials and private paths from its transcript', () => {
  const evidenceDirectory = mkdtempSync(join(tmpdir(), 'mempalace-release-redaction-'));
  try {
    const marker = 'CHILD_DIAGNOSTIC_TAIL';
    // Assembled from parts so this suite carries no credential or private-path
    // literal of its own: the child prints them, the gate must not keep them.
    const credential = `ghp_${'B'.repeat(36)}`;
    const privatePath = ['', 'Users', 'maintainer', 'private', 'release-gate.json'].join('/');
    const leaking = join(evidenceDirectory, 'leaking-pi');
    writeFileSync(
      leaking,
      `#!/usr/bin/env node\nprocess.stdout.write('${credential}\\n${privatePath}\\n');\n` +
        `process.stderr.write('${marker}');\nprocess.exit(3);\n`,
      { mode: 0o755 },
    );
    const blocked = spawnSync(process.execPath, ['scripts/release-gate.mjs', '--runs', '1'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...withoutMatrixAnchors(), PI_BINARY: leaking, RELEASE_EVIDENCE_DIR: evidenceDirectory },
    });
    assert.notEqual(blocked.status, 0, 'a leaking child command must not exit 0');

    const evidence = JSON.parse(readFileSync(join(evidenceDirectory, 'latest.json'), 'utf8'));
    const failed = evidence.checks.find((check: Record<string, unknown>) => check.outcome === 'FAIL');
    assert.ok(failed, 'the failed check must be recorded');
    for (const [name, transcript] of [
      ['check output', String(failed.output)],
      ['recorded error', String(evidence.error)],
      ['gate stderr', blocked.stderr],
    ] as const) {
      assert.ok(transcript.includes(marker), `${name} lost the diagnostic tail`);
      assert.ok(!transcript.includes(credential), `${name} retains a credential`);
      assert.ok(!transcript.includes(privatePath), `${name} retains a private absolute path`);
    }
    assert.ok(failed.output.length <= 4096, `retained output is unbounded: ${failed.output.length}`);
  } finally {
    rmSync(evidenceDirectory, { recursive: true, force: true });
  }
});

test('packaged acceptance asserts the package identity the manifest declares', () => {
  const manifest = readManifest();
  const acceptance = readRepositoryFile('scripts/acceptance-extension.mjs');
  const asserted = acceptance.match(/assert\.equal\(manifest\.name, '([^']+)'\)/);
  assert.ok(asserted, 'packaged acceptance must assert the installed package name');
  assert.equal(asserted[1], manifest.name, 'packaged acceptance asserts a stale package name');
});

test('a pairing may only claim verification with complete SHA-bound matrix evidence', async () => {
  const compatibility = await loadCompatibility();
  const verified = compatibility.COMPATIBILITY_PAIRINGS.filter(({ verification, mempalace }) =>
    verification === 'verified' && compatibility.SUPPORTED_MEMPALACE_VERSIONS.includes(mempalace as never));
  if (verified.length === 0) return;

  const evidencePath = join(root, '.github', 'verification', 'task-967-matrix.json');
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  const { declared } = matrixEvidence.assertMatrixEvidenceBound(evidence, { root });
  // Pinned to an empty environment so these describe the unanchored contract
  // whatever the surrounding run supplies. Inside a matrix cell the real
  // environment carries an anchor, and asserting against it here would test the
  // wrong branch — see the anchoring regression below.
  const wrongCandidate = '0'.repeat(64);
  assert.throws(
    () => matrixEvidence.assertMatrixEvidenceBound({
      ...evidence,
      candidateSha256: wrongCandidate,
      cells: evidence.cells.map((cell: Record<string, unknown>) => ({ ...cell, candidateSha256: wrongCandidate })),
    }, { root, env: {} }),
    /matrix candidate differs/u,
  );

  // A commit that resolves but is not reachable from HEAD is exactly what a
  // sibling branch or a cherry-picked original leaves behind. Building one
  // here keeps the contract observable without depending on repository layout.
  const unreachable = spawnSync('git', ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'unreachable probe'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'matrix probe',
      GIT_AUTHOR_EMAIL: 'probe@example.invalid',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_NAME: 'matrix probe',
      GIT_COMMITTER_EMAIL: 'probe@example.invalid',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  });
  assert.equal(unreachable.status, 0, unreachable.stderr);
  const unreachableCommit = unreachable.stdout.trim();
  assert.throws(
    () => matrixEvidence.assertMatrixEvidenceBound({
      ...evidence,
      sourceCommit: unreachableCommit,
      cells: evidence.cells.map((cell: Record<string, unknown>) => ({ ...cell, sourceCommit: unreachableCommit })),
    }, { root, env: {} }),
    /not an ancestor/u,
  );
  assert.match(evidence.candidateSha256, /^[a-f0-9]{64}$/u);
  assert.match(evidence.sourceCommit, /^[a-f0-9]{40}$/u);
  assert.match(evidence.sourceTree, /^[a-f0-9]{40}$/u);
  const expectedCells = declared.map((cell) => `${cell.platform}+${cell.arch}+${cell.nodeDeclared}+${cell.pi}+${cell.core}`);
  assert.deepEqual(evidence.cells.map((cell: Record<string, string>) =>
    `${cell.platform}+${cell.arch}+${cell.nodeDeclared}+${cell.pi}+${cell.core}`).sort(), expectedCells.sort());
  assert.ok(evidence.cells.every((cell: Record<string, unknown>) =>
    cell.candidateSha256 === evidence.candidateSha256 && cell.sourceCommit === evidence.sourceCommit &&
    cell.sourceTree === evidence.sourceTree && cell.outcome === 'PASS'));
  assert.deepEqual(verified.map(({ mempalace }) => mempalace).sort(), ['3.9.0']);
});

function historicalMatrix(): Record<string, any> {
  const historic = spawnSync(
    'git',
    ['show', '1f1675fe5562bb158050a9d19e88bae61123efa3:.github/verification/task-967-matrix.json'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(historic.status, 0, historic.stderr);
  return JSON.parse(historic.stdout);
}

test('the anchored authority accepts the historical eight-cell record while the current surface is four cells', () => {
  const evidence = historicalMatrix();
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(head.status, 0, head.stderr);
  assert.doesNotThrow(() => matrixEvidence.assertMatrixEvidenceBound(evidence, {
    root,
    env: {
      EXPECTED_CANDIDATE_SHA256: matrixEvidence.packCandidateDigest(root),
      EXPECTED_SOURCE_COMMIT: head.stdout.trim(),
    },
  }));
  assert.equal(evidence.cells.length, 8);
});

test('historical evidence rejects missing and extra rows instead of trimming them', () => {
  const evidence = historicalMatrix();
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(head.status, 0, head.stderr);
  const env = {
    EXPECTED_CANDIDATE_SHA256: matrixEvidence.packCandidateDigest(root),
    EXPECTED_SOURCE_COMMIT: head.stdout.trim(),
  };
  assert.throws(
    () => matrixEvidence.assertMatrixEvidenceBound({ ...evidence, cells: evidence.cells.slice(1) }, { root, env }),
    /missing|no record/u,
  );
  assert.throws(
    () => matrixEvidence.assertMatrixEvidenceBound({ ...evidence, cells: [...evidence.cells, evidence.cells[0]] }, { root, env }),
    /duplicate|exactly|cell/u,
  );
});

test('anchors are complete, well-formed, and bound to the measured candidate and HEAD', () => {
  const evidence = historicalMatrix();
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(head.status, 0, head.stderr);
  const digest = matrixEvidence.packCandidateDigest(root);
  for (const env of [
    { EXPECTED_CANDIDATE_SHA256: digest },
    { EXPECTED_SOURCE_COMMIT: head.stdout.trim() },
    { EXPECTED_CANDIDATE_SHA256: 'not-a-sha', EXPECTED_SOURCE_COMMIT: head.stdout.trim() },
    { EXPECTED_CANDIDATE_SHA256: digest, EXPECTED_SOURCE_COMMIT: '0'.repeat(40) },
  ]) {
    assert.throws(
      () => matrixEvidence.assertMatrixEvidenceBound(evidence, { root, env }),
      /anchor|SHA|commit|HEAD|source/u,
    );
  }
});

test('unanchored reads reject stale historical evidence instead of treating it as current', () => {
  assert.throws(
    () => matrixEvidence.assertMatrixEvidenceBound(historicalMatrix(), { root, env: {} }),
    /matrix candidate differs|current|declared|surface/u,
  );
});

// Refreshing the attestation was impossible for any release that touched a packed
// file. Each matrix cell runs this suite, this suite compared the committed
// evidence against a live `npm pack`, and a release changes `package.json` by
// definition — so every cell failed, the aggregation that would have refreshed
// the evidence never ran, and the only way out was the evidence it refused to
// produce. It went unseen because the file had never once been refreshed against
// a changed candidate: of the two commits that touched it, neither changed a
// packed file, and the third was the squashed initial commit where evidence and
// package were born in the same tree.
test('an attesting run binds the candidate to the anchor CI measured, not to the file it regenerates', () => {
  const evidence = JSON.parse(readRepositoryFile('.github/verification/task-967-matrix.json'));
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(head.status, 0, head.stderr);
  const commit = head.stdout.trim();
  const digest = matrixEvidence.packCandidateDigest(root);

  // What a cell sees mid-release: the committed evidence describes a candidate
  // that no longer exists, while CI hands the cell the digest it measured from
  // this very tree. The run is regenerating that file, so the file cannot also
  // be the authority for it.
  const superseded = {
    ...evidence,
    candidateSha256: '0'.repeat(64),
    cells: evidence.cells.map((cell: Record<string, any>) => ({ ...cell, candidateSha256: '0'.repeat(64) })),
  };
  assert.doesNotThrow(() => matrixEvidence.assertMatrixEvidenceBound(superseded, {
    root,
    env: {
      EXPECTED_CANDIDATE_SHA256: digest,
      EXPECTED_SOURCE_COMMIT: commit,
    },
  }));

  // The anchor is an authority, not a bypass. A tree that does not produce it is
  // still refused, and so is a tree that is not the commit CI is attesting.
  assert.throws(() => matrixEvidence.assertMatrixEvidenceBound(evidence, {
    root,
    env: {
      EXPECTED_CANDIDATE_SHA256: '0'.repeat(64),
      EXPECTED_SOURCE_COMMIT: commit,
    },
  }), /differs from the anchor/u);
  assert.throws(() => matrixEvidence.assertMatrixEvidenceBound(evidence, {
    root,
    env: {
      EXPECTED_CANDIDATE_SHA256: digest,
      EXPECTED_SOURCE_COMMIT: '0'.repeat(40),
    },
  }), /not the commit/u);

  // Without an anchor the committed file is still the authority, so a developer
  // checkout keeps catching evidence that has gone stale.
  assert.throws(() => matrixEvidence.assertMatrixEvidenceBound(superseded, { root, env: {} }), /matrix candidate differs/u);
});

test('the licence attributes the migrated integration and disclaims MemPalace core', () => {
  const license = readRepositoryFile('LICENSE');
  assert.ok(license.startsWith('MIT License'), 'the integration stays MIT licensed');
  assert.ok(license.includes('Pi Mnesia contributors'), 'the existing copyright line is retained');
  // The migrated code needs its AUTHOR named. It does not need the private
  // project it came from named: he is the sole copyright holder with no
  // third-party contribution, so the MIT grant here is his to make and the
  // origin is not something the licence depends on. `check-public-repository.mjs`
  // enforces that no tracked file names that private source, this one included.
  assert.ok(
    license.includes('Noah W. Teng') && /private predecessor extension/i.test(license),
    'the migrated code needs its own attribution',
  );
  assert.ok(
    license.includes('https://github.com/MemPalace/mempalace'),
    'the MemPalace third-party notice must name the upstream project',
  );
  assert.ok(
    /does not (?:copy|vendor|redistribute)/i.test(license),
    'the notice must state that MemPalace core is not redistributed',
  );
});

test('provenance records the snapshot, inventory, licence evidence, and no-vendoring statement', () => {
  const provenance = readRepositoryFile('MIGRATION_PROVENANCE.md');
  assert.ok(
    provenance.includes('1e7819cf4b48ba30aca577273138dde9387191f6'),
    'the exact source snapshot must be recorded',
  );
  // Paths are recorded relative to the snapshot root. What makes the inventory
  // evidence is the snapshot commit plus the per-file digests; the private
  // project's own directory layout is not evidence, and naming it would point
  // straight at the source repository.
  for (const imported of [
    'src/mcp-client.ts',
    'src/resolve.ts',
    'src/wakeup.ts',
    'src/tools.ts',
    'src/extension.ts',
    'src/index.ts',
    'src/compact-handoff.ts',
  ]) {
    // The whole table cell, not a substring: a path that merely CONTAINS the
    // relative one would let a fully-qualified private path satisfy this.
    assert.ok(
      provenance.includes(`| \`${imported}\` |`),
      `imported source file is missing from the inventory: ${imported}`,
    );
  }
  for (const excluded of [
    'src/command.ts',
    'tests/unit/run-evals-env.test.ts',
  ]) {
    assert.ok(
      provenance.includes(`| \`${excluded}\` |`),
      `excluded source file is missing from the inventory: ${excluded}`,
    );
  }
  assert.ok(provenance.includes('MIT'), 'licence evidence must be recorded');
  assert.ok(
    /MemPalace core is not (?:copied|vendored)/i.test(provenance),
    'the no-core-vendoring statement must be explicit',
  );
});
