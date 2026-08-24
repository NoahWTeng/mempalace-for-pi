import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { redactSecrets } from './check-public-repository.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  assert(value && !value.startsWith('--'), `${name} requires a value`);
  return value;
}

for (let index = 2; index < process.argv.length; index += 2) {
  assert(process.argv[index] === '--runs' || process.argv[index] === '--tarball',
    `unknown argument: ${process.argv[index]}`);
}

const runs = Number(argument('--runs', '3'));
const candidateTarball = argument('--tarball');
assert(Number.isInteger(runs) && runs > 0, '--runs must be a positive integer');

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new Error(`Invalid JSON: ${path}`, { cause });
  }
}

const startedAt = new Date().toISOString();
const startedClock = performance.now();
const evidence = {
  schemaVersion: 1,
  candidate: {},
  environment: {
    arch: process.arch,
    node: process.version,
    platform: process.platform,
  },
  support: {},
  checks: [],
  enforcedBindings: [],
  knownLimitations: [
    'Local-only memory: no remote sync, embeddings, or shared-memory service.',
    'Inspection, export, correction, and forget commands are not included in 0.1.0.',
    'Linux and current-runtime matrix evidence is a separate blocking release task.',
    'Publication and tag creation require explicit owner authorization.',
  ],
  security: {
    acceptedRisks: [],
    blockingSeverities: ['critical', 'high'],
    confidence: 'npm registry advisory data',
  },
  authorization: 'explicit-owner-decision-required',
  startedAt,
  verdict: 'BLOCKED',
};

const temporary = mkdtempSync(join(tmpdir(), 'mempalace-for-pi-release-'));
const evidenceDirectory = resolve(process.env.RELEASE_EVIDENCE_DIR ?? '.release-evidence');
const evidencePath = join(evidenceDirectory, 'latest.json');

function commandText(command, args) {
  return [command, ...args].join(' ');
}

// A failed release check that records only its exit status cannot be diagnosed
// afterwards, and the run that produced it is expensive to repeat. The tail is
// what carries the assertion or stack that ended the child, so the transcript
// is kept from the end and capped to keep the evidence file bounded. A child of
// a release check handles credentials, and this transcript is written to an
// evidence file and to stderr, so it is redacted before it is bounded: the cap
// then applies to what is actually retained, and the diagnostic tail survives.
const FAILED_OUTPUT_MAX_CHARS = 2000;
const FAILED_SUMMARY_MAX_CHARS = FAILED_OUTPUT_MAX_CHARS / 2;
const FAILED_SUMMARY_LINE_MAX_CHARS = 180;
const FAILED_TEST_LINE = /^\s*not ok \d+\s+-\s+\S/u;
const TEST_TOTAL_LINE = /^[#ℹ] (?:tests|pass|fail|cancelled) \d+$/u;

function prefixWithoutSplitCharacter(value, maximum) {
  let end = Math.min(value.length, maximum);
  if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]) && /[\uDC00-\uDFFF]/u.test(value[end])) end -= 1;
  return value.slice(0, end);
}

function suffixWithoutSplitCharacter(value, maximum) {
  let start = Math.max(0, value.length - maximum);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(value[start]) && /[\uD800-\uDBFF]/u.test(value[start - 1])) start += 1;
  return value.slice(start);
}

function failedTestSummary(output, maximum) {
  const lines = output.split(/\r?\n/u);
  const failures = lines.filter((line) => FAILED_TEST_LINE.test(line));
  const prioritized = [...new Set([...failures.slice(0, 2), ...failures.slice(-2)])];
  const totals = lines.map((line) => line.trimEnd()).filter((line) => TEST_TOTAL_LINE.test(line)).slice(-4);
  let summary = '';
  for (const line of [...prioritized, ...totals]) {
    const bounded = prefixWithoutSplitCharacter(line.trim(), FAILED_SUMMARY_LINE_MAX_CHARS);
    const next = summary ? `${summary}\n${bounded}` : bounded;
    if (next.length > Math.min(FAILED_SUMMARY_MAX_CHARS, maximum / 2)) break;
    summary = next;
  }
  return summary;
}

