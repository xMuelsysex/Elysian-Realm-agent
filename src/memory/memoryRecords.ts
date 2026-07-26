export const MEMORY_KINDS = [
  "observation",
  "action",
  "conversation",
  "relationship",
  "plan",
  "reflection",
  "intervention",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_VISIBILITIES = ["private", "shared", "system", "user-authored"] as const;

export type MemoryVisibility = (typeof MEMORY_VISIBILITIES)[number];

export const MEMORY_IMPORTANCE_MIN = 0;
export const MEMORY_IMPORTANCE_MAX = 9;

export const DEFAULT_MEMORY_RETRIEVAL_TOP_K = 5;

export interface MemoryRetrievalWeights {
  relevance: number;
  recency: number;
  importance: number;
}

export const DEFAULT_MEMORY_RETRIEVAL_WEIGHTS: MemoryRetrievalWeights = {
  relevance: 0.5,
  recency: 0.3,
  importance: 0.2,
};

export interface MemoryRecord<Metadata = Record<string, unknown>> {
  id: string;
  agentId: string;
  kind: MemoryKind;
  content: string;
  createdAt: string;
  lastAccessedAt: string;
  importance: number;
  sourceIds: readonly string[];
  relatedMemoryIds: readonly string[];
  visibility: MemoryVisibility;
  tags: readonly string[];
  metadata: Metadata;
}

export interface MemoryWrite<Metadata = Record<string, unknown>> {
  id?: string;
  kind: MemoryKind;
  content: string;
  createdAt: string;
  importance: number;
  sourceIds: readonly string[];
  relatedMemoryIds?: readonly string[];
  visibility?: MemoryVisibility;
  tags?: readonly string[];
  metadata?: Metadata;
}

export interface NormalizedMemoryWrite<Metadata = Record<string, unknown>> {
  id?: string;
  kind: MemoryKind;
  content: string;
  createdAt: string;
  importance: number;
  sourceIds: readonly string[];
  relatedMemoryIds: readonly string[];
  visibility: MemoryVisibility;
  tags: readonly string[];
  metadata: Metadata;
}

export interface MemoryRetrievalQuery {
  text: string;
  now: string;
  topK?: number;
  tags?: readonly string[];
  sourceIds?: readonly string[];
  weights?: Partial<MemoryRetrievalWeights>;
}

export interface NormalizedMemoryRetrievalQuery {
  text: string;
  now: string;
  topK: number;
  tags: readonly string[];
  sourceIds: readonly string[];
  weights: MemoryRetrievalWeights;
}

export interface MemoryScoreBreakdown {
  relevance: number;
  recency: number;
  importance: number;
  finalScore: number;
}

export interface MemoryRetrievalHit<Metadata = Record<string, unknown>> {
  record: MemoryRecord<Metadata>;
  score: MemoryScoreBreakdown;
}

export interface MemoryCandidateDiagnostic {
  memoryId: string;
  score: MemoryScoreBreakdown;
}

export interface ExcludedMemoryDiagnostic {
  memoryId: string;
  reason: string;
}

export interface MemoryRetrievalDiagnostic {
  query: NormalizedMemoryRetrievalQuery;
  candidateIds: readonly string[];
  selectedIds: readonly string[];
  candidateScores: readonly MemoryCandidateDiagnostic[];
  excluded: readonly ExcludedMemoryDiagnostic[];
}

export interface MemoryRetrievalResult<Metadata = Record<string, unknown>> {
  hits: readonly MemoryRetrievalHit<Metadata>[];
  diagnostics: MemoryRetrievalDiagnostic;
}
