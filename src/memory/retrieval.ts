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

interface ScoredRecord<Metadata> {
  record: MemoryRecord<Metadata>;
  score: MemoryScoreBreakdown;
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
    candidates.push(record);
  }

  const scored = candidates.map((record) => ({
    record,
    score: scoreMemoryRecord(record, normalizedQuery),
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
  const relevance = scoreRelevance(record, query);
  const recency = scoreRecency(record.createdAt, query.now);
  const importance = normalizeScore(record.importance / MEMORY_IMPORTANCE_MAX);
  const finalScore =
    query.weights.relevance * relevance +
    query.weights.recency * recency +
    query.weights.importance * importance;

  return {
    relevance,
    recency,
    importance,
    finalScore: normalizeScore(finalScore),
  };
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

function scoreRelevance<Metadata>(record: MemoryRecord<Metadata>, query: NormalizedMemoryRetrievalQuery): number {
  const channelScores: number[] = [];
  const queryTokens = tokenize(query.text);
  if (queryTokens.size > 0) {
    const recordTokens = new Set([...tokenize(record.content), ...record.tags.flatMap((tag) => [...tokenize(tag)])]);
    channelScores.push(scoreSetOverlap(queryTokens, recordTokens));
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

function tokenize(value: string): Set<string> {
  const matches = value.toLocaleLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return new Set(matches.map(normalizeToken).filter((token) => token.length > 0));
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
