import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test, { after } from 'node:test';

import { resolveProjectIdentity } from '../../integration/project-identity.ts';

// One scratch parent for every repository this file builds, removed once the
// file finishes. macOS hands out `/var/folders/...`, a symlink to
// `/private/var/folders/...`; that is not incidental here, it is the case that
// proves identity is taken from the canonical location rather than the spelling.
const scratch = mkdtempSync(join(tmpdir(), 'mempalace-identity-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): void {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')} failed: ${run.stderr}`);
}

/** A repository with one commit — `git worktree add` refuses an empty HEAD. */
function makeRepository(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
  git(dir, 'add', 'README.md');
  git(
    dir,
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'user.name=Test',
    'commit',
    '-q',
    '-m',
    'initial',
  );
  return dir;
}

function makeClone(source: string, name: string): string {
  const dir = join(scratch, name);
  git(scratch, 'clone', '-q', '--no-hardlinks', source, dir);
  return dir;
}

test('worktrees of one repository share a single project identity', () => {
  const repository = makeRepository('shared-repo');
  const linked = join(scratch, 'shared-repo-worktree');
  git(repository, 'worktree', 'add', '-q', '-b', 'feature', linked);

  const main = resolveProjectIdentity(repository);
  const worktree = resolveProjectIdentity(linked);

  assert.equal(main.source, 'git');
  assert.equal(worktree.source, 'git');
  assert.equal(
    worktree.digest,
    main.digest,
    'a linked worktree is the same canonical repository and must select the same memory',
  );
  assert.equal(worktree.project, main.project, 'the shared identity must also carry one label');
});

test('a subdirectory resolves to the repository identity, not its own path', () => {
  const repository = makeRepository('nested-repo');
  const nested = join(repository, 'packages', 'deep');
  mkdirSync(nested, { recursive: true });

  assert.deepEqual(resolveProjectIdentity(nested), resolveProjectIdentity(repository));
});

test('independent clones of one repository isolate from each other and from their source', () => {
  const origin = makeRepository('origin-repo');
  const first = makeClone(origin, 'clone-one');
  const second = makeClone(origin, 'clone-two');

  const digests = [origin, first, second].map((dir) => resolveProjectIdentity(dir).digest);
  assert.equal(new Set(digests).size, 3, 'independent clones must not share default project memory');
});

test('a fork isolates from the repository it was forked from', () => {
  const upstream = makeRepository('upstream-repo');
  const fork = makeClone(upstream, 'forked-repo');
  git(fork, 'remote', 'rename', 'origin', 'upstream');
  git(fork, 'remote', 'add', 'origin', 'https://example.invalid/fork.git');

  assert.notEqual(
    resolveProjectIdentity(fork).digest,
    resolveProjectIdentity(upstream).digest,
    'a fork is an independent repository and must keep its own memory',
  );
});

test('non-Git roots fall back to a canonical-path digest', () => {
  const first = join(scratch, 'plain-dir-one');
  const second = join(scratch, 'plain-dir-two');
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });

  const identity = resolveProjectIdentity(first);
  assert.equal(identity.source, 'path');
  assert.equal(identity.project, 'plain-dir-one');
  assert.notEqual(
    resolveProjectIdentity(second).digest,
    identity.digest,
    'two unrelated non-repository locations must isolate',
  );
});

test('two spellings of one canonical non-Git location share an identity', () => {
  const real = join(scratch, 'canonical-dir');
  const alias = join(scratch, 'alias-dir');
  mkdirSync(real, { recursive: true });
  symlinkSync(real, alias);

  assert.equal(
    resolveProjectIdentity(alias).digest,
    resolveProjectIdentity(real).digest,
    'the digest must be taken from the canonical location, not the path spelling',
  );
});

test('directories that share a basename in different locations still isolate', () => {
  const first = join(scratch, 'left', 'same-name');
  const second = join(scratch, 'right', 'same-name');
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });

  const a = resolveProjectIdentity(first);
  const b = resolveProjectIdentity(second);
  assert.equal(a.project, b.project, 'the human label is only a basename');
  assert.notEqual(a.digest, b.digest, 'the digest is what keeps two same-named projects apart');
});

test('identity is deterministic across repeated resolution', () => {
  const repository = makeRepository('stable-repo');
  assert.deepEqual(resolveProjectIdentity(repository), resolveProjectIdentity(repository));
});

test('no public identity value reveals a raw absolute path', () => {
  const repository = makeRepository('private-path-repo');
  const identity = resolveProjectIdentity(repository);

  for (const [field, value] of Object.entries(identity)) {
    assert.ok(!value.includes(sep), `${field} must not contain a path separator: ${value}`);
    assert.ok(!value.includes(scratch), `${field} leaks the directory it was derived from`);
  }
  assert.match(identity.digest, /^[0-9a-f]{16}$/, 'the digest is an opaque hex value');
  assert.equal(identity.project, 'private-path-repo');
});

test('a label that could not be a directory name is sanitised', () => {
  const awkward = join(scratch, 'weird name: $(whoami)');
  mkdirSync(awkward, { recursive: true });

  const identity = resolveProjectIdentity(awkward);
  assert.match(identity.project, /^[A-Za-z0-9._-]+$/, 'the label is used to build a directory name');
});
