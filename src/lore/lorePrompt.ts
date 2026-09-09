import {
  LORE_MAX_PROMPT_CHARS,
  LORE_MAX_TOP_K,
  LoreValidationError,
  validateLoreEntry,
  type LoreRetrievalHitV1,
} from "./loreRecords.js";

/** Render retrieved canon separately from lived memories and self-concept. */
export function renderLoreContext(
  hits: readonly LoreRetrievalHitV1[],
): string | undefined {
  if (hits.length === 0) return undefined;
  if (hits.length > LORE_MAX_TOP_K) {
    throw new LoreValidationError([`lore context may contain at most ${LORE_MAX_TOP_K} entries`]);
  }

  const ordered = hits
    .map((hit, index) => ({
      ...hit,
      entry: validateLoreEntry(hit.entry, `loreHits[${index}].entry`),
    }))
    .sort((left, right) => {
      const arcDelta = compareCodeUnits(left.entry.arcId, right.entry.arcId);
      if (arcDelta !== 0) return arcDelta;
      const orderDelta = left.entry.order - right.entry.order;
      if (orderDelta !== 0) return orderDelta;
      return compareCodeUnits(left.entry.id, right.entry.id);
    });
  const lines = ordered.map(({ entry }) => [
    `- [canon:${entry.id}] ${entry.title}: ${entry.summary}`,
    ...(entry.cause !== undefined ? [`  Cause: ${entry.cause}`] : []),
    ...(entry.consequence !== undefined ? [`  Consequence: ${entry.consequence}`] : []),
    `  Source: ${entry.sourceUrl} (canon version ${entry.canonVersion})`,
  ].join("\n"));

  const context = [
    "Canonical story context (read-only; not personal memory):",
    ...lines,
    "Treat these entries as world facts. Do not present them as personal memories or claim to have witnessed them unless a separate personal memory supports that claim.",
    "Do not invent canon details that are absent here, and do not mention canon IDs unless the participant asks.",
    "If the participant asks for provenance, quote only the exact Source URL and canon version shown above; otherwise do not mention source URLs.",
  ].join("\n");
  if (context.length > LORE_MAX_PROMPT_CHARS) {
    throw new LoreValidationError([
      `rendered lore context exceeds ${LORE_MAX_PROMPT_CHARS} characters`,
    ]);
  }
  return context;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
