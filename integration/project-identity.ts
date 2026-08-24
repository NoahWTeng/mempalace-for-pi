import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

export interface ProjectIdentity {
  readonly project: string;
  readonly digest: string;
  readonly source: 'git' | 'path';
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function label(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'project';
}

function gitCommonDirectory(cwd: string): string | null {
  try {
    const output = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
    if (!output) return null;
    return realpathSync(isAbsolute(output) ? output : resolve(cwd, output));
  } catch {
    return null;
  }
}

export function resolveProjectIdentity(cwd: string): ProjectIdentity {
  const commonDirectory = gitCommonDirectory(cwd);
  if (commonDirectory) {
    const repositoryDirectory = basename(commonDirectory) === '.git' ? dirname(commonDirectory) : commonDirectory;
    return {
      project: label(basename(repositoryDirectory)),
      digest: digest(`git:${commonDirectory}`),
      source: 'git',
    };
  }

  const canonicalDirectory = realpathSync(cwd);
  return {
    project: label(basename(canonicalDirectory)),
    digest: digest(`path:${canonicalDirectory}`),
    source: 'path',
  };
}
