import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspect } from 'node:util';

import {
  FIXTURE_LITERALS,
  PUBLIC_REPOSITORY_FILES,
  assertCutoverManifest,
  assertPublicRepository,
  assertRemoteRefs,
  redactSecrets,
} from '../../scripts/check-public-repository.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readRepositoryFile(path) {
  return readFileSync(join(root, path), 'utf8');
}

const safeContents = Object.fromEntries(PUBLIC_REPOSITORY_FILES.map((path) => [path, `public fixture for ${path}\n`]));

// Files the scanner used to exempt as a whole. A whole-file exemption hides a
// real credential behind an inert fixture that happens to share the file, so
// each of these must now reject every credential class like any other file.
const FORMERLY_EXEMPT_FILES = [
  'integration/safety.ts',
  'scripts/check-package.mjs',
  'scripts/check-public-repository.mjs',
  'scripts/gate-release.sh',
  'test/mempalace/package-boundary.test.mjs',
  'test/mempalace/public-repository-boundary.test.mjs',
  'test/mempalace/resolve.test.ts',
  'test/mempalace/safety.test.ts',
];

// Assembled from parts so this suite carries no credential literal of its own:
// the only literals it is allowed to hold are the fixtures already declared in
// FIXTURE_LITERALS, and every sample below must stay outside that allowance.
const PADDING = 'A'.repeat(40);
const CREDENTIAL_SAMPLES = {
  'private key': `-----BEGIN RSA PRIVATE KEY${'-'.repeat(5)}`,
  'aws access key id': `AKIA${'BCDEFGHIJKLMNOPQ'}`,
  'aws secret access key': `aws_secret_access_key = "${PADDING}"`,
  'github token': `ghp_${'B'.repeat(36)}`,
  'github fine-grained token': `github_pat_${'C'.repeat(24)}`,
  'gitlab token': `glpat-${'D'.repeat(24)}`,
  'hugging face token': `hf_${'E'.repeat(24)}`,
  'google oauth client secret': `GOCSPX-${'F'.repeat(24)}`,
  'anthropic token': `sk-ant-api03-${'G'.repeat(24)}`,
  'stripe secret': `sk_live_${'H'.repeat(24)}`,
  'google cloud token': `AIza${'I'.repeat(35)}`,
  'npm token': `npm_${'J'.repeat(36)}`,
  'npm registry auth': ['//registry.example.test', `:_authToken=${PADDING}`].join('/'),
  'slack token': `xoxb-${'K'.repeat(24)}`,
};

const UNLISTED_PRIVATE_PATH = ['/Users', 'maintainer', 'private', 'unlisted.json'].join('/');
// Enough token characters to continue any allowance into a longer token.
const TOKEN_PADDING = 'Z'.repeat(24);

// The project-configuration work added three tracked artifacts: the JSON
// loader, its contract suite, and the pre-attestation gate that deferred this
// very check while the candidate could not be re-attested. The tracked-tree
// boundary is only exact while it names all three, so each one is asserted
// both ways — present in the allowlist and in the tracked tree, and rejected
// when it goes missing or when it carries content no tracked file may carry.
const PROJECT_CONFIGURATION_ARTIFACTS = [
  'integration/config.ts',
  'scripts/gate-project-config-pre-attestation.sh',
  'test/mempalace/config.test.ts',
];

const EXPLORER_ARTIFACTS = [
  'docs/public/memory-explorer.md',
  'integration/explorer/adapter.ts',
  'integration/explorer/assets/app.js',
  'integration/explorer/assets/index.html',
  'integration/explorer/assets/model.js',
  'integration/explorer/assets/styles.css',
  'integration/explorer/command.ts',
  'integration/explorer/server.ts',
  'scripts/acceptance-explorer.mjs',
  'scripts/gate-explorer-task.sh',
  'test/mempalace/explorer-adapter.test.ts',
  'test/mempalace/explorer-server.test.ts',
  'test/mempalace/explorer-ui.test.mjs',
  'test/mempalace/fixtures/explorer-study.json',
];

const BOUNDARY_ARTIFACTS = [...PROJECT_CONFIGURATION_ARTIFACTS, ...EXPLORER_ARTIFACTS];

function trackedFiles() {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.split('\0').filter(Boolean);
}

