import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname, basename, join, resolve } from 'node:path';
import { spawn as defaultSpawn, type SpawnOptions } from 'node:child_process';

import { hubServerArgv, type Argv, type Launcher } from './resolve.ts';

export interface HubRegistration {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly scheme: 'http' | 'https';
  readonly read_only: boolean;
  readonly palace_path: string;
  readonly [key: string]: unknown;
}

interface HubChild {
  readonly pid?: number;
  readonly unref?: () => void;
  readonly once?: (event: string, listener: (...args: any[]) => void) => HubChild;
}

interface HubSpawnOptions {
  readonly detached: true;
  readonly stdio: 'ignore';
}

type HubSpawn = (cmd: string, args: string[], options: HubSpawnOptions) => HubChild;

export interface HubDeps {
  readonly homeDir?: string;
  readonly readRegistration?: (path: string) => unknown;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly health?: (registration: HubRegistration) => Promise<boolean>;
  readonly spawn?: HubSpawn;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly startTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface HubOptions {
  readonly launcher: Launcher;
  readonly palacePath: string;
  readonly deps?: HubDeps;
}

export interface HubRuntime {
  ensureHub(): Promise<HubRegistration>;
}

export const HUB_START_TIMEOUT_MS = 10_000;
export const HUB_POLL_INTERVAL_MS = 50;
export const HUB_HEALTH_TIMEOUT_MS = 1_000;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function canonicalPath(value: string): string {
  const absolute = resolve(value);
  const missing: string[] = [];
  let current = absolute;
  while (true) {
    try {
      const resolved = realpathSync(current);
      return missing.reduceRight((path, part) => join(path, part), resolved);
    } catch {
      const parent = dirname(current);
      if (parent === current) return missing.reduceRight((path, part) => join(path, part), current);
      missing.push(basename(current));
      current = parent;
    }
  }
}

export function serverInfoPath(palacePath: string, homeDir = homedir()): string {
  const canonical = canonicalPath(palacePath);
  const normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const key = createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 24);
  return join(homeDir, '.mempalace', 'server', key, 'serverinfo.json');
}

function parseRegistration(value: unknown): HubRegistration | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    !Number.isInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    typeof record.host !== 'string' ||
    !record.host.trim() ||
    !LOOPBACK_HOSTS.has(record.host.trim().toLowerCase()) ||
    !Number.isInteger(record.port) ||
    (record.port as number) < 1 ||
    (record.port as number) > 65535 ||
    (record.scheme !== 'http' && record.scheme !== 'https') ||
    typeof record.read_only !== 'boolean' ||
    typeof record.palace_path !== 'string' ||
    !record.palace_path.trim()
  ) {
    return null;
  }
  return record as HubRegistration;
}

function readRegistration(path: string): HubRegistration | null {
  try {
    return parseRegistration(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function health(registration: HubRegistration): Promise<boolean> {
  const requestFn = registration.scheme === 'https' ? httpsRequest : httpRequest;
  return new Promise((resolveHealth) => {
    let body = '';
    let settled = false;
    let responseStream: { destroy: () => void } | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const settle = (healthy: boolean) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolveHealth(healthy);
    };
    const request = requestFn(
      {
        hostname: registration.host,
        port: registration.port,
        path: '/healthz',
        method: 'GET',
        timeout: HUB_HEALTH_TIMEOUT_MS,
      },
      (response) => {
        responseStream = response;
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          if (body.length < 16) body += chunk.slice(0, 16 - body.length);
        });
        response.on('end', () => settle(response.statusCode === 200 && body.trim() === 'ok'));
        response.on('aborted', () => settle(false));
        response.on('error', () => settle(false));
        response.on('close', () => settle(false));
      },
    );
    const abort = () => {
      if (settled) return;
      responseStream?.destroy();
      request.destroy();
      settle(false);
    };
    request.on('error', () => settle(false));
    request.on('timeout', abort);
    deadline = setTimeout(abort, HUB_HEALTH_TIMEOUT_MS);
    request.end();
  });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, milliseconds);
    timer.unref?.();
  });
}

export class HubUnavailableError extends Error {
  constructor(detail = 'the loopback Hub did not become ready') {
    super(`MemPalace Hub unavailable: ${detail}. Install MemPalace 3.9.0 and restart Pi.`);
    this.name = 'HubUnavailableError';
  }
}

export function createHub(options: HubOptions): HubRuntime {
  const deps = options.deps ?? {};
  const infoPath = serverInfoPath(options.palacePath, deps.homeDir ?? homedir());
  const read = deps.readRegistration ?? readRegistration;
  const alive = deps.isPidAlive ?? pidAlive;
  const probe = deps.health ?? health;
  const spawn = deps.spawn ?? ((cmd: string, args: string[], spawnOptions: HubSpawnOptions) =>
    defaultSpawn(cmd, args, spawnOptions as SpawnOptions));
  const sleep = deps.sleep ?? wait;
  const timeout = deps.startTimeoutMs ?? HUB_START_TIMEOUT_MS;
  const interval = deps.pollIntervalMs ?? HUB_POLL_INTERVAL_MS;
  const expectedPalace = canonicalPath(options.palacePath);
  let inFlight: Promise<HubRegistration> | undefined;

  function matching(value: unknown): HubRegistration | null {
    const registration = parseRegistration(value);
    if (!registration || registration.read_only || !alive(registration.pid)) return null;
    try {
      if (canonicalPath(registration.palace_path) !== expectedPalace) return null;
    } catch {
      return null;
    }
    return registration;
  }

  async function ready(): Promise<HubRegistration | null> {
    const registration = matching(read(infoPath));
    if (!registration || !(await probe(registration))) return null;
    return registration;
  }

  async function start(): Promise<HubRegistration> {
    const existing = await ready();
    if (existing) return existing;
    const argv: Argv | null = hubServerArgv(options.launcher, options.palacePath);
    if (!argv) throw new HubUnavailableError('no matching MemPalace MCP executable is available');

    let child: HubChild;
    try {
      child = spawn(argv.cmd, argv.args, { detached: true, stdio: 'ignore' });
      child.unref?.();
    } catch (error) {
      throw new HubUnavailableError(`Hub start failed: ${(error as Error).message}`);
    }

    let startupError: Error | undefined;
    child.once?.('error', (error: Error) => {
      startupError = error;
    });
    const deadline = Date.now() + timeout;
    while (Date.now() <= deadline) {
      if (startupError) throw new HubUnavailableError(`Hub start failed: ${startupError.message}`);
      const registration = await ready();
      if (registration) return registration;
      await sleep(interval);
    }
    throw new HubUnavailableError();
  }

  function ensureHub(): Promise<HubRegistration> {
    if (!inFlight) {
      const current = start();
      inFlight = current;
      current.then(
        () => { if (inFlight === current) inFlight = undefined; },
        () => { if (inFlight === current) inFlight = undefined; },
      );
    }
    return inFlight;
  }

  return { ensureHub };
}
