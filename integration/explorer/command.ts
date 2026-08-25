import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

import type { ExplorerAdapter } from './adapter.ts';
import {
  startExplorerServer as defaultStartExplorerServer,
  type ExplorerServer,
  type ExplorerServerOptions,
} from './server.ts';

export const EXPLORER_COMMAND_NAME = 'palace-explore';

const EXPLORER_DESCRIPTION = 'Open the read-only MemPalace memory explorer in a local browser.';
const EXPLORER_OPENED = 'MemPalace explorer is serving this session at';
const EXPLORER_MANUAL = 'MemPalace explorer could not open a browser. Open it yourself at';
const EXPLORER_UNAVAILABLE = 'MemPalace explorer could not start a local host; no memory was exposed.';
const DEFAULT_ASSET_ROOT = fileURLToPath(new URL('./assets/', import.meta.url));

export interface ExplorerHostOverrides {
  readonly assetRoot?: string;
  readonly openBrowser?: (url: string) => Promise<void>;
  readonly startServer?: (options: ExplorerServerOptions) => Promise<ExplorerServer>;
}

export interface ExplorerHostOptions extends ExplorerHostOverrides {
  readonly createAdapter: () => ExplorerAdapter;
}

interface ExplorerCommand {
  readonly description: string;
  readonly handler: (args: string, context: ExtensionCommandContext) => Promise<void>;
}

export interface ExplorerHost {
  readonly command: ExplorerCommand;
  close(): Promise<void>;
}

function browserArgv(url: string): { command: string; args: readonly string[] } {
  if (process.platform === 'darwin') return { command: 'open', args: [url] };
  if (process.platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}

function launchBrowser(url: string): Promise<void> {
  const { command, args } = browserArgv(url);
  return new Promise<void>((launched, failed) => {
    const child = spawn(command, [...args], { detached: true, stdio: 'ignore' });
    child.once('error', failed);
    child.once('spawn', () => {
      child.unref();
      launched();
    });
  });
}

function notifySafely(context: ExtensionCommandContext, message: string): void {
  try {
    context?.ui?.notify?.(message, 'info');
  } catch {
    return;
  }
}

export function createExplorerHost(options: ExplorerHostOptions): ExplorerHost {
  const assetRoot = options.assetRoot ?? DEFAULT_ASSET_ROOT;
  const openBrowser = options.openBrowser ?? launchBrowser;
  const startServer = options.startServer ?? defaultStartExplorerServer;
  let hosting: Promise<ExplorerServer> | undefined;
  let closing: Promise<void> | undefined;

  function host(): Promise<ExplorerServer> {
    hosting ??= startServer({ adapter: options.createAdapter(), assetRoot });
    return hosting;
  }

  function close(): Promise<void> {
    const started = hosting;
    if (started === undefined) return Promise.resolve();
    closing ??= started.then(
      (server) => server.close(),
      () => undefined,
    );
    return closing;
  }

  async function handler(_args: string, context: ExtensionCommandContext): Promise<void> {
    let server: ExplorerServer;
    try {
      server = await host();
    } catch {
      notifySafely(context, EXPLORER_UNAVAILABLE);
      return;
    }
    try {
      await openBrowser(server.url);
    } catch {
      notifySafely(context, `${EXPLORER_MANUAL} ${server.url}`);
      return;
    }
    notifySafely(context, `${EXPLORER_OPENED} ${server.origin}`);
  }

  return { command: { description: EXPLORER_DESCRIPTION, handler }, close };
}
