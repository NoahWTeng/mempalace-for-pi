import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { PROJECT_CONFIG_LOCATION, effectiveConfig, type ProjectConfig } from './config.ts';
import { resolveProjectIdentity, type ProjectIdentity } from './project-identity.ts';

export type ResolveEnv = Record<string, string | undefined>;

export interface Launcher {
  readonly mode: 'path' | 'uv' | 'inert';
  readonly mempalaceMcpBin?: string;
  readonly dir?: string;
}

export interface Argv {
  readonly cmd: string;
  readonly args: string[];
}

/** Which declaration selected the palace: temporary, project document, or default. */
export type PalaceSource = 'env' | 'project-config' | 'identity';

/** The two sources a user can declare a palace from, and must be told about. */
export type ExplicitPalaceSource = Exclude<PalaceSource, 'identity'>;

export interface PalaceResolution {
  readonly palacePath: string;
  readonly source: PalaceSource;
  readonly identity: ProjectIdentity;
}

export type PalaceAccessReason = 'not-a-directory' | 'unreadable' | 'unreachable';

/**
 * A declared palace that cannot be opened. It names the declaration to correct
 * but never the resolved location, because this text reaches a shared host
 * surface where a raw absolute path would leak the user's filesystem.
 */
export class PalaceAccessError extends Error {
  readonly reason: PalaceAccessReason;
  readonly source: ExplicitPalaceSource;

  constructor(reason: PalaceAccessReason, source: ExplicitPalaceSource, detail: string) {
    const declaration = source === 'env' ? 'MEMPALACE_PALACE' : PROJECT_CONFIG_LOCATION;
    super(`MemPalace cannot open the palace declared by ${declaration}: ${detail}`);
    this.name = 'PalaceAccessError';
    this.reason = reason;
    this.source = source;
  }
}

interface PlatformDeps {
  readonly platform?: NodeJS.Platform;
}

interface HomeDeps {
  readonly homeDir?: string;
}

interface PalaceDeps extends HomeDeps {
  /** The already-validated project document, read only once the host trusts it. */
  readonly config?: ProjectConfig | null;
}

function expandHome(value: string, homeDir: string): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return join(homeDir, value.slice(2));
  return value;
}

function accessible(path: string, mode: number): boolean {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

function executable(path: string, platform: NodeJS.Platform): boolean {
  return accessible(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
}

export function resolveOnPath(name: string, env: ResolveEnv, deps: PlatformDeps = {}): string | null {
  const pathValue = env.PATH?.trim();
  if (!pathValue) return null;

  const platform = deps.platform ?? process.platform;
  const separator = platform === 'win32' ? ';' : ':';
  const extensions =
    platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];

  for (const directory of pathValue.split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, platform === 'win32' ? `${name}${extension}` : name);
      if (executable(candidate, platform)) return candidate;
    }
  }
  return null;
}

export function resolveLauncher(env: ResolveEnv, deps: PlatformDeps & HomeDeps = {}): Launcher {
  const mempalaceMcpBin = resolveOnPath('mempalace-mcp', env, deps);
  if (mempalaceMcpBin) return { mode: 'path', mempalaceMcpBin };

  const configuredDirectory = env.MEMPALACE_DIR?.trim();
  if (configuredDirectory) {
    return { mode: 'uv', dir: expandHome(configuredDirectory, deps.homeDir ?? homedir()) };
  }

  return { mode: 'inert' };
}

export function mcpServerArgv(launcher: Launcher, palacePath: string): Argv | null {
  if (launcher.mode === 'path' && launcher.mempalaceMcpBin) {
    return { cmd: launcher.mempalaceMcpBin, args: ['--palace', palacePath] };
  }
  if (launcher.mode === 'uv' && launcher.dir) {
    return {
      cmd: 'uv',
      args: ['run', '--directory', launcher.dir, 'mempalace-mcp', '--palace', palacePath],
    };
  }
  return null;
}

/**
 * Proves a declared palace can be opened in place before anything depends on it.
 * Every check is a read: a palace that fails preflight is refused, never
 * replaced, moved, or created.
 */
function preflightPalace(palacePath: string, source: ExplicitPalaceSource): void {
  let stats;
  try {
    stats = statSync(palacePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new PalaceAccessError('unreadable', source, 'it cannot be inspected. Check its permissions.');
    }
    // A palace that does not exist yet is the ordinary first launch on a new
    // computer. The memory core creates it, but only somewhere already reachable.
    const parent = dirname(palacePath);
    let parentStats;
    try {
      parentStats = statSync(parent);
    } catch {
      throw new PalaceAccessError(
        'unreachable',
        source,
        'the directory that would contain it does not exist. Create it or correct the declared location.',
      );
    }
    if (!parentStats.isDirectory() || !accessible(parent, constants.R_OK | constants.W_OK | constants.X_OK)) {
      throw new PalaceAccessError(
        'unreachable',
        source,
        'the directory that would contain it is not a writable directory. Correct the declared location.',
      );
    }
    return;
  }

  if (!stats.isDirectory()) {
    throw new PalaceAccessError('not-a-directory', source, 'it is not a directory. Correct the declared location.');
  }
  if (!accessible(palacePath, constants.R_OK | constants.X_OK)) {
    throw new PalaceAccessError('unreadable', source, 'it cannot be read. Check its permissions.');
  }
}

export function resolvePalace(env: ResolveEnv, cwd: string, deps: PalaceDeps = {}): PalaceResolution {
  const homeDir = deps.homeDir ?? homedir();
  const identity = resolveProjectIdentity(cwd);
  const config = effectiveConfig(env, deps.config ?? null);

  if (config.palace !== undefined && config.sources.palace !== 'default') {
    const source = config.sources.palace;
    const expanded = expandHome(config.palace, homeDir);
    const palacePath = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    preflightPalace(palacePath, source);
    return { palacePath, source, identity };
  }

  return {
    palacePath: join(homeDir, '.mempalace', `${identity.project}-${identity.digest}`),
    source: 'identity',
    identity,
  };
}

/** Public, path-free names for where the palace selection came from. */
const PALACE_LOCATIONS: Record<PalaceSource, string> = {
  env: 'explicit',
  'project-config': 'project-configured',
  identity: 'project-default',
};

export function describePalace(resolution: PalaceResolution): Record<string, string> {
  return {
    project: resolution.identity.project,
    identity: resolution.identity.digest,
    location: PALACE_LOCATIONS[resolution.source],
  };
}

export function describeLauncher(launcher: Launcher): string {
  if (launcher.mode === 'path') return 'installed executable';
  if (launcher.mode === 'uv') return 'configured checkout';
  return 'unavailable';
}