const PRIVATE_SCOPE = ['@we', 'stack'].join('-');
const PRIVATE_BRIDGE = ['pi-extensions', 'mempalace-bridge'].join('/');
// An injected reference shares no declared allowance; the rest each extend one
// into a longer token or path, which is exactly what a blanket file exemption
// — or an allowance that ignores its own boundaries — lets through.
const PRIVATE_REFERENCE_SAMPLES = [
  `${PRIVATE_SCOPE}/internal-only`,
  `${PRIVATE_SCOPE}/mempalace-bridge-internal-only`,
  `${PRIVATE_SCOPE}/mempalace-bridge.internal`,
  `${PRIVATE_SCOPE}/mempalace-bridge${TOKEN_PADDING}`,
  `${PRIVATE_BRIDGE}/src/mcp-client.ts.internal-only`,
];

// `scripts/check-package.mjs` inspects a tarball as soon as it is imported, so
// its catalogue cannot be loaded; the parity contract reads it from source.
function credentialClasses(source, name) {
  const start = source.indexOf(`const ${name} = [`);
  assert.ok(start >= 0, `${name} is not declared as a literal array`);
  const end = source.indexOf('\n];', start);
  assert.ok(end > start, `${name} is not terminated`);
  return source.slice(start, end).split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/') && !line.startsWith('//'))
    .map((line) => line.replace(/,$/u, ''));
}

function validManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    repositoryVisibility: 'PRIVATE',
    oldMain: '1'.repeat(40),
    cleanCommit: '2'.repeat(40),
    cleanTree: '3'.repeat(40),
    reviewedTree: '3'.repeat(40),
    bundleSha256: '4'.repeat(64),
    candidateSha256: '5'.repeat(64),
    ownerControlledRefs: [
      'refs/heads/main',
      'refs/heads/feat/community-mempalace-pi',
      'refs/heads/feat/pi-lifecycle-adapter',
      'refs/heads/feat/public-repo-sanitization',
    ],
    pullRequests: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    tags: [],
    scanners: [
      { name: 'gitleaks', oldHistory: 'PASS', cleanHistory: 'PASS' },
      { name: 'dependency-review', oldHistory: 'PASS', cleanHistory: 'PASS' },
    ],
    generatedAt: '2026-08-19T12:00:00.000Z',
    ...overrides,
  };
}

test('the exact public tracked tree is accepted', () => {
  assert.doesNotThrow(() => assertPublicRepository(PUBLIC_REPOSITORY_FILES, safeContents));
});

test('forbidden roots and files are rejected even when presented as tracked input', () => {
  for (const path of [
    'src/index.ts',
    'benchmarks/results.json',
    'extensions/lifecycle.ts',
    'test/archive.test.ts',
    'test/fixtures/provider.ts',
    'docs/contexts/internal/plan.md',
    '.pi/agent/config.json',
    '.mcp.json',
    '.git/public-history-cutover/manifest.json',
  ]) {
    assert.throws(
      () => assertPublicRepository([...PUBLIC_REPOSITORY_FILES, path], { ...safeContents, [path]: 'fixture\n' }),
      /forbidden tracked path|tracked tree differs/u,
      path,
    );
  }
});

test('unexpected files, credentials, and private paths are rejected', () => {
  assert.throws(
    () => assertPublicRepository([...PUBLIC_REPOSITORY_FILES, 'notes.md'], { ...safeContents, 'notes.md': 'extra\n' }),
    /tracked tree differs/u,
  );
  for (const content of [
    '-----BEGIN PRIVATE KEY-----',
    `github_pat_${'A'.repeat(24)}`,
    `aws_secret_access_key=${'A'.repeat(40)}`,
    '/Users/maintainer/private/repository/config.json',
    '/home/maintainer/private/repository/config.json',
    String.raw`C:\Users\maintainer\private\repository\config.json`,
  ]) {
    assert.throws(
      () => assertPublicRepository(PUBLIC_REPOSITORY_FILES, { ...safeContents, 'integration/index.ts': content }),
      /credential content|private absolute path/u,
      content,
    );
  }
});

test('the declared artifacts are inside the exact tracked boundary', () => {
  const tracked = trackedFiles();
  for (const path of BOUNDARY_ARTIFACTS) {
    assert.ok(PUBLIC_REPOSITORY_FILES.includes(path), `${path} is missing from the exact public allowlist`);
    assert.ok(tracked.includes(path), `${path} is not tracked`);
  }
  assert.deepEqual(
    [...tracked].sort(),
    PUBLIC_REPOSITORY_FILES,
    'the tracked tree and the exact public allowlist have drifted apart',
  );
});

