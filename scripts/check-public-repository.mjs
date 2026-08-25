import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PUBLIC_REPOSITORY_FILES = [
  '.github/verification/task-967-matrix.json',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  '.gitignore',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'MIGRATION_PROVENANCE.md',
  'README.md',
  'docs/public/compatibility.md',
  'docs/public/configuration.md',
  'docs/public/install.md',
  'docs/public/memory-explorer.md',
  'docs/public/migration.md',
  'docs/public/privacy.md',
  'docs/public/troubleshooting.md',
  'extensions/index.ts',
  'integration/compact-handoff.ts',
  'integration/compatibility.ts',
  'integration/config.ts',
  'integration/explorer/adapter.ts',
  'integration/explorer/assets/app.js',
  'integration/explorer/assets/index.html',
  'integration/explorer/assets/model.js',
  'integration/explorer/assets/styles.css',
  'integration/explorer/command.ts',
  'integration/explorer/server.ts',
  'integration/extension.ts',
  'integration/index.ts',
  'integration/lifecycle.ts',
  'integration/mcp-client.ts',
  'integration/project-identity.ts',
  'integration/recall.ts',
  'integration/resolve.ts',
  'integration/safety.ts',
  'integration/tools.ts',
  'integration/wakeup.ts',
  'package-lock.json',
  'package.json',
  'scripts/acceptance-explorer.mjs',
  'scripts/acceptance-extension.mjs',
  'scripts/aggregate-matrix-evidence.mjs',
  'scripts/check-package.mjs',
  'scripts/check-public-repository.mjs',
  'scripts/gate-ci.sh',
  'scripts/gate-community-mempalace.sh',
  'scripts/gate-core.sh',
  'scripts/gate-explorer-task.sh',
  'scripts/gate-packaged.sh',
  'scripts/gate-project-config-pre-attestation.sh',
  'scripts/gate-release.sh',
  'scripts/release-gate.mjs',
  'test/mempalace/compact-handoff.test.ts',
  'test/mempalace/compatibility.test.ts',
  'test/mempalace/config.test.ts',
  'test/mempalace/explorer-adapter.test.ts',
  'test/mempalace/explorer-server.test.ts',
  'test/mempalace/explorer-ui.test.mjs',
  'test/mempalace/extension.test.ts',
  'test/mempalace/fixtures/explorer-study.json',
  'test/mempalace/fixtures/fake-mempalace-bin.mjs',
  'test/mempalace/fixtures/fake-mempalace-server.mjs',
  'test/mempalace/fixtures/network-guard.mjs',
  'test/mempalace/fixtures/packaged-provider.ts',
  'test/mempalace/fixtures/sitecustomize.py',
  'test/mempalace/lifecycle.test.ts',
  'test/mempalace/mcp-client-integration.test.ts',
  'test/mempalace/mcp-client.test.ts',
  'test/mempalace/package-boundary.test.mjs',
  'test/mempalace/packaged-acceptance.test.mjs',
  'test/mempalace/packaged-real-provider.mjs',
  'test/mempalace/project-identity.test.ts',
  'test/mempalace/public-docs.test.mjs',
  'test/mempalace/recall.test.ts',
  'test/mempalace/public-repository-boundary.test.mjs',
  'test/mempalace/resolve.test.ts',
  'test/mempalace/safety.test.ts',
  'test/mempalace/tools.test.ts',
  'test/mempalace/wakeup.test.ts',
  'tsconfig.json',
].sort();

