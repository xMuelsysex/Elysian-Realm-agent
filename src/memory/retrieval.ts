import {
  MEMORY_IMPORTANCE_MAX,
  type ExcludedMemoryDiagnostic,
  type MemoryCandidateDiagnostic,
  type MemoryRecord,
  type MemoryRetrievalDiagnostic,
  type MemoryRetrievalHit,
  type MemoryRetrievalQuery,
  type MemoryRetrievalResult,
  type MemoryScoreBreakdown,
  type NormalizedMemoryRetrievalQuery,
} from "./memoryRecords.js";
import { validateMemoryRetrievalQuery } from "./validation.js";
import { buildCorpusStats, scoreBm25, type Bm25CorpusStats, type TokenFrequencies } from "../text/bm25.js";
import { tokenizeSearchFrequencies } from "../text/tokenize.js";

interface ScoredRecord<Metadata> {
  record: MemoryRecord<Metadata>;
  score: MemoryScoreBreakdown;
}

/**
 * Length normalization is off for the memory stream (measured, not assumed).
 *
 * LoCoMo 证据召回 @10（default / lexical-only 权重）：b=0 → 34.6 / 47.5，b=0.25 →
 * 33.1 / 47.7，b=0.5 → 31.6 / 47.3，b=0.75 → 29.1 / 46.7。合成唯一答案语料里「唯一相关
 * 但既旧又不重要」的 recall@1：b=0 → 95%，b≥0.25 → 20%。
 * 原因：记忆流里最长的记录恰好是最具体的记录，长度惩罚正好压掉值得召回的那些。
 * TF 饱和与 IDF 保留。
 */
const MEMORY_BM25_OPTIONS = { b: 0 } as const;

/**
 * Everything the keyword signal needs, built once per retrieval call over the
 * agent's candidates: the query's term frequencies, the corpus statistics, and
 * each candidate's precomputed frequencies so scoring stays a single pass.
 */
interface MemorySearchIndex {
  readonly query: TokenFrequencies;
  readonly corpus: Bm25CorpusStats;
  readonly frequenciesByMemoryId: ReadonlyMap<string, TokenFrequencies>;
}

export function retrieveMemoryRecords<Metadata = Record<string, unknown>>(
  records: readonly MemoryRecord<Metadata>[],
  agentId: string,
  query: MemoryRetrievalQuery,
): MemoryRetrievalResult<Metadata> {
  const normalizedQuery = validateMemoryRetrievalQuery(query);
  const excluded: ExcludedMemoryDiagnostic[] = [];
  const candidates: Array<MemoryRecord<Metadata>> = [];

  for (const record of records) {
    if (record.agentId !== agentId) {
      excluded.push({ memoryId: record.id, reason: "different agentId" });
      continue;
    }
    if (record.invalidAt !== undefined) {
      excluded.push({ memoryId: record.id, reason: "invalidated" });
      continue;
    }
    candidates.push(record);
  }

  const index = buildSearchIndex(candidates, normalizedQuery.text);
  const scored = candidates.map((record) => ({
    record,
    score: scoreRecordWithIndex(record, normalizedQuery, index),
  }));

  scored.sort(compareScoredRecords);
  const selected = scored.slice(0, normalizedQuery.topK);

  return {
    hits: selected.map((entry) => ({
      record: cloneMemoryRecord(entry.record),
      score: cloneScore(entry.score),
    })),
    diagnostics: buildDiagnostic(normalizedQuery, scored, selected, excluded),
  };
}

export function scoreMemoryRecord<Metadata>(
  record: MemoryRecord<Metadata>,
  query: NormalizedMemoryRetrievalQuery,
): MemoryScoreBreakdown {
  return scoreRecordWithIndex(record, query, buildSearchIndex([record], query.text));
}

function scoreRecordWithIndex<Metadata>(
  record: MemoryRecord<Metadata>,
  query: NormalizedMemoryRetrievalQuery,
  index: MemorySearchIndex,
): MemoryScoreBreakdown {
  const relevance = scoreRelevance(record, query, index);
  const recency = scoreRecency(record.createdAt, query.now);
  const importance = normalizeScore(record.importance / MEMORY_IMPORTANCE_MAX);
  const emotion = query.emotionBias !== undefined
    ? scoreEmotionCongruence(record, query.emotionBias)
    : undefined;
  const finalScore =
    query.weights.relevance * relevance +
    query.weights.recency * recency +
    query.weights.importance * importance +
    (emotion !== undefined ? query.weights.emotion! * emotion : 0);

  return {
    relevance,
    recency,
    importance,
    ...(emotion !== undefined ? { emotion } : {}),
    finalScore: normalizeScore(finalScore),
  };
}

/**
 * Mood-congruent recall: how closely the record's emotional signature matches
 * the agent's current state. Records without a signature score a neutral 0.5
 * so emotionless (e.g. deterministic tick) memories stay competitive.
 */
