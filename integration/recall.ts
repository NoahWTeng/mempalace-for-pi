import type { McpClient } from './mcp-client.ts';
import { serializeBounded, serializeBoundedItems } from './wakeup.ts';

/** Recall is paid on every turn, so its budgets are deliberately tighter than
 * the once-per-session wake-up: a slow palace must cost a moment, never a turn. */
export const RECALL_TIMEOUT_MS = 3_000;
export const RECALL_LIMIT = 5;
export const MAX_RECALL_CHARS = 2000;

const RECALL_TAG = 'mempalace-recall';
const RECALL_TOOL = 'mempalace_search';

export interface CaptureRecallOptions {
  /** The raw user prompt for this turn; it is the retrieval query. */
  readonly prompt: string;
  /** The resolved project identity, used to keep retrieval inside this project. */
  readonly project: string;
  readonly timeoutMs?: number;
}

/** Render retrieved memory inside the same inert boundary the wake-up uses,
 * under its own tag so the ambient snapshot and this turn's hits stay distinct. */
export function serializeRecall(value: unknown): string {
  return serializeBounded(RECALL_TAG, value, MAX_RECALL_CHARS);
}

/**
 * True when the core answered but found nothing. An empty answer must produce no
 * block at all: injecting an empty boundary spends prompt on the statement that
 * nothing was remembered, which is never worth a turn's cache.
 */
function isEmptyResult(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0 || value.every(isEmptyResult);
  if (typeof value === 'object') {
    const entries = Object.values(value as Record<string, unknown>);
    return entries.length === 0 || entries.every(isEmptyResult);
  }
  return false;
}

/**
 * Retrieve the memory relevant to this turn's prompt, scoped to this project.
 *
 * Recall is an enhancement and never a dependency, so every failure mode —
 * blank prompt, dead core, slow core, empty palace — resolves to `undefined`
 * and the turn proceeds exactly as it would have without it. Unlike the
 * session wake-up, a timeout here does not tear the client down: the session is
 * live and the next turn deserves a working connection.
 */
export async function captureRecall(
  client: McpClient,
  options: CaptureRecallOptions,
): Promise<string | undefined> {
  const query = options.prompt.trim();
  if (query.length === 0) return undefined;

  const timeoutMs = options.timeoutMs ?? RECALL_TIMEOUT_MS;
  const expired = Symbol('recall-timeout');
  let timer: NodeJS.Timeout | undefined;

  try {
    const timeout = new Promise<typeof expired>((resolve) => {
      timer = setTimeout(() => resolve(expired), timeoutMs);
    });
    const result = await Promise.race([
      client.callReadTool(RECALL_TOOL, {
        query,
        wing: options.project,
        limit: RECALL_LIMIT,
      }),
      timeout,
    ]);

    if (result === expired || isEmptyResult(result)) return undefined;
    // Whole hits are dropped to fit rather than the payload being sliced, so a
    // delivered block always parses and its count is what actually shipped.
    return serializeBoundedItems(RECALL_TAG, result, MAX_RECALL_CHARS);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
