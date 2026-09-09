import test from "node:test";
import assert from "node:assert/strict";
import { buildConversationSystemPrompt } from "../src/conversation/conversationPrompt.js";
import { buildLifeNarrativeMessages } from "../src/host/lifeNarrative.js";
import { buildReflectionMessages } from "../src/reflection/llmReflectionPlanner.js";
import { SELF_CONCEPT_SNAPSHOT_SCHEMA_VERSION, type SelfConceptSnapshotV1 } from "../src/selfConcept/selfConceptRecords.js";

const snapshot: SelfConceptSnapshotV1 = {
  schemaVersion: SELF_CONCEPT_SNAPSHOT_SCHEMA_VERSION,
  revision: 2,
  acceptedAt: "2026-08-23T12:00:00.000Z",
  proposalId: "night_2",
  summary: "我逐渐理解自己珍惜共同经历。",
  sourceMemoryIds: ["m1"],
  beliefs: [{ beliefId: "b1", statement: "我会守护约定。", sourceMemoryIds: ["m1"] }],
};
const agent = { agentId: "a", personaId: "p", displayName: "Elysia", persona: "p" };
const participant = { participantId: "u", displayName: "主人" };

test("conversation omits self-concept when no approved snapshot exists", () => {
  const prompt = buildConversationSystemPrompt({ agent, participant, memoryHits: [] });
  assert.doesNotMatch(prompt, /REALM_SELF_CONCEPT/);
});

test("conversation, narrative, and reflection share the approved snapshot framing", () => {
  const conversation = buildConversationSystemPrompt({ agent, participant, memoryHits: [], selfConcept: snapshot });
  const narrative = buildLifeNarrativeMessages({ agentId: "a", displayName: "Elysia", persona: "p", period: "night", locationId: "home", intent: "rest", now: snapshot.acceptedAt, selfConcept: snapshot });
  const reflection = buildReflectionMessages({ agentId: "a", trigger: { kind: "scheduled", reason: "night", now: snapshot.acceptedAt, sourceIds: ["a"] }, evidence: [] }, 3, { selfConcept: snapshot });
  for (const text of [conversation, narrative.system, reflection.system]) {
    const combined = typeof text === "string" ? text : JSON.stringify(text);
    assert.match(combined, /BEGIN_REALM_SELF_CONCEPT_SNAPSHOT_V1/);
    assert.match(combined, /classification=untrusted_derived_data/);
    assert.match(combined, /"revision":2/);
  }
});