const FORBIDDEN_PATH = /^(?:src|benchmarks|docs\/contexts|\.pi)(?:\/|$)|^extensions\/lifecycle\.ts$|^test\/(?!mempalace\/)|^\.mcp\.json$|^\.git\/public-history-cutover(?:\/|$)/u;
const PRIVATE_PATH = /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)[/\\][^\s`'"<>)]+/u;
// The tracked tree and the packed tarball must reject the same credential
// classes: a class the package check knows about but this one does not is a
// leak that only publication would reveal. Everything below the marker is
// copied verbatim from `scripts/check-package.mjs`, and
// `test/mempalace/public-repository-boundary.test.mjs` compares the two
// catalogues literal by literal so they cannot drift apart again.
// A credential assignment is not a line. It sits mid-expression in JavaScript,
// after another assignment on the same line, and inside one-line JSON, with the
// key or the value quoted — and escaped where a file embeds JSON in a string. A
// class anchored on the start of a line sees none of those, so the key is
// bounded by a lookbehind instead. The class owns no delimiter it did not find:
// it starts at the key rather than at the newline before it, a quoted value
// ends at its closing quote, and a bare value ends at the first separator, so
// redacting a match leaves the punctuation and the surrounding lines in place.
// An indented continuation is the one newline a match may cross, because there
// the value on the next line is part of the assignment and not a line of its
// own — the shape the line-anchored class did reach, and the only one it did.
export const CREDENTIALS = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u,
  /\b(?:github_pat_|gh[pousr]_|glpat-|sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{20,}\b/u,
  /(?<![A-Za-z0-9_$-])\\?["']?(?:aws_secret_access_key|npm_[a-z_]*token|[A-Za-z0-9_$-]*(?:password|api[_-]?key))\\?["']?[^\S\n]*[:=][^\S\n]*(?:\r?\n[^\S\n]+)?(?:\\?"[^"\n]*\\?"|\\?'[^'\n]*\\?'|[^\s"',;)\]}]+)/iu,
  // --- verbatim from scripts/check-package.mjs ---
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
// A fixture allowance blanks the literal it declares, so the inert opening
// delimiter of a private key is gone before the catalogue above runs. What is
// left — the base64 body and the closing delimiter — matches no other class,
// and that is the whole key. These classes are therefore evaluated against the
// raw content, where no allowance can reach them. An inert fixture carries the
// opening delimiter alone, with neither a body line nor a close, so nothing a
// tracked file legitimately quotes needs to be exempt from them.
const KEY_MATERIAL = [
  /-----END (?:[A-Z ]+ )?PRIVATE KEY-----/u,
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[^\S\n]*\r?\n[^\S\n]*[A-Za-z0-9+/]{16,}={0,2}[^\S\n]*(?:\r?\n|$)/u,
];
// This scanner is scanned by its own rule, and the repository is public, so the
// token it bans cannot be written here as a literal: a reader searching for the
// private project would find it in the very guard that exists to keep it out.
// The fragments below assemble it at load time — the same technique the
// credential fixtures use — which is what lets the rule apply to every tracked
// file with no exemption at all.
const PRIVATE_ORG = ['we', 'stack'].join('-');
const PRIVATE_BRIDGE_PATH = ['pi-extensions', 'mempalace-bridge'].join('/');
const PRIVATE_SOURCE_REFERENCE = new RegExp(
  [
    `@${PRIVATE_ORG}/`,
    `\\b${PRIVATE_ORG}\\b`,
    PRIVATE_BRIDGE_PATH,
    ['WE', 'STACK', 'EVAL'].join('_'),
    ['ws', 'config'].join('-'),
  ].join('|'),
  'iu',
);
// No file is exempt. `LICENSE` and `MIGRATION_PROVENANCE.md` used to be: the
// provenance record named the private source it documented, and the licence
// named it in the attribution line. Neither needs to. The author is the sole
// copyright holder of the migrated code with no third-party contribution, so
// the MIT grant stands on authorship, the frozen snapshot, and the per-file
// digests — none of which require publishing where private work lives. Dropping
// the exemption is what proves the scrub stayed complete.
// Tracked tests and gates have to name the credentials they prove are
// rejected, so a few files legitimately contain inert fixture tokens. Exempting
// those files as a whole also exempts every real credential that lands beside
// the fixture, so each allowance is the exact literal instead: the scanner
// blanks the occurrences that are exactly the declared literal and inspects
// everything that remains.
export const FIXTURE_LITERALS = new Map([
  ['scripts/gate-release.sh', [
    '-----BEGIN PRIVATE KEY-----',
    String.raw`\0-----BEGIN PRIVATE KEY-----`,
    "aws_secret_access_key=$(printf 'A%.0s' {1..40})",
    "aws_secret_access_key=$(printf 'A%.0s' {1..39})",
    "aws_secret_access_key = '$(printf 'A%.0s' {1..40})'",
    String.raw`\"aws_secret_access_key\": \"$(printf 'A%.0s' {1..40})\"`,
    'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'github_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    '//registry.npmjs.org/:_authToken=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    "//npm.pkg.github.com/:_authToken=$(printf 'A%.0s' {1..40})",
    "//registry.example.com/:_auth=$(printf 'A%.0s' {1..40})",
    '/Users/maintainer/private/config.json',
  ]],
  ['test/mempalace/compact-handoff.test.ts', [
    'api_key=secret',
  ]],
  ['test/mempalace/package-boundary.test.mjs', [
    '-----BEGIN PRIVATE KEY-----',
    "aws_secret_access_key=${'A'.repeat(40)}",
    '/Users/maintainer/private/repository/config.json',
  ]],
  ['test/mempalace/public-repository-boundary.test.mjs', [
    '-----BEGIN PRIVATE KEY-----',
    "aws_secret_access_key=${'A'.repeat(40)}",
    'aws_secret_access_key = "${PADDING}"',
    '/Users/maintainer/private/repository/config.json',
    '/home/maintainer/private/repository/config.json',
    String.raw`C:\Users\maintainer\private\repository\config.json`,
  ]],
  ['test/mempalace/safety.test.ts', [
    '-----BEGIN PRIVATE KEY-----',
    'ASIA1234567890ABCDEF',
    'glpat-abcdefghij1234567890abcde',
    'hf_12345678901234567890abcdefgh',
    'GOCSPX-1234567890abcdefghijklmnop',
    'sk_live_12345678901234567890123456',
    'sk_test_12345678901234567890123456',
    'npm_123456789012345678901234567890123456',
    'xoxb-1234567890123456789012345678',
    'xoxp-1234567890123456789012345678',
    'xoxr-1234567890123456789012345678',
    'xoxs-1234567890123456789012345678',
    'xoxa-1234567890123456789012345678',
    'password=hunter2',
    'api_key=sk-test-secret',
  ]],
  ['test/mempalace/tools.test.ts', [
    'password=hunter2',
  ]],
]);

