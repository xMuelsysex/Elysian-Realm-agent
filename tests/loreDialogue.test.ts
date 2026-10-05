import test from "node:test";
import assert from "node:assert/strict";

import { ELYSIAN_REALM_DIALOGUE } from "../src/lore/elysianRealmDialogue.js";
import { renderLoreDialogueContext } from "../src/lore/loreDialoguePrompt.js";
import { retrieveLoreDialogue } from "../src/lore/loreDialogueRetrieval.js";
import { validateLoreDialogueCatalog } from "../src/lore/loreDialogueRecords.js";

test("bundled dialogue snapshot preserves both requested arcs and source diagnostics", () => {
  const catalog = validateLoreDialogueCatalog(ELYSIAN_REALM_DIALOGUE);
  assert.equal(catalog.scenes.length, 608);
  assert.deepEqual(
    catalog.chapters.map((chapter) => [chapter.id, chapter.sceneIds.length]),
    [
      ["er-1", 182],
      ["er-2", 117],
      ["er-3", 91],
      ["mainline-29", 103],
      ["mainline-30", 74],
      ["mainline-31", 41],
    ],
  );
  assert.ok(catalog.scenes.every((scene, index) => scene.order === index));
  assert.ok(catalog.scenes.some((scene) => scene.available && scene.stages.some((stage) => stage.lines.some((line) => line.kind === "dialogue"))));
  assert.equal(catalog.scenes.filter((scene) => !scene.available).length, 3);
  assert.equal(catalog.diagnostics?.length, 3);
});

test("dialogue retrieval enforces cursor and first-speaker visibility", () => {
  const catalog = validateLoreDialogueCatalog(ELYSIAN_REALM_DIALOGUE);
  const firstScene = catalog.scenes[0];
  const beforeEntry = retrieveLoreDialogue(catalog, {
    cursor: firstScene.order,
    speakerAliases: ["？？？"],
    text: "往世乐土",
  });
  assert.equal(beforeEntry.hits.length, 0);

  const hits = retrieveLoreDialogue(catalog, {
    cursor: 1,
    speakerAliases: ["芽衣"],
    text: "往世乐土",
    topK: 1,
  }).hits;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].scene.id, firstScene.id);
  assert.equal(hits[0].lines[0].speaker, "芽衣");
  assert.ok(hits[0].lines.every((line) => line.sourceIndex >= hits[0].lines[0].sourceIndex));

  const rendered = renderLoreDialogueContext(hits);
  assert.match(rendered ?? "", /read-only knowledge/);
  assert.match(rendered ?? "", /active story continuity/);
  assert.match(rendered ?? "", /芽衣:/);
});

test("dialogue retrieval keeps the latest unlocked scene for continuity", () => {
  const catalog = {
    schemaVersion: "lore-dialogue.v1",
    source: "test",
    arcs: [],
    chapters: [],
    scenes: [
      {
        id: "old-scene",
        arcId: "arc",
        chapterId: "chapter",
        order: 0,
        title: "旧场景",
        sourceUrl: "https://example.com/old",
        available: true,
        stages: [{
          id: "old-stage",
          lines: [{ id: "old-line", stageId: "old-stage", sourceIndex: 0, kind: "dialogue", speaker: "角色", text: "旧主题" }],
        }],
      },
      {
        id: "latest-scene",
        arcId: "arc",
        chapterId: "chapter",
        order: 1,
        title: "当前场景",
        sourceUrl: "https://example.com/latest",
        available: true,
        stages: [{
          id: "latest-stage",
          lines: [{ id: "latest-line", stageId: "latest-stage", sourceIndex: 0, kind: "dialogue", speaker: "角色", text: "当前主题" }],
        }],
      },
    ],
  } as const;

  const hits = retrieveLoreDialogue(catalog, {
    cursor: 2,
    speakerAliases: ["角色"],
    text: "旧主题",
    topK: 1,
  }).hits;
  assert.equal(hits[0]?.scene.id, "latest-scene");
});

test("dialogue retrieval excludes locked scenes even when a later query matches", () => {
  const catalog = validateLoreDialogueCatalog(ELYSIAN_REALM_DIALOGUE);
  const hits = retrieveLoreDialogue(catalog, {
    cursor: 1,
    speakerAliases: ["爱莉希雅"],
    text: "终绝之战",
    topK: 4,
  }).hits;
  assert.ok(hits.every((hit) => hit.scene.order < 1));
  assert.ok(hits.every((hit) => !hit.lines.some((line) => line.text.includes("终绝之战"))));
});
