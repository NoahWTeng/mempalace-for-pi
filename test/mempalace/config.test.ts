import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ProjectConfig } from '../../integration/config.ts';
import {
  PROJECT_CONFIG_LOCATION,
  PROJECT_CONFIG_VERSION,
  ProjectConfigError,
  effectiveConfig,
  parseProjectConfig,
  projectConfigPath,
  readProjectConfig,
} from '../../integration/config.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const scratch = mkdtempSync(join(tmpdir(), 'mempalace-config-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const HOME = join(scratch, 'home');
mkdirSync(HOME, { recursive: true });

/** A project directory holding exactly the given configuration document bytes. */
function projectWithDocument(name: string, document: string): string {
  const cwd = join(scratch, name);
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  writeFileSync(join(cwd, '.pi', 'mempalace.json'), document);
  return cwd;
}

/** The rejection a hostile document produces, or `null` when it was accepted. */
function rejection(document: string): ProjectConfigError | null {
  try {
    parseProjectConfig(document);
    return null;
  } catch (error) {
    assert.ok(error instanceof ProjectConfigError, `expected a ProjectConfigError, got ${String(error)}`);
    return error;
  }
}

// ---------------------------------------------------------------------------
// Document location
// ---------------------------------------------------------------------------

test('the configuration document has one stable, portable project location', () => {
  const cwd = join(scratch, 'location-project');

  assert.equal(PROJECT_CONFIG_LOCATION, '.pi/mempalace.json');
  assert.equal(projectConfigPath(cwd), join(cwd, '.pi', 'mempalace.json'));
});

test('an absent document keeps zero-configuration startup available', () => {
  const cwd = join(scratch, 'absent-project');
  mkdirSync(cwd, { recursive: true });

  assert.equal(readProjectConfig(cwd), null);
  assert.equal(existsSync(join(cwd, '.pi')), false, 'reading configuration must never create it');
});

test('reading a document returns its declarations without touching the bytes', () => {
  const document = '{\n  "version": 1,\n  "palace": "~/palaces/work"\n}\n';
  const cwd = projectWithDocument('read-project', document);

  assert.deepEqual(readProjectConfig(cwd), { version: 1, palace: '~/palaces/work' });
  assert.equal(readFileSync(projectConfigPath(cwd), 'utf8'), document, 'the loader never rewrites the document');
});

test('an unreadable document is a rejection, never a silent absence', () => {
  const cwd = projectWithDocument('unreadable-project', '{"version": 1}\n');
  chmodSync(projectConfigPath(cwd), 0o000);
  after(() => chmodSync(projectConfigPath(cwd), 0o644));

  const error = (() => {
    try {
      readProjectConfig(cwd);
      return null;
    } catch (caught) {
      return caught as ProjectConfigError;
    }
  })();

  assert.ok(error instanceof ProjectConfigError, 'an unreadable document must not read as absent');
  assert.equal(error.reason, 'unreadable');
});

// ---------------------------------------------------------------------------
// Strict version 1 contract
// ---------------------------------------------------------------------------

test('the first contract is exactly required version 1 plus four optional settings', () => {
  assert.equal(PROJECT_CONFIG_VERSION, 1);

  const full: ProjectConfig = parseProjectConfig(
    '{"version": 1, "palace": "~/p", "readOnly": true, "handoff": true, "disabled": false}',
  );

  assert.deepEqual(full, { version: 1, palace: '~/p', readOnly: true, handoff: true, disabled: false });
  assert.deepEqual(parseProjectConfig('{"version": 1}'), { version: 1 });
});

test('malformed JSON rejects instead of degrading to defaults', () => {
  for (const document of ['', '   ', '{', '{"version": 1,}', 'version: 1', '{"version": 1} trailing']) {
    const error = rejection(document);
    assert.ok(error, `malformed document accepted: ${JSON.stringify(document)}`);
    assert.equal(error.reason, 'malformed', JSON.stringify(document));
  }
});

test('a document that is not a JSON object rejects', () => {
  for (const document of ['null', '[]', '[{"version": 1}]', '"version 1"', '1', 'true']) {
    const error = rejection(document);
    assert.ok(error, `non-object document accepted: ${document}`);
    assert.equal(error.reason, 'not-an-object', document);
  }
});

