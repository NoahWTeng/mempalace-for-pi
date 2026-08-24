import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The one contract version this integration understands. */
export const PROJECT_CONFIG_VERSION = 1;

/** The single documented, portable location of the project document. */
export const PROJECT_CONFIG_LOCATION = '.pi/mempalace.json';

export type ProjectConfigReason =
  | 'unreadable'
  | 'malformed'
  | 'not-an-object'
  | 'version'
  | 'unknown-field'
  | 'field-type';

/**
 * A bounded, actionable refusal. It names the document and the offending
 * declaration; it never echoes a declared value or a machine-specific path,
 * because this text reaches a shared host surface.
 */
export class ProjectConfigError extends Error {
  readonly reason: ProjectConfigReason;

  constructor(reason: ProjectConfigReason, detail: string) {
    super(`MemPalace could not use ${PROJECT_CONFIG_LOCATION}: ${detail}`);
    this.name = 'ProjectConfigError';
    this.reason = reason;
  }
}

export interface ProjectConfig {
  readonly version: typeof PROJECT_CONFIG_VERSION;
  readonly palace?: string;
  readonly readOnly?: boolean;
  readonly handoff?: boolean;
  readonly disabled?: boolean;
  readonly recall?: boolean;
  /**
   * Room-name prefixes the wake-up offers its character budget first.
   *
   * The shipped ranking assumes this repository's own naming, which leaves the
   * feature inert for a project that names its rooms differently. Declaring the
   * prefixes here replaces that default; an empty list ranks nothing.
   */
  readonly rooms?: readonly string[];
}

/**
 * Bounds on the room ranking. The wake-up only ever ships about ten drawers, so a
 * list longer than this could not be represented even if every prefix matched; the
 * cap exists so a config file cannot spend the capture budget.
 */
export const MAX_ROOM_PREFIXES = 16;
export const MAX_ROOM_PREFIX_CHARS = 64;

export type ConfigEnv = Record<string, string | undefined>;

/** Where an effective field came from, so the user can tell what to change. */
export type ConfigSource = 'env' | 'project-config' | 'default';

export interface ConfigSources {
  readonly palace: ConfigSource;
  readonly readOnly: ConfigSource;
  readonly handoff: ConfigSource;
  readonly disabled: ConfigSource;
  readonly recall: ConfigSource;
  readonly rooms: ConfigSource;
}

export interface EffectiveConfig {
  readonly palace: string | undefined;
  /** Undeclared stays `undefined` so the wake-up's own default is the single
   * place that decides the shipped ranking. An empty list is a real answer. */
  readonly rooms: readonly string[] | undefined;
  readonly readOnly: boolean;
  readonly handoff: boolean;
  readonly disabled: boolean;
  readonly recall: boolean;
  readonly sources: ConfigSources;
}

/** The whole contract: one required version plus six optional settings. */
const BOOLEAN_FIELDS = ['readOnly', 'handoff', 'disabled', 'recall'] as const;
const ACCEPTED_KEYS: ReadonlySet<string> = new Set(['version', 'palace', 'rooms', ...BOOLEAN_FIELDS]);

const ENV_KEYS = {
  palace: 'MEMPALACE_PALACE',
  readOnly: 'MEMPALACE_READ_ONLY',
  handoff: 'MEMPALACE_HANDOFF',
  disabled: 'MEMPALACE_BRIDGE_DISABLE',
  recall: 'MEMPALACE_RECALL',
  rooms: 'MEMPALACE_ROOMS',
} as const;

/** The documented literal that turns a boolean control on. Nothing else does. */
const ENABLED = '1';

export function projectConfigPath(cwd: string): string {
  return join(cwd, ...PROJECT_CONFIG_LOCATION.split('/'));
}

function optionalBoolean(
  document: Record<string, unknown>,
  key: (typeof BOOLEAN_FIELDS)[number],
): boolean | undefined {
  if (!Object.hasOwn(document, key)) return undefined;
  const value = document[key];
  if (typeof value !== 'boolean') {
    throw new ProjectConfigError('field-type', `"${key}" must be true or false.`);
  }
  return value;
}

/**
 * Reads the room ranking, refusing anything that is not a bounded list of
 * non-blank prefixes. An empty list is accepted: "rank nothing" is a real choice,
 * distinct from not declaring the field at all.
 */
function optionalRooms(document: Record<string, unknown>): readonly string[] | undefined {
  if (!Object.hasOwn(document, 'rooms')) return undefined;
  const value = document.rooms;
  if (!Array.isArray(value)) {
    throw new ProjectConfigError('field-type', '"rooms" must be a list of room-name prefixes.');
  }
  if (value.length > MAX_ROOM_PREFIXES) {
    throw new ProjectConfigError(
      'field-type',
      `"rooms" must declare at most ${MAX_ROOM_PREFIXES} prefixes.`,
    );
  }
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ProjectConfigError('field-type', '"rooms" entries must be non-empty strings.');
    }
    const prefix = entry.trim();
    if (prefix.length > MAX_ROOM_PREFIX_CHARS) {
      throw new ProjectConfigError(
        'field-type',
        `"rooms" entries must be at most ${MAX_ROOM_PREFIX_CHARS} characters.`,
      );
    }
    return prefix;
  });
}

