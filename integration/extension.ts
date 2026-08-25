import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { handleCompactHandoff } from './compact-handoff.ts';
import {
  PROJECT_CONFIG_LOCATION,
  ProjectConfigError,
  effectiveConfig,
  readProjectConfig,
  type ProjectConfig,
} from './config.ts';
import { createExplorerAdapter } from './explorer/adapter.ts';
import {
  createExplorerHost,
  EXPLORER_COMMAND_NAME,
  type ExplorerHost,
  type ExplorerHostOverrides,
} from './explorer/command.ts';
import { createLifecycle, type Lifecycle, type LifecycleState, type LifecycleStatus } from './lifecycle.ts';
import { createMcpClient as defaultCreateMcpClient, type McpClient } from './mcp-client.ts';
import {
  PalaceAccessError,
  mcpServerArgv,
  resolveLauncher as defaultResolveLauncher,
  resolvePalace as defaultResolvePalace,
  type Launcher,
  type PalaceResolution,
  type ResolveEnv,
} from './resolve.ts';
import { createWriteSafetyGate, type WriteSafetyGate } from './safety.ts';
import { registerPalaceTools } from './tools.ts';
import { captureWakeUp as defaultCaptureWakeUp } from './wakeup.ts';

/** Why no runtime exists. `pending` simply means no session has started yet. */
export type ExtensionInactiveReason = 'pending' | 'disabled' | 'inert' | 'misconfigured';

export interface ExtensionHandle {
  readonly active: boolean;
  readonly reason?: ExtensionInactiveReason;
  readonly status: () => LifecycleStatus;
}

/** The already-validated project document, or `null` when none is in force. */
export interface ResolvePalaceDeps {
  readonly config: ProjectConfig | null;
}

export interface CreateExtensionOptions {
  readonly env?: ResolveEnv;
  readonly cwd?: string;
  readonly enabled?: boolean;
  readonly readOnly?: boolean;
  readonly handoff?: boolean;
  readonly recall?: boolean;
  readonly resolveLauncher?: (env: ResolveEnv) => Launcher;
  readonly resolvePalace?: (
    env: ResolveEnv,
    cwd: string,
    deps: ResolvePalaceDeps,
  ) => PalaceResolution;
  readonly createMcpClient?: (
    resolveArgv: () => ReturnType<typeof mcpServerArgv>,
    cwd: string,
  ) => McpClient;
  readonly captureWakeUp?: (client: McpClient) => Promise<string>;
  readonly explorer?: ExplorerHostOverrides;
}

const CORE_UNAVAILABLE = 'MemPalace is unavailable. Install MemPalace 3.6.0 or 3.7.1, then restart Pi.';
const PALACE_UNAVAILABLE =
  'MemPalace palace selection failed. Check MEMPALACE_PALACE and project access, then restart Pi.';
const CONFIG_UNUSABLE = `MemPalace could not use ${PROJECT_CONFIG_LOCATION}. Correct or remove it, then restart Pi.`;

/** What an inactive extension reports, so `status()` is always callable. */
const INACTIVE_STATE: Record<ExtensionInactiveReason, LifecycleState> = {
  pending: 'idle',
  disabled: 'disabled',
  inert: 'inert',
  misconfigured: 'disabled',
};

function notifySafely(context: ExtensionContext | undefined, message: string): void {
  try {
    context?.ui?.notify?.(message, 'warning');
  } catch {
    // Host diagnostics must never break a lifecycle event.
  }
}

/**
 * Fails closed. A host that cannot state a trust decision is not a host that
 * has granted one, so the project document stays unread.
 */
function isProjectTrusted(context: ExtensionContext | undefined): boolean {
  try {
    return context?.isProjectTrusted?.() === true;
  } catch {
    return false;
  }
}

interface Runtime {
  readonly lifecycle: Lifecycle;
  readonly client: McpClient;
  readonly gate: WriteSafetyGate;
  readonly project: string;
  readonly handoff: boolean;
  readonly explorer: ExplorerHost | undefined;
}

function inactiveExtension(reason: ExtensionInactiveReason): ExtensionHandle {
  return { active: false, reason, status: () => ({ state: INACTIVE_STATE[reason], project: '' }) };
}

/**
 * Registers the event surface immediately and builds nothing else. The project
 * document is the host's to release, so every decision that could depend on it
 * — palace, read-only, handoff, and whether to run at all — waits for the first
 * session start, when a trust decision exists. Until then the wrappers are
 * deliberately inert: there is no runtime for them to disturb.
 */
