import test from "node:test";
import assert from "node:assert/strict";

import {
  parseReflectionInsights,
  buildReflectionMessages,
} from "../src/reflection/llmReflectionPlanner.js";
import type { MemoryRecord } from "../src/memory/memoryRecords.js";
import { SELF_CONCEPT_PROPOSAL_SCHEMA_VERSION } from "../src/selfConcept/selfConceptRecords.js";

const NOW = "2026-08-23T12:00:00.000Z";
const evidence: MemoryRecord[] = [{
  id: "m1",
  agentId: "agent_elysia",
  kind: "conversation",
  content: "主人记得我们的约定。",
  createdAt: NOW,
  lastAccessedAt: NOW,
  importance: 6,
  sourceIds: ["user_master"],
  relatedMemoryIds: [],
  visibility: "private",
  tags: [],
  metadata: {},
}];

const input = {
  agentId: "agent_elysia",
  trigger: { kind: "scheduled" as const, reason: "night", now: NOW, sourceIds: ["agent_elysia"] },
  evidence,
};

test("reflection envelope preserves valid insights and parses self-concept proposal", () => {
  const result = parseReflectionInsights(JSON.stringify({
    insights: [{ content: "我开始珍惜共同经历。", evidenceIds: ["m1"], importance: 7 }],
    selfConceptProposal: {
      schemaVersion: SELF_CONCEPT_PROPOSAL_SCHEMA_VERSION,
      proposalId: "night_1",
      expectedRevision: 0,
      summary: "我开始理解自己珍惜共同经历。",
      sourceMemoryIds: ["m1"],
      beliefs: [{ beliefId: "b1", statement: "我会珍惜约定。", sourceMemoryIds: ["m1"] }],
    },
  }), input, 3);
  assert.equal(result.insights.length, 1);
  assert.equal(result.selfConceptProposal?.expectedRevision, 0);
  assert.equal(result.selfConceptProposalError, undefined);
});

test("invalid self-concept proposal does not discard valid reflection insights", () => {
  const result = parseReflectionInsights(JSON.stringify({
    insights: [{ content: "我开始珍惜共同经历。", evidenceIds: ["m1"], importance: 7 }],
    selfConceptProposal: { proposalId: "bad", expectedRevision: 0 },
  }), input, 3);
  assert.equal(result.insights.length, 1);
  assert.equal(result.selfConceptProposal, undefined);
  assert.equal(result.selfConceptProposalError, "invalid_self_concept_proposal");
});

test("reflection prompt limits self-concept proposal production to the reflection envelope", () => {
  const messages = buildReflectionMessages(input, 3, {});
  assert.match(messages.system, /selfConceptProposal/);
  assert.match(messages.system, /sourceMemoryIds are provenance references/);
});
