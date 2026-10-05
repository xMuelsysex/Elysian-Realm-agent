import { buildCorpusStats, scoreBm25 } from "../text/bm25.js";
import { tokenizeFrequencies } from "../text/tokenize.js";
import {
  DEFAULT_LORE_RETRIEVAL_TOP_K,
  validateLoreRetrievalQuery,
  type LoreEntryV1,
  type LoreRetrievalHitV1,
  type LoreRetrievalQueryV1,
  type LoreRetrievalResultV1,
  type NormalizedLoreRetrievalQueryV1,
} from "./loreRecords.js";

interface ScoredLoreEntry {
  entry: LoreEntryV1;
  score: number;
}

/** Deterministic BM25 retrieval for curated canon; zero-score entries stay out. */
export function retrieveLoreEntries(
  entries: readonly LoreEntryV1[],
  query: LoreRetrievalQueryV1,
): LoreRetrievalResultV1 {
  const normalizedQuery = validateLoreRetrievalQuery(query);
  const queryFrequencies = tokenizeFrequencies(normalizedQuery.text);
  const excluded: Array<{ loreId: string; reason: string }> = [];
  const visible: LoreEntryV1[] = [];

  for (const entry of entries) {
    if (entry.knownTo !== undefined && !entry.knownTo.includes(normalizedQuery.agentId)) {
      excluded.push({ loreId: entry.id, reason: "agent is outside knownTo" });
      continue;
    }
    visible.push(entry);
  }

  const documents = visible.map((entry) => tokenizeFrequencies(loreSearchableText(entry)));
  const corpusStats = buildCorpusStats(documents);
  const scored = visible.map((entry, index) => ({
    entry,
    score: scoreBm25(queryFrequencies, documents[index]!, corpusStats),
  }));
  const selected = scored
    .filter((entry) => entry.score > 0)
    .sort(compareScoredEntries)
    .slice(0, normalizedQuery.topK);

  return {
    hits: selected.map((entry) => ({ entry: cloneLoreEntry(entry.entry), score: entry.score })),
    diagnostics: {
      query: normalizedQuery,
      candidateIds: visible.map((entry) => entry.id),
      selectedIds: selected.map((entry) => entry.entry.id),
      candidateScores: scored.map((entry) => ({ loreId: entry.entry.id, score: entry.score })),
      excluded,
    },
  };
}

function loreSearchableText(entry: LoreEntryV1): string {
  return [
    entry.title,
    entry.summary,
    entry.cause,
    entry.consequence,
    ...entry.participants,
    ...entry.aliases,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");
}

function compareScoredEntries(left: ScoredLoreEntry, right: ScoredLoreEntry): number {
  const scoreDelta = right.score - left.score;
  if (scoreDelta !== 0) return scoreDelta;
  const arcDelta = compareCodeUnits(left.entry.arcId, right.entry.arcId);
  if (arcDelta !== 0) return arcDelta;
  const orderDelta = left.entry.order - right.entry.order;
  if (orderDelta !== 0) return orderDelta;
  return compareCodeUnits(left.entry.id, right.entry.id);
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function cloneLoreEntry(entry: LoreEntryV1): LoreEntryV1 {
  return {
    ...entry,
    participants: [...entry.participants],
    aliases: [...entry.aliases],
    ...(entry.knownTo !== undefined ? { knownTo: [...entry.knownTo] } : {}),
  };
}

export { DEFAULT_LORE_RETRIEVAL_TOP_K };