export function createExtension(
  pi: ExtensionAPI,
  options: CreateExtensionOptions = {},
): ExtensionHandle {
  const env = options.env ?? process.env;
  // The environment is the user's own launch, never project-supplied, so an
  // explicit off switch can be honoured before any session exists.
  const enabled = options.enabled ?? env.MEMPALACE_BRIDGE_DISABLE !== '1';
  if (!enabled) return inactiveExtension('disabled');

  let runtime: Runtime | undefined;
  let reason: ExtensionInactiveReason = 'pending';
  let initialized = false;
  let warningContext: ExtensionContext | undefined;
  const diagnosticsSent = new Set<string>();

  const warnOnce = (message: string) => {
    if (diagnosticsSent.has(message)) return;
    diagnosticsSent.add(message);
    notifySafely(warningContext, message);
  };
  const refuse = (nextReason: ExtensionInactiveReason, message?: string): void => {
    reason = nextReason;
    if (message !== undefined) warnOnce(message);
  };

  function initialize(context: ExtensionContext | undefined): void {
    if (initialized) return;
    initialized = true;
    const cwd = options.cwd ?? context?.cwd ?? process.cwd();

    let config: ProjectConfig | null = null;
    const trusted = isProjectTrusted(context);
    if (trusted) {
      try {
        config = readProjectConfig(cwd);
      } catch (error) {
        return refuse(
          'misconfigured',
          error instanceof ProjectConfigError ? error.message : CONFIG_UNUSABLE,
        );
      }
    }

    const effective = effectiveConfig(env, config);
    // An explicit host decision already settled this; only an undeclared one
    // defers to the document.
    if (options.enabled === undefined && effective.disabled) return refuse('disabled');

    let launcher: Launcher;
    try {
      launcher = (options.resolveLauncher ?? defaultResolveLauncher)(env);
    } catch {
      return refuse('inert', CORE_UNAVAILABLE);
    }
    if (launcher.mode === 'inert') return refuse('inert', CORE_UNAVAILABLE);

    let palace: PalaceResolution;
    try {
      palace = (options.resolvePalace ?? defaultResolvePalace)(env, cwd, { config });
    } catch (error) {
      return refuse(
        'inert',
        error instanceof PalaceAccessError ? error.message : PALACE_UNAVAILABLE,
      );
    }

    const readOnly = options.readOnly ?? effective.readOnly;
    const gate = createWriteSafetyGate({ readOnly });
    const resolveArgv = () => mcpServerArgv(launcher, palace.palacePath);
    const client = options.createMcpClient
      ? options.createMcpClient(resolveArgv, cwd)
      : defaultCreateMcpClient(resolveArgv, cwd, { onCompatibilityError: warnOnce });

    const lifecycle = createLifecycle({
      launcher,
      palace,
      cwd,
      createClient: () => client,
      capture: options.captureWakeUp ?? defaultCaptureWakeUp,
      recall: options.recall ?? effective.recall,
      ...(effective.rooms === undefined ? {} : { rooms: effective.rooms }),
      onWarning: warnOnce,
    });

    registerPalaceTools(pi, client, gate, effective.sources);

    const explorer = trusted
      ? createExplorerHost({
        ...options.explorer,
        createAdapter: () => createExplorerAdapter(client, { project: palace.identity.project }),
      })
      : undefined;
    if (explorer !== undefined) pi.registerCommand(EXPLORER_COMMAND_NAME, explorer.command);

    runtime = {
      lifecycle,
      client,
      gate,
      project: palace.identity.project,
      handoff: options.handoff ?? effective.handoff,
      explorer,
    };
  }

  pi.on('session_start', async (_event, context) => {
    warningContext = context;
    initialize(context);
    await runtime?.lifecycle.sessionStart();
  });
  pi.on('before_agent_start', async (event) =>
    runtime?.lifecycle.beforeAgentStart(event.systemPrompt, event.prompt));
  pi.on('session_shutdown', async () => {
    await runtime?.explorer?.close();
    await runtime?.lifecycle.shutdown();
    warningContext = undefined;
  });
  pi.on('session_before_compact', async (event, context) => {
    if (!runtime?.handoff) return;
    await handleCompactHandoff(event, context, {
      client: runtime.client,
      project: runtime.project,
      gate: runtime.gate,
    });
  });

  return {
    get active() {
      return runtime !== undefined;
    },
    get reason() {
      return runtime === undefined ? reason : undefined;
    },
    status: () => runtime?.lifecycle.status() ?? { state: INACTIVE_STATE[reason], project: '' },
  };
}
