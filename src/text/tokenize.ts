const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]+/g;

/** Token frequencies for mixed CJK and ASCII text; the counts feed BM25 scoring. */
export function tokenizeFrequencies(value: string): Map<string, number> {
  const lowered = value.toLowerCase();
  const frequencies = new Map<string, number>();
  const count = (token: string): void => {
    const normalized = normalizeSearchToken(token);
    if (normalized.length === 0) return;
    frequencies.set(normalized, (frequencies.get(normalized) ?? 0) + 1);
  };

  for (const token of lowered.match(/[a-z0-9_]+/g) ?? []) {
    count(token);
  }
  // CJK runs become overlapping bigrams (the Lucene CJKAnalyzer approach).
  for (const run of lowered.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      count(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      count(run.slice(index, index + 2));
    }
  }
  return frequencies;
}

/** Tokenize mixed CJK and ASCII text for deterministic local search. */
export function tokenizeText(value: string): Set<string> {
  return new Set(tokenizeFrequencies(value).keys());
}

function normalizeSearchToken(value: string): string {
  return value.trim().toLowerCase();
}

const ASCII_WORD = /^[a-z0-9_]+$/;

// 从长到短匹配并立即返回，所以 "meetings" 剥一次成 "meet"，不会先剥 "s" 再剥 "ing"。
const ASCII_SUFFIXES = ["ations", "ation", "ings", "ing", "edly", "ed", "ly", "ies", "es", "s"];

/**
 * Light English suffix strip so "researching" and "research" meet. No dictionary,
 * no stemming library: deterministic, and short words are left alone.
 */
export function stemAsciiWord(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  for (const suffix of ASCII_SUFFIXES) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/**
 * Search-term frequencies for the keyword signal: the plain frequencies plus
 * their stemmed ASCII forms, so morphology does not hide a match. A term that is
 * literally present keeps its own count, so exact matches never score worse.
 */
export function tokenizeSearchFrequencies(value: string): Map<string, number> {
  const frequencies = tokenizeFrequencies(value);
  for (const [token, frequency] of [...frequencies]) {
    if (!ASCII_WORD.test(token)) continue;
    const stem = stemAsciiWord(token);
    if (stem === token) continue;
    frequencies.set(stem, (frequencies.get(stem) ?? 0) + frequency);
  }
  return frequencies;
}
