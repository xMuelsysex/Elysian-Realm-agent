/** BM25 saturation constant: how fast repeated terms stop adding score. */
export const BM25_K1 = 1.2;
/** BM25 length-normalization strength: 1 normalizes fully, 0 disables it. */
export const BM25_B = 0.75;

export type TokenFrequencies = ReadonlyMap<string, number>;

export interface Bm25Options {
  /** Term-frequency saturation strength; defaults to BM25_K1. */
  readonly k1?: number;
  /**
   * Length-normalization strength; defaults to BM25_B. `0` disables it, which is
   * what the memory stream wants: its longest records are also its most specific
   * ones, so penalizing length demotes exactly the memories worth recalling.
   */
  readonly b?: number;
}

export interface Bm25CorpusStats {
  /** How many documents the query is ranked against. */
  readonly documentCount: number;
  /** Mean document length in tokens: the length that carries no penalty. */
  readonly averageLength: number;
  /** How many documents contain each term. */
  readonly documentFrequency: ReadonlyMap<string, number>;
}

/** Collect the term statistics BM25 needs from the documents being ranked. */
export function buildCorpusStats(documents: readonly TokenFrequencies[]): Bm25CorpusStats {
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;

  for (const document of documents) {
    totalLength += documentLength(document);
    for (const term of document.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  return {
    documentCount: documents.length,
    averageLength: documents.length === 0 ? 0 : totalLength / documents.length,
    documentFrequency,
  };
}

/**
 * Score one document against one query on a 0..1 scale.
 *
 * The denominator is the score an ideal document would reach: every query term
 * present exactly once at the corpus average length. Such a document scores
 * exactly 1, shorter documents exceed it and clamp back to 1, and longer
 * documents fall below it, so length normalization applies to every term rather
 * than only to terms that repeat. Rare terms carry more weight through IDF.
 */
export function scoreBm25(
  query: TokenFrequencies,
  document: TokenFrequencies,
  stats: Bm25CorpusStats,
  options: Bm25Options = {},
): number {
  if (query.size === 0) return 0;

  const normalization = lengthNormalization(documentLength(document), stats, options);
  let matched = 0;
  let ideal = 0;

  for (const [term, queryFrequency] of query) {
    const weight = inverseDocumentFrequency(stats, term) * queryFrequency;
    ideal += weight;
    const frequency = document.get(term);
    if (frequency === undefined) continue;
    matched += weight * saturation(frequency, normalization, options);
  }

  return clampUnit(matched / ideal);
}

/**
 * Robertson-Sparck Jones IDF in its always-positive form, so small corpora and
 * terms present in every document stay above zero instead of flipping the sign.
 */
function inverseDocumentFrequency(stats: Bm25CorpusStats, term: string): number {
  const containing = stats.documentFrequency.get(term) ?? 0;
  return Math.log(1 + (stats.documentCount - containing + 0.5) / (containing + 0.5));
}

/** Term-frequency saturation: repeated occurrences approach but never reach k1 + 1. */
function saturation(frequency: number, normalization: number, options: Bm25Options): number {
  return (frequency * ((options.k1 ?? BM25_K1) + 1)) / (frequency + normalization);
}

/** k1 scaled by how far the document length sits from the corpus average. */
function lengthNormalization(length: number, stats: Bm25CorpusStats, options: Bm25Options): number {
  const k1 = options.k1 ?? BM25_K1;
  const b = options.b ?? BM25_B;
  return k1 * (1 - b + b * (length / stats.averageLength));
}

function documentLength(document: TokenFrequencies): number {
  let length = 0;
  for (const frequency of document.values()) {
    length += frequency;
  }
  return length;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}
