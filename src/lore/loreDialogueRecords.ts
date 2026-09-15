export const LORE_DIALOGUE_SCHEMA_VERSION = "lore-dialogue.v1" as const;

export const LORE_DIALOGUE_LINE_KINDS = [
  "dialogue",
  "narration",
  "option",
  "annotation",
  "system",
] as const;
export type LoreDialogueLineKindV1 = (typeof LORE_DIALOGUE_LINE_KINDS)[number];

export const LORE_STAGE_MARKER_KINDS = ["result", "branch", "route", "media-marker"] as const;
export type LoreStageMarkerKindV1 = (typeof LORE_STAGE_MARKER_KINDS)[number];

export interface LoreDialogueLineV1 {
  id: string;
  stageId: string;
  sourceIndex: number;
  kind: LoreDialogueLineKindV1;
  speaker?: string;
  text: string;
}

export interface LoreDialogueMediaV1 {
  cg?: string;
  displayName?: string;
  href?: string;
}

export interface LoreDialogueStageV1 {
  id: string;
  marker?: string;
  markerKind?: LoreStageMarkerKindV1;
  lines: readonly LoreDialogueLineV1[];
  media?: LoreDialogueMediaV1;
}

export interface LoreDialogueSceneV1 {
  id: string;
  arcId: string;
  chapterId: string;
  order: number;
  title: string;
  sourceUrl: string;
  available: boolean;
  stages: readonly LoreDialogueStageV1[];
}

export interface LoreDialogueChapterV1 {
  id: string;
  arcId: string;
  title: string;
  sceneIds: readonly string[];
}

export interface LoreDialogueArcV1 {
  id: string;
  title: string;
  chapterIds: readonly string[];
}

export interface LoreDialogueImportDiagnosticV1 {
  sourceUrl: string;
  status: number;
  message: string;
}

export interface LoreDialogueCatalogV1 {
  schemaVersion: typeof LORE_DIALOGUE_SCHEMA_VERSION;
  source: string;
  arcs: readonly LoreDialogueArcV1[];
  chapters: readonly LoreDialogueChapterV1[];
  scenes: readonly LoreDialogueSceneV1[];
  diagnostics?: readonly LoreDialogueImportDiagnosticV1[];
}

export interface LoreDialogueContextV1 {
  sceneId: string;
  sceneTitle: string;
  sourceUrl: string;
  stageId: string;
  lines: readonly LoreDialogueLineV1[];
}

export interface LoreDialogueRetrievalHitV1 {
  scene: LoreDialogueSceneV1;
  lines: readonly LoreDialogueLineV1[];
  score: number;
}

export function validateLoreDialogueRetrievalHits(input: unknown): readonly LoreDialogueRetrievalHitV1[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) throw new Error("lore dialogue context must be an array");
  return input.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.score !== "number" || !Number.isFinite(entry.score)) {
      throw new Error(`lore dialogue context[${index}] must have a finite score`);
    }
    const scene = validateScenes([entry.scene])[0];
    const lines = validateLines(entry.lines, index, 0);
    return { scene, lines, score: entry.score };
  });
}

export function validateLoreDialogueCatalog(input: unknown): LoreDialogueCatalogV1 {
  if (!isRecord(input)) throw new Error("lore dialogue catalog must be an object");
  if (input.schemaVersion !== LORE_DIALOGUE_SCHEMA_VERSION) {
    throw new Error(`lore dialogue schemaVersion must be ${LORE_DIALOGUE_SCHEMA_VERSION}`);
  }
  const source = requireString(input.source, "lore dialogue source");
  const arcs = validateArcs(input.arcs);
  const chapters = validateChapters(input.chapters);
  const scenes = validateScenes(input.scenes);
  const diagnostics = validateDiagnostics(input.diagnostics);
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  for (const chapter of chapters) {
    if (chapter.sceneIds.some((sceneId) => !sceneIds.has(sceneId))) {
      throw new Error(`chapter ${chapter.id} references an unknown scene`);
    }
  }
  const chapterIds = new Set(chapters.map((chapter) => chapter.id));
  for (const arc of arcs) {
    if (arc.chapterIds.some((chapterId) => !chapterIds.has(chapterId))) {
      throw new Error(`arc ${arc.id} references an unknown chapter`);
    }
  }
  return {
    schemaVersion: LORE_DIALOGUE_SCHEMA_VERSION,
    source,
    arcs,
    chapters,
    scenes,
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  };
}