test('a missing, mistyped, or unsupported version rejects explicitly', () => {
  for (const document of [
    '{}',
    '{"palace": "~/p"}',
    '{"version": "1"}',
    '{"version": null}',
    '{"version": true}',
    '{"version": 0}',
    '{"version": 2}',
    '{"version": 1.5}',
  ]) {
    const error = rejection(document);
    assert.ok(error, `unsupported version accepted: ${document}`);
    assert.equal(error.reason, 'version', document);
  }
});

// The wake-up ranks rooms by name prefix, and the shipped default assumes this
// repository's own naming. A project that names its rooms differently — `valee` is
// the measured case, 3 of its 11 snapshot drawers matched — had no way to ask for
// its own, so the always-on block stayed alphabetical for it. This is that field.
test('rooms accepts a list of room-name prefixes', () => {
  const config = parseProjectConfig('{"version": 1, "rooms": ["lessons", "adr"]}');
  assert.deepEqual(config.rooms, ['lessons', 'adr']);
});

test('rooms rejects anything that is not a list of non-empty strings', () => {
  for (const value of ['"lessons"', '1', 'null', 'true', '{}', '[1]', '[null]', '[""]', '["  "]', '[[]]']) {
    const error = rejection(`{"version": 1, "rooms": ${value}}`);
    assert.ok(error, `rooms accepted a bad value: ${value}`);
    assert.equal(error.reason, 'field-type', value);
  }
});

// An unbounded list is a way to spend the capture budget from a config file. The
// block only ever ships about ten drawers, so more prefixes than that could never
// all be represented anyway.
test('rooms is bounded in both count and prefix length', () => {
  const tooMany = JSON.stringify(Array.from({ length: 64 }, (_, index) => `room-${index}`));
  const tooLong = JSON.stringify(['x'.repeat(500)]);
  for (const value of [tooMany, tooLong]) {
    const error = rejection(`{"version": 1, "rooms": ${value}}`);
    assert.ok(error, 'an unbounded rooms list was accepted');
    assert.equal(error.reason, 'field-type');
  }
});

test('rooms reports its source and leaves the shipped default undeclared', () => {
  const declared = effectiveConfig({}, { version: PROJECT_CONFIG_VERSION, rooms: ['lessons'] });
  assert.deepEqual(declared.rooms, ['lessons']);
  assert.equal(declared.sources.rooms, 'project-config');

  // Undeclared stays undefined rather than copying the wake-up's own default, so
  // exactly one place decides what the shipped ranking is.
  const absent = effectiveConfig({}, null);
  assert.equal(absent.rooms, undefined);
  assert.equal(absent.sources.rooms, 'default');
});

test('MEMPALACE_ROOMS overrides the document for one launch', () => {
  const effective = effectiveConfig(
    { MEMPALACE_ROOMS: 'lessons, adr ,, ' },
    { version: PROJECT_CONFIG_VERSION, rooms: ['invariants'] },
  );
  assert.deepEqual(effective.rooms, ['lessons', 'adr'], 'blank entries should be dropped, not kept');
  assert.equal(effective.sources.rooms, 'env');

  // A blank override declares nothing, the same way a blank palace override does.
  const blank = effectiveConfig(
    { MEMPALACE_ROOMS: '  ' },
    { version: PROJECT_CONFIG_VERSION, rooms: ['invariants'] },
  );
  assert.deepEqual(blank.rooms, ['invariants']);
  assert.equal(blank.sources.rooms, 'project-config');
});

test('an unknown key rejects and names the key it refused', () => {
  for (const key of ['palacePath', 'readonly', 'Handoff', 'enabled', 'credential', '__proto__']) {
    const error = rejection(`{"version": 1, ${JSON.stringify(key)}: "x"}`);
    assert.ok(error, `unknown key accepted: ${key}`);
    assert.equal(error.reason, 'unknown-field', key);
    assert.ok(error.message.includes(key), `the rejection does not name "${key}": ${error.message}`);
  }
});