test('a declared artifact missing from either side is rejected', () => {
  for (const path of BOUNDARY_ARTIFACTS) {
    const { [path]: _dropped, ...withoutArtifact } = safeContents;
    assert.throws(
      () => assertPublicRepository(PUBLIC_REPOSITORY_FILES.filter((entry) => entry !== path), withoutArtifact),
      /tracked tree differs/u,
      `an untracked ${path} is accepted`,
    );
    assert.throws(
      () => assertPublicRepository([...PUBLIC_REPOSITORY_FILES, `${path}.bak`], {
        ...safeContents,
        [`${path}.bak`]: 'fixture\n',
      }),
      /tracked tree differs/u,
      `an unlisted sibling of ${path} is accepted`,
    );
  }
});

test('the declared artifacts are scanned like every other tracked file', () => {
  for (const path of BOUNDARY_ARTIFACTS) {
    for (const [name, sample] of Object.entries(CREDENTIAL_SAMPLES)) {
      assert.match(rejection(path, sample) ?? '', /credential content/u, `${path} exempts ${name}`);
    }
    assert.match(
      rejection(path, UNLISTED_PRIVATE_PATH) ?? '',
      /private absolute path/u,
      `${path} exempts a private absolute path`,
    );
    for (const sample of PRIVATE_REFERENCE_SAMPLES) {
      assert.match(
        rejection(path, sample) ?? '',
        /private source reference/u,
        `${path} accepts an injected private source reference`,
      );
    }
    assert.equal(
      FIXTURE_LITERALS.has(path),
      false,
      `${path} must need no credential allowance of its own`,
    );
  }
});

test('the tracked scanner enforces every credential class the package check enforces', () => {
  const packaged = credentialClasses(readRepositoryFile('scripts/check-package.mjs'), 'credentialContent');
  const tracked = new Set(credentialClasses(readRepositoryFile('scripts/check-public-repository.mjs'), 'CREDENTIALS'));
  assert.ok(packaged.length >= 14, `the package credential catalogue looks truncated: ${packaged.length}`);
  for (const pattern of packaged) {
    assert.ok(tracked.has(pattern), `the tracked-repository scanner does not enforce ${pattern}`);
  }
});

test('every credential class is rejected in tracked content', () => {
  for (const [name, sample] of Object.entries(CREDENTIAL_SAMPLES)) {
    assert.throws(
      () => assertPublicRepository(PUBLIC_REPOSITORY_FILES, { ...safeContents, 'integration/index.ts': sample }),
      /credential content/u,
      name,
    );
  }
});

test('no tracked file is exempt as a whole', () => {
  const scanner = readRepositoryFile('scripts/check-public-repository.mjs');
  assert.doesNotMatch(scanner, /SECURITY_FIXTURES/u, 'whole-file credential exemptions must not return');
  for (const path of FORMERLY_EXEMPT_FILES) {
    assert.ok(PUBLIC_REPOSITORY_FILES.includes(path), `${path} is no longer tracked`);
    for (const [name, sample] of Object.entries(CREDENTIAL_SAMPLES)) {
      assert.throws(
        () => assertPublicRepository(PUBLIC_REPOSITORY_FILES, {
          ...safeContents,
          [path]: `${safeContents[path]}${sample}\n`,
        }),
        /credential content/u,
        `${path} still exempts ${name}`,
      );
    }
    assert.throws(
      () => assertPublicRepository(PUBLIC_REPOSITORY_FILES, {
        ...safeContents,
        [path]: `${safeContents[path]}${UNLISTED_PRIVATE_PATH}\n`,
      }),
      /private absolute path/u,
      `${path} still exempts a private absolute path`,
    );
  }
});