// This file quotes every allowance above verbatim, so the literals it may hold
// are exactly that union — no more, and no whole-file pass for itself.
FIXTURE_LITERALS.set(
  'scripts/check-public-repository.mjs',
  [...new Set([...FIXTURE_LITERALS.values()].flat())],
);

const OID = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CUTOVER_KEYS = [
  'bundleSha256',
  'candidateSha256',
  'cleanCommit',
  'cleanTree',
  'generatedAt',
  'oldMain',
  'ownerControlledRefs',
  'pullRequests',
  'repositoryVisibility',
  'reviewedTree',
  'scanners',
  'schemaVersion',
  'tags',
].sort();

// An allowance covers the literal exactly as declared. An occurrence that
// continues into a longer token or a longer path is a different string: blanking
// it would erase the detector and take the secret around it out of the scan, so
// such an occurrence is left in place for the scanners to reject. A literal that
// ends in a delimiter — `-----BEGIN PRIVATE KEY-----` — cannot be continued by
// another delimiter, only by a token character, and tracked fixtures do abut it
// with escape text, so only a token character continues it there.
const TOKEN_CHARACTER = /[A-Za-z0-9_]/u;
const TOKEN_OR_PATH_CHARACTER = /[A-Za-z0-9_+/=.\\-]/u;

function isExactOccurrence(content, index, literal) {
  const before = index > 0 ? content[index - 1] : '';
  const after = content[index + literal.length] ?? '';
  const continues = TOKEN_CHARACTER.test(literal.at(-1)) ? TOKEN_OR_PATH_CHARACTER : TOKEN_CHARACTER;
  return !(before && TOKEN_OR_PATH_CHARACTER.test(before)) && !(after && continues.test(after));
}

function withoutLiterals(content, literals) {
  let remaining = content;
  for (const literal of literals) {
    let scanned = '';
    let cursor = 0;
    for (let index = remaining.indexOf(literal); index >= 0; index = remaining.indexOf(literal, cursor)) {
      const end = index + literal.length;
      scanned += isExactOccurrence(remaining, index, literal)
        ? `${remaining.slice(cursor, index)}<inert fixture literal>`
        : remaining.slice(cursor, end);
      cursor = end;
    }
    remaining = scanned + remaining.slice(cursor);
  }
  return remaining;
}

function withoutFixtureLiterals(path, content) {
  return withoutLiterals(content, FIXTURE_LITERALS.get(path) ?? []);
}