test('an oversized or escaped unknown key stays inside the diagnostic bound', () => {
  for (const key of ['x'.repeat(100000), '\u0001'.repeat(80)]) {
    const error = rejection(`{"version": 1, ${JSON.stringify(key)}: "x"}`);
    assert.ok(error);
    assert.equal(error.reason, 'unknown-field');
    assert.ok(error.message.length <= 300, `the error message exceeds 300 bytes: ${error.message.length}`);
    assert.ok(error.message.includes('unknown key'), 'the truncated message must still explain what was wrong');
    assert.ok(!error.message.includes(key), 'the full key must not appear in the truncated error');
  }
});

test('a wrong value type rejects for every optional setting', () => {
  for (const document of [
    '{"version": 1, "palace": 1}',
    '{"version": 1, "palace": null}',
    '{"version": 1, "palace": ["~/p"]}',
    '{"version": 1, "palace": ""}',
    '{"version": 1, "palace": "   "}',
    '{"version": 1, "readOnly": "true"}',
    '{"version": 1, "readOnly": 1}',
    '{"version": 1, "readOnly": null}',
    '{"version": 1, "handoff": "1"}',
    '{"version": 1, "handoff": {}}',
    '{"version": 1, "disabled": "false"}',
    '{"version": 1, "disabled": 0}',
  ]) {
    const error = rejection(document);
    assert.ok(error, `wrong type accepted: ${document}`);
    assert.equal(error.reason, 'field-type', document);
  }
});

test('a rejection is actionable without exposing a machine-specific path', () => {
  const cwd = projectWithDocument('diagnostic-project', '{"version": 2}\n');

  const error = (() => {
    try {
      readProjectConfig(cwd);
      return null;
    } catch (caught) {
      return caught as ProjectConfigError;
    }
  })();

  assert.ok(error instanceof ProjectConfigError);
  assert.ok(error.message.includes(PROJECT_CONFIG_LOCATION), 'the diagnostic must name the document to fix');
  assert.ok(!error.message.includes(cwd), `the diagnostic exposes the project path: ${error.message}`);
  assert.ok(!error.message.includes(HOME), `the diagnostic exposes the home directory: ${error.message}`);
  assert.ok(!error.message.includes(scratch), `the diagnostic exposes a machine-specific path: ${error.message}`);
});

test('a document carrying secret material is refused by the closed contract', () => {
  // FR-015: the contract holds no field a credential could legitimately occupy,
  // so secret material can only arrive as an unknown key — and is refused there.
  const error = rejection('{"version": 1, "credential": "value", "palace": "~/p"}');

  assert.ok(error);
  assert.equal(error.reason, 'unknown-field');
  assert.ok(!error.message.includes('value'), 'a rejection must not echo the refused value back');
});

// ---------------------------------------------------------------------------
// Per-field precedence: MEMPALACE_* > JSON > defaults
// ---------------------------------------------------------------------------

test('defaults apply when neither the environment nor the document declares a field', () => {
  assert.deepEqual(effectiveConfig({}, null), {
    palace: undefined,
    rooms: undefined,
    readOnly: false,
    handoff: false,
    disabled: false,
    recall: false,
    sources: {
      palace: 'default', readOnly: 'default', handoff: 'default',
      disabled: 'default', recall: 'default', rooms: 'default',
    },
  });
});

test('project configuration supplies every field the environment leaves alone', () => {
  const config = effectiveConfig({}, {
    version: 1,
    palace: '~/palaces/work',
    readOnly: true,
    handoff: true,
    disabled: true,
  });

  assert.equal(config.palace, '~/palaces/work', 'resolution owns expansion; the loader keeps the declared value');
  assert.deepEqual(
    { readOnly: config.readOnly, handoff: config.handoff, disabled: config.disabled },
    { readOnly: true, handoff: true, disabled: true },
  );
  assert.deepEqual(config.sources, {
    palace: 'project-config',
    readOnly: 'project-config',
    handoff: 'project-config',
    disabled: 'project-config',
    recall: 'default',
    rooms: 'default',
  });
});

