import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OID = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MATRIX_FIELDS = ['candidateSha256', 'cells', 'generatedAt', 'schemaVersion', 'sourceCommit', 'sourceTree'];
const CELL_FIELDS = [
  'arch', 'candidateSha256', 'core', 'lifecycle', 'migrationRecordsAfter', 'migrationRecordsBefore',
  'migrationRetainedPercent', 'migrationSyntheticPredecessor', 'networkAttempts', 'nodeDeclared',
  'nodeRuntime', 'outcome', 'pi', 'platform', 'sourceCommit', 'sourceTree',
];
const LEGACY_CELL_FIELDS = [
  'arch', 'candidateSha256', 'core', 'lifecycle', 'networkAttempts', 'nodeDeclared', 'nodeRuntime',
  'outcome', 'pi', 'platform', 'recordsAfter', 'recordsBefore', 'retainedPercent', 'sourceCommit',
  'sourceTree', 'syntheticPredecessor',
];
const PACKED_PATHS = [
  'package.json', 'integration', 'extensions/index.ts', 'prompts', 'docs/public',
  'README.md', 'LICENSE', 'CHANGELOG.md', 'MIGRATION_PROVENANCE.md',
];

function exactKeys(value, expected, label) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has an unexpected shape`);
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function literalList(source, name) {
  const match = source.match(new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`, 'u'));
  assert(match, `compatibility.ts does not declare ${name}`);
  const values = [...match[1].matchAll(/'([^']+)'/gu)].map(([, value]) => value);
  assert(values.length > 0, `${name} is empty`);
  assert.equal(new Set(values).size, values.length, `${name} contains a duplicate`);
  return values;
}

function surfaceFromSource(source) {
  const pairings = source.match(/COMPATIBILITY_PAIRINGS[^=]*=\s*\[([\s\S]*?)\n\];/u);
  assert(pairings, 'compatibility.ts does not declare COMPATIBILITY_PAIRINGS');
  const values = [...pairings[1].matchAll(
    /\{\s*pi:\s*'([^']+)',\s*mempalace:\s*'([^']+)',\s*verification:\s*'([^']+)'\s*\}/gu,
  )].map(([, pi, core, verification]) => ({ pi, core, verification }));
  assert(values.length > 0, 'compatibility.ts declares no pairings');
  const verified = values.filter(({ verification }) => verification === 'verified');
  assert(verified.length > 0, 'compatibility.ts declares no verified pairings');
  const expected = [];
  for (const platform of literalList(source, 'SUPPORTED_PLATFORMS')) {
    for (const arch of literalList(source, 'SUPPORTED_ARCHITECTURES')) {
      for (const nodeDeclared of literalList(source, 'SUPPORTED_NODE_VERSIONS')) {
        for (const { pi, core } of verified) expected.push({ platform, arch, nodeDeclared, pi, core });
      }
    }
  }
  return expected;
}

export function declaredSurface(root = DEFAULT_ROOT) {
  return surfaceFromSource(readFileSync(join(root, 'integration', 'compatibility.ts'), 'utf8'));
}

function surfaceAtCommit(root, commit) {
  const source = git(root, ['show', `${commit}:integration/compatibility.ts`]);
  return surfaceFromSource(source);
}

function cellKey(cell) {
  return [cell.platform, cell.arch, cell.nodeDeclared, cell.pi, cell.core].join(' / ');
}

function assertSurface(cells, expected, label) {
  const actualKeys = cells.map(cellKey);
  assert.equal(new Set(actualKeys).size, actualKeys.length, `${label} contains duplicate cells`);
  const expectedKeys = expected.map(cellKey);
  const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
  const extra = actualKeys.filter((key) => !expectedKeys.includes(key));
  assert.equal(missing.length, 0, `${label} is missing declared cell(s): ${missing.join(', ')}`);
  assert.equal(extra.length, 0, `${label} contains undeclared cell(s): ${extra.join(', ')}`);
  assert.equal(actualKeys.length, expectedKeys.length, `${label} has the wrong number of cells`);
}

export function packCandidateDigest(root = DEFAULT_ROOT) {
  const packedRoot = mkdtempSync(join(tmpdir(), 'mempalace-matrix-binding-'));
  try {
    const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', packedRoot], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(packed.status, 0, packed.stderr);
    const entries = JSON.parse(packed.stdout);
    assert.equal(entries.length, 1, 'npm pack produced an unexpected number of candidates');
    const filename = entries[0]?.filename;
    assert(filename, 'npm pack did not return a candidate');
    return createHash('sha256').update(readFileSync(join(packedRoot, filename))).digest('hex');
  } finally {
    rmSync(packedRoot, { recursive: true, force: true });
  }
}

