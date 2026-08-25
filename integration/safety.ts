export const WRITE_CONTENT_MAX_CHARS = 6_000;
export const WRITE_METADATA_MAX_CHARS = 500;

export type WriteSafetyReason =
  | 'read-only'
  | 'non-retainable'
  | 'credential'
  | 'empty'
  | 'over-limit';

export interface WriteCandidate {
  readonly content: string;
  readonly metadata?: readonly string[];
  readonly retain?: boolean;
}

export type WriteSafetyGate = (candidate: WriteCandidate) => void;

export class WriteSafetyError extends Error {
  readonly reason: WriteSafetyReason;

  constructor(reason: WriteSafetyReason, message: string) {
    super(`MemPalace write refused: ${message}`);
    this.name = 'WriteSafetyError';
    this.reason = reason;
  }
}

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/iu,
  /^authorization\s*:\s*\S+/imu,
  /^(?:set-)?cookie\s*:\s*\S+/imu,
  /\bbearer\s+\S+/iu,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]+@/iu,
  /\b[\w-]*(?:auth[-_ ]?)?token["']?\s*[:=]\s*["']?\S+/iu,
  /(?:^|[;\s])session(?:[_-]?(?:id|token))?["']?\s*[:=]\s*["']?[^;\s]+/iu,
  /\b[\w-]*password["']?\s*[:=]\s*["']?\S+/iu,
  /\b[\w-]*api[-_ ]?key["']?\s*[:=]\s*["']?\S+/iu,
  /\b[\w-]*(?:access[-_ ]?token|client[-_ ]?secret|secret[-_ ]?access[-_ ]?key)["']?\s*[:=]\s*["']?\S+/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bASIA[0-9A-Z]{16}\b/u,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/u,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/u,
  /\bhf_[A-Za-z0-9]{20,}\b/u,
  /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/u,
  /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/u,
  /\bAIza[0-9A-Za-z_-]{35,}\b/u,
  /\bnpm_[A-Za-z0-9]{36,}\b/u,
  /\bxox[abaprs]-[A-Za-z0-9-]{20,}\b/u,
];

function hasNoMemoryMarker(content: string): boolean {
  const firstLine = content.split(/\r?\n/u, 1)[0]?.trimStart() ?? '';
  return /^\[no-memory\](?:\s|$)/iu.test(firstLine);
}

function exceedsCharacterLimit(content: string): boolean {
  let count = 0;
  for (const _character of content) {
    count += 1;
    if (count > WRITE_CONTENT_MAX_CHARS) return true;
  }
  return false;
}

/** The single fail-closed boundary used immediately before every integration write. */
export function createWriteSafetyGate(options: { readonly readOnly?: boolean } = {}): WriteSafetyGate {
  return (candidate) => {
    if (options.readOnly) {
      throw new WriteSafetyError('read-only', 'read-only mode is enabled');
    }
    if (!candidate || typeof candidate.content !== 'string') {
      throw new WriteSafetyError('empty', 'content is missing');
    }
    const metadata = candidate.metadata ?? [];
    if (metadata.some((field) => typeof field !== 'string')) {
      throw new WriteSafetyError('empty', 'metadata is invalid');
    }
    const fields = [candidate.content, ...metadata];
    if (candidate.retain === false || fields.some(hasNoMemoryMarker)) {
      throw new WriteSafetyError('non-retainable', 'content is explicitly non-retainable');
    }
    if (candidate.content.length === 0) {
      throw new WriteSafetyError('empty', 'content is empty');
    }
    if (exceedsCharacterLimit(candidate.content)) {
      throw new WriteSafetyError(
        'over-limit',
        `content exceeds the ${WRITE_CONTENT_MAX_CHARS}-character limit`,
      );
    }
    if (metadata.some((field) => [...field].length > WRITE_METADATA_MAX_CHARS)) {
      throw new WriteSafetyError(
        'over-limit',
        `metadata exceeds the ${WRITE_METADATA_MAX_CHARS}-character limit`,
      );
    }
    if (fields.some((field) => CREDENTIAL_PATTERNS.some((pattern) => pattern.test(field)))) {
      throw new WriteSafetyError('credential', 'credential-like content was detected');
    }
  };
}