function scoreEmotionCongruence<Metadata>(
  record: MemoryRecord<Metadata>,
  bias: { valence: number; arousal: number },
): number {
  if (record.emotion === undefined) {
    return 0.5;
  }
  const valenceCongruence = 1 - Math.abs(bias.valence - record.emotion.valence) / 2;
  const arousalCongruence = 1 - Math.abs(bias.arousal - record.emotion.arousal);
  return normalizeScore((valenceCongruence + arousalCongruence) / 2);
}

export function cloneMemoryRecord<Metadata = Record<string, unknown>>(record: MemoryRecord<Metadata>): MemoryRecord<Metadata> {
  return {
    ...record,
    sourceIds: [...record.sourceIds],
    relatedMemoryIds: [...record.relatedMemoryIds],
    tags: [...record.tags],
  };
}

function buildDiagnostic<Metadata>(
  query: NormalizedMemoryRetrievalQuery,
  scored: readonly ScoredRecord<Metadata>[],
  selected: readonly ScoredRecord<Metadata>[],
  excluded: readonly ExcludedMemoryDiagnostic[],
): MemoryRetrievalDiagnostic {
  const candidateScores: MemoryCandidateDiagnostic[] = scored.map((entry) => ({
    memoryId: entry.record.id,
    score: cloneScore(entry.score),
  }));

  return {
    query: {
      ...query,
      tags: [...query.tags],
      sourceIds: [...query.sourceIds],
      weights: { ...query.weights },
    },
    candidateIds: scored.map((entry) => entry.record.id),
    selectedIds: selected.map((entry) => entry.record.id),
    candidateScores,
    excluded: excluded.map((entry) => ({ ...entry })),
  };
}

function compareScoredRecords<Metadata>(left: ScoredRecord<Metadata>, right: ScoredRecord<Metadata>): number {
  const scoreDelta = right.score.finalScore - left.score.finalScore;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const createdDelta = Date.parse(right.record.createdAt) - Date.parse(left.record.createdAt);
  if (createdDelta !== 0) {
    return createdDelta;
  }

  return left.record.id.localeCompare(right.record.id);
}

function buildSearchIndex<Metadata>(
  records: readonly MemoryRecord<Metadata>[],
  queryText: string,
): MemorySearchIndex {
  const frequenciesByMemoryId = new Map<string, TokenFrequencies>();
  for (const record of records) {
    frequenciesByMemoryId.set(record.id, recordFrequencies(record));
  }
  return {
    query: tokenizeSearchFrequencies(queryText),
    corpus: buildCorpusStats([...frequenciesByMemoryId.values()]),
    frequenciesByMemoryId,
  };
}

function recordFrequencies<Metadata>(record: MemoryRecord<Metadata>): TokenFrequencies {
  const frequencies = tokenizeSearchFrequencies(record.content);
  for (const tag of record.tags) {
    for (const [term, count] of tokenizeSearchFrequencies(tag)) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + count);
    }
  }
  return frequencies;
}

function scoreRelevance<Metadata>(
  record: MemoryRecord<Metadata>,
  query: NormalizedMemoryRetrievalQuery,
  index: MemorySearchIndex,
): number {
  const channelScores: number[] = [];
  if (index.query.size > 0) {
    const recordFreqs = index.frequenciesByMemoryId.get(record.id) ?? recordFrequencies(record);
    channelScores.push(scoreBm25(index.query, recordFreqs, index.corpus, MEMORY_BM25_OPTIONS));
  }

  if (query.tags.length > 0) {
    channelScores.push(scoreSetOverlap(new Set(query.tags.map(normalizeToken)), new Set(record.tags.map(normalizeToken))));
  }

  if (query.sourceIds.length > 0) {
    channelScores.push(scoreSetOverlap(new Set(query.sourceIds), new Set(record.sourceIds)));
  }

  if (channelScores.length === 0) {
    return 0;
  }

  return normalizeScore(channelScores.reduce((sum, score) => sum + score, 0) / channelScores.length);
}

function scoreRecency(createdAt: string, now: string): number {
  const ageMs = Date.parse(now) - Date.parse(createdAt);
  if (ageMs <= 0) {
    return 1;
  }

  const ageHours = ageMs / (1000 * 60 * 60);
  return normalizeScore(1 / (1 + ageHours / 24));
}

function scoreSetOverlap(queryValues: ReadonlySet<string>, recordValues: ReadonlySet<string>): number {
  if (queryValues.size === 0) {
    return 0;
  }

  let matches = 0;
  for (const value of queryValues) {
    if (recordValues.has(value)) {
      matches += 1;
    }
  }
  return matches / queryValues.size;
}

function normalizeToken(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function normalizeScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function cloneScore(score: MemoryScoreBreakdown): MemoryScoreBreakdown {
  return { ...score };
}