function validateDiagnostics(input: unknown): readonly LoreDialogueImportDiagnosticV1[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) throw new Error("lore dialogue diagnostics must be an array");
  return input.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`lore dialogue diagnostics[${index}] must be an object`);
    if (typeof entry.status !== "number" || !Number.isInteger(entry.status) || entry.status < 400) {
      throw new Error(`lore dialogue diagnostics[${index}].status is invalid`);
    }
    return {
      sourceUrl: requireString(entry.sourceUrl, `lore dialogue diagnostics[${index}].sourceUrl`),
      status: entry.status,
      message: requireString(entry.message, `lore dialogue diagnostics[${index}].message`),
    };
  });
}

function validateArcs(input: unknown): readonly LoreDialogueArcV1[] {
  if (!Array.isArray(input)) throw new Error("lore dialogue arcs must be an array");
  return input.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`lore dialogue arcs[${index}] must be an object`);
    return {
      id: requireString(entry.id, `lore dialogue arcs[${index}].id`),
      title: requireString(entry.title, `lore dialogue arcs[${index}].title`),
      chapterIds: stringArray(entry.chapterIds, `lore dialogue arcs[${index}].chapterIds`),
    };
  });
}

function validateChapters(input: unknown): readonly LoreDialogueChapterV1[] {
  if (!Array.isArray(input)) throw new Error("lore dialogue chapters must be an array");
  return input.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`lore dialogue chapters[${index}] must be an object`);
    return {
      id: requireString(entry.id, `lore dialogue chapters[${index}].id`),
      arcId: requireString(entry.arcId, `lore dialogue chapters[${index}].arcId`),
      title: requireString(entry.title, `lore dialogue chapters[${index}].title`),
      sceneIds: stringArray(entry.sceneIds, `lore dialogue chapters[${index}].sceneIds`),
    };
  });
}

function validateScenes(input: unknown): readonly LoreDialogueSceneV1[] {
  if (!Array.isArray(input)) throw new Error("lore dialogue scenes must be an array");
  return input.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`lore dialogue scenes[${index}] must be an object`);
    if (typeof entry.order !== "number" || !Number.isInteger(entry.order) || entry.order < 0) {
      throw new Error(`lore dialogue scenes[${index}].order must be a non-negative integer`);
    }
    return {
      id: requireString(entry.id, `lore dialogue scenes[${index}].id`),
      arcId: requireString(entry.arcId, `lore dialogue scenes[${index}].arcId`),
      chapterId: requireString(entry.chapterId, `lore dialogue scenes[${index}].chapterId`),
      order: entry.order,
      title: requireString(entry.title, `lore dialogue scenes[${index}].title`),
      sourceUrl: requireString(entry.sourceUrl, `lore dialogue scenes[${index}].sourceUrl`),
      available: entry.available === undefined ? true : requireBoolean(entry.available, `lore dialogue scenes[${index}].available`),
      stages: validateStages(entry.stages, index),
    };
  });
}

function validateStages(input: unknown, sceneIndex: number): readonly LoreDialogueStageV1[] {
  if (!Array.isArray(input)) throw new Error(`lore dialogue scenes[${sceneIndex}].stages must be an array`);
  return input.map((entry, stageIndex) => {
    if (!isRecord(entry)) throw new Error(`lore dialogue stage ${sceneIndex}:${stageIndex} must be an object`);
    const markerKind = entry.markerKind;
    if (markerKind !== undefined && !LORE_STAGE_MARKER_KINDS.includes(markerKind as LoreStageMarkerKindV1)) {
      throw new Error(`lore dialogue stage ${sceneIndex}:${stageIndex}.markerKind is invalid`);
    }
    return {
      id: requireString(entry.id, `lore dialogue stage ${sceneIndex}:${stageIndex}.id`),
      ...(entry.marker !== undefined ? { marker: requireString(entry.marker, "lore dialogue stage marker") } : {}),
      ...(markerKind !== undefined ? { markerKind: markerKind as LoreStageMarkerKindV1 } : {}),
      lines: validateLines(entry.lines, sceneIndex, stageIndex),
      ...(entry.media !== undefined ? { media: validateMedia(entry.media, sceneIndex, stageIndex) } : {}),
    };
  });
}

function validateLines(input: unknown, sceneIndex: number, stageIndex: number): readonly LoreDialogueLineV1[] {
  if (!Array.isArray(input)) throw new Error(`lore dialogue lines ${sceneIndex}:${stageIndex} must be an array`);
  return input.map((entry, lineIndex) => {
    if (!isRecord(entry)) throw new Error(`lore dialogue line ${sceneIndex}:${stageIndex}:${lineIndex} must be an object`);
    if (!LORE_DIALOGUE_LINE_KINDS.includes(entry.kind as LoreDialogueLineKindV1)) {
      throw new Error(`lore dialogue line ${sceneIndex}:${stageIndex}:${lineIndex}.kind is invalid`);
    }
    if (typeof entry.sourceIndex !== "number" || !Number.isInteger(entry.sourceIndex) || entry.sourceIndex < 0) {
      throw new Error(`lore dialogue line ${sceneIndex}:${stageIndex}:${lineIndex}.sourceIndex is invalid`);
    }
    const speaker = entry.speaker;
    if (speaker !== undefined && typeof speaker !== "string") {
      throw new Error(`lore dialogue line ${sceneIndex}:${stageIndex}:${lineIndex}.speaker must be a string`);
    }
    return {
      id: requireString(entry.id, "lore dialogue line id"),
      stageId: requireString(entry.stageId, "lore dialogue line stageId"),
      sourceIndex: entry.sourceIndex,
      kind: entry.kind as LoreDialogueLineKindV1,
      ...(speaker !== undefined ? { speaker } : {}),
      text: requireString(entry.text, "lore dialogue line text"),
    };
  });
}

