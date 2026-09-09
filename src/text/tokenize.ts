const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]+/g;

/** Tokenize mixed CJK and ASCII text for deterministic local search. */
export function tokenizeText(value: string): Set<string> {
  const lowered = value.toLowerCase();
  const tokens: string[] = [...(lowered.match(/[a-z0-9_]+/g) ?? [])];
  // CJK runs become overlapping bigrams (the Lucene CJKAnalyzer approach).
  for (const run of lowered.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.push(run.slice(index, index + 2));
    }
  }
  return new Set(tokens.map(normalizeSearchToken).filter((token) => token.length > 0));
}

function normalizeSearchToken(value: string): string {
  return value.trim().toLowerCase();
}
