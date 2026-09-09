export const REALM_LORE_SCHEMA_VERSION = "realm-lore.v1" as const;

export const LORE_ENTRY_KINDS = ["setting", "character", "arc", "event"] as const;
export type LoreEntryKind = (typeof LORE_ENTRY_KINDS)[number];

export const DEFAULT_LORE_RETRIEVAL_TOP_K = 4;
export const LORE_MAX_ENTRIES = 64;
export const LORE_MAX_TOP_K = 4;
export const LORE_MAX_IDENTIFIER_LENGTH = 128;
export const LORE_MAX_TEXT_LENGTH = 400;
export const LORE_MAX_ARRAY_LENGTH = 32;
export const LORE_MAX_ARRAY_ITEM_LENGTH = 128;
export const LORE_MAX_SOURCE_URL_LENGTH = 512;
export const LORE_MAX_CANON_VERSION_LENGTH = 64;
export const LORE_MAX_PROMPT_CHARS = 8000;
const LORE_RENDER_OVERHEAD_CHARS = 512;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/** A curated, immutable story fact used as world context, not lived memory. */
export interface LoreEntryV1 {
  id: string;
  kind: LoreEntryKind;
  arcId: string;
  /** Chronological order within an arc; lower values happened earlier. */
  order: number;
  title: string;
  summary: string;
  cause?: string;
  consequence?: string;
  participants: readonly string[];
  aliases: readonly string[];
  /** Absent means public canon; present restricts the entry to these agents. */
  knownTo?: readonly string[];
  sourceUrl: string;
  canonVersion: string;
}

export interface LoreRetrievalQueryV1 {
  agentId: string;
  text: string;
  topK?: number;
}

export interface NormalizedLoreRetrievalQueryV1 {
  agentId: string;
  text: string;
  topK: number;
}

export interface LoreRetrievalHitV1 {
  entry: LoreEntryV1;
  score: number;
}

export interface LoreCandidateDiagnosticV1 {
  loreId: string;
  score: number;
}

export interface LoreExcludedDiagnosticV1 {
  loreId: string;
  reason: string;
}

export interface LoreRetrievalDiagnosticV1 {
  query: NormalizedLoreRetrievalQueryV1;
  candidateIds: readonly string[];
  selectedIds: readonly string[];
  candidateScores: readonly LoreCandidateDiagnosticV1[];
  excluded: readonly LoreExcludedDiagnosticV1[];
}

export interface LoreRetrievalResultV1 {
  hits: readonly LoreRetrievalHitV1[];
  diagnostics: LoreRetrievalDiagnosticV1;
}

export class LoreValidationError extends Error {
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(errors.join("; "));
    this.name = "LoreValidationError";
    this.errors = [...errors];
  }
}

export function validateLoreEntry(input: unknown, path = "entry"): LoreEntryV1 {
  const errors: string[] = [];
  if (!isRecord(input)) {
    throw new LoreValidationError([`${path} must be an object`]);
  }

  const id = boundedString(input.id, `${path}.id`, errors, LORE_MAX_IDENTIFIER_LENGTH);
  const kind = validateKind(input.kind, `${path}.kind`, errors);
  const arcId = boundedString(input.arcId, `${path}.arcId`, errors, LORE_MAX_IDENTIFIER_LENGTH);
  const order = validateOrder(input.order, `${path}.order`, errors);
  const title = boundedString(input.title, `${path}.title`, errors, LORE_MAX_TEXT_LENGTH);
  const summary = boundedString(input.summary, `${path}.summary`, errors, LORE_MAX_TEXT_LENGTH);
  const cause = optionalString(input.cause, `${path}.cause`, errors, LORE_MAX_TEXT_LENGTH);
  const consequence = optionalString(input.consequence, `${path}.consequence`, errors, LORE_MAX_TEXT_LENGTH);
  const participants = stringArray(input.participants, `${path}.participants`, errors);
  const aliases = stringArray(input.aliases, `${path}.aliases`, errors);
  const knownTo = input.knownTo === undefined
    ? undefined
    : stringArray(input.knownTo, `${path}.knownTo`, errors);
  const sourceUrl = validateSourceUrl(input.sourceUrl, `${path}.sourceUrl`, errors);
  const canonVersion = boundedString(input.canonVersion, `${path}.canonVersion`, errors, LORE_MAX_CANON_VERSION_LENGTH);

  if (errors.length > 0) {
    throw new LoreValidationError(errors);
  }

  return {
    id,
    kind,
    arcId,
    order,
    title,
    summary,
    ...(cause !== undefined ? { cause } : {}),
    ...(consequence !== undefined ? { consequence } : {}),
    participants,
    aliases,
    ...(knownTo !== undefined ? { knownTo } : {}),
    sourceUrl,
    canonVersion,
  };
}