function boundedOutput(output, maximum = FAILED_OUTPUT_MAX_CHARS) {
  const redacted = redactSecrets(output);
  if (redacted.length <= maximum) return redacted;
  const summary = failedTestSummary(redacted, maximum);
  const prefix = summary ? `${summary}\n\u2026\n` : '\u2026';
  return `${prefix}${suffixWithoutSplitCharacter(redacted, maximum - prefix.length)}`;
}

function runCheck(name, category, command, args, enforceStatus = true) {
  const checkStarted = performance.now();
  const result = spawnSync(command, args, { encoding: 'utf8', env: process.env, timeout: 240_000 });
  const check = {
    category,
    command: commandText(command, args),
    durationMs: Number((performance.now() - checkStarted).toFixed(2)),
    name,
    outcome: result.status === 0 && !result.error ? 'PASS' : 'FAIL',
  };
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (check.outcome === 'FAIL') check.output = boundedOutput(output);
  evidence.checks.push(check);
  if (result.error) throw new Error(`${name} failed to start`, { cause: result.error });
  if (enforceStatus && result.status !== 0) {
    const context = `${name} failed with exit ${result.status}: `;
    throw new Error(`${context}${boundedOutput(output, FAILED_OUTPUT_MAX_CHARS - context.length)}`);
  }
  return { output, status: result.status };
}

function expectedBinding(name) {
  if (!Object.hasOwn(process.env, name)) return;
  evidence.enforcedBindings.push(name);
  const value = process.env[name];
  assert(value, `${name} must not be empty`);
  return value;
}

function assertExpectedEnvironment() {
  const expectedPlatform = expectedBinding('EXPECTED_PLATFORM');
  if (expectedPlatform) assert.equal(process.platform, expectedPlatform, 'unexpected platform');
  const expectedArch = expectedBinding('EXPECTED_ARCH');
  if (expectedArch) assert.equal(process.arch, expectedArch, 'unexpected architecture');
  const expectedNode = expectedBinding('EXPECTED_NODE_VERSION');
  if (!expectedNode) return;
  if (expectedNode.endsWith('.x')) {
    assert(process.version.startsWith(`v${expectedNode.slice(0, -1)}`), 'unexpected Node major version');
  } else {
    assert.equal(process.version, `v${expectedNode}`, 'unexpected Node version');
  }
}

