import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ProjectConfig } from '../../integration/config.ts';
import type { Launcher } from '../../integration/resolve.ts';
import {
  PalaceAccessError,
  describeLauncher,
  describePalace,
  mcpServerArgv,
  resolveLauncher,
  resolveOnPath,
  resolvePalace,
} from '../../integration/resolve.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const BIN_FIXTURE = join(here, 'fixtures', 'fake-mempalace-bin.mjs');

const scratch = mkdtempSync(join(tmpdir(), 'mempalace-resolve-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A PATH entry holding an executable named exactly `mempalace-mcp`. */
function binDirectoryWithMcp(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const installed = join(dir, 'mempalace-mcp');
  copyFileSync(BIN_FIXTURE, installed);
  chmodSync(installed, 0o755);
  return dir;
}

/** A PATH entry holding nothing the resolver may accept. */
function emptyBinDirectory(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const HOME = join(scratch, 'home');
mkdirSync(HOME, { recursive: true });

// ---------------------------------------------------------------------------
// Executable resolution
// ---------------------------------------------------------------------------

test('resolveOnPath finds an executable by name across PATH entries', () => {
  const empty = emptyBinDirectory('path-empty');
  const withBin = binDirectoryWithMcp('path-with-bin');

  assert.equal(
    resolveOnPath('mempalace-mcp', { PATH: [empty, withBin].join(':') }, { platform: 'linux' }),
    join(withBin, 'mempalace-mcp'),
  );
});

test('resolveOnPath rejects a non-executable file and an empty PATH', () => {
  const dir = emptyBinDirectory('path-not-executable');
  writeFileSync(join(dir, 'mempalace-mcp'), 'not executable\n');
  chmodSync(join(dir, 'mempalace-mcp'), 0o644);

  assert.equal(resolveOnPath('mempalace-mcp', { PATH: dir }, { platform: 'linux' }), null);
  assert.equal(resolveOnPath('mempalace-mcp', {}, { platform: 'linux' }), null);
});

// ---------------------------------------------------------------------------
// Launcher resolution
// ---------------------------------------------------------------------------

test('a `mempalace-mcp` executable on PATH resolves to path mode', () => {
  const dir = binDirectoryWithMcp('launcher-path');
  const launcher = resolveLauncher({ PATH: dir }, { platform: 'linux' });

  assert.equal(launcher.mode, 'path');
  assert.equal(launcher.mempalaceMcpBin, join(dir, 'mempalace-mcp'));
});

test('MEMPALACE_DIR resolves to uv mode when nothing is on PATH', () => {
  const checkout = join(scratch, 'mempalace-checkout');
  const launcher = resolveLauncher(
    { PATH: emptyBinDirectory('launcher-empty'), MEMPALACE_DIR: checkout },
    { platform: 'linux' },
  );

  assert.deepEqual(launcher, { mode: 'uv', dir: checkout });
});

test('MEMPALACE_DIR accepts a home-relative checkout', () => {
  const launcher = resolveLauncher(
    { PATH: emptyBinDirectory('launcher-tilde'), MEMPALACE_DIR: '~/mempalace' },
    { platform: 'linux', homeDir: HOME },
  );

  assert.deepEqual(launcher, { mode: 'uv', dir: join(HOME, 'mempalace') });
});

test('an installed executable wins over a checkout directory', () => {
  const dir = binDirectoryWithMcp('launcher-precedence');
  const launcher = resolveLauncher(
    { PATH: dir, MEMPALACE_DIR: join(scratch, 'ignored-checkout') },
    { platform: 'linux' },
  );

  assert.equal(launcher.mode, 'path');
  assert.equal(launcher.dir, undefined);
});

test('no executable and no checkout leaves the integration inert', () => {
  const launcher = resolveLauncher({ PATH: emptyBinDirectory('launcher-inert') }, { platform: 'linux' });

  assert.deepEqual(launcher, { mode: 'inert' });
  assert.equal(mcpServerArgv(launcher, join(scratch, 'palace')), null);
});

// ---------------------------------------------------------------------------
// Server argv — `mempalace-mcp` is executed directly
// ---------------------------------------------------------------------------

test('path mode executes the resolved `mempalace-mcp` binary against the palace', () => {
  const bin = join(binDirectoryWithMcp('argv-path'), 'mempalace-mcp');
  const palace = join(scratch, 'argv-palace');

  assert.deepEqual(mcpServerArgv({ mode: 'path', mempalaceMcpBin: bin }, palace), {
    cmd: bin,
    args: ['--palace', palace],
  });
});

test('uv mode runs the `mempalace-mcp` console script from the checkout', () => {
  const checkout = join(scratch, 'argv-checkout');
  const palace = join(scratch, 'argv-palace-uv');

  assert.deepEqual(mcpServerArgv({ mode: 'uv', dir: checkout }, palace), {
    cmd: 'uv',
    args: ['run', '--directory', checkout, 'mempalace-mcp', '--palace', palace],
  });
});

test('no launcher ever invokes the `mempalace` CLI or an `mcp` subcommand', () => {
  const launchers: Launcher[] = [
    { mode: 'path', mempalaceMcpBin: join(scratch, 'bin', 'mempalace-mcp') },
    { mode: 'uv', dir: join(scratch, 'checkout') },
  ];

  for (const launcher of launchers) {
    const argv = mcpServerArgv(launcher, join(scratch, 'palace'));
    assert.ok(argv, `${launcher.mode} mode must produce an argv`);
    assert.notEqual(basename(argv.cmd), 'mempalace', 'the `mempalace` CLI does not serve MCP');
    assert.ok(!argv.args.includes('mcp'), 'there is no `mempalace mcp` fallback to fall back to');
    assert.ok(
      argv.cmd.endsWith('mempalace-mcp') || argv.args.includes('mempalace-mcp'),
      'the MCP server executable must be named explicitly',
    );
  }
});

// ---------------------------------------------------------------------------
// Palace resolution
// ---------------------------------------------------------------------------

test('MEMPALACE_PALACE reconnects an existing palace exactly as given', () => {
  const existing = join(scratch, 'existing-palace');
  mkdirSync(existing, { recursive: true });
  writeFileSync(join(existing, 'drawers.jsonl'), '{"kept":true}\n');

  const resolution = resolvePalace({ MEMPALACE_PALACE: existing }, scratch, { homeDir: HOME });

  assert.equal(resolution.palacePath, existing);
  assert.equal(resolution.source, 'env');
  assert.equal(
    readFileSync(join(existing, 'drawers.jsonl'), 'utf8'),
    '{"kept":true}\n',
    'resolution reads configuration; it never touches stored data',
  );
});

test('MEMPALACE_PALACE accepts a home-relative palace', () => {
  mkdirSync(join(HOME, 'palaces'), { recursive: true });
  const resolution = resolvePalace({ MEMPALACE_PALACE: '~/palaces/work' }, scratch, { homeDir: HOME });

  assert.equal(resolution.palacePath, join(HOME, 'palaces', 'work'));
  assert.equal(resolution.source, 'env');
});

test('a blank override does not count as an explicit palace', () => {
  const resolution = resolvePalace({ MEMPALACE_PALACE: '   ' }, scratch, { homeDir: HOME });

  assert.equal(resolution.source, 'identity');
});

// ---------------------------------------------------------------------------
// Project-configured palace
// ---------------------------------------------------------------------------

/** A palace directory that already holds retained records. */
function retainedPalace(name: string): string {
  const palace = join(scratch, name);
  mkdirSync(palace, { recursive: true });
  writeFileSync(join(palace, 'drawers.jsonl'), '{"kept":true}\n');
  return palace;
}

/** The refusal an unusable explicit palace produces, or `null` when it resolved. */
function refusal(env: Record<string, string | undefined>, config: ProjectConfig | null): PalaceAccessError | null {
  try {
    resolvePalace(env, scratch, { homeDir: HOME, config });
    return null;
  } catch (error) {
    assert.ok(error instanceof PalaceAccessError, `expected a PalaceAccessError, got ${String(error)}`);
    return error;
  }
}

test('a project-configured palace resolves as its own distinct source', () => {
  const palace = retainedPalace('project-config-palace');
  const resolution = resolvePalace({}, scratch, { homeDir: HOME, config: { version: 1, palace } });

  assert.equal(resolution.palacePath, palace);
  assert.equal(resolution.source, 'project-config');
  assert.equal(
    readFileSync(join(palace, 'drawers.jsonl'), 'utf8'),
    '{"kept":true}\n',
    'reconnecting a retained palace never touches its bytes',
  );
});

test('a project-configured palace is portable through a home-relative path', () => {
  mkdirSync(join(HOME, 'palaces'), { recursive: true });
  const resolution = resolvePalace({}, scratch, {
    homeDir: HOME,
    config: { version: 1, palace: '~/palaces/shared' },
  });

  assert.equal(resolution.palacePath, join(HOME, 'palaces', 'shared'));
  assert.equal(resolution.source, 'project-config');
});

test('a temporary override outranks the project-configured palace', () => {
  const overridden = retainedPalace('override-palace');
  const configured = retainedPalace('configured-palace');
  const resolution = resolvePalace({ MEMPALACE_PALACE: overridden }, scratch, {
    homeDir: HOME,
    config: { version: 1, palace: configured },
  });

  assert.equal(resolution.palacePath, overridden);
  assert.equal(resolution.source, 'env');
});

test('a blank override leaves the project-configured palace in force', () => {
  const configured = retainedPalace('blank-override-palace');
  const resolution = resolvePalace({ MEMPALACE_PALACE: '   ' }, scratch, {
    homeDir: HOME,
    config: { version: 1, palace: configured },
  });

  assert.equal(resolution.palacePath, configured);
  assert.equal(resolution.source, 'project-config');
});

test('a document that declares no palace still resolves the project default', () => {
  const resolution = resolvePalace({}, scratch, { homeDir: HOME, config: { version: 1, readOnly: true } });

  assert.equal(resolution.source, 'identity');
  assert.equal(dirname(resolution.palacePath), join(HOME, '.mempalace'));
});

// ---------------------------------------------------------------------------
// Explicit palace preflight — no fallback, no mutation
// ---------------------------------------------------------------------------

test('an explicit palace that is not a directory is refused, not replaced', () => {
  const file = join(scratch, 'palace-is-a-file');
  writeFileSync(file, 'not a palace\n');

  for (const [origin, error] of [
    ['env', refusal({ MEMPALACE_PALACE: file }, null)],
    ['project-config', refusal({}, { version: 1, palace: file })],
  ] as const) {
    assert.ok(error, `${origin} accepted a palace that is not a directory`);
    assert.equal(error.reason, 'not-a-directory', origin);
    assert.equal(error.source, origin);
  }

  assert.equal(readFileSync(file, 'utf8'), 'not a palace\n', 'a refused palace keeps its bytes');
});

test('an unreachable explicit palace is refused rather than created', () => {
  const missing = join(scratch, 'absent-parent', 'palace');

  const error = refusal({ MEMPALACE_PALACE: missing }, null);

  assert.ok(error, 'an explicit palace under a missing parent must not resolve');
  assert.equal(error.reason, 'unreachable');
  assert.equal(existsSync(join(scratch, 'absent-parent')), false, 'preflight must create nothing');
  assert.equal(existsSync(missing), false, 'preflight must create nothing');
});

test('an unreadable explicit palace is refused without reading past it', () => {
  const locked = join(scratch, 'locked-palace');
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, 'drawers.jsonl'), '{"kept":true}\n');
  chmodSync(locked, 0o000);
  after(() => chmodSync(locked, 0o755));

  const error = refusal({ MEMPALACE_PALACE: locked }, null);

  assert.ok(error, 'an unreadable palace must not resolve');
  assert.equal(error.reason, 'unreadable');
});

test('a refused explicit palace never falls back to the identity default', () => {
  const missing = join(scratch, 'no-such-parent', 'palace');
  const fallback = resolvePalace({}, scratch, { homeDir: HOME }).palacePath;

  assert.throws(
    () => resolvePalace({ MEMPALACE_PALACE: missing }, scratch, { homeDir: HOME }),
    PalaceAccessError,
  );
  assert.throws(
    () => resolvePalace({}, scratch, { homeDir: HOME, config: { version: 1, palace: missing } }),
    PalaceAccessError,
  );
  assert.equal(existsSync(fallback), false, 'a refused explicit palace must not materialize a substitute');
});

test('a first-run explicit palace under a reachable parent is accepted', () => {
  const parent = join(scratch, 'reachable-parent');
  mkdirSync(parent, { recursive: true });
  const palace = join(parent, 'new-palace');

  const resolution = resolvePalace({ MEMPALACE_PALACE: palace }, scratch, { homeDir: HOME });

  assert.equal(resolution.palacePath, palace);
  assert.equal(resolution.source, 'env');
  assert.equal(existsSync(palace), false, 'resolution declares the palace; the core owns creating it');
});

test('the identity default is never preflighted away when it does not exist yet', () => {
  const freshHome = join(scratch, 'fresh-home');
  mkdirSync(freshHome, { recursive: true });

  const resolution = resolvePalace({}, scratch, { homeDir: freshHome });

  assert.equal(resolution.source, 'identity');
  assert.equal(existsSync(join(freshHome, '.mempalace')), false, 'the default is declared, never created');
});

test('a palace refusal is actionable without exposing the path it refused', () => {
  const missing = join(scratch, 'undisclosed-parent', 'palace');

  for (const [origin, error] of [
    ['MEMPALACE_PALACE', refusal({ MEMPALACE_PALACE: missing }, null)],
    ['.pi/mempalace.json', refusal({}, { version: 1, palace: missing })],
  ] as const) {
    assert.ok(error);
    assert.ok(error.message.includes(origin), `the refusal does not name ${origin}: ${error.message}`);
    assert.ok(!error.message.includes(missing), `the refusal exposes the palace path: ${error.message}`);
    assert.ok(!error.message.includes(HOME), `the refusal exposes the home directory: ${error.message}`);
    assert.ok(!error.message.includes(scratch), `the refusal exposes a machine-specific path: ${error.message}`);
  }
});

test('resolution never reads the configuration document itself', () => {
  // The document may only be read after the host resolves project trust, so
  // resolution must accept an already-parsed document and open no file of its own.
  const source = readFileSync(join(root, 'integration', 'resolve.ts'), 'utf8');

  for (const forbidden of ['readFileSync', 'readFile', 'mempalace.json', 'projectConfigPath', 'readProjectConfig']) {
    assert.ok(!source.includes(forbidden), `integration/resolve.ts must not carry "${forbidden}"`);
  }
});

test('the default palace is derived from the project identity under the home directory', () => {
  const resolution = resolvePalace({}, scratch, { homeDir: HOME });

  assert.equal(resolution.source, 'identity');
  assert.equal(dirname(resolution.palacePath), join(HOME, '.mempalace'));
  assert.ok(
    basename(resolution.palacePath).includes(resolution.identity.digest),
    'the digest is what isolates two projects that share a basename',
  );
});

test('a different project identity selects a different default palace', () => {
  const first = join(scratch, 'palace-project-one');
  const second = join(scratch, 'palace-project-two');
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });

  assert.notEqual(
    resolvePalace({}, first, { homeDir: HOME }).palacePath,
    resolvePalace({}, second, { homeDir: HOME }).palacePath,
  );
});