function assertMatrixShape(evidence) {
  assert(evidence && typeof evidence === 'object' && !Array.isArray(evidence), 'matrix evidence must be an object');
  exactKeys(evidence, MATRIX_FIELDS, 'matrix evidence');
  assert.equal(evidence.schemaVersion, 1, 'matrix evidence schema is unsupported');
  assert.match(evidence.candidateSha256, SHA256, 'matrix candidate digest is malformed');
  assert.match(evidence.sourceCommit, OID, 'matrix source commit is malformed');
  assert.match(evidence.sourceTree, OID, 'matrix source tree is malformed');
  assert.match(evidence.generatedAt, ISO, 'matrix generatedAt is malformed');
  assert.equal(new Date(evidence.generatedAt).toISOString(), evidence.generatedAt, 'matrix generatedAt is not canonical');
  assert(Array.isArray(evidence.cells) && evidence.cells.length > 0, 'matrix cells are empty');
  const legacy = Object.hasOwn(evidence.cells[0], 'recordsBefore');
  const cellFields = legacy ? LEGACY_CELL_FIELDS : CELL_FIELDS;
  const retentionFields = legacy
    ? ['recordsBefore', 'recordsAfter', 'retainedPercent', 'syntheticPredecessor']
    : ['migrationRecordsBefore', 'migrationRecordsAfter', 'migrationRetainedPercent', 'migrationSyntheticPredecessor'];
  for (const [index, cell] of evidence.cells.entries()) {
    const label = `matrix cell ${index + 1}`;
    assert(cell && typeof cell === 'object' && !Array.isArray(cell), `${label} must be an object`);
    exactKeys(cell, cellFields, label);
    for (const field of ['platform', 'arch', 'nodeDeclared', 'nodeRuntime', 'pi', 'core', 'outcome', 'sourceCommit', 'sourceTree']) {
      assert.equal(typeof cell[field], 'string', `${label} ${field} is not a string`);
    }
    assert.match(cell.sourceCommit, OID, `${label} source commit is malformed`);
    assert.match(cell.sourceTree, OID, `${label} source tree is malformed`);
    assert.match(cell.candidateSha256, SHA256, `${label} candidate digest is malformed`);
    assert.match(cell.nodeRuntime, /^v\d+\.\d+\.\d+$/u, `${label} runtime version is malformed`);
    assert.equal(cell.outcome, 'PASS', `${label} did not PASS`);
    assert.equal(cell[retentionFields[0]], 5, `${label} did not measure five records before`);
    assert.equal(cell[retentionFields[1]], 5, `${label} did not retain five records`);
    assert.equal(cell[retentionFields[2]], 100, `${label} did not retain 100%`);
    assert.equal(cell.networkAttempts, 0, `${label} attempted non-loopback network`);
    assert.equal(cell[retentionFields[3]], true, `${label} lacks predecessor evidence`);
    assert(Array.isArray(cell.lifecycle) && cell.lifecycle.length > 0, `${label} has no lifecycle evidence`);
    assert(cell.lifecycle.every((phase) => typeof phase === 'string' && phase.length > 0), `${label} has malformed lifecycle evidence`);
  }
  const first = evidence.cells[0];
  for (const [index, cell] of evidence.cells.entries()) {
    const label = `matrix cell ${index + 1}`;
    assert.equal(cell.candidateSha256, evidence.candidateSha256, `${label} proves another candidate`);
    assert.equal(cell.sourceCommit, evidence.sourceCommit, `${label} proves another source commit`);
    assert.equal(cell.sourceTree, evidence.sourceTree, `${label} proves another source tree`);
    assert.deepEqual(cell.lifecycle, first.lifecycle, `${label} exercised a different lifecycle`);
  }
}

function anchorMode(env) {
  const hasCandidate = Object.hasOwn(env, 'EXPECTED_CANDIDATE_SHA256');
  const hasSource = Object.hasOwn(env, 'EXPECTED_SOURCE_COMMIT');
  assert.equal(hasCandidate, hasSource, 'candidate and source anchors must be supplied together');
  if (!hasCandidate) return undefined;
  const candidate = env.EXPECTED_CANDIDATE_SHA256;
  const source = env.EXPECTED_SOURCE_COMMIT;
  assert.equal(typeof candidate, 'string', 'candidate anchor must be a string');
  assert.equal(typeof source, 'string', 'source anchor must be a string');
  assert.match(candidate, SHA256, 'candidate anchor is malformed');
  assert.match(source, OID, 'source anchor is malformed');
  return { candidate, source };
}

export function assertMatrixEvidenceBound(evidence, { root = DEFAULT_ROOT, env = process.env } = {}) {
  assertMatrixShape(evidence);
  const anchor = anchorMode(env);
  const sourceCommit = evidence.sourceCommit;
  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', sourceCommit, 'HEAD'], { cwd: root });
  assert.equal(ancestry.status, 0, 'matrix source commit is not an ancestor of HEAD');
  const sourceTree = git(root, ['rev-parse', `${sourceCommit}^{tree}`]);
  assert.equal(evidence.sourceTree, sourceTree, 'matrix source tree differs from source commit');
  const historicalSurface = surfaceAtCommit(root, sourceCommit);
  assertSurface(evidence.cells, historicalSurface, 'matrix evidence');

  const measured = packCandidateDigest(root);
  if (anchor) {
    assert.equal(measured, anchor.candidate, 'packed candidate differs from the anchor CI measured');
    assert.equal(git(root, ['rev-parse', 'HEAD']), anchor.source, 'tree under test is not the commit CI is attesting');
    return { anchored: true, declared: historicalSurface };
  }

  const current = declaredSurface(root);
  assert.equal(measured, evidence.candidateSha256, 'matrix candidate differs from npm pack');
  assertSurface(evidence.cells, current, 'unanchored matrix evidence');
  assert.deepEqual(
    historicalSurface.map(cellKey).sort(),
    current.map(cellKey).sort(),
    'matrix source commit does not declare the current support surface',
  );
  const drift = spawnSync('git', ['diff', '--quiet', sourceCommit, 'HEAD', '--', ...PACKED_PATHS], { cwd: root });
  assert.equal(drift.status, 0, 'packed paths changed after matrix verification');
  return { anchored: false, declared: current };
}