test('a temporary environment override wins per field, leaving the rest on the document', () => {
  const config = effectiveConfig(
    { MEMPALACE_PALACE: '/tmp/incident-palace', MEMPALACE_HANDOFF: '1' },
    { version: 1, palace: '~/palaces/work', readOnly: true, handoff: false },
  );

  assert.equal(config.palace, '/tmp/incident-palace');
  assert.equal(config.handoff, true);
  assert.equal(config.readOnly, true, 'an untouched field still comes from the document');
  assert.deepEqual(config.sources, {
    palace: 'env',
    readOnly: 'project-config',
    handoff: 'env',
    disabled: 'default',
    recall: 'default',
    rooms: 'default',
  });
});

test('a defined boolean override that is not the literal 1 forces the field off', () => {
  // The documented rule is that only `1` enables a boolean control. Presence is
  // therefore the whole signal: `MEMPALACE_READ_ONLY=0` must switch read-only
  // off for that launch even though the shared document turned it on.
  for (const value of ['0', 'true', 'yes', '', ' ']) {
    const config = effectiveConfig(
      { MEMPALACE_READ_ONLY: value, MEMPALACE_HANDOFF: value, MEMPALACE_BRIDGE_DISABLE: value },
      { version: 1, readOnly: true, handoff: true, disabled: true },
    );

    assert.deepEqual(
      { readOnly: config.readOnly, handoff: config.handoff, disabled: config.disabled },
      { readOnly: false, handoff: false, disabled: false },
      `MEMPALACE_* = ${JSON.stringify(value)} did not override the document`,
    );
    assert.deepEqual(config.sources, {
      palace: 'default',
      readOnly: 'env',
      handoff: 'env',
      disabled: 'env',
      recall: 'default',
      rooms: 'default',
    });
  }
});

test('a blank palace override is absent, so the document keeps the field', () => {
  for (const value of ['', '   ', '\t\n']) {
    const config = effectiveConfig(
      { MEMPALACE_PALACE: value },
      { version: 1, palace: '~/palaces/work' },
    );

    assert.equal(config.palace, '~/palaces/work', `blank ${JSON.stringify(value)} consumed the document palace`);
    assert.equal(config.sources.palace, 'project-config');
  }
});

test('a blank palace override with no document falls through to the project default', () => {
  const config = effectiveConfig({ MEMPALACE_PALACE: '   ' }, null);

  assert.equal(config.palace, undefined);
  assert.equal(config.sources.palace, 'default');
});

test('a palace override is trimmed but otherwise carried through verbatim', () => {
  const config = effectiveConfig({ MEMPALACE_PALACE: '  ~/palaces/work  ' }, null);

  assert.equal(config.palace, '~/palaces/work');
  assert.equal(config.sources.palace, 'env');
});

test('existing environment-only launches keep their exact current behavior', () => {
  const enabled = effectiveConfig({ MEMPALACE_READ_ONLY: '1', MEMPALACE_HANDOFF: '1' }, null);
  assert.deepEqual(
    { readOnly: enabled.readOnly, handoff: enabled.handoff, disabled: enabled.disabled },
    { readOnly: true, handoff: true, disabled: false },
  );

  const disabled = effectiveConfig({ MEMPALACE_BRIDGE_DISABLE: '1' }, null);
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.sources.disabled, 'env');
});

// ---------------------------------------------------------------------------
// Dependency and boundary
// ---------------------------------------------------------------------------

test('the strict loader adds no dependency and no non-standard import', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies, undefined, 'the integration must ship with no runtime dependency');

  const source = readFileSync(join(root, 'integration', 'config.ts'), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/gu)].map((match) => match[1]!);
  for (const specifier of imports) {
    assert.ok(
      specifier.startsWith('node:') || specifier.startsWith('./'),
      `integration/config.ts imports a non-standard module: ${specifier}`,
    );
  }
  // Assembled, not quoted: this file is scanned by the same private source rule
  // it helps enforce, and the repository it ships in is public.
  for (const forbidden of [
    ['ws', 'config'].join('-'),
    'yaml',
    ['WE', 'STACK'].join('_'),
    ['we', 'stack'].join('-'),
    '/Users/',
  ]) {
    assert.ok(!source.includes(forbidden), `integration/config.ts must not carry "${forbidden}"`);
  }
});