// ---------------------------------------------------------------------------
// Public description
// ---------------------------------------------------------------------------

test('the public palace description reveals no raw absolute path', () => {
  for (const env of [{}, { MEMPALACE_PALACE: join(scratch, 'secret-palace') }]) {
    const resolution = resolvePalace(env, scratch, { homeDir: HOME });
    const description = describePalace(resolution);

    for (const [field, value] of Object.entries<string>(description)) {
      assert.ok(!value.includes(sep), `${field} exposes a path: ${value}`);
      assert.ok(!value.includes(HOME), `${field} exposes the home directory`);
      assert.ok(!value.includes(resolution.palacePath), `${field} exposes the palace location`);
    }
    assert.equal(description.project, resolution.identity.project);
  }
});

test('the public palace description still distinguishes an explicit palace', () => {
  const explicit = describePalace(resolvePalace({ MEMPALACE_PALACE: join(scratch, 'p') }, scratch, { homeDir: HOME }));
  const derived = describePalace(resolvePalace({}, scratch, { homeDir: HOME }));

  assert.notEqual(explicit.location, derived.location);
});

test('the public palace description separates all three selection origins', () => {
  const configured = retainedPalace('description-configured-palace');
  const locations = [
    describePalace(resolvePalace({ MEMPALACE_PALACE: join(scratch, 'p') }, scratch, { homeDir: HOME })),
    describePalace(resolvePalace({}, scratch, { homeDir: HOME, config: { version: 1, palace: configured } })),
    describePalace(resolvePalace({}, scratch, { homeDir: HOME })),
  ].map((description) => description.location!);

  assert.equal(new Set(locations).size, 3, 'each selection origin must be separately identifiable');
  for (const location of locations) {
    assert.ok(!location.includes(sep), `the location exposes a path: ${location}`);
    assert.ok(!location.includes(HOME), `the location exposes the home directory: ${location}`);
  }
});

