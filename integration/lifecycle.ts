import { createMcpClient, IncompatibleCoreError, type McpClient } from './mcp-client.ts';
import { captureRecall as defaultCaptureRecall, type CaptureRecallOptions } from './recall.ts';
import { mcpServerArgv, type Launcher, type PalaceResolution } from './resolve.ts';
import { captureWakeUp } from './wakeup.ts';

export const SHUTDOWN_BUDGET_MS = 4_900;

export type LifecycleState =
  | 'disabled'
  | 'inert'
  | 'idle'
  | 'capturing'
  | 'operational'
  | 'degraded'
  | 'incompatible'
  | 'closed';

export interface LifecycleStatus {
  readonly state: LifecycleState;
  readonly project: string;
}

export interface LifecycleOptions {
  readonly enabled?: boolean;
  readonly launcher: Launcher;
  readonly palace: PalaceResolution;
  readonly cwd: string;
  readonly createClient?: (
    resolveArgv: () => ReturnType<typeof mcpServerArgv>,
    cwd: string,
  ) => McpClient;
  readonly capture?: (
    client: McpClient,
    options: { project: string; rooms?: readonly string[] },
  ) => Promise<string>;
  /** Room-name prefixes the wake-up ranks first; undeclared keeps its default. */
  readonly rooms?: readonly string[];
  /** Opt-in per-turn retrieval. Off leaves the turn byte-identical to before. */
  readonly recall?: boolean;
  readonly captureRecall?: (
    client: McpClient,
    options: CaptureRecallOptions,
  ) => Promise<string | undefined>;
  readonly onWarning?: (message: string) => void;
  readonly shutdownBudgetMs?: number;
}

export interface Lifecycle {
  sessionStart(): Promise<void>;
  beforeAgentStart(
    systemPrompt: string,
    prompt?: string,
  ): Promise<{ systemPrompt: string } | undefined>;
  shutdown(): Promise<void>;
  status(): LifecycleStatus;
}

/** Session-scoped lifecycle. Constructing it is side-effect free; the MCP
 * client is not even created until the first active session start. */
export function createLifecycle(options: LifecycleOptions): Lifecycle {
  const enabled = options.enabled ?? true;
  const active = enabled && options.launcher.mode !== 'inert';
  const project = options.palace.identity.project;
  const buildClient = options.createClient ?? createMcpClient;
  const capture = options.capture ?? captureWakeUp;
  const recall = options.captureRecall ?? defaultCaptureRecall;
  const recallEnabled = options.recall ?? false;
  const shutdownBudgetMs = options.shutdownBudgetMs ?? SHUTDOWN_BUDGET_MS;

  let state: LifecycleState = enabled ? active ? 'idle' : 'inert' : 'disabled';
  let client: McpClient | undefined;
  let snapshot = '';
  let startPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let closing = false;
  let warned = false;

  function warnOnce(message = 'MemPalace wake-up unavailable; continuing without recalled memory.'): void {
    if (warned) return;
    warned = true;
    try {
      options.onWarning?.(message);
    } catch {
      // A host notifier must never break a Pi event handler.
    }
  }

  function ownedClient(): McpClient {
    if (!client) {
      client = buildClient(() => mcpServerArgv(options.launcher, options.palace.palacePath), options.cwd);
    }
    return client;
  }

  async function runStart(): Promise<void> {
    state = 'capturing';
    try {
      const captured = await capture(ownedClient(), {
        project,
        ...(options.rooms === undefined ? {} : { rooms: options.rooms }),
      });
      if (closing) return;
      snapshot = captured;
      state = 'operational';
    } catch (error) {
      if (closing) return;
      snapshot = '';
      state = error instanceof IncompatibleCoreError ? 'incompatible' : 'degraded';
      warnOnce(error instanceof IncompatibleCoreError ? error.message : undefined);
    }
  }

  async function sessionStart(): Promise<void> {
    try {
      if (!active || state === 'closed') return;
      startPromise ??= runStart();
      await startPromise;
    } catch {
      state = 'degraded';
      warnOnce();
    }
  }

  /**
   * Append the session snapshot, then — only when recall is enabled — this
   * turn's retrieved memory.
   *
   * Order is deliberate. The snapshot is identical for every turn of a session,
   * so keeping it first leaves the longest possible byte-stable prefix for the
   * provider to cache; the prompt-dependent block goes last, where it can only
   * invalidate the tail. A missing snapshot means the palace never answered, so
   * recall is skipped rather than retried on every turn.
   */
  async function beforeAgentStart(
    systemPrompt: string,
    prompt = '',
  ): Promise<{ systemPrompt: string } | undefined> {
    try {
      if (closing || !snapshot) return undefined;
      if (!recallEnabled || !client) return { systemPrompt: `${systemPrompt}\n\n${snapshot}` };

      const retrieved = await recall(client, { prompt, project });
      if (closing) return undefined;
      const blocks = retrieved ? `${snapshot}\n\n${retrieved}` : snapshot;
      return { systemPrompt: `${systemPrompt}\n\n${blocks}` };
    } catch {
      return undefined;
    }
  }

  function closeOwnedClient(): Promise<void> {
    if (!client) return Promise.resolve();
    return client.shutdown();
  }

  async function runShutdown(): Promise<void> {
    if (!active) return;
    snapshot = '';
    let timer: NodeJS.Timeout | undefined;
    try {
      const closed = await Promise.race([
        closeOwnedClient().then(
          () => true,
          () => false,
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), shutdownBudgetMs);
        }),
      ]);
      state = closed ? 'closed' : 'degraded';
    } catch {
      state = 'degraded';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function shutdown(): Promise<void> {
    try {
      closing = true;
      shutdownPromise ??= runShutdown();
      await shutdownPromise;
    } catch {
      state = 'degraded';
    }
  }

  return {
    sessionStart,
    beforeAgentStart,
    shutdown,
    status: () => ({ state, project }),
  };
}
