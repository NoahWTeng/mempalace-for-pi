import { execFileSync } from 'node:child_process';
import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
} from '@earendil-works/pi-coding-agent';

import type { McpClient } from './mcp-client.ts';
import type { WriteSafetyGate } from './safety.ts';

export const HANDOFF_BUDGET_MS = 15_000;
export const LAST_MESSAGE_MAX_CHARS = 500;
const GIT_BRANCH_TIMEOUT_MS = 2_000;
const PROJECT_MAX_CHARS = 200;
const BRANCH_MAX_CHARS = 500;

type BranchEntry = SessionBeforeCompactEvent['branchEntries'][number];

export interface CompactHandoffDeps {
  readonly gitBranch?: (cwd: string) => string | undefined;
  readonly budgetMs?: number;
  readonly onLog?: (message: string) => void;
}

export interface CompactHandoffOptions {
  readonly client: McpClient;
  readonly project: string;
  readonly gate: WriteSafetyGate;
  readonly agentName?: string;
}

function bounded(value: string, maximum: number): string {
  let result = '';
  let count = 0;
  for (const character of value) {
    if (count === maximum) break;
    result += character;
    count += 1;
  }
  return result;
}

function safeLabel(value: string, maximum: number): string {
  return bounded(value, maximum).replace(/[^A-Za-z0-9._\/-]+/gu, '-');
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: string; text: string } =>
      typeof part === 'object' && part !== null &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string')
    .map((part) => part.text)
    .join('\n');
}

export function summarizeBranch(branchEntries: readonly BranchEntry[]): {
  readonly messageCount: number;
  readonly lastUserText: string;
} {
  let messageCount = 0;
  let lastUserText = '';
  for (const entry of branchEntries) {
    if (entry.type !== 'message') continue;
    messageCount += 1;
    if (entry.message?.role === 'user') lastUserText = messageText(entry.message.content);
  }
  return { messageCount, lastUserText };
}

function currentGitBranch(cwd: string): string | undefined {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_BRANCH_TIMEOUT_MS,
    }).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

function serializeHandoff(params: {
  readonly project: string;
  readonly branch: string | undefined;
  readonly messageCount: number;
  readonly lastUserText: string;
  readonly now?: Date;
}, boundFields: boolean): string {
  const limit = (value: string, maximum: number) => boundFields ? bounded(value, maximum) : value;
  return JSON.stringify({
    timestamp: (params.now ?? new Date()).toISOString(),
    project: boundFields
      ? safeLabel(params.project, PROJECT_MAX_CHARS)
      : limit(params.project, PROJECT_MAX_CHARS),
    branch: boundFields
      ? safeLabel(params.branch ?? 'unknown', BRANCH_MAX_CHARS)
      : limit(params.branch ?? 'unknown', BRANCH_MAX_CHARS),
    messageCount: params.messageCount,
    lastUserText: limit(params.lastUserText, LAST_MESSAGE_MAX_CHARS),
  });
}

export function composeHandoffEntry(params: {
  readonly project: string;
  readonly branch: string | undefined;
  readonly messageCount: number;
  readonly lastUserText: string;
  readonly now?: Date;
}): string {
  return serializeHandoff(params, true);
}

/** Mechanical only: validate the whole source candidate, then write one bounded
 * allowlisted diary entry. Refusal, failure, and timeout never escape to Pi. */
export async function handleCompactHandoff(
  event: SessionBeforeCompactEvent,
  context: ExtensionContext,
  options: CompactHandoffOptions,
  deps: CompactHandoffDeps = {},
): Promise<void> {
  const started = Date.now();
  const budgetMs = deps.budgetMs ?? HANDOFF_BUDGET_MS;
  const work = (async () => {
    try {
      const summary = summarizeBranch(event.branchEntries ?? []);
      const branch = (deps.gitBranch ?? currentGitBranch)(context.cwd);
      const fields = { ...summary, project: options.project, branch };
      const agentName = options.agentName ?? 'mempalace-pi';

      // Validate every untruncated persisted source field as one candidate before
      // bounding or sanitizing it. The composed payload contains only these
      // allowlisted fields, so no unsafe source can be transformed into a write.
      const content = composeHandoffEntry(fields);
      options.gate({
        content: summary.lastUserText || content,
        metadata: [options.project, branch ?? 'unknown', agentName],
      });
      await options.client.callWriteTool('mempalace_diary_write', {
        agent_name: agentName,
        content,
        topic: 'compact-handoff',
        wing: options.project,
      });
    } catch (error) {
      try {
        deps.onLog?.(`MemPalace compact handoff skipped: ${error instanceof Error ? error.message : String(error)}`);
      } catch {
        // Diagnostics must not fail compaction.
      }
    }
  })();

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, budgetMs - (Date.now() - started)));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
