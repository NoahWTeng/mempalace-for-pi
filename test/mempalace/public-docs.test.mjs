import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = new URL('../..', import.meta.url);
const PUBLIC_DOCS = [
  'README.md',
  'CHANGELOG.md',
  'docs/public/install.md',
  'docs/public/configuration.md',
  'docs/public/privacy.md',
  'docs/public/migration.md',
  'docs/public/troubleshooting.md',
  'docs/public/compatibility.md',
];

function text(path) {
  return readFileSync(new URL(path, ROOT), 'utf8');
}

function allText() {
  return PUBLIC_DOCS.map((path) => `\n<!-- ${path} -->\n${text(path)}`).join('\n');
}

function markdownLinks(content) {
  return [...content.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/gu)].map((match) => match[1]);
}

test('public documentation set exists, is linked, and contains no broken relative links', () => {
  for (const path of PUBLIC_DOCS) assert.equal(existsSync(new URL(path, ROOT)), true, `missing ${path}`);

  const readme = text('README.md');
  for (const path of PUBLIC_DOCS.slice(2)) assert.match(readme, new RegExp(`\\(${path.replaceAll('/', '\\/')}\\)`, 'u'));

  for (const path of PUBLIC_DOCS) {
    for (const link of markdownLinks(text(path))) {
      if (/^(?:https?:|mailto:|#)/u.test(link)) continue;
      const target = link.split('#', 1)[0];
      assert(target, `empty relative link in ${path}`);
      const resolved = normalize(join(dirname(path), target));
      assert.equal(existsSync(new URL(resolved, ROOT)), true, `broken link in ${path}: ${link}`);
    }
  }
});

test('identity, status, install path, first use, and release authorization claims are exact', () => {
  const docs = allText();
  assert.match(text('README.md'), /^# MemPalace for Pi$/mu);
  assert.match(docs, /community-maintained/u);
  assert.match(docs, /mempalace-for-pi/u);
  assert.match(docs, /official MemPalace core/u);
  assert.match(docs, /separate(?:ly)? (?:installed|distributed)|separate prerequisite/iu);
  assert.match(text('docs/public/install.md'), /uv tool install --python 3\.12 'mempalace==3\.7\.1'/u);
  assert.match(text('docs/public/install.md'), /pi install git:github\.com\/NoahWTeng\/mempalace-for-pi/u);
  // Both approved sources stay documented. npm is the short path; Git is the
  // one a reader can audit before running it, and it is the only one that can
  // pin a commit. Dropping either removes a choice the release actually offers.
  assert.match(docs, /npm:mempalace-for-pi/u);
  assert.match(docs, /git:github\.com\/NoahWTeng\/mempalace-for-pi/u);
  // Two sources are one release only if the documentation says so; otherwise a
  // reader has no reason to believe the npm tarball is the reviewed tree.
  assert.match(docs, /same artifact|one artifact|same bytes/iu);
  for (const tool of ['palace_search', 'palace_save', 'palace_diary', 'palace_status']) {
    assert.match(text('README.md'), new RegExp(`\\b${tool}\\b`, 'u'));
  }
  // Release status is stated, never left for the reader to infer.
  assert.match(text('README.md'), /## Release status/u);
  assert.match(docs, /Release authorization/u);
  // The pre-publication wording described a state that no longer exists, and
  // restating it would misrepresent the release rather than merely read stale.
  assert.doesNotMatch(docs, /\bunpublished\b/iu);
  assert.doesNotMatch(docs, /remains private[^\n]*(?:package|repositor)/iu);
});

// The project document is the portable half of the contract: it travels with
// the repository, so the documentation has to teach the project-local install,
// the trust decision that releases the document, and the exact keys the loader
// accepts — in that order, and without ever printing a machine-specific path.
test('installation documents the project-local package and the trust decision', () => {
  const install = text('docs/public/install.md');
  assert.match(install, /pi install -l npm:mempalace-for-pi/u);
  assert.match(install, /git:github\.com\/NoahWTeng\/mempalace-for-pi/u);
  assert.match(install, /`\.pi\/mempalace\.json`/u);
  assert.match(install, /trust/iu);
  assert.match(install, /--approve/u);
  assert.match(install, /restart/iu);
});

test('configuration documents the exact project JSON contract and its precedence', () => {
  const configuration = text('docs/public/configuration.md');
  assert.match(configuration, /`\.pi\/mempalace\.json`/u);
  assert.match(configuration, /"version": 1/u);
  for (const field of ['version', 'palace', 'readOnly', 'handoff', 'disabled']) {
    assert.match(configuration, new RegExp(`\`${field}\``, 'u'), `the JSON contract omits ${field}`);
  }
  assert.match(
    configuration,
    /`MEMPALACE_\*`[^\n]*>[^\n]*`\.pi\/mempalace\.json`[^\n]*>[^\n]*default/u,
    'the per-field precedence order must be stated exactly',
  );
  assert.match(configuration, /unknown key[^\n]*(?:reject|refus)/iu);
  assert.match(configuration, /(?:only|never)[^\n]*trust/iu);
  assert.match(configuration, /first `?session_start`?[^\n]*each Pi launch/iu);
  assert.match(configuration, /trusted at that point/iu);
  assert.match(configuration, /restart[^\n]*granting trust|granting trust[^\n]*restart/iu);
});

test('project setup is portable across computers and names no machine path', () => {
  const docs = allText();
  assert.match(docs, /`\.pi\/mempalace\.json`/u);
  assert.match(docs, /(?:multi-(?:PC|computer|machine)|another computer|second computer)/iu);
  assert.match(text('README.md'), /pi install -l npm:mempalace-for-pi/u);
  assert.match(text('docs/public/configuration.md'), /"palace": "~\//u);
  // A committed document that names a machine-specific location stops being
  // portable the moment a second computer checks the repository out.
  for (const [, declared] of docs.matchAll(/"palace"\s*:\s*"([^"]+)"/gu)) {
    assert.ok(
      declared.startsWith('~/') || !declared.startsWith('/'),
      `a documented palace declaration is machine-specific: ${declared}`,
    );
  }
});

test('status documentation uses actual source categories, not resolve vocabulary', () => {
  const configuration = text('docs/public/configuration.md');
  for (const category of ['env', 'project-config', 'default']) {
    assert.ok(configuration.includes(`\`${category}\``), `configuration omits the ${category} source category`);
  }
  assert.match(configuration, /configuration block[^\n]*(?:path|location)/iu);
  assert.doesNotMatch(configuration, /(?<![a-z-])describePalace(?![a-z-])/u, 'docs must not reference internal resolve functions');
});

test('configuration and privacy document both handoff opt-in paths and environment precedence', () => {
  const configuration = text('docs/public/configuration.md');
  const privacy = text('docs/public/privacy.md');
  for (const document of [configuration, privacy]) {
    assert.match(document, /`"handoff": true`/u);
    assert.match(document, /`MEMPALACE_HANDOFF=1`/u);
    assert.match(document, /environment[^\n]*(?:wins|precedence)/iu);
  }
  assert.doesNotMatch(configuration, /off by default unless `MEMPALACE_HANDOFF=1`/u);
});

test('configuration and privacy claims match the fail-closed runtime', () => {
  const docs = allText();
  const configuration = text('docs/public/configuration.md');
  for (const variable of [
    'MEMPALACE_DIR',
    'MEMPALACE_PALACE',
    'MEMPALACE_BRIDGE_DISABLE',
    'MEMPALACE_READ_ONLY',
    'MEMPALACE_HANDOFF',
  ]) assert.match(configuration, new RegExp(`\\b${variable}\\b`, 'u'));
  assert.match(configuration, /Git common directory/u);
  assert.match(configuration, /worktrees[^\n]*share/iu);
  assert.match(configuration, /independent clones[^\n]*isolated/iu);
  assert.match(configuration, /handoff[^\n]*(?:off|disabled) by default/iu);
  assert.match(configuration, /read-only[^\n]*reads[^\n]*(?:continue|available)/iu);
  assert.match(docs, /retain:false/u);
  assert.match(docs, /\[no-memory\]/u);
  assert.match(docs, /rejects? the whole (?:write )?candidate/iu);
  assert.match(docs, /no partial redaction/iu);
  assert.match(docs, /local-first/iu);
  assert.match(docs, /no routine[^\n]*network[^\n]*after provisioning/iu);
  assert.match(docs, /Pi(?:'s)? model provider[^\n]*(?:outside|not controlled)/iu);
  assert.match(docs, /tracked public boundary[^\n]*only the current MemPalace integration/iu);
  assert.doesNotMatch(docs, /historical `?src\/?`?[^\n]*(?:retained|remain)|historical `?benchmarks\/?`?[^\n]*(?:retained|remain)/iu);
});

test('migration and troubleshooting document the exact non-destructive lifecycle', () => {
  const migration = text('docs/public/migration.md');
  for (const word of ['disable', 'remove', 'reinstall', 'synthetic predecessor', 'rollback', 'current restore']) {
    assert.match(migration, new RegExp(word, 'iu'));
  }
  assert.match(migration, /never moves or deletes palace data/iu);
  assert.match(migration, /pi config/u);
  assert.match(migration, /pi remove git:github\.com\/NoahWTeng\/mempalace-for-pi/u);
  assert.match(migration, /MEMPALACE_PALACE/u);

  const troubleshooting = text('docs/public/troubleshooting.md');
  for (const claim of ['core is missing', 'timeout', 'permission', 'unsupported version', 'process cleanup', 'inert']) {
    assert.match(troubleshooting, new RegExp(claim, 'iu'));
  }
});

test('migration documents the retained private-bridge cutover without credentials', () => {
  const migration = text('docs/public/migration.md');
  assert.match(migration, /private bridge/iu);
  assert.match(migration, /`\.pi\/mempalace\.json`/u);
  assert.match(migration, /"palace": "~\//u);
  assert.match(migration, /never moves or deletes palace data/iu);
  assert.match(migration, /record ID|exact record/iu);
  assert.doesNotMatch(
    migration,
    /\b(?:token|api[_ -]?key|password|secret|credential)\b[^\S\n]*[:=]/iu,
    'the cutover must ask for no credential',
  );
});

test('troubleshooting diagnoses an invalid or untrusted project document', () => {
  const troubleshooting = text('docs/public/troubleshooting.md');
  assert.match(troubleshooting, /`\.pi\/mempalace\.json`/u);
  assert.match(troubleshooting, /could not use/iu);
  assert.match(troubleshooting, /(?:untrusted|not trusted)/iu);
  assert.match(troubleshooting, /(?:zero|no) palace tool/iu);
  assert.match(troubleshooting, /--approve/u);
});

test('documented rollback removes the old Pi source before installing its replacement', () => {
  const migration = text('docs/public/migration.md');
  assert.match(migration, /CURRENT_SOURCE=git:github\.com\/NoahWTeng\/mempalace-for-pi/u);
  assert.match(migration, /PINNED_SOURCE="git:github\.com\/NoahWTeng\/mempalace-for-pi@\$KNOWN_GOOD_COMMIT"/u);
  assert.match(migration, /pi remove "\$CURRENT_SOURCE"[\s\S]*pi install "\$PINNED_SOURCE"/u);
  assert.match(migration, /pi remove "\$PINNED_SOURCE"[\s\S]*pi install "\$CURRENT_SOURCE"/u);

  const root = mkdtempSync(join(tmpdir(), 'mempalace-for-pi-docs-'));
  try {
    const current = join(root, 'current');
    const pinned = join(root, 'pinned');
    const home = join(root, 'home');
    const agentDir = join(home, '.pi', 'agent');
    for (const source of [current, pinned]) {
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, 'package.json'), JSON.stringify({
        name: 'mempalace-for-pi',
        version: '0.1.0',
        private: true,
        pi: { extensions: [] },
      }));
    }
    mkdirSync(home);
    const pi = fileURLToPath(new URL('node_modules/.bin/pi', ROOT));
    const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir };
    const run = (...args) => execFileSync(pi, args, { env, stdio: 'pipe' });
    const sources = () => JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).packages;

    run('install', current);
    run('remove', current);
    run('install', pinned);
    assert.equal(sources().length, 1, 'rollback must leave exactly one configured source');

    run('remove', pinned);
    run('install', current);
    assert.equal(sources().length, 1, 'current restore must leave exactly one configured source');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compatibility page is an exact projection of the SHA-bound eight-cell matrix', () => {
  const matrix = JSON.parse(text('.github/verification/task-967-matrix.json'));
  assert.equal(matrix.cells.length, 8);
  assert(matrix.cells.every((cell) => cell.outcome === 'PASS'));
  const compatibility = text('docs/public/compatibility.md');
  assert.match(compatibility, /one SHA-bound packed candidate/iu);
  for (const cell of matrix.cells) {
    const row = `| ${cell.platform} | ${cell.arch} | ${cell.nodeDeclared} | ${cell.pi} | ${cell.core} | PASS |`;
    assert.equal(compatibility.split(row).length - 1, 1, `missing or duplicate matrix row: ${row}`);
  }
  assert.equal((compatibility.match(/^\| (?:darwin|linux) \| arm64 \|/gmu) ?? []).length, 8);
  assert.doesNotMatch(compatibility, /Windows|x64|amd64/iu);
  assert.doesNotMatch(compatibility, /Node (?:20|21|23|25)|Pi 0\.(?!84\.2)|MemPalace 3\.(?!6\.0|7\.1)/iu);
});

// The page is a projection, so it may only claim what every recorded cell
// actually produced. Each threshold below is a field of the matrix, and the
// matrix is written from real gate output rather than edited by hand.
test('compatibility states the exact evidence every recorded cell produced', () => {
  const compatibility = text('docs/public/compatibility.md');
  assert.match(compatibility, /`\.github\/verification\/task-967-matrix\.json`/u);
  assert.match(compatibility, /5\/5/u);
  assert.match(compatibility, /100% retention/u);
  assert.match(compatibility, /zero[^\n]*non-loopback/iu);
  assert.match(compatibility, /five seconds/iu);
  assert.match(compatibility, /project-local install/iu);
  assert.match(compatibility, /`\.pi\/mempalace\.json`/u);
});

test('the recorded matrix is one candidate proved by eight complete cells', () => {
  const matrix = JSON.parse(text('.github/verification/task-967-matrix.json'));
  assert.match(matrix.candidateSha256, /^[a-f0-9]{64}$/u);
  assert.equal(matrix.cells.length, 8);
  for (const cell of matrix.cells) {
    const cellName = `${cell.platform}+${cell.nodeDeclared}+${cell.core}`;
    assert.equal(cell.candidateSha256, matrix.candidateSha256, `${cellName} proves another candidate`);
    assert.equal(cell.sourceCommit, matrix.sourceCommit, `${cellName} proves another commit`);
    assert.equal(cell.sourceTree, matrix.sourceTree, `${cellName} proves another tree`);
    assert.equal(cell.recordsBefore, 5, `${cellName} did not create five records`);
    assert.equal(cell.recordsAfter, 5, `${cellName} did not retain five records`);
    assert.equal(cell.retainedPercent, 100, `${cellName} did not retain every record`);
    assert.equal(cell.networkAttempts, 0, `${cellName} attempted routine non-loopback network`);
    for (const phase of [
      'project-local-install',
      'project-json-palace',
      'restart',
      'env-override',
      'project-json-disabled',
      'project-json-invalid',
      'untrusted-json-unread',
    ]) {
      assert.ok(cell.lifecycle.includes(phase), `${cellName} did not exercise ${phase}`);
    }
  }
});

test('all public docs are present in the exact packed artifact', () => {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
  }))[0];
  const paths = new Set(packed.files.map(({ path }) => path));
  for (const path of PUBLIC_DOCS) assert(paths.has(path), `${path} is not packed`);
});