function validateMedia(input: unknown, sceneIndex: number, stageIndex: number): LoreDialogueMediaV1 {
  if (!isRecord(input)) throw new Error(`lore dialogue media ${sceneIndex}:${stageIndex} must be an object`);
  return {
    ...(input.cg !== undefined ? { cg: requireString(input.cg, "lore dialogue media cg") } : {}),
    ...(input.displayName !== undefined ? { displayName: requireString(input.displayName, "lore dialogue media displayName") } : {}),
    ...(input.href !== undefined ? { href: requireString(input.href, "lore dialogue media href") } : {}),
  };
}

function stringArray(input: unknown, field: string): readonly string[] {
  if (!Array.isArray(input) || input.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return input;
}

function requireString(input: unknown, field: string): string {
  if (typeof input !== "string" || input.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  return input;
}

function requireBoolean(input: unknown, field: string): boolean {
  if (typeof input !== "boolean") throw new Error(`${field} must be a boolean`);
  return input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

const PERSONA_SPEAKER_ALIASES: Record<string, readonly string[]> = {
  elysia: ["爱莉希雅", "爱莉希雅（？）", "真我的英桀，爱莉希雅"],
  mobius: ["梅比乌斯", "梅比乌斯（?）", "曾经的梅比乌斯", "无限的英桀，梅比乌斯", "无限的蛇主"],
};

// This is a separate in-world character in the imported transcript, not an
// alias for the playable Elysia persona. Keep it out of both entry and voice
// attribution even when a local config happens to use that display name.
const NON_PERSONA_SPEAKER_LABELS = new Set(["妖精爱莉"]);

/**
 * Resolve transcript labels from the stable persona id, while retaining a
 * configured display name for custom/localized catalogs.
 */
export function dialogueSpeakerAliases(
  displayName: string,
  personaId?: string,
): readonly string[] {
  const knownDisplayNameAliases = Object.values(PERSONA_SPEAKER_ALIASES)
    .find((aliases) => aliases.includes(displayName)) ?? [];
  const displayNameBelongsToAnotherPersona = personaId !== undefined && Object.entries(PERSONA_SPEAKER_ALIASES)
    .some(([knownPersonaId, aliases]) => knownPersonaId !== personaId && aliases.includes(displayName));
  const aliasesForDisplayName = displayNameBelongsToAnotherPersona ? [] : knownDisplayNameAliases;
  const displayNameAlias = NON_PERSONA_SPEAKER_LABELS.has(displayName) || displayNameBelongsToAnotherPersona
    ? []
    : [displayName];
  return [...new Set([
    ...(personaId !== undefined ? PERSONA_SPEAKER_ALIASES[personaId] ?? [] : []),
    ...aliasesForDisplayName,
    ...displayNameAlias,
  ])];
}

export function dialogueLinesForSpeaker(
  scene: LoreDialogueSceneV1,
  speakerAliases: readonly string[],
): readonly LoreDialogueLineV1[] {
  const aliases = new Set(speakerAliases);
  const lines = scene.stages.flatMap((stage) => stage.lines);
  const firstVisibleIndex = lines.findIndex((line) => line.speaker !== undefined && aliases.has(line.speaker));
  if (firstVisibleIndex < 0) return [];

  // The importer preserves actor labels, but the source site also labels
  // private parenthetical thoughts as dialogue. They are not audible scene
  // context: keep the character's own thoughts as voice evidence, while
  // removing another speaker's private thoughts from the character-visible
  // projection. A later speaker must not become an accidental mind-reading
  // channel merely because the scene continues after the character leaves.
  return lines.slice(firstVisibleIndex).filter((line) => (
    !isPrivateThought(line.text) || (line.speaker !== undefined && aliases.has(line.speaker))
  ));
}

function isPrivateThought(text: string): boolean {
  const trimmed = text.trim();
  return (trimmed.startsWith("（") && trimmed.endsWith("）")) ||
    (trimmed.startsWith("(") && trimmed.endsWith(")"));
}