// Gates that quote a child transcript into an evidence file or onto stderr are
// quoting whatever the child printed, and those artefacts outlive the run. They
// redact through this catalogue rather than one of their own, so a credential
// class enforced against the tracked tree cannot go unenforced in diagnostics.
// Leading whitespace is kept so that a class which does own the whitespace in
// front of its match cannot fold the transcript's lines together.
const REDACTED_CREDENTIAL = '[redacted credential]';
const REDACTED_PRIVATE_PATH = '[redacted absolute path]';
// A private key is a block, not a line: the catalogue's opening class matches
// the delimiter alone, so substituting class by class leaves the base64 body
// and the closing delimiter — the key itself — in the artefact. The block is
// removed as a whole and first. A transcript can also be cut off mid-key, so a
// header followed only by base64 lines goes the same way; the substitution
// stops at the first line that is not body, which keeps the diagnostic tail.
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/gu;
const PRIVATE_KEY_TAIL = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----(?:[^\S\n]*\r?\n[^\S\n]*[A-Za-z0-9+/]{16,}={0,2}[^\S\n]*)+/gu;

function everyMatch(pattern) {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
}

export function redactSecrets(text) {
  let redacted = String(text)
    .replace(PRIVATE_KEY_BLOCK, REDACTED_CREDENTIAL)
    .replace(PRIVATE_KEY_TAIL, REDACTED_CREDENTIAL);
  for (const pattern of CREDENTIALS) {
    redacted = redacted.replace(
      everyMatch(pattern),
      (match) => `${/^\s*/u.exec(match)[0]}${REDACTED_CREDENTIAL}`,
    );
  }
  return redacted.replace(everyMatch(PRIVATE_PATH), REDACTED_PRIVATE_PATH);
}

// `assert.doesNotMatch` attaches the string it scanned to the AssertionError as
// `actual`, and a failing check is printed by CI into a log that outlives the
// run and is readable by everyone who can read the job. A scanner that reports
// a credential by quoting the file that held it publishes that credential. Each
// content class is reported by path alone, and a class that cannot be evaluated
// counts as a match: the check fails closed rather than passing content it did
// not manage to inspect.
function assertUnmatched(content, pattern, reason) {
  let matched = true;
  try {
    matched = pattern.test(content);
  } catch {
    matched = true;
  }
  if (matched) assert.fail(reason);
}

export function assertPublicRepository(trackedFiles, contents) {
  const files = [...trackedFiles].sort();
  for (const path of files) assert.doesNotMatch(path, FORBIDDEN_PATH, `forbidden tracked path: ${path}`);
  assert.deepEqual(files, PUBLIC_REPOSITORY_FILES, 'tracked tree differs from the exact public allowlist');

  for (const path of files) {
    assert(Object.hasOwn(contents, path), `tracked content missing: ${path}`);
    const content = String(contents[path]);
    const scanned = withoutFixtureLiterals(path, content);
    assertUnmatched(scanned, PRIVATE_PATH, `private absolute path in ${path}`);
    for (const pattern of CREDENTIALS) assertUnmatched(scanned, pattern, `credential content in ${path}`);
    for (const pattern of KEY_MATERIAL) assertUnmatched(content, pattern, `key material in ${path}`);
    // No allowance, no narrowing: every tracked file is scanned raw. The files
    // that enforce this rule assemble the banned token from fragments instead
    // of quoting it, so none of them needs to be exempt from it.
    assertUnmatched(content, PRIVATE_SOURCE_REFERENCE, `private source reference in ${path}`);
  }
}

