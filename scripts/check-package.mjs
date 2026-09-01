import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw new Error(`${command} failed to start`, { cause: result.error });
  if (result.status !== 0) throw new Error(result.stderr || `${command} ${args.join(' ')} failed`);
  return result.stdout;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return;
  const value = process.argv[index + 1];
  assert(value && !value.startsWith('--'), `${name} requires a value`);
  return value;
}

for (let index = 2; index < process.argv.length; index += 2) {
  assert.equal(process.argv[index], '--tarball', `unknown argument: ${process.argv[index]}`);
}

function walk(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(root, path);
    assert(entry.isFile(), `package contains non-file entry: ${relative(root, path)}`);
    return [relative(root, path).replaceAll('\\', '/')];
  });
}

const credentialPath = /(?:^|\/)(?:\.env(?:\..*)?|[^/]+\.env(?:\..*)?|\.(?:npmrc|yarnrc|pypirc|netrc)|credentials?(?:\.[^/]*)?|[^/]+\.(?:key|pem|p12|pfx))$/i;
const memoryPath = /(?:^|\/)(?:memory|mnesia|palace).*(?:\.(?:db|sqlite)(?:-(?:shm|wal))?|\/drawers?\.json)$/i;
const generatedPath = /(?:^|\/)(?:coverage|sessions?|test-state|tests?|tmp|\.release-evidence)(?:\/|$)/i;
const absoluteInternalPath = /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)[/\\][^\s`'"<>)]+/;
const credentialContent = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\baws_secret_access_key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/i,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bhf_[A-Za-z0-9]{20,}\b/,
  /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-(?:ant-(?:api\d{2}-)?|proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bnpm_[A-Za-z0-9]{36,}\b/,
  /\/\/[^\s:]+\/:_(?:auth|authToken|password)\s*=\s*\S+/i,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
];

const root = mkdtempSync(join(tmpdir(), 'mempalace-for-pi-package-check-'));
try {
  let tarball = argument('--tarball');
  if (!tarball) {
    const pack = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', root]));
    assert(pack[0]?.filename, 'npm pack did not return a tarball');
    tarball = join(root, basename(pack[0].filename));
  }
  tarball = resolve(tarball);

  const archiveEntries = run('tar', ['-tzf', tarball]).trim().split('\n').filter(Boolean);
  assert(archiveEntries.length > 0, 'package tarball is empty');
  for (const entry of archiveEntries) {
    assert(entry === 'package' || entry.startsWith('package/'), `tarball entry escapes package root: ${entry}`);
    assert(!entry.split('/').includes('..'), `tarball entry traverses parent: ${entry}`);
  }
  run('tar', ['-xzf', tarball, '-C', root]);

  const packageRoot = join(root, 'package');
  const files = walk(packageRoot).sort();
  for (const required of ['package.json', 'extensions/index.ts', 'integration/index.ts']) {
    assert(files.includes(required), `package is missing ${required}`);
  }
  const packedManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']) {
    if (packedManifest.scripts?.[hook] !== undefined) {
      throw new Error(`package includes npm lifecycle hook: ${hook}`);
    }
  }
  const publicFiles = new Set([
    'package.json', 'CHANGELOG.md', 'README.md', 'LICENSE', 'MIGRATION_PROVENANCE.md', 'extensions/index.ts',
  ]);
  for (const path of files) {
    if (credentialPath.test(path)) throw new Error(`package includes credential file: ${path}`);
    if (path.split('/').some((part) => part.startsWith('.'))) {
      throw new Error(`package includes hidden file: ${path}`);
    }
    if (memoryPath.test(path)) throw new Error(`package includes local memory payload: ${path}`);
    if (generatedPath.test(path)) throw new Error(`package includes generated test state: ${path}`);
    if (!(publicFiles.has(path) || path.startsWith('integration/') || path.startsWith('docs/public/')
      || path.startsWith('prompts/'))) {
      throw new Error(`package includes unrelated file: ${path}`);
    }
    const content = readFileSync(join(packageRoot, path));
    if (content.includes(0)) throw new Error(`package includes binary content: ${path}`);
    const text = content.toString('utf8');
    if (credentialContent.some((pattern) => pattern.test(text))) {
      throw new Error(`package includes credential content: ${path}`);
    }
    if (absoluteInternalPath.test(text)) throw new Error(`package includes absolute internal path: ${path}`);
  }
  process.stdout.write(`Package check: PASS (${files.length} files)\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