test('exact inert fixture literals are accepted only in the file that needs them', () => {
  assert.ok(FIXTURE_LITERALS.size > 0, 'the scanner must declare its narrow fixture allowances');
  for (const [path, literals] of FIXTURE_LITERALS) {
    assert.ok(PUBLIC_REPOSITORY_FILES.includes(path), `${path} is not tracked`);
    assert.ok(literals.length > 0, `${path} declares an empty allowance`);
    const ordered = [
      ...literals.filter((literal) => !literal.includes('BEGIN PRIVATE KEY')),
      ...literals.filter((literal) => literal.includes('BEGIN PRIVATE KEY')),
    ];
    assert.doesNotThrow(
      () => assertPublicRepository(PUBLIC_REPOSITORY_FILES, {
        ...safeContents,
        [path]: `${safeContents[path]}${ordered.join('\n')}\n`,
      }),
      `${path} rejects the fixture literals it declares`,
    );
    for (const literal of literals) {
      assert.throws(
        () => assertPublicRepository(PUBLIC_REPOSITORY_FILES, {
          ...safeContents,
          'integration/index.ts': `${safeContents['integration/index.ts']}${literal}\n`,
        }),
        /credential content|private absolute path/u,
        `a fixture literal of ${path} is accepted elsewhere`,
      );
    }
  }
});

// A fixture allowance blanks its literal wherever it appears. An occurrence
// that continues into a longer token or a longer path is not the literal that
// was declared inert: blanking it erases the detector and takes the secret that
// surrounds it out of the scan. For everything except the literal itself, the
// declaring file must therefore reject exactly what an unexempt file rejects.
const TOKEN_EXTENSIONS = [
  (literal) => `${literal}${TOKEN_PADDING}`,
  (literal) => `${TOKEN_PADDING}${literal}`,
];
const PATH_EXTENSIONS = [
  (literal) => `${literal}/private/key.pem`,
  (literal) => `${literal}.backup`,
  (literal) => `${literal}-2/config.json`,
];

function rejection(path, body) {
  try {
    assertPublicRepository(PUBLIC_REPOSITORY_FILES, {
      ...safeContents,
      [path]: `${safeContents[path]}${body}\n`,
    });
    return undefined;
  } catch (error) {
    return error.message;
  }
}

test('a fixture allowance never covers a literal embedded in a longer token', () => {
  let observed = 0;
  for (const [path, literals] of FIXTURE_LITERALS) {
    for (const literal of literals) {
      for (const extend of TOKEN_EXTENSIONS) {
        const embedded = extend(literal);
        const unexempt = rejection('integration/index.ts', embedded);
        assert.equal(
          Boolean(rejection(path, embedded)),
          Boolean(unexempt),
          `${path} treats an embedded fixture literal differently from an unexempt file`,
        );
        if (unexempt) observed += 1;
      }
    }
  }
  assert.ok(observed >= 40, `the embedding regression exercised too few rejections: ${observed}`);
});

test('a fixture allowance never covers a literal embedded in a longer path', () => {
  let observed = 0;
  for (const [path, literals] of FIXTURE_LITERALS) {
    for (const literal of literals) {
      if (!rejection('integration/index.ts', literal)?.includes('private absolute path')) continue;
      for (const extend of PATH_EXTENSIONS) {
        assert.match(
          rejection(path, extend(literal)) ?? '',
          /private absolute path/u,
          `${path} accepts a declared fixture path extended into a longer path`,
        );
        observed += 1;
      }
    }
  }
  assert.ok(observed > 0, 'no declared fixture path was exercised');
});

test('every declared fixture allowance is still present in the file it narrows', () => {
  for (const [path, literals] of FIXTURE_LITERALS) {
    const content = readRepositoryFile(path);
    for (const literal of literals) {
      assert.ok(content.includes(literal), `stale fixture allowance in ${path}: ${literal}`);
    }
  }
});

// This used to walk a list of files that were allowed to quote the private
// source, because the scanner and the gates enforcing the rule had to name the
// token to ban it. They assemble it from fragments now, so no allowance is left
// and the claim gets stronger: EVERY tracked file rejects an injected private
// source reference. Reintroducing an exemption of either kind fails here.
test('no file is exempt from the private source reference scan', () => {
  const scanner = readRepositoryFile('scripts/check-public-repository.mjs');
  assert.doesNotMatch(
    scanner,
    /PRIVATE_REFERENCE_FIXTURES|PRIVATE_REFERENCE_LITERALS/u,
    'whole-file or per-literal reference exemptions must not return',
  );
  for (const path of PUBLIC_REPOSITORY_FILES) {
    for (const sample of PRIVATE_REFERENCE_SAMPLES) {
      assert.match(
        rejection(path, sample) ?? '',
        /private source reference/u,
        `${path} accepts an injected private source reference`,
      );
    }
  }
});

