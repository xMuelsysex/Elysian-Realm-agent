import { tokenizeText } from "../text/tokenize.js";
import {
  dialogueLinesForSpeaker,
  type LoreDialogueCatalogV1,
  type LoreDialogueLineV1,
  type LoreDialogueRetrievalHitV1,
  type LoreDialogueSceneV1,
} from "./loreDialogueRecords.js";

export const DEFAULT_DIALOGUE_RETRIEVAL_TOP_K = 3;
export const MAX_DIALOGUE_RETRIEVAL_TOP_K = 4;
export const DEFAULT_DIALOGUE_CONTEXT_CHARS = 6000;

export interface LoreDialogueRetrievalInput {
  cursor: number;
  speakerAliases: readonly string[];
  text: string;
  topK?: number;
  maxChars?: number;
}

/** Retrieve only unlocked transcript lines that begin at the character's entry. */
export function retrieveLoreDialogue(
  catalog: LoreDialogueCatalogV1,
  input: LoreDialogueRetrievalInput,
): { hits: readonly LoreDialogueRetrievalHitV1[] } {
  if (!Number.isInteger(input.cursor) || input.cursor <= 0 || input.speakerAliases.length === 0) {
    return { hits: [] };
  }
  const topK = Math.min(
    MAX_DIALOGUE_RETRIEVAL_TOP_K,
    Math.max(1, Math.floor(input.topK ?? DEFAULT_DIALOGUE_RETRIEVAL_TOP_K)),
  );
  const queryTokens = tokenizeText(input.text);
  const rankedCandidates = catalog.scenes
    .filter((scene) => scene.available && scene.order < input.cursor)
    .map((scene) => {
      const lines = dialogueLinesForSpeaker(scene, input.speakerAliases);
      if (lines.length === 0) return undefined;
      const score = scoreScene(scene, lines, queryTokens);
      return { scene, lines, score };
    })
    .filter((candidate): candidate is LoreDialogueRetrievalHitV1 => candidate !== undefined)
    .sort((a, b) =>
      b.score - a.score ||
      b.scene.order - a.scene.order ||
      compareCodeUnits(a.scene.id, b.scene.id),
    );

  // Keep the latest visible scene as continuity even when an older scene
  // matches the message more strongly. Relevance fills the remaining slots.
  const latestUnlocked = rankedCandidates
    .slice()
    .sort((a, b) => b.scene.order - a.scene.order || compareCodeUnits(a.scene.id, b.scene.id))[0];
  const candidates = latestUnlocked === undefined
    ? []
    : [
        latestUnlocked,
        ...rankedCandidates.filter((candidate) => candidate.scene.id !== latestUnlocked.scene.id).slice(0, topK - 1),
      ]
    .map((hit) => ({ ...hit, lines: selectLines(hit.lines, queryTokens) }));

  return { hits: limitHits(candidates, input.maxChars ?? DEFAULT_DIALOGUE_CONTEXT_CHARS) };
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function scoreScene(
  scene: LoreDialogueSceneV1,
  lines: readonly LoreDialogueLineV1[],
  queryTokens: ReadonlySet<string>,
): number {
  if (queryTokens.size === 0) return 0;
  const sceneTokens = tokenizeText([scene.title, ...lines.map((line) => line.text)].join("\n"));
  let matched = 0;
  for (const token of queryTokens) {
    if (sceneTokens.has(token)) matched += 1;
  }
  return matched / queryTokens.size;
}

function selectLines(
  lines: readonly LoreDialogueLineV1[],
  queryTokens: ReadonlySet<string>,
): readonly LoreDialogueLineV1[] {
  if (lines.length <= 12 || queryTokens.size === 0) {
    return lines.slice(-12);
  }
  const matching = lines
    .map((line, index) => ({ index, tokens: tokenizeText(line.text) }))
    .filter(({ tokens }) => [...queryTokens].some((token) => tokens.has(token)))
    .flatMap(({ index }) => [index - 1, index, index + 1])
    .filter((index) => index >= 0 && index < lines.length);
  const indexes = [...new Set(matching)].sort((a, b) => a - b);
  if (indexes.length === 0) return lines.slice(-12);
  return indexes.map((index) => lines[index]);
}

function limitHits(
  hits: readonly LoreDialogueRetrievalHitV1[],
  maxChars: number,
): readonly LoreDialogueRetrievalHitV1[] {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return [];
  let used = 0;
  const out: LoreDialogueRetrievalHitV1[] = [];
  for (const hit of hits) {
    const lines: LoreDialogueLineV1[] = [];
    for (const line of hit.lines) {
      const lineChars = line.text.length + (line.speaker?.length ?? 0) + 12;
      if (used + lineChars > maxChars) break;
      lines.push(line);
      used += lineChars;
    }
    if (lines.length > 0) out.push({ ...hit, lines });
  }
  return out;
}
