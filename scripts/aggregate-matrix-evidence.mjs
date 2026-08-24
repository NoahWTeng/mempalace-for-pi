#!/usr/bin/env node
// Aggregates the per-cell records the packaged gate emits into the committed
// matrix evidence file.
//
// This exists because the eight cells each measure one pairing and nothing
// joined them up: refreshing `.github/verification/task-967-matrix.json` was a
// manual step, and a manual step over evidence is where a hand-written digest
// gets in. Nothing here decides a result. Every field is copied from a record
// that a real gate run produced, and the file is written only when the records
// are complete, mutually consistent, and cover exactly the support surface the
// integration declares.
//
// Usage:
//   node scripts/aggregate-matrix-evidence.mjs --records <dir|file>... --out <path>
//   node scripts/aggregate-matrix-evidence.mjs --records <dir> --check <path>
//
// `--check` verifies an existing file would be reproduced by these records
// without writing anything, so CI can prove the committed evidence matches what
// the run measured.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA256 = /^[a-f0-9]{64}$/u;
const OID = /^[a-f0-9]{40}$/u;
const SCHEMA_VERSION = 1;

/** Fields a record must carry. A record missing any of them is not evidence. */
const REQUIRED_RECORD_FIELDS = [
  'arch',
  'candidateSha256',
  'core',
  'lifecycle',
  'networkAttempts',
  'node',
  'nodeDeclared',
  'outcome',
  'pi',
  'platform',
  'recordsAfter',
  'recordsBefore',
  'retainedPercent',
  'sourceCommit',
  'sourceTree',
  'syntheticPredecessor',
];

/** Shape of a committed cell, in the order the file records them. */
const CELL_FIELDS = [
  'platform',
  'arch',
  'nodeDeclared',
  'nodeRuntime',
  'pi',
  'core',
  'candidateSha256',
  'sourceCommit',
  'sourceTree',
  'outcome',
  'recordsBefore',
  'recordsAfter',
  'retainedPercent',
  'networkAttempts',
  'syntheticPredecessor',
  'lifecycle',
];

function fail(message) {
  process.stderr.write(`matrix evidence: ${message}\n`);
  process.exit(1);
}

