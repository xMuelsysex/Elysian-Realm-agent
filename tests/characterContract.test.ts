import test from "node:test";
import assert from "node:assert/strict";

import {
  personaSections,
  buildConversationSystemPrompt,
} from "../src/conversation/conversationPrompt.js";
import { RealmStateStore } from "../src/host/realmState.js";
import { buildLifeNarrativeMessages } from "../src/host/lifeNarrative.js";
import { buildReflectionMessages } from "../src/reflection/llmReflectionPlanner.js";
import type { RealmStructuredPersonaV1 } from "../src/service/realmConversationV1.js";
import { validateRealmConversationRequestV1 } from "../src/service/realmConversationExecutor.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STRUCTURED: RealmStructuredPersonaV1 = {
  identity: "爱莉希雅，往世乐土逐火十三英桀中的「粉色妖精小姐」。",
  personality: "开朗俏皮，真诚地喜欢眼前的人。",
  values: "珍惜约定与共同经历，相信美好值得守护。",
  speechStyle: "说话轻快带点小狡黠，偶尔以「♪」结尾。",
  boundaries: ["始终保持爱莉希雅的开朗温柔，不脱离往世乐土世界观。"],
  behaviorTraits: ["外向：会主动提起花园、诗集等日常话题。"],
  exampleLines: ["「今天的花开得特别好哦♪」"],
};

const LEGACY_TEXT = "爱莉希雅，乐园的粉色妖精小姐♪ 开朗俏皮。";

// ── personaSections：结构化分块 ─────────────────────────────────────────

test("personaSections renders every structured facet as its own section", () => {
  const sections = personaSections(STRUCTURED);
  assert.ok(sections.some((s) => s === `Identity:\n${STRUCTURED.identity}`));
  assert.ok(sections.some((s) => s === `Personality:\n${STRUCTURED.personality}`));
  assert.ok(sections.some((s) => s === `Values:\n${STRUCTURED.values}`));
  assert.ok(sections.some((s) => s === `Speech style:\n${STRUCTURED.speechStyle}`));
  assert.ok(sections.some((s) => s.includes("Character boundaries (never break these):")));
  assert.ok(sections.some((s) => s.includes("- 始终保持爱莉希雅的开朗温柔")));
  assert.ok(sections.some((s) => s.includes("Behavior tendencies:")));
  assert.ok(sections.some((s) => s.includes("- 外向：会主动提起花园")));
  assert.ok(sections.some((s) => s.includes("Speech examples (match this voice):")));
  assert.ok(sections.some((s) => s.includes("- 「今天的花开得特别好哦♪」")));
});

test("personaSections keeps the legacy single-section shape for plain text", () => {
  assert.deepEqual(personaSections(LEGACY_TEXT), [`Persona:\n${LEGACY_TEXT}`]);
});

test("personaSections tolerates absent optional arrays (validation default)", () => {
  const partial: RealmStructuredPersonaV1 = {
    identity: "id",
    personality: "p",
    values: "v",
    speechStyle: "s",
    boundaries: [],
    behaviorTraits: [],
    exampleLines: [],
  };
  const sections = personaSections(partial);
  assert.equal(sections.length, 4);
  assert.ok(!sections.join("\n").includes("Character boundaries"));
});

test("system prompt injects structured sections and stays in character", () => {
  const prompt = buildConversationSystemPrompt({
    agent: { agentId: "agent_elysia", personaId: "elysia", displayName: "爱莉希雅", persona: STRUCTURED },
    participant: { participantId: "user_master", displayName: "主人" },
    memoryHits: [],
  });
  assert.match(prompt, /Identity:\n爱莉希雅，往世乐土逐火十三英桀/);
  assert.match(prompt, /Speech style:\n说话轻快带点小狡黠/);
  assert.match(prompt, /Character boundaries \(never break these\):/);
  assert.match(prompt, /Stay in character as 爱莉希雅/);
});

// ── realm.json：结构化 persona 校验 ────────────────────────────────────