test('cutover manifests are complete, exact, and private', () => {
  assert.doesNotThrow(() => assertCutoverManifest(validManifest()));
  for (const malformed of [
    {},
    validManifest({ repositoryVisibility: 'PUBLIC' }),
    validManifest({ cleanTree: 'bad' }),
    validManifest({ reviewedTree: '6'.repeat(40) }),
    validManifest({ candidateSha256: '7'.repeat(63) }),
    validManifest({ ownerControlledRefs: ['refs/heads/main'] }),
    validManifest({ pullRequests: [1, 2, 3] }),
    validManifest({ tags: 'none' }),
    validManifest({ scanners: [{ name: 'gitleaks', oldHistory: 'FAIL', cleanHistory: 'PASS' }] }),
    validManifest({ unexpected: true }),
  ]) {
    assert.throws(() => assertCutoverManifest(malformed), /cutover manifest/u);
  }
});

test('remote refs accept only the clean main and reject stale branches or tags', () => {
  const cleanCommit = '2'.repeat(40);
  assert.doesNotThrow(() => assertRemoteRefs([{ oid: cleanCommit, ref: 'refs/heads/main' }], cleanCommit));
  for (const refs of [
    [{ oid: cleanCommit, ref: 'refs/heads/main' }, { oid: '6'.repeat(40), ref: 'refs/heads/feature' }],
    [{ oid: cleanCommit, ref: 'refs/heads/main' }, { oid: cleanCommit, ref: 'refs/tags/v0.1.0' }],
    [{ oid: '7'.repeat(40), ref: 'refs/heads/main' }],
    [],
  ]) {
    assert.throws(() => assertRemoteRefs(refs, cleanCommit), /remote refs/u);
  }

  // A release tag is legitimate, but only when the manifest declares it and it
  // points at the clean commit. Both halves matter: an undeclared tag is how
  // old history returns unnoticed, and a declared tag aimed elsewhere is the
  // same leak wearing an approved name.
  const main = { oid: cleanCommit, ref: 'refs/heads/main' };
  assert.doesNotThrow(() => assertRemoteRefs(
    [main, { oid: cleanCommit, ref: 'refs/tags/v0.1.0' }],
    cleanCommit,
    ['v0.1.0'],
  ));
  // An annotated tag publishes the tag object and its dereference; the
  // dereferenced commit is the one that has to match, not the tag object.
  assert.doesNotThrow(() => assertRemoteRefs(
    [main, { oid: '8'.repeat(40), ref: 'refs/tags/v0.1.0' }, { oid: cleanCommit, ref: 'refs/tags/v0.1.0^{}' }],
    cleanCommit,
    ['v0.1.0'],
  ));
  for (const [refs, tags] of [
    [[main, { oid: '6'.repeat(40), ref: 'refs/tags/v0.1.0' }], ['v0.1.0']],
    [[main, { oid: '6'.repeat(40), ref: 'refs/tags/v0.1.0' }, { oid: '6'.repeat(40), ref: 'refs/tags/v0.1.0^{}' }], ['v0.1.0']],
    [[main, { oid: cleanCommit, ref: 'refs/tags/v0.2.0' }], ['v0.1.0']],
    [[main], ['v0.1.0']],
    // The namespace that survives every history rewrite and cannot be deleted.
    [[main, { oid: '6'.repeat(40), ref: 'refs/pull/1/head' }], []],
  ]) {
    assert.throws(() => assertRemoteRefs(refs, cleanCommit, tags), /remote refs/u);
  }
});

// A rejection is printed by CI. `assert.doesNotMatch` attaches the string it
// scanned to the AssertionError as `actual`, so the report that says a
// credential was found also republishes it — into a build log that outlives the
// run and is readable by everyone who can see the job. A rejection may name the
// file and nothing of what the file held.
const SCANNED_BODY = ['scanned', 'body', 'that', 'must', 'not', 'reach', 'ci'].join('-');
const LEAKING_CONTENTS = {
  'credential content': CREDENTIAL_SAMPLES['github token'],
  'private absolute path': UNLISTED_PRIVATE_PATH,
  'private source reference': PRIVATE_REFERENCE_SAMPLES[0],
};