// The declared support surface is parsed out of the integration rather than
// restated here. Hard-coding "eight cells" would let the matrix silently keep
// its old size after the surface grows — the same defect as pinning a version
// literal in a release gate. Parsing keeps one source of truth: widen
// `compatibility.ts` and this demands the extra cells on the next run.
function declaredSurface(root) {
  const source = readFileSync(join(root, 'integration', 'compatibility.ts'), 'utf8');

  const literalList = (name) => {
    const match = source.match(new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`, 'u'));
    if (!match) fail(`compatibility.ts does not declare ${name}`);
    const values = [...match[1].matchAll(/'([^']+)'/gu)].map(([, value]) => value);
    if (values.length === 0) fail(`${name} is empty`);
    return values;
  };

  const pairingBlock = source.match(/COMPATIBILITY_PAIRINGS[^=]*=\s*\[([\s\S]*?)\n\];/u);
  if (!pairingBlock) fail('compatibility.ts does not declare COMPATIBILITY_PAIRINGS');
  const pairings = [...pairingBlock[1].matchAll(
    /\{\s*pi:\s*'([^']+)',\s*mempalace:\s*'([^']+)',\s*verification:\s*'([^']+)'\s*\}/gu,
  )]
    .filter(([, , , verification]) => verification === 'verified')
    .map(([, pi, mempalace]) => ({ pi, mempalace }));
  if (pairings.length === 0) fail('no verified pairings are declared');

  const expected = [];
  for (const platform of literalList('SUPPORTED_PLATFORMS')) {
    for (const arch of literalList('SUPPORTED_ARCHITECTURES')) {
      for (const nodeDeclared of literalList('SUPPORTED_NODE_VERSIONS')) {
        for (const { pi, mempalace } of pairings) {
          expected.push({ platform, arch, nodeDeclared, pi, core: mempalace });
        }
      }
    }
  }
  return expected;
}

function cellKey({ platform, arch, nodeDeclared, pi, core }) {
  return [platform, arch, nodeDeclared, pi, core].join(' / ');
}

function readRecords(inputs) {
  const files = [];
  for (const input of inputs) {
    let stat;
    try {
      stat = statSync(input);
    } catch {
      fail(`records path does not exist: ${input}`);
    }
    if (stat.isDirectory()) {
      const walk = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          // `.jsonl` only. The gate appends one record per line, so records are
          // JSONL by construction, while an aggregated matrix file is
          // pretty-printed `.json`. Accepting both meant pointing `--records`
          // at a directory that also held the output failed with a parse error
          // about the output file rather than doing the obvious thing.
          if (entry.isDirectory()) walk(path);
          else if (entry.name.endsWith('.jsonl')) files.push(path);
        }
      };
      walk(input);
    } else {
      files.push(input);
    }
  }
  if (files.length === 0) fail('no record files were found');

  const records = [];
  for (const file of files.sort()) {
    for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      if (line.trim() === '') continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        fail(`${file}:${index + 1} is not valid JSON`);
      }
      records.push({ record, origin: `${file}:${index + 1}` });
    }
  }
  if (records.length === 0) fail('record files contained no records');
  return records;
}

function validate(records, expected) {
  for (const { record, origin } of records) {
    for (const field of REQUIRED_RECORD_FIELDS) {
      if (record[field] === undefined) fail(`${origin} is missing "${field}"`);
    }
    if (record.nodeDeclared === '') {
      fail(`${origin} ran without EXPECTED_NODE_VERSION, so it cannot be placed in the matrix`);
    }
    // The gate only emits a record once every assertion in the cell passed, so
    // anything other than PASS means the record was edited after the fact.
    if (record.outcome !== 'PASS') fail(`${origin} reports outcome ${record.outcome}`);
    if (!SHA256.test(record.candidateSha256)) fail(`${origin} has a malformed candidate digest`);
    for (const field of ['sourceCommit', 'sourceTree']) {
      if (!OID.test(record[field])) fail(`${origin} has a malformed ${field}`);
    }
    if (record.retainedPercent !== 100) fail(`${origin} retained ${record.retainedPercent}%`);
    if (record.networkAttempts !== 0) {
      fail(`${origin} recorded ${record.networkAttempts} guarded network attempts`);
    }
    if (!Array.isArray(record.lifecycle) || record.lifecycle.length === 0) {
      fail(`${origin} recorded no lifecycle phases`);
    }
  }

  // One immutable candidate, or the cells did not measure the same artifact and
  // the matrix would describe a build that never existed.
  const [{ record: first }] = records;
  for (const { record, origin } of records) {
    for (const field of ['candidateSha256', 'sourceCommit', 'sourceTree']) {
      if (record[field] !== first[field]) {
        fail(`${origin} ran against a different ${field} than the first record`);
      }
    }
    if (record.lifecycle.join('\u0000') !== first.lifecycle.join('\u0000')) {
      fail(`${origin} exercised a different lifecycle than the first record`);
    }
  }

  // Exactly the declared cross-product: no gap, no duplicate, no surprise cell.
  const seen = new Map();
  for (const { record, origin } of records) {
    const key = cellKey(record);
    if (seen.has(key)) fail(`duplicate cell ${key} (${seen.get(key)} and ${origin})`);
    seen.set(key, origin);
  }
  const expectedKeys = expected.map(cellKey);
  const missing = expectedKeys.filter((key) => !seen.has(key));
  const unexpected = [...seen.keys()].filter((key) => !expectedKeys.includes(key));
  if (missing.length > 0) fail(`no record for declared cell(s): ${missing.join(', ')}`);
  if (unexpected.length > 0) fail(`record for undeclared cell(s): ${unexpected.join(', ')}`);
}

function buildMatrix(records, generatedAt) {
  const [{ record: first }] = records;
  const cells = records
    .map(({ record }) => {
      const cell = {};
      for (const field of CELL_FIELDS) {
        cell[field] = field === 'nodeRuntime' ? record.node : record[field];
      }
      return cell;
    })
    .sort((a, b) =>
      a.platform.localeCompare(b.platform)
      || a.arch.localeCompare(b.arch)
      || a.nodeDeclared.localeCompare(b.nodeDeclared)
      || a.core.localeCompare(b.core));

  return {
    schemaVersion: SCHEMA_VERSION,
    candidateSha256: first.candidateSha256,
    sourceCommit: first.sourceCommit,
    sourceTree: first.sourceTree,
    generatedAt,
    cells,
  };
}

function parseArguments(argv) {
  const options = { records: [], out: undefined, check: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--records') {
      if (!value) fail('--records requires a value');
      options.records.push(value);
      index += 1;
    } else if (flag === '--out' || flag === '--check') {
      if (!value) fail(`${flag} requires a value`);
      options[flag.slice(2)] = value;
      index += 1;
    } else {
      fail(`unknown argument: ${flag}`);
    }
  }
  if (options.records.length === 0) fail('--records is required');
  if ((options.out === undefined) === (options.check === undefined)) {
    fail('pass exactly one of --out or --check');
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const records = readRecords(options.records);
  validate(records, declaredSurface(root));

  if (options.check !== undefined) {
    let committed;
    try {
      committed = JSON.parse(readFileSync(options.check, 'utf8'));
    } catch {
      fail(`${options.check} is missing or not valid JSON`);
    }
    // `generatedAt` is the only field that legitimately differs between two
    // aggregations of identical records, so it is the one field excluded.
    const rebuilt = buildMatrix(records, committed.generatedAt);
    try {
      assert.deepEqual(committed, rebuilt);
    } catch (error) {
      fail(`committed evidence does not match these records: ${error.message.split('\n')[0]}`);
    }
    process.stdout.write(`Matrix evidence check: PASS (${rebuilt.cells.length} cells)\n`);
    return;
  }

  const matrix = buildMatrix(records, new Date().toISOString().replace(/\.\d{3}Z$/u, '.000Z'));
  writeFileSync(options.out, `${JSON.stringify(matrix, null, 2)}\n`);
  process.stdout.write(
    `Matrix evidence: ${matrix.cells.length} cells, candidate ${matrix.candidateSha256}\n`,
  );
}

main();
