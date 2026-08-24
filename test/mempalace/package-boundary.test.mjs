import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const ROOT = new URL('../..', import.meta.url);
const EXACT_FILES_ALLOWLIST = [
  'integration',
  'extensions/index.ts',
  'docs/public',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'MIGRATION_PROVENANCE.md',
];
const ALWAYS_INCLUDED = ['package.json'];
const FIXED_PUBLIC_FILES = [
  'CHANGELOG.md',
  'LICENSE',
  'MIGRATION_PROVENANCE.md',
  'README.md',
  'extensions/index.ts',
  'package.json',
];
const FORBIDDEN_PATHS = [
  /^src(?:\/|$)/u,
  /^benchmarks(?:\/|$)/u,
  /^test(?:\/|$)/u,
  /^docs\/contexts(?:\/|$)/u,
  /(?:^|\/)\.mcp\.json$/u,
  /(?:^|\/)\.pi(?:\/|$)/u,
  /(?:^|\/)(?:\.mempalace|palaces?|palace-data)(?:\/|$)/iu,
  /(?:^|\/)(?:credentials?|secrets?)(?:[./_-]|$)/iu,
  /\.(?:db|sqlite|sqlite3)(?:$|\.)/iu,
];
const FORBIDDEN_CONTENT = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u,
  /\b(?:github_pat_|gh[pousr]_|glpat-|sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{20,}\b/u,
  /(?:^|\n)\s*(?:aws_secret_access_key|npm_[a-z_]*token|[^\s=]*(?:password|api[_-]?key))\s*[:=]\s*\S+/imu,
];
const ABSOLUTE_INTERNAL_PATH = /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)[/\\][^\s`'"<>)]+/u;
// Assembled rather than quoted: this file is itself scanned for the token it
// bans, and it ships in a public repository.
const PRIVATE_ORG = ['we', 'stack'].join('-');
const PRIVATE_SOURCE_REFERENCE = new RegExp(
  [
    `@${PRIVATE_ORG}/`,
    `\\b${PRIVATE_ORG}\\b`,
    ['pi-extensions', 'mempalace-bridge'].join('/'),
    ['WE', 'STACK', 'EVAL'].join('_'),
    ['ws', 'config'].join('-'),
  ].join('|'),
  'iu',
);

function walk(relativeDirectory) {
  if (!existsSync(new URL(relativeDirectory, ROOT))) return [];
  return readdirSync(new URL(relativeDirectory, ROOT), { withFileTypes: true }).flatMap((entry) => {
    const path = `${relativeDirectory.replace(/\/$/u, '')}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function assertSafePath(path) {
  assert.equal(FORBIDDEN_PATHS.some((pattern) => pattern.test(path)), false, `forbidden packed path: ${path}`);
}

function assertSafeContent(path, content) {
  assert.doesNotMatch(content, ABSOLUTE_INTERNAL_PATH, `absolute internal path in ${path}`);
  for (const pattern of FORBIDDEN_CONTENT) {
    assert.doesNotMatch(content, pattern, `credential content in ${path}`);
  }
  // No file is exempt. `LICENSE` and `MIGRATION_PROVENANCE.md` used to be, while
  // they named the private source they documented; they describe it without
  // naming it now, so the rule applies to the whole tree.
  assert.doesNotMatch(content, PRIVATE_SOURCE_REFERENCE, `private source reference in ${path}`);
}

test('package dry-run contains exactly the public MemPalace integration boundary', () => {
  const manifest = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'));
  assert.equal(manifest.private, undefined, 'a private manifest cannot be published');
  assert.deepEqual(manifest.files, EXACT_FILES_ALLOWLIST);
  assert.deepEqual(manifest.pi?.extensions, ['./extensions/index.ts']);
  assert.deepEqual(manifest.exports, { '.': './extensions/index.ts' });
  assert.equal(manifest.dependencies, undefined, 'runtime packages must remain peer-only');
  assert.equal(manifest.optionalDependencies, undefined, 'runtime packages must remain peer-only');
  assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}).sort(), [
    '@earendil-works/pi-coding-agent',
    'typebox',
  ]);

  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
  }))[0];
  const actual = packed.files.map(({ path }) => path).sort();
  const expected = [
    ...FIXED_PUBLIC_FILES,
    ...walk('docs/public'),
    ...walk('integration'),
  ].sort();
  assert.deepEqual(actual, expected);

  for (const path of actual) {
    assertSafePath(path);
    const content = readFileSync(new URL(path, ROOT), 'utf8');
    assertSafeContent(path, content);
  }

  for (const retiredTree of ['src', 'benchmarks']) {
    assert.equal(existsSync(new URL(retiredTree, ROOT)), false, `${retiredTree}/ must not remain in the public tree`);
    assert.equal(actual.some((path) => path.startsWith(`${retiredTree}/`)), false);
  }
});

test('boundary rejects every forbidden path and secret class', () => {
  for (const path of [
    'src/index.ts',
    'benchmarks/results.json',
    'test/fixture.ts',
    'docs/contexts/internal/spec.md',
    '.mcp.json',
    '.pi/agent/config.json',
    '.mempalace/project/drawers.json',
    'palace-data/memory.sqlite',
    'integration/credentials.json',
  ]) {
    assert.throws(() => assertSafePath(path), /forbidden packed path/u);
  }

  for (const content of [
    '-----BEGIN PRIVATE KEY-----',
    `github_pat_${'A'.repeat(24)}`,
    `aws_secret_access_key=${'A'.repeat(40)}`,
    '/Users/maintainer/private/repository/config.json',
    `@${PRIVATE_ORG}/mempalace-bridge`,
    `load config from the private ${PRIVATE_ORG} checkout`,
  ]) {
    assert.throws(() => assertSafeContent('integration/leak.ts', content));
  }

  // `LICENSE` and `MIGRATION_PROVENANCE.md` were exempt from this rule while
  // they named the private source they documented. They describe it without
  // naming it now, so the exemption is gone and they are scanned like anything
  // else — which is what proves the scrub cannot quietly regress.
  for (const notice of ['LICENSE', 'MIGRATION_PROVENANCE.md']) {
    assert.throws(() => assertSafeContent(
      notice,
      `Historical source attribution: @${PRIVATE_ORG}/mempalace-bridge.`,
    ));
  }
});