test('the public launcher description names a mode, never a filesystem location', () => {
  const bin = join(binDirectoryWithMcp('describe-launcher'), 'mempalace-mcp');
  const descriptions = [
    describeLauncher({ mode: 'path', mempalaceMcpBin: bin }),
    describeLauncher({ mode: 'uv', dir: join(scratch, 'checkout') }),
    describeLauncher({ mode: 'inert' }),
  ];

  assert.equal(new Set(descriptions).size, 3, 'each mode is separately diagnosable');
  for (const description of descriptions) {
    assert.ok(!description.includes(sep), `launcher description exposes a path: ${description}`);
  }
});

// ---------------------------------------------------------------------------
// Migration boundary
// ---------------------------------------------------------------------------

test('resolution carries no private source assumption into the public integration', () => {
  const source = readFileSync(join(root, 'integration', 'resolve.ts'), 'utf8');

  // Assembled, not quoted, for the same reason the scanner assembles them.
  for (const forbidden of [
    ['ws', 'config'].join('-'),
    ['WE', 'STACK'].join('_'),
    ['we', 'stack'].join('-'),
    'mempalace mcp',
    '/Users/',
  ]) {
    assert.ok(!source.includes(forbidden), `integration/resolve.ts must not carry "${forbidden}"`);
  }
});