export function assertCutoverManifest(manifest) {
  const fail = (message) => assert.fail(`cutover manifest ${message}`);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('must be an object');
  try {
    assert.deepEqual(Object.keys(manifest).sort(), CUTOVER_KEYS);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.repositoryVisibility, 'PRIVATE');
    for (const key of ['oldMain', 'cleanCommit', 'cleanTree', 'reviewedTree']) assert.match(manifest[key], OID);
    for (const key of ['bundleSha256', 'candidateSha256']) assert.match(manifest[key], SHA256);
    assert.equal(manifest.cleanTree, manifest.reviewedTree);
    // The refs and pull requests the predecessor repository actually carried at
    // the cutover. Both lists grew after this schema was first written, and a
    // stale expectation here would pass a manifest that under-reports what was
    // left behind — which is the one thing this record exists to state.
    assert.deepEqual(manifest.ownerControlledRefs, [
      'refs/heads/main',
      'refs/heads/feat/community-mempalace-pi',
      'refs/heads/feat/pi-lifecycle-adapter',
      'refs/heads/feat/public-repo-sanitization',
    ]);
    assert.deepEqual(manifest.pullRequests, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert(Array.isArray(manifest.tags));
    assert(Array.isArray(manifest.scanners) && manifest.scanners.length > 0);
    for (const scanner of manifest.scanners) {
      assert.deepEqual(Object.keys(scanner).sort(), ['cleanHistory', 'name', 'oldHistory']);
      assert.equal(typeof scanner.name, 'string');
      assert.equal(scanner.oldHistory, 'PASS');
      assert.equal(scanner.cleanHistory, 'PASS');
    }
    assert.equal(new Date(manifest.generatedAt).toISOString(), manifest.generatedAt);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

// A release needs a tag, and a tag is a ref like any other: it is precisely how
// a slice of the old history would come back to a public remote without any
// branch showing it. So tags are permitted, but only the ones the manifest
// declares and only pointing at the clean commit, and every other namespace —
// `refs/pull`, `refs/notes`, anything a tool invents — stays forbidden outright.
// An annotated tag publishes two lines, the tag object and its `^{}`
// dereference; the dereferenced commit is what has to match.
export function assertRemoteRefs(refs, cleanCommit, tags = []) {
  try {
    assert.match(cleanCommit, OID);
    assert.deepEqual(
      refs.filter(({ ref }) => ref.startsWith('refs/heads/')),
      [{ oid: cleanCommit, ref: 'refs/heads/main' }],
      'the remote carries a branch other than clean main',
    );

    const resolved = new Map();
    for (const { oid, ref } of refs) {
      if (!ref.startsWith('refs/tags/')) continue;
      const name = ref.replace(/^refs\/tags\//u, '').replace(/\^\{\}$/u, '');
      if (ref.endsWith('^{}') || !resolved.has(name)) resolved.set(name, oid);
    }
    assert.deepEqual([...resolved.keys()].sort(), [...tags].sort(), 'remote tags differ from the declared tags');
    for (const [name, oid] of resolved) {
      assert.equal(oid, cleanCommit, `refs/tags/${name} does not point at the clean commit`);
    }

    assert.deepEqual(
      refs.filter(({ ref }) => !ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')),
      [],
      'the remote carries refs outside heads and tags',
    );
  } catch (error) {
    assert.fail(`remote refs differ from clean main: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function readTrackedRepository() {
  const trackedFiles = git('ls-files', '-z').split('\0').filter(Boolean);
  const contents = Object.fromEntries(trackedFiles.map((path) => [path, readFileSync(path, 'utf8')]));
  return { contents, trackedFiles };
}

function manifestPath() {
  return `${git('rev-parse', '--git-dir')}/public-history-cutover/manifest.json`;
}

function main() {
  const mode = process.argv[2];
  assert(mode === undefined || mode === '--cutover-manifest' || mode === '--remote', `unknown argument: ${mode}`);
  assert.equal(process.argv.length, mode === undefined ? 2 : 3, 'unexpected arguments');

  if (mode === undefined) {
    const { contents, trackedFiles } = readTrackedRepository();
    assertPublicRepository(trackedFiles, contents);
    process.stdout.write(`Public repository check: PASS (${trackedFiles.length} tracked files)\n`);
    return;
  }

  const manifest = JSON.parse(readFileSync(manifestPath(), 'utf8'));
  assertCutoverManifest(manifest);
  if (mode === '--cutover-manifest') {
    assert.equal(git('rev-parse', `${manifest.cleanCommit}^{tree}`), manifest.cleanTree);
    process.stdout.write('Public cutover manifest check: PASS\n');
    return;
  }

  const refs = git('ls-remote', '--heads', '--tags', 'origin').split('\n').filter(Boolean)
    .map((line) => { const [oid, ref] = line.split(/\s+/u); return { oid, ref }; });
  assertRemoteRefs(refs, manifest.cleanCommit, manifest.tags);
  process.stdout.write('Public remote check: PASS\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
