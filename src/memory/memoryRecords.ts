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

export const EMOTION_VALENCE_MIN = -1;
export const EMOTION_VALENCE_MAX = 1;
export const EMOTION_AROUSAL_MIN = 0;
export const EMOTION_AROUSAL_MAX = 1;

/**
 * The emotional signature of a memory: how the agent felt at the moment the
 * memory was formed. Valence runs negative..positive, arousal calm..intense.
 * Optional on records — deterministic tick memories may carry no signature.
 */
export interface EmotionSignature {
  valence: number;
  arousal: number;
}

export const DEFAULT_MEMORY_RETRIEVAL_TOP_K = 5;

export interface MemoryRetrievalWeights {
  relevance: number;
  recency: number;
  importance: number;
  /** Mood-congruent recall: how much the agent's current emotional state biases retrieval. Default 0 (off). */
  emotion?: number;
}

export const DEFAULT_MEMORY_RETRIEVAL_WEIGHTS: MemoryRetrievalWeights = {
  relevance: 0.5,
  recency: 0.3,
  importance: 0.2,
  emotion: 0,
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
  /** How the agent felt when this memory was formed; absent on emotion-free records. */
  emotion?: EmotionSignature;
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
  emotion?: EmotionSignature;
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
  emotion?: EmotionSignature;
  metadata: Metadata;
}

export interface MemoryRetrievalQuery {
  text: string;
  now: string;
  topK?: number;
  tags?: readonly string[];
  sourceIds?: readonly string[];
  weights?: Partial<MemoryRetrievalWeights>;
  /**
   * The agent's current emotional state; when set (with a positive emotion
   * weight), memories whose emotion signature matches rank higher — the
   * mood-congruent recall pattern from companion memory systems.
   */
  emotionBias?: { valence: number; arousal: number };
}

export interface NormalizedMemoryRetrievalQuery {
  text: string;
  now: string;
  topK: number;
  tags: readonly string[];
  sourceIds: readonly string[];
  weights: MemoryRetrievalWeights;
  emotionBias?: { valence: number; arousal: number };
}

export interface MemoryScoreBreakdown {
  relevance: number;
  recency: number;
  importance: number;
  /** Present only when the query carries an emotion bias. */
  emotion?: number;
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