export function validateLoreEntries(input: unknown): readonly LoreEntryV1[] {
  if (!Array.isArray(input)) {
    throw new LoreValidationError(["lore must be an array"]);
  }
  if (input.length > LORE_MAX_ENTRIES) {
    throw new LoreValidationError([`lore must contain at most ${LORE_MAX_ENTRIES} entries`]);
  }

  const errors: string[] = [];
  const entries: LoreEntryV1[] = [];
  const ids = new Set<string>();
  input.forEach((entry, index) => {
    try {
      const normalized = validateLoreEntry(entry, `lore[${index}]`);
      if (ids.has(normalized.id)) {
        errors.push(`lore[${index}].id duplicates ${normalized.id}`);
      } else {
        ids.add(normalized.id);
      }
      entries.push(normalized);
    } catch (error) {
      if (error instanceof LoreValidationError) {
        errors.push(...error.errors);
        return;
      }
      throw error;
    }
  });

  if (errors.length === 0) {
    const estimatedPromptChars = entries
      .map(estimateLoreEntryChars)
      .sort((left, right) => right - left)
      .slice(0, LORE_MAX_TOP_K)
      .reduce((sum, chars) => sum + chars, LORE_RENDER_OVERHEAD_CHARS);
    if (estimatedPromptChars > LORE_MAX_PROMPT_CHARS) {
      errors.push(`lore may render up to ${estimatedPromptChars} characters; maximum is ${LORE_MAX_PROMPT_CHARS}`);
    }
  }
  if (errors.length > 0) {
    throw new LoreValidationError(errors);
  }
  return entries;
}

export function validateLoreRetrievalQuery(
  input: LoreRetrievalQueryV1,
): NormalizedLoreRetrievalQueryV1 {
  const errors: string[] = [];
  const agentId = nonEmptyString(input.agentId, "query.agentId", errors);
  const text = nonEmptyString(input.text, "query.text", errors);
  const requestedTopK = input.topK ?? DEFAULT_LORE_RETRIEVAL_TOP_K;
  const topK = Number.isInteger(requestedTopK) && requestedTopK > 0 && requestedTopK <= LORE_MAX_TOP_K
    ? requestedTopK
    : (errors.push(`query.topK must be an integer from 1 to ${LORE_MAX_TOP_K}`), DEFAULT_LORE_RETRIEVAL_TOP_K);

  if (errors.length > 0) {
    throw new LoreValidationError(errors);
  }
  return { agentId, text, topK };
}

function validateKind(value: unknown, path: string, errors: string[]): LoreEntryKind {
  if (typeof value !== "string" || !(LORE_ENTRY_KINDS as readonly string[]).includes(value)) {
    errors.push(`${path} must be one of: ${LORE_ENTRY_KINDS.join(", ")}`);
    return "event";
  }
  return value as LoreEntryKind;
}

function validateOrder(value: unknown, path: string, errors: string[]): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    errors.push(`${path} must be a non-negative integer`);
    return 0;
  }
  return value;
}

function validateSourceUrl(value: unknown, path: string, errors: string[]): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${path} must be an http(s) URL`);
    return "";
  }
  if (value.length > LORE_MAX_SOURCE_URL_LENGTH) {
    errors.push(`${path} must be at most ${LORE_MAX_SOURCE_URL_LENGTH} characters`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    errors.push(`${path} must not contain control characters`);
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      errors.push(`${path} must be an http(s) URL`);
    }
  } catch {
    errors.push(`${path} must be an http(s) URL`);
  }
  return value;
}

function nonEmptyString(value: unknown, path: string, errors: string[]): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${path} must be a non-empty string`);
    return "";
  }
  return value;
}

function boundedString(value: unknown, path: string, errors: string[], maxLength: number): string {
  const text = nonEmptyString(value, path, errors);
  if (text.length === 0) {
    return text;
  }
  if (text.length > maxLength) {
    errors.push(`${path} must be at most ${maxLength} characters`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(text)) {
    errors.push(`${path} must not contain control characters`);
  }
  return text;
}

function optionalString(
  value: unknown,
  path: string,
  errors: string[],
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  return boundedString(value, path, errors, maxLength);
}

function stringArray(value: unknown, path: string, errors: string[]): readonly string[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array of non-empty strings`);
    return [];
  }
  if (value.length > LORE_MAX_ARRAY_LENGTH) {
    errors.push(`${path} must contain at most ${LORE_MAX_ARRAY_LENGTH} entries`);
  }
  return value.map((entry, index) => boundedString(
    entry,
    `${path}[${index}]`,
    errors,
    LORE_MAX_ARRAY_ITEM_LENGTH,
  ));
}

function estimateLoreEntryChars(entry: LoreEntryV1): number {
  return 128 + entry.id.length + entry.title.length + entry.summary.length +
    (entry.cause?.length ?? 0) + (entry.consequence?.length ?? 0) +
    entry.sourceUrl.length + entry.canonVersion.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
