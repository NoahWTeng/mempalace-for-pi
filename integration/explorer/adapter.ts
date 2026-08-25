import { createHmac, randomBytes } from 'node:crypto';

import type { McpClient } from '../mcp-client.ts';
import { CREDENTIAL_PATTERNS } from '../safety.ts';

export const EXPLORER_RECENT_LIMIT = 10;
export const EXPLORER_EXPANSION_LIMIT = 25;
export const EXPLORER_VISIBLE_LIMIT = 100;
export const EXPLORER_PAGE_LIMIT = 100;
export const EXPLORER_PREVIEW_MAX_CHARS = 200;
export const EXPLORER_TITLE_MAX_CHARS = 120;
export const EXPLORER_CONTENT_MAX_CHARS = 4_000;
export const EXPLORER_HANDLE_CHARS = 32;
export const EXPLORER_QUERY_MAX_CHARS = 200;
export const EXPLORER_ROOM_MAX_CHARS = 120;

export const EXPLORER_READ_TOOLS = {
  drawer: 'mempalace_get_drawer',
  list: 'mempalace_list_drawers',
  search: 'mempalace_search',
} as const;

const REDACTED_CREDENTIAL = '[redacted credential]';
const REDACTED_ABSOLUTE_PATH = '[redacted path]';
const FILE_URI_PATH = /\bfile:\/\/\/[^\s"'<>]+/giu;
const UNC_PATH = /\\\\[^\\\s"'<>]+(?:\\[^\\\s"'<>]+)+/gu;
const ABSOLUTE_PATH = /(?<![:\w/\\])(?:\/(?:[\w.@%+~-]+\/)*[\w.@%+~-]+|[A-Za-z]:\\(?:[\w.@%+~ -]+\\)*[\w.@%+~ -]*)/gu;
const ABSENT_CORE_VALUES = new Set(['', '?', 'unknown']);

export type ExplorerSourceScope = 'project' | 'label' | 'unavailable';

export interface ExplorerSource {
  readonly scope: ExplorerSourceScope;
  readonly label: string;
}

export interface ExplorerMemory {
  readonly id: string;
  readonly room: string;
  readonly title: string;
  readonly preview: string;
  readonly source: ExplorerSource;
  readonly recordedAt: string | null;
  readonly authoredAt: string | null;
  readonly chunks: number;
  readonly evidence: number;
}

export interface ExplorerDetails extends ExplorerMemory {
  readonly content: string;
}

export interface ExplorerSearchHit extends Omit<ExplorerMemory, 'id'> {
  readonly id: string | null;
  readonly resolved: boolean;
}

export interface ExplorerPage {
  readonly memories: readonly ExplorerMemory[];
  readonly available: number;
  readonly displayed: number;
  readonly omitted: number;
}

export interface ExplorerSearchPage {
  readonly query: string;
  readonly hits: readonly ExplorerSearchHit[];
  readonly available: number;
  readonly displayed: number;
  readonly omitted: number;
  readonly unresolved: number;
}

export type ExplorerRelationshipCategory = 'structural' | 'recorded' | 'temporal' | 'inferred';
export type ExplorerTemporalStatus = 'current' | 'historical' | 'superseded' | 'unknown';

export interface ExplorerRelationship {
  readonly category: ExplorerRelationshipCategory;
  readonly kind: string;
  readonly direction: 'incoming' | 'outgoing' | 'undirected';
  readonly target: ExplorerMemory | null;
  readonly entity: string | null;
  readonly temporalStatus: ExplorerTemporalStatus;
  readonly confidence: number | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly provenance: 'available' | 'unavailable';
}

export interface ExplorerNeighborhood {
  readonly seed: ExplorerMemory;
  readonly relationships: readonly ExplorerRelationship[];
  readonly available: number;
  readonly displayed: number;
  readonly omitted: number;
  readonly knowledgeGraph: 'available' | 'unavailable';
}

export interface ExplorerAdapter {
  recent(): Promise<ExplorerPage>;
  search(query: string, options?: { readonly limit?: number }): Promise<ExplorerSearchPage>;
  details(id: string): Promise<ExplorerDetails | null>;
  neighborhood(id: string, options?: { readonly visible?: number }): Promise<ExplorerNeighborhood | null>;
}

interface LogicalDrawer {
  readonly drawerId: string;
  readonly room: string;
  readonly content: string;
  readonly sourceKey: string;
  readonly rawSource: string;
  readonly recordedAt: string | null;
  readonly authoredAt: string | null;
  readonly chunks: number;
}

interface DrawerPage {
  readonly rows: readonly LogicalDrawer[];
  readonly available: number;
  readonly truncated: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function presentOrNull(value: unknown): string | null {
  const candidate = asText(value).trim();
  return ABSENT_CORE_VALUES.has(candidate) ? null : candidate;
}

function bounded(value: string, maxChars: number): string {
  const characters = [...value];
  return characters.length <= maxChars ? value : characters.slice(0, maxChars).join('');
}

function withoutSensitiveContent(value: string): string {
  let redacted = value;
  for (const pattern of CREDENTIAL_PATTERNS) {
    const everyMatch = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
    redacted = redacted.replace(everyMatch, REDACTED_CREDENTIAL);
  }
  return redacted
    .replace(FILE_URI_PATH, REDACTED_ABSOLUTE_PATH)
    .replace(UNC_PATH, REDACTED_ABSOLUTE_PATH)
    .replace(ABSOLUTE_PATH, REDACTED_ABSOLUTE_PATH);
}

function baseName(value: string): string {
  return value.split(/[\\/]/u).at(-1) ?? '';
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(value);
}

function safeRoom(rawRoom: string): string {
  const value = rawRoom.trim();
  return value === '' ? 'unavailable' : bounded(withoutSensitiveContent(value), EXPLORER_ROOM_MAX_CHARS);
}

function safeSource(rawSource: string): ExplorerSource {
  const value = rawSource.trim();
  if (value === '' || value === '?') return { scope: 'unavailable', label: 'unavailable' };
  const safeLabel = (label: string) => bounded(withoutSensitiveContent(label), EXPLORER_TITLE_MAX_CHARS);
  if (isAbsolutePath(value) || value.split(/[\\/]/u).includes('..')) {
    return { scope: 'label', label: safeLabel(baseName(value)) };
  }
  if (value.includes('/') || value.includes('\\')) {
    return { scope: 'project', label: safeLabel(value.replaceAll('\\', '/')) };
  }
  return { scope: 'label', label: safeLabel(value) };
}

function withoutCorePreviewEllipsis(value: string): string {
  return value.replace(/\.\.\.$/u, '');
}

function titleOf(content: string): string {
  const firstLine = content.split(/\r?\n/u, 1)[0] ?? '';
  return bounded(firstLine.trim(), EXPLORER_TITLE_MAX_CHARS);
}

function previewOf(content: string): string {
  return bounded(withoutCorePreviewEllipsis(content), EXPLORER_PREVIEW_MAX_CHARS);
}

function comparableContent(value: string): string {
  return withoutCorePreviewEllipsis(value.replace(/\s+/gu, ' ').trim().toLowerCase());
}

function mergedChunkCount(row: Record<string, unknown>, metadata: Record<string, unknown>): number {
  const declared = row.chunks ?? metadata.chunks;
  if (typeof declared === 'number' && Number.isFinite(declared) && declared > 0) return Math.floor(declared);
  const chunkIds = row.chunk_ids ?? metadata.chunk_ids;
  if (Array.isArray(chunkIds) && chunkIds.length > 0) return chunkIds.length;
  return 1;
}

function expansionCapacity(visible: number): number {
  return Math.max(0, Math.min(EXPLORER_EXPANSION_LIMIT, EXPLORER_VISIBLE_LIMIT - visible));
}

export function createExplorerAdapter(
  client: McpClient,
  options: { readonly project: string },
): ExplorerAdapter {
  const project = options.project;
  const handleSecret = randomBytes(32);
  const drawerByHandle = new Map<string, LogicalDrawer>();
  const pageByRoom = new Map<string | null, DrawerPage>();

  function issueHandle(drawer: LogicalDrawer): string {
    const handle = createHmac('sha256', handleSecret)
      .update(drawer.drawerId)
      .digest('hex')
      .slice(0, EXPLORER_HANDLE_CHARS);
    drawerByHandle.set(handle, drawer);
    return handle;
  }

  function toLogicalDrawer(row: Record<string, unknown>): LogicalDrawer | null {
    const metadata = asRecord(row.metadata);
    const drawerId = asText(row.drawer_id);
    const wing = asText(row.wing) || asText(metadata.wing);
    const room = (asText(row.room) || asText(metadata.room)).trim();
    if (drawerId === '' || wing !== project || room === '') return null;
    const rawSource = asText(metadata.source_file) || asText(row.source_file);
    return {
      drawerId,
      room,
      content: asText(row.content) || asText(row.content_preview),
      sourceKey: baseName(rawSource),
      rawSource,
      recordedAt: presentOrNull(metadata.filed_at ?? row.filed_at),
      authoredAt: presentOrNull(metadata.authored_at ?? row.authored_at),
      chunks: mergedChunkCount(row, metadata),
    };
  }

  function toMemory(drawer: LogicalDrawer): ExplorerMemory {
    const content = withoutSensitiveContent(drawer.content);
    return {
      id: issueHandle(drawer),
      room: safeRoom(drawer.room),
      title: titleOf(content),
      preview: previewOf(content),
      source: safeSource(drawer.rawSource),
      recordedAt: drawer.recordedAt,
      authoredAt: drawer.authoredAt,
      chunks: drawer.chunks,
      evidence: drawer.chunks - 1,
    };
  }

  async function readTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    try {
      return asRecord(await client.callReadTool(name, args));
    } catch {
      return null;
    }
  }

  async function listDrawers(room?: string): Promise<DrawerPage> {
    const cacheKey = room ?? null;
    const cached = pageByRoom.get(cacheKey);
    if (cached) return cached;

    const args: Record<string, unknown> = { wing: project, limit: EXPLORER_PAGE_LIMIT };
    if (room !== undefined) args.room = room;
    const answer = await readTool(EXPLORER_READ_TOOLS.list, args);
    if (answer === null) return { rows: [], available: 0, truncated: false };
    const rawRows = Array.isArray(answer.drawers) ? answer.drawers : [];
    const rows = rawRows
      .map((entry) => toLogicalDrawer(asRecord(entry)))
      .filter((drawer): drawer is LogicalDrawer => drawer !== null);
    const reportedTotal = answer.total;
    const hasTotal = typeof reportedTotal === 'number' && Number.isFinite(reportedTotal);
    const available = hasTotal ? Math.max(rows.length, Math.floor(reportedTotal)) : rows.length;
    const page: DrawerPage = {
      rows,
      available,
      truncated: hasTotal ? available > rawRows.length : rawRows.length === EXPLORER_PAGE_LIMIT,
    };
    pageByRoom.set(cacheKey, page);
    return page;
  }

  async function resolveUniqueDrawer(hit: Record<string, unknown>): Promise<LogicalDrawer | null> {
    const room = asText(hit.room);
    const recordedAt = presentOrNull(hit.created_at);
    const hitContent = comparableContent(asText(hit.text));
    if (room === '' || recordedAt === null || hitContent === '') return null;

    const sourceKey = baseName(asText(hit.source_file) || asText(hit.source_path));
    const authoredAt = presentOrNull(hit.authored_at);
    const page = await listDrawers(room);
    if (page.truncated) return null;
    const matches = page.rows.filter((drawer) => {
      if (drawer.room !== room || drawer.sourceKey !== sourceKey || drawer.recordedAt !== recordedAt) return false;
      if (authoredAt !== null && drawer.authoredAt !== authoredAt) return false;
      const drawerContent = comparableContent(drawer.content);
      return drawerContent.startsWith(hitContent) || hitContent.startsWith(drawerContent);
    });
    return matches.length === 1 ? (matches[0] as LogicalDrawer) : null;
  }

  function unresolvedHit(hit: Record<string, unknown>): ExplorerSearchHit {
    const content = withoutSensitiveContent(asText(hit.text));
    return {
      id: null,
      resolved: false,
      room: safeRoom(asText(hit.room)),
      title: titleOf(content),
      preview: previewOf(content),
      source: safeSource(asText(hit.source_file) || asText(hit.source_path)),
      recordedAt: presentOrNull(hit.created_at),
      authoredAt: presentOrNull(hit.authored_at),
      chunks: 1,
      evidence: 0,
    };
  }

  async function recent(): Promise<ExplorerPage> {
    const { rows, available } = await listDrawers();
    const newestFirst = [...rows].sort((left, right) => {
      const byRecency = (right.recordedAt ?? '').localeCompare(left.recordedAt ?? '');
      return byRecency === 0 ? left.drawerId.localeCompare(right.drawerId) : byRecency;
    });
    const memories = newestFirst.slice(0, EXPLORER_RECENT_LIMIT).map(toMemory);
    return {
      memories,
      available,
      displayed: memories.length,
      omitted: Math.max(0, available - memories.length),
    };
  }

  async function search(
    query: string,
    searchOptions: { readonly limit?: number } = {},
  ): Promise<ExplorerSearchPage> {
    const limit = Math.max(1, Math.min(searchOptions.limit ?? EXPLORER_PAGE_LIMIT, EXPLORER_PAGE_LIMIT));
    const coreQuery = bounded(query, EXPLORER_QUERY_MAX_CHARS);
    const answer = await readTool(EXPLORER_READ_TOOLS.search, { query: coreQuery, wing: project, limit });
    const results = (Array.isArray(answer?.results) ? answer.results : []).map(asRecord);
    const inActiveProject = results.filter((hit) => asText(hit.wing) === project);

    const hits: ExplorerSearchHit[] = [];
    for (const hit of inActiveProject) {
      const drawer = await resolveUniqueDrawer(hit);
      if (drawer === null) {
        hits.push(unresolvedHit(hit));
        continue;
      }
      const { id, ...memory } = toMemory(drawer);
      hits.push({ ...memory, id, resolved: true });
    }

    const reportedTotal = answer?.total_before_filter;
    const available = typeof reportedTotal === 'number' && Number.isFinite(reportedTotal)
      ? Math.max(results.length, Math.floor(reportedTotal))
      : results.length;
    return {
      query: bounded(withoutSensitiveContent(coreQuery), EXPLORER_QUERY_MAX_CHARS),
      hits,
      available,
      displayed: hits.length,
      omitted: Math.max(0, available - hits.length),
      unresolved: hits.filter((hit) => !hit.resolved).length,
    };
  }

  async function details(id: string): Promise<ExplorerDetails | null> {
    const known = drawerByHandle.get(id);
    if (!known) return null;
    const answer = await readTool(EXPLORER_READ_TOOLS.drawer, { drawer_id: known.drawerId });
    if (answer === null) return null;
    const drawer = toLogicalDrawer(answer);
    if (drawer === null) return null;
    return {
      ...toMemory(drawer),
      id,
      content: bounded(withoutSensitiveContent(drawer.content), EXPLORER_CONTENT_MAX_CHARS),
    };
  }

  function structuralRelationship(seed: LogicalDrawer, neighbour: LogicalDrawer): ExplorerRelationship {
    const sharesSource = seed.sourceKey !== '' && seed.sourceKey === neighbour.sourceKey;
    return {
      category: 'structural',
      kind: sharesSource ? 'same-source' : 'room-co-membership',
      direction: 'undirected',
      target: toMemory(neighbour),
      entity: null,
      temporalStatus: 'unknown',
      confidence: null,
      validFrom: null,
      validTo: null,
      provenance: 'unavailable',
    };
  }

  async function neighborhood(
    id: string,
    neighborhoodOptions: { readonly visible?: number } = {},
  ): Promise<ExplorerNeighborhood | null> {
    const seed = drawerByHandle.get(id);
    if (!seed) return null;

    const page = await listDrawers(seed.room);
    const neighbours = page.rows.filter((drawer) => drawer.drawerId !== seed.drawerId);
    const visible = Math.max(1, neighborhoodOptions.visible ?? 1);
    const displayed = neighbours.slice(0, expansionCapacity(visible));
    const available = Math.max(0, page.available - 1);

    return {
      seed: { ...toMemory(seed), id },
      relationships: displayed.map((neighbour) => structuralRelationship(seed, neighbour)),
      available,
      displayed: displayed.length,
      omitted: Math.max(0, available - displayed.length),
      knowledgeGraph: 'unavailable',
    };
  }

  return { details, neighborhood, recent, search };
}