function optionalPalace(document: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(document, 'palace')) return undefined;
  const value = document.palace;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProjectConfigError('field-type', '"palace" must be a non-empty path string.');
  }
  return value.trim();
}

function displayKey(key: string): string {
  return JSON.stringify(key.length > 20 ? `${key.slice(0, 20)}...` : key);
}

/** Validates one document's text strictly; every rejection is explicit. */
export function parseProjectConfig(text: string): ProjectConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ProjectConfigError('malformed', 'it is not valid JSON.');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProjectConfigError('not-an-object', 'it must be a JSON object.');
  }
  const document = parsed as Record<string, unknown>;

  if (document.version !== PROJECT_CONFIG_VERSION) {
    throw new ProjectConfigError(
      'version',
      `it must declare "version": ${PROJECT_CONFIG_VERSION}, the only supported contract version.`,
    );
  }

  for (const key of Object.keys(document)) {
    if (!ACCEPTED_KEYS.has(key)) {
      throw new ProjectConfigError(
        'unknown-field',
        `it declares an unknown key ${displayKey(key)}. Accepted keys are ${[...ACCEPTED_KEYS].join(', ')}.`,
      );
    }
  }

  const rooms = optionalRooms(document);
  const palace = optionalPalace(document);
  const readOnly = optionalBoolean(document, 'readOnly');
  const handoff = optionalBoolean(document, 'handoff');
  const disabled = optionalBoolean(document, 'disabled');
  const recall = optionalBoolean(document, 'recall');

  return {
    version: PROJECT_CONFIG_VERSION,
    ...(rooms === undefined ? {} : { rooms }),
    ...(palace === undefined ? {} : { palace }),
    ...(readOnly === undefined ? {} : { readOnly }),
    ...(handoff === undefined ? {} : { handoff }),
    ...(disabled === undefined ? {} : { disabled }),
    ...(recall === undefined ? {} : { recall }),
  };
}

/**
 * Reads the project document. An absent document is `null` — zero-configuration
 * startup stays available — but a document that exists and cannot be read is a
 * refusal, never a silent absence.
 */
export function readProjectConfig(cwd: string): ProjectConfig | null {
  let text: string;
  try {
    text = readFileSync(projectConfigPath(cwd), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ProjectConfigError('unreadable', 'it exists but could not be read. Check its permissions.');
  }
  return parseProjectConfig(text);
}

/**
 * Applies precedence one field at a time: temporary environment override, then
 * project document, then the existing safe default.
 *
 * The two kinds of field read presence differently on purpose. A boolean control
 * says everything by being present — `MEMPALACE_READ_ONLY=0` is a deliberate
 * "not this launch", and only the literal `1` ever enables a control — while a
 * palace needs an actual location, so a blank override declares nothing and
 * leaves the document in force.
 */
export function effectiveConfig(env: ConfigEnv, config: ProjectConfig | null): EffectiveConfig {
  const override = env[ENV_KEYS.palace]?.trim();
  const declaredPalace = config?.palace;

  const palace = override
    ? { value: override, source: 'env' as const }
    : declaredPalace
      ? { value: declaredPalace, source: 'project-config' as const }
      : { value: undefined, source: 'default' as const };

  const booleanField = (key: (typeof BOOLEAN_FIELDS)[number]) => {
    const raw = env[ENV_KEYS[key]];
    if (raw !== undefined) return { value: raw === ENABLED, source: 'env' as const };
    const declared = config?.[key];
    if (declared !== undefined) return { value: declared, source: 'project-config' as const };
    return { value: false, source: 'default' as const };
  };

  const readOnly = booleanField('readOnly');
  const handoff = booleanField('handoff');
  const disabled = booleanField('disabled');
  const recall = booleanField('recall');

  // A blank override declares nothing, matching how a blank palace override is
  // read; blank entries inside a real override are dropped rather than becoming
  // a prefix that matches every room.
  const roomsOverride = env[ENV_KEYS.rooms]
    ?.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const rooms = roomsOverride && roomsOverride.length > 0
    ? { value: roomsOverride as readonly string[], source: 'env' as const }
    : config?.rooms !== undefined
      ? { value: config.rooms, source: 'project-config' as const }
      : { value: undefined, source: 'default' as const };

  return {
    palace: palace.value,
    rooms: rooms.value,
    readOnly: readOnly.value,
    handoff: handoff.value,
    disabled: disabled.value,
    recall: recall.value,
    sources: {
      palace: palace.source,
      readOnly: readOnly.source,
      handoff: handoff.source,
      disabled: disabled.source,
      recall: recall.source,
      rooms: rooms.source,
    },
  };
}