function writeEvidence() {
  mkdirSync(evidenceDirectory, { recursive: true });
  const pendingPath = `${evidencePath}.${process.pid}.tmp`;
  writeFileSync(pendingPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  renameSync(pendingPath, evidencePath);
}

writeEvidence();
try {
  assertExpectedEnvironment();
  const commitResult = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (commitResult.status !== 0) throw new Error(commitResult.stderr || 'git commit identity unavailable');
  const statusResult = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
  if (statusResult.status !== 0) throw new Error(statusResult.stderr || 'git source status unavailable');
  const dirty = statusResult.stdout.trim().length > 0;
  evidence.source = { commit: commitResult.stdout.trim(), dirty };
  const expectedSourceCommit = expectedBinding('EXPECTED_SOURCE_COMMIT');
  if (expectedSourceCommit) {
    assert.equal(evidence.source.commit, expectedSourceCommit, 'source commit differs from matrix identity');
    assert.equal(dirty, false, 'source tree differs from matrix commit');
  }

  const packageJson = readJson('package.json');
  const lockJson = readJson('package-lock.json');
  assert.equal(packageJson.version, '0.1.0', 'release candidate version must be 0.1.0');
  assert.equal(lockJson.version, packageJson.version, 'package-lock version differs from package version');
  assert.equal(lockJson.packages?.['']?.version, packageJson.version, 'package-lock root version differs');

  let sourceTarball;
  if (candidateTarball) {
    sourceTarball = resolve(candidateTarball);
    assert(existsSync(sourceTarball), `candidate tarball does not exist: ${sourceTarball}`);
  } else {
    const packResult = spawnSync('npm', ['pack', '--json', '--pack-destination', temporary], { encoding: 'utf8' });
    if (packResult.error) throw new Error('npm pack failed to start', { cause: packResult.error });
    if (packResult.status !== 0) throw new Error(packResult.stderr || 'npm pack failed');
    const [packed] = JSON.parse(packResult.stdout);
    assert(packed?.filename, 'npm pack did not return a tarball');
    sourceTarball = join(temporary, basename(packed.filename));
  }
  const tarball = join(temporary, 'candidate.tgz');
  copyFileSync(sourceTarball, tarball);
  const manifestResult = spawnSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' });
  if (manifestResult.error) throw new Error('tar failed to start', { cause: manifestResult.error });
  if (manifestResult.status !== 0) throw new Error(manifestResult.stderr || 'tarball manifest missing');
  let candidateManifest;
  try {
    candidateManifest = JSON.parse(manifestResult.stdout);
  } catch (cause) {
    throw new Error('tarball manifest is invalid JSON', { cause });
  }
  assert.equal(candidateManifest.name, packageJson.name, 'tarball name differs from workspace metadata');
  assert.equal(candidateManifest.version, packageJson.version, 'tarball version differs from workspace metadata');
  evidence.candidate = {
    name: candidateManifest.name,
    sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex'),
    tarball: basename(tarball),
    version: candidateManifest.version,
  };
  const expectedCandidateSha = expectedBinding('EXPECTED_CANDIDATE_SHA256');
  if (expectedCandidateSha) {
    assert.equal(
      evidence.candidate.sha256,
      expectedCandidateSha,
      'candidate SHA-256 differs from matrix identity',
    );
  }
  evidence.support = {
    node: candidateManifest.engines?.node,
    pi: candidateManifest.peerDependencies?.['@earendil-works/pi-coding-agent'],
  };
  evidence.security.auditScope = 'full installed tree, including development copies of peer dependencies';
  evidence.security.productionDependencies = Object.keys(candidateManifest.dependencies ?? {}).length;
  writeEvidence();

  const piBinary = process.env.PI_BINARY ?? 'pi';
  evidence.environment.pi = runCheck('Pi version', 'compatibility', piBinary, ['--version']).output;
  runCheck('Candidate inspection', 'packaging', process.execPath, [
    'scripts/check-package.mjs', '--tarball', tarball,
  ]);
  runCheck('Type check', 'compatibility', 'npm', ['run', 'check']);
  runCheck('Functional tests', 'functional', 'npm', ['test']);
  runCheck('Lifecycle acceptance', 'lifecycle', process.execPath, [
    '--test', '--experimental-strip-types',
    'test/mempalace/lifecycle.test.ts',
    'test/mempalace/wakeup.test.ts',
    'test/mempalace/compact-handoff.test.ts',
  ]);
  for (let runIndex = 1; runIndex <= runs; runIndex++) {
    runCheck(`Package boundary ${runIndex}/${runs}`, 'lifecycle-recovery', 'npm', [
      'run', 'test:package-boundary',
    ]);
  }
  const auditResult = runCheck('Installed dependency audit', 'security', 'npm', [
    'audit', '--audit-level=high', '--json',
  ], false);
  let audit;
  try {
    audit = JSON.parse(auditResult.output);
  } catch (cause) {
    throw new Error('npm audit returned invalid JSON', { cause });
  }
  evidence.security.findings = audit.metadata?.vulnerabilities ?? {};
  evidence.security.acceptedRisks = ['low', 'moderate'].flatMap((severity) => {
    const count = Number(evidence.security.findings[severity] ?? 0);
    return count > 0 ? [{ count, severity }] : [];
  });
  const blockingFindings = Number(evidence.security.findings.high ?? 0) +
    Number(evidence.security.findings.critical ?? 0);
  if (blockingFindings > 0) throw new Error(`npm audit found ${blockingFindings} High/Critical vulnerabilities`);
  if (auditResult.status !== 0) throw new Error(`npm audit failed with exit ${auditResult.status}`);

  evidence.completedAt = new Date().toISOString();
  evidence.durationMs = Number((performance.now() - startedClock).toFixed(2));
  evidence.verdict = 'PASS';
  writeEvidence();
  process.stdout.write(`${JSON.stringify({ evidence: evidencePath, verdict: evidence.verdict })}\n`);
} catch (error) {
  evidence.completedAt = new Date().toISOString();
  evidence.durationMs = Number((performance.now() - startedClock).toFixed(2));
  evidence.error = boundedOutput(error instanceof Error ? error.message : String(error));
  writeEvidence();
  process.stderr.write(`${JSON.stringify({ evidence: evidencePath, error: evidence.error, verdict: evidence.verdict })}\n`);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