test("realm config accepts structured persona and rejects broken ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "elysian-persona-"));
  const good = {
    user: { participantId: "user_master", displayName: "主人" },
    agents: [
      {
        agentId: "agent_elysia",
        personaId: "elysia",
        displayName: "爱莉希雅",
        persona: STRUCTURED,
        routines: [],
      },
    ],
  };
  writeFileSync(join(dir, "realm.json"), JSON.stringify(good));
  const store = new RealmStateStore(dir);
  assert.deepEqual(store.agent("agent_elysia").persona, STRUCTURED);

  const missingFacet = {
    ...good,
    agents: [
      {
        ...good.agents[0],
        persona: { identity: "only" },
      },
    ],
  };
  writeFileSync(join(dir, "realm.json"), JSON.stringify(missingFacet));
  assert.throws(() => new RealmStateStore(dir), /persona\.personality/);

  const brokenArray = {
    ...good,
    agents: [
      {
        ...good.agents[0],
        persona: { ...STRUCTURED, boundaries: "not-an-array" },
      },
    ],
  };
  writeFileSync(join(dir, "realm.json"), JSON.stringify(brokenArray));
  assert.throws(() => new RealmStateStore(dir), /persona\.boundaries/);
});

// ── conversation executor：结构化 persona 透传校验 ──────────────────────

test("conversation validator accepts structured persona and rejects broken one", () => {
  const ok = validateRealmConversationRequestV1({
    schemaVersion: "realm-conversation.v1",
    conversationId: "c1",
    now: "2026-07-26T20:30:00.000Z",
    agent: { agentId: "a1", personaId: "elysia", displayName: "爱莉希雅", persona: STRUCTURED },
    participant: { participantId: "u", displayName: "主人" },
    memories: [],
    history: [],
    message: { messageId: "m1", content: "hi" },
  });
  assert.deepEqual(ok.agent.persona, STRUCTURED);

  assert.throws(
    () =>
      validateRealmConversationRequestV1({
        schemaVersion: "realm-conversation.v1",
        conversationId: "c1",
        now: "2026-07-26T20:30:00.000Z",
        agent: { agentId: "a1", personaId: "elysia", displayName: "爱莉希雅", persona: { identity: "x" } },
        participant: { participantId: "u", displayName: "主人" },
        memories: [],
        history: [],
        message: { messageId: "m1", content: "hi" },
      }),
    /persona\.personality/,
  );
});

// ── 叙事与反思：结构化 persona 复用 ─────────────────────────────────────

test("life narrative prompt carries structured persona sections", () => {
  const { system } = buildLifeNarrativeMessages({
    agentId: "agent_elysia",
    displayName: "爱莉希雅",
    persona: STRUCTURED,
    period: "morning",
    locationId: "garden",
    intent: "照料向日葵",
    now: "2026-07-26T08:00:00.000Z",
  });
  assert.match(system, /Identity:\n爱莉希雅，往世乐土逐火十三英桀/);
  assert.match(system, /Behavior tendencies:/);
  assert.match(system, /Character boundaries/);
});

test("reflection prompt carries structured persona sections", () => {
  const { system } = buildReflectionMessages(
    {
      agentId: "agent_elysia",
      trigger: { kind: "scheduled", reason: "night", now: "2026-07-26T22:00:00.000Z", sourceIds: [] },
      evidence: [
        {
          id: "e1",
          agentId: "agent_elysia",
          kind: "conversation",
          content: "和主人一起赏花。",
          createdAt: "2026-07-26T10:00:00.000Z",
          importance: 6,
          lastAccessedAt: "2026-07-26T10:00:00.000Z",
          sourceIds: [],
          relatedMemoryIds: [],
          visibility: "private",
          tags: [],
          metadata: {},
        },
      ],
    },
    3,
    { personaName: "爱莉希雅", persona: STRUCTURED },
  );
  assert.match(system, /Identity:\n爱莉希雅，往世乐土逐火十三英桀/);
  assert.match(system, /Values:/);
  assert.match(system, /Character boundaries/);
});
