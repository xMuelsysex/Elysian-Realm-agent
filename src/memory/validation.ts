import {
  DEFAULT_MEMORY_RETRIEVAL_TOP_K,
  DEFAULT_MEMORY_RETRIEVAL_WEIGHTS,
  MEMORY_IMPORTANCE_MAX,
  MEMORY_IMPORTANCE_MIN,
  MEMORY_KINDS,
  MEMORY_VISIBILITIES,
  type MemoryKind,
  type MemoryRetrievalQuery,
  type MemoryRetrievalWeights,
  type MemoryVisibility,
  type MemoryWrite,
  type NormalizedMemoryRetrievalQuery,
  type NormalizedMemoryWrite,
} from "./memoryRecords.js";

export class MemoryValidationError extends Error {
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(errors.join("; "));
    this.name = "MemoryValidationError";
    this.errors = [...errors];
  }
}

export function validateMemoryWrite<Metadata = Record<string, unknown>>(
  agentId: string,
  write: MemoryWrite<Metadata>,
): NormalizedMemoryWrite<Metadata> {
  const errors: string[] = [];

  validateNonEmptyString(agentId, "agentId", errors);
  if (write.id !== undefined) {
    validateNonEmptyString(write.id, "write.id", errors);
  }
  validateMemoryKind(write.kind, "write.kind", errors);
  validateNonEmptyString(write.content, "write.content", errors);
  validateIsoDate(write.createdAt, "write.createdAt", errors);
  validateImportance(write.importance, "write.importance", errors);
  const sourceIds = normalizeStringArray(write.sourceIds, "write.sourceIds", errors, { required: true });
  const relatedMemoryIds = normalizeStringArray(write.relatedMemoryIds ?? [], "write.relatedMemoryIds", errors, { required: false });
  const tags = normalizeStringArray(write.tags ?? [], "write.tags", errors, { required: false });
  const visibility = validateVisibility(write.visibility ?? "private", "write.visibility", errors);

  if (errors.length > 0) {
    throw new MemoryValidationError(errors);
  }

  return {
    id: write.id,
    kind: write.kind,
    content: write.content,
    createdAt: write.createdAt,
    importance: write.importance,
    sourceIds,
    relatedMemoryIds,
    visibility,
    tags,
    metadata: (write.metadata ?? {}) as Metadata,
  };
}

export function validateMemoryRetrievalQuery(query: MemoryRetrievalQuery): NormalizedMemoryRetrievalQuery {
  const errors: string[] = [];

  validateNonEmptyString(query.text, "query.text", errors);
  validateIsoDate(query.now, "query.now", errors);
  const topK = validateTopK(query.topK ?? DEFAULT_MEMORY_RETRIEVAL_TOP_K, "query.topK", errors);
  const tags = normalizeStringArray(query.tags ?? [], "query.tags", errors, { required: false });
  const sourceIds = normalizeStringArray(query.sourceIds ?? [], "query.sourceIds", errors, { required: false });
  const weights = validateWeights(query.weights ?? {}, errors);

  if (errors.length > 0) {
    throw new MemoryValidationError(errors);
  }

  return {
    text: query.text,
    now: query.now,
    topK,
    tags,
    sourceIds,
    weights,
  };
}

export function assertUniqueMemoryId(existingIds: ReadonlySet<string>, id: string): void {
  if (existingIds.has(id)) {
    throw new MemoryValidationError([`memory id already exists: ${id}`]);
  }
}

export function isMemoryKind(value: string): value is MemoryKind {
  return (MEMORY_KINDS as readonly string[]).includes(value);
}

export function isMemoryVisibility(value: string): value is MemoryVisibility {
  return (MEMORY_VISIBILITIES as readonly string[]).includes(value);
}

function validateNonEmptyString(value: string, path: string, errors: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${path} must be a non-empty string`);
  }
}

function validateMemoryKind(value: MemoryKind, path: string, errors: string[]): void {
  if (typeof value !== "string" || !isMemoryKind(value)) {
    errors.push(`${path} must be one of: ${MEMORY_KINDS.join(", ")}`);
  }
}

function validateVisibility(value: MemoryVisibility, path: string, errors: string[]): MemoryVisibility {
  if (typeof value !== "string" || !isMemoryVisibility(value)) {
    errors.push(`${path} must be one of: ${MEMORY_VISIBILITIES.join(", ")}`);
    return "private";
  }
  return value;
}

function validateIsoDate(value: string, path: string, errors: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0 || Number.isNaN(Date.parse(value))) {
    errors.push(`${path} must be a valid ISO date string`);
  }
}

function validateImportance(value: number, path: string, errors: string[]): void {
  if (!Number.isFinite(value) || value < MEMORY_IMPORTANCE_MIN || value > MEMORY_IMPORTANCE_MAX) {
    errors.push(`${path} must be a number from ${MEMORY_IMPORTANCE_MIN} to ${MEMORY_IMPORTANCE_MAX}`);
  }
}

function normalizeStringArray(
  value: readonly string[],
  path: string,
  errors: string[],
  options: { required: boolean },
): readonly string[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be a string array`);
    return [];
  }

  if (options.required && value.length === 0) {
    errors.push(`${path} must be a non-empty string array`);
  }

  const normalized = value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      errors.push(`${path} must contain only non-empty strings`);
      return "";
    }
    return entry;
  });

  return normalized;
}

function validateTopK(value: number, path: string, errors: string[]): number {
  if (!Number.isInteger(value) || value <= 0) {
    errors.push(`${path} must be a positive integer`);
    return DEFAULT_MEMORY_RETRIEVAL_TOP_K;
  }
  return value;
}

function validateWeights(partialWeights: Partial<MemoryRetrievalWeights>, errors: string[]): MemoryRetrievalWeights {
  const rawWeights: MemoryRetrievalWeights = {
    ...DEFAULT_MEMORY_RETRIEVAL_WEIGHTS,
    ...partialWeights,
  };

  const entries = Object.entries(rawWeights) as Array<[keyof MemoryRetrievalWeights, number]>;
  for (const [key, value] of entries) {
    if (!Number.isFinite(value) || value < 0) {
      errors.push(`query.weights.${key} must be a non-negative finite number`);
    }
  }

  const sum = rawWeights.relevance + rawWeights.recency + rawWeights.importance;
  if (!Number.isFinite(sum) || sum <= 0) {
    errors.push("query.weights must have a positive sum");
    return DEFAULT_MEMORY_RETRIEVAL_WEIGHTS;
  }

  return {
    relevance: rawWeights.relevance / sum,
    recency: rawWeights.recency / sum,
    importance: rawWeights.importance / sum,
  };
}