function capture(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

test('a rejection names the file it rejected and republishes nothing it read', () => {
  for (const [reason, secret] of Object.entries(LEAKING_CONTENTS)) {
    const body = `${SCANNED_BODY}\n${secret}\n`;
    const error = capture(() => assertPublicRepository(PUBLIC_REPOSITORY_FILES, {
      ...safeContents,
      'integration/index.ts': body,
    }));
    assert.ok(error, `${reason} was not rejected`);
    assert.ok(error.message.startsWith(reason), `${reason} is not the reported reason: ${error.message}`);
    assert.ok(error.message.includes('integration/index.ts'), `${reason} does not name the file`);
    assert.equal(error.actual, undefined, `${reason} attaches the scanned body to the report`);
    assert.equal(error.expected, undefined, `${reason} attaches an expectation built from the body`);
    for (const rendered of [error.message, String(error), error.stack ?? '', inspect(error)]) {
      assert.equal(rendered.includes(SCANNED_BODY), false, `${reason} republishes the scanned body`);
      assert.equal(rendered.includes(secret), false, `${reason} republishes the secret it found`);
    }
  }
});

test('an uncaught rejection prints the path and no scanned content to stderr', () => {
  const scanner = pathToFileURL(join(root, 'scripts', 'check-public-repository.mjs')).href;
  const body = `${SCANNED_BODY}\n${UNLISTED_PRIVATE_PATH}\n`;
  const directory = mkdtempSync(join(tmpdir(), 'mempalace-for-pi-scan-report-'));
  try {
    const entry = join(directory, 'reject.mjs');
    writeFileSync(entry, [
      `import { PUBLIC_REPOSITORY_FILES, assertPublicRepository } from ${JSON.stringify(scanner)};`,
      'const contents = Object.fromEntries(',
      "  PUBLIC_REPOSITORY_FILES.map((path) => [path, `public fixture for ${path}\\n`]),",
      ');',
      `contents['integration/index.ts'] = ${JSON.stringify(body)};`,
      'assertPublicRepository(PUBLIC_REPOSITORY_FILES, contents);',
      '',
    ].join('\n'));
    const child = spawnSync(process.execPath, [entry], { encoding: 'utf8' });
    const printed = `${child.stdout ?? ''}${child.stderr ?? ''}`;
    assert.notEqual(child.status, 0, 'the scanner accepted a private absolute path');
    assert.ok(printed.includes('integration/index.ts'), 'the report does not name the rejected file');
    assert.equal(printed.includes(SCANNED_BODY), false, 'the report printed the scanned body to stderr');
    assert.equal(printed.includes(UNLISTED_PRIVATE_PATH), false, 'the report printed the secret to stderr');
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

// A fixture may declare the inert opening delimiter on its own. It may not
// declare a key: the allowance blanks that delimiter, and the base64 body and
// the closing delimiter that follow it match no other class, so a complete key
// committed beside the fixture passes in every file that declares the header.
// Assembled from parts, like the samples above, so this suite holds no key.
const DELIMITER = '-'.repeat(5);
const KEY_LABEL = `${['PRIVATE', 'KEY'].join(' ')}${DELIMITER}`;
const KEY_HEADER = `${DELIMITER}BEGIN ${KEY_LABEL}`;
const KEY_FOOTER = `${DELIMITER}END ${KEY_LABEL}`;
const KEY_BODY_LINE = `MIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8AgEAAkEA${'a'.repeat(16)}`;
const KEY_BODY = [KEY_BODY_LINE, KEY_BODY_LINE, `${'b'.repeat(20)}==`].join('\n');
const COMPLETE_KEY = `${KEY_HEADER}\n${KEY_BODY}\n${KEY_FOOTER}`;
const TRUNCATED_KEY = `${KEY_HEADER}\n${KEY_BODY}`;
const KEY_DECLARING_FILES = [...FIXTURE_LITERALS]
  .filter(([, literals]) => literals.includes(KEY_HEADER))
  .map(([path]) => path);

test('a truncated key with a short body is rejected beside every inert header fixture', () => {
  for (const path of KEY_DECLARING_FILES) {
    for (const length of [16, 20, 32, 39]) {
      const key = `${KEY_HEADER}\n${'A'.repeat(length)}`;
      assert.match(
        rejection(path, key) ?? '',
        /key material/u,
        `${path} accepts a truncated private key with a ${length}-character body`,
      );
    }
  }
});

test('a complete key is rejected in every file that declares the inert header', () => {
  assert.ok(KEY_DECLARING_FILES.length >= 4, `too few files declare the inert header: ${KEY_DECLARING_FILES.length}`);
  for (const path of [...KEY_DECLARING_FILES, 'integration/index.ts']) {
    for (const [name, key] of Object.entries({ complete: COMPLETE_KEY, truncated: TRUNCATED_KEY })) {
      assert.match(
        rejection(path, key) ?? '',
        /credential content|key material/u,
        `${path} accepts a ${name} private key beside its inert header`,
      );
    }
  }
});

test('the inert header-only fixture is still accepted where it is declared', () => {
  for (const path of KEY_DECLARING_FILES) {
    assert.equal(rejection(path, KEY_HEADER), undefined, `${path} rejects the inert header it declares`);
  }
});

// Gates quote a failed child into an evidence file and onto stderr. A private
// key is a block, not a line: substituting per credential class replaces the
// opening delimiter and leaves the base64 body and the closing delimiter in the
// artefact, which is the whole key. The block is removed as a whole, first.
test('redaction removes a whole private key block, not just its opening delimiter', () => {
  for (const [name, key] of Object.entries({ complete: COMPLETE_KEY, truncated: TRUNCATED_KEY })) {
    const redacted = redactSecrets(`Functional tests failed with exit 1\n${key}\nnpm ERR! code 1`);
    for (const fragment of [KEY_HEADER, KEY_FOOTER, KEY_BODY_LINE]) {
      assert.equal(redacted.includes(fragment), false, `a ${name} key survives redaction: ${fragment}`);
    }
    assert.ok(redacted.includes('Functional tests failed with exit 1'), `${name} redaction lost the diagnostic head`);
    assert.ok(redacted.includes('npm ERR! code 1'), `${name} redaction lost the diagnostic tail`);
  }
});

test('a failed release check writes no key material to its evidence file or to stderr', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mempalace-for-pi-release-redaction-'));
  try {
    const packageRoot = join(directory, 'candidate', 'package');
    mkdirSync(packageRoot, { recursive: true });
    // Derived, not pinned: the gate rejects a candidate whose version differs
    // from the workspace, so a literal here turns every version bump into a
    // failure of this redaction test — which is about key material, not
    // versions, and would report the wrong cause.
    writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({
      engines: { node: '>=22.19.0' },
      name: 'mempalace-for-pi',
      version: JSON.parse(readRepositoryFile('package.json')).version,
    })}\n`);
    const tarball = join(directory, 'candidate.tgz');
    const packed = spawnSync('tar', ['-czf', tarball, '-C', join(directory, 'candidate'), 'package'], {
      encoding: 'utf8',
    });
    assert.equal(packed.status, 0, `could not build the candidate tarball: ${packed.stderr ?? ''}`);

    const fakePi = join(directory, 'pi');
    writeFileSync(fakePi, [
      '#!/usr/bin/env node',
      `process.stderr.write(${JSON.stringify(`pi probe marker\n${COMPLETE_KEY}\nend of pi probe\n`)});`,
      'process.exit(1);',
      '',
    ].join('\n'));
    chmodSync(fakePi, 0o755);

    const evidenceDirectory = join(directory, 'evidence');
    const env = { ...process.env, PI_BINARY: fakePi, RELEASE_EVIDENCE_DIR: evidenceDirectory };
    for (const name of Object.keys(env)) if (name.startsWith('EXPECTED_')) delete env[name];
    const gate = spawnSync(
      process.execPath,
      ['scripts/release-gate.mjs', '--runs', '1', '--tarball', tarball],
      { cwd: root, encoding: 'utf8', env },
    );
    assert.notEqual(gate.status, 0, 'the release gate passed with a failing child');

    const evidenceText = readFileSync(join(evidenceDirectory, 'latest.json'), 'utf8');
    const evidence = JSON.parse(evidenceText);
    const check = evidence.checks.find((entry) => entry.outcome === 'FAIL');
    assert.ok(check?.output, 'the failed check recorded no transcript');
    assert.ok(check.output.includes('pi probe marker'), 'the failed check lost its diagnostic transcript');
    assert.ok(evidence.error, 'the release gate recorded no error');
    for (const [sink, text] of Object.entries({
      'check transcript': check.output,
      'evidence error': evidence.error,
      'evidence file': evidenceText,
      stderr: `${gate.stdout ?? ''}${gate.stderr ?? ''}`,
    })) {
      for (const fragment of [KEY_HEADER, KEY_FOOTER, KEY_BODY_LINE]) {
        assert.equal(text.includes(fragment), false, `${sink} retained key material: ${fragment}`);
      }
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

// A credential assignment is not a line: it sits mid-expression in JavaScript,
// after another assignment on the same line, and inside one-line JSON, with the
// key or the value quoted — and escaped where the file embeds JSON in a string.
// A class anchored on the start of a line sees none of those.
const [PASSWORD_NAME, API_NAME, AWS_NAME, NPM_NAME] = [
  ['pass', 'word'].join(''),
  ['api', 'key'].join('_'),
  ['aws', 'secret', 'access', 'key'].join('_'),
  ['npm', 'config', 'token'].join('_'),
];
const SECRET_VALUE = 'S'.repeat(16);
const ASSIGNMENT_SAMPLES = {
  'escaped one-line json': `"{\\"${PASSWORD_NAME}\\": \\"${SECRET_VALUE}\\"}"`,
  'mid-line javascript': `const settings = { ${PASSWORD_NAME}: "${SECRET_VALUE}" };`,
  'npm token': `${NPM_NAME}: ${SECRET_VALUE}`,
  'one-line json': `{"${PASSWORD_NAME}":"${SECRET_VALUE}"}`,
  'quoted key and value': `'${API_NAME}' = '${SECRET_VALUE}'`,
  'second assignment on one line': `const mode = 'live'; ${API_NAME}=${SECRET_VALUE}`,
  'unquoted aws secret': `${AWS_NAME}=${SECRET_VALUE}`,
};

test('an assignment is rejected wherever it sits on the line', () => {
  for (const [name, sample] of Object.entries(ASSIGNMENT_SAMPLES)) {
    assert.match(rejection('integration/index.ts', sample) ?? '', /credential content/u, name);
  }
});

test('redaction removes an assignment wherever it sits and keeps the line around it', () => {
  for (const [name, sample] of Object.entries(ASSIGNMENT_SAMPLES)) {
    const redacted = redactSecrets(`first diagnostic line\n${sample}\nlast diagnostic line`);
    assert.equal(redacted.includes(SECRET_VALUE), false, `${name} survives redaction`);
    assert.equal(redacted.split('\n').length, 3, `${name} folded the transcript's lines together`);
    assert.equal(redacted.split('\n')[0], 'first diagnostic line', `${name} consumed the preceding line`);
    assert.equal(redacted.split('\n')[2], 'last diagnostic line', `${name} consumed the following line`);
  }
  assert.match(redactSecrets(ASSIGNMENT_SAMPLES['one-line json']), /^\{.*\}$/u, 'redaction ate the JSON delimiters');
  assert.match(
    redactSecrets(ASSIGNMENT_SAMPLES['mid-line javascript']),
    /^const settings = \{ .* \};$/u,
    'redaction ate the statement around the assignment',
  );
  assert.match(
    redactSecrets(ASSIGNMENT_SAMPLES['second assignment on one line']),
    /^const mode = 'live'; /u,
    'redaction ate the assignment that preceded the credential',
  );
});

// The one newline an assignment may cross: an indented continuation is part of
// the assignment, not a line of its own. This is the shape the line-anchored
// class did reach, so the boundary-aware class has to keep reaching it.
const CONTINUED_ASSIGNMENT = `${PASSWORD_NAME}:\n  ${SECRET_VALUE}`;

test('an assignment continued onto an indented line is still rejected and redacted', () => {
  assert.match(rejection('integration/index.ts', CONTINUED_ASSIGNMENT) ?? '', /credential content/u);
  const redacted = redactSecrets(`first diagnostic line\n${CONTINUED_ASSIGNMENT}\nlast diagnostic line`);
  assert.equal(redacted.includes(SECRET_VALUE), false, 'a continued assignment survives redaction');
  assert.equal(redacted.split('\n')[0], 'first diagnostic line', 'redaction consumed the preceding line');
  assert.equal(redacted.split('\n').at(-1), 'last diagnostic line', 'redaction consumed the following line');
});

test('the tracked catalogue may hold more classes than the package check, and none is line-anchored', () => {
  const packaged = credentialClasses(readRepositoryFile('scripts/check-package.mjs'), 'credentialContent');
  const tracked = credentialClasses(readRepositoryFile('scripts/check-public-repository.mjs'), 'CREDENTIALS');
  assert.ok(
    tracked.length > packaged.length,
    'the tracked scanner is expected to enforce classes the package check does not',
  );
  for (const pattern of tracked) {
    assert.equal(
      pattern.includes(String.raw`(?:^|\n)`),
      false,
      `a line-anchored credential class cannot see a mid-line assignment: ${pattern}`,
    );
  }
});
