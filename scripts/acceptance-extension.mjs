import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(manifest.name, 'mempalace-for-pi');

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return;
  const value = process.argv[index + 1];
  assert(value && !value.startsWith('--'), `${name} requires a value`);
  return value;
}
for (let index = 2; index < process.argv.length; index++) {
  const value = process.argv[index];
  if (value === '--smoke' || value === '--full') continue;
  assert(value === '--runs' || value === '--tarball' || value === '--mempalace-version', `unknown argument: ${value}`);
  index++;
}
assert(process.argv.includes('--smoke') || process.argv.includes('--full'), 'use --smoke or --full');
const args = [];
for (const name of ['--tarball', '--mempalace-version']) {
  const value = argument(name);
  if (value) args.push(name, value);
}
const runs = Number(argument('--runs') ?? '1');
assert(Number.isInteger(runs) && runs > 0, '--runs must be a positive integer');
for (let run = 0; run < runs; run++) {
  const result = spawnSync('bash', ['scripts/gate-packaged.sh', ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `packaged acceptance exited ${result.status}`);
}
process.stdout.write(`Packaged Pi E2E: PASS (${runs} run${runs === 1 ? '' : 's'})\n`);
