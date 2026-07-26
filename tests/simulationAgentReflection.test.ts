import test from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryMemoryStore,
  runReflection,
  runReflectionSync,
  type MemoryRecord,
  type ReflectionInput,
  type ReflectionPlanner,
} from "@elysian/simulation-agent";

const AGENT_ID = "agent_elysia";
const OTHER_AGENT_ID = "agent_eden";
const NOW = "2026-07-04T12:30:00.000Z";

interface EvidenceMetadata {
  origin: string;
}

interface InsightMetadata {
  theme: string;
}

function evidenceRecords(agentId = AGENT_ID): readonly MemoryRecord<EvidenceMetadata>[] {
  const store = new InMemoryMemoryStore<EvidenceMetadata>();
  store.remember(agentId, {
    id: "memory_garden",
    kind: "observation",
    content: "Elysia noticed Eden returning to the garden after music practice.",
    createdAt: "2026-07-04T09:00:00.000Z",
    importance: 5,
    sourceIds: ["event_garden"],
    tags: ["garden", "music"],
    metadata: { origin: "seed" },
  });
  store.remember(agentId, {
    id: "memory_promise",
    kind: "conversation",
    content: "Elysia promised to check whether Eden wanted a quieter rehearsal.",
    createdAt: "2026-07-04T11:00:00.000Z",
    importance: 7,
    sourceIds: ["event_promise"],
    relatedMemoryIds: ["memory_garden"],
    tags: ["promise"],
    metadata: { origin: "conversation" },
  });
  return store.list(agentId);
}

function reflectionInput(
  overrides: Partial<ReflectionInput<EvidenceMetadata>> = {},
): ReflectionInput<EvidenceMetadata> {
  return {
    agentId: AGENT_ID,
    trigger: {
      kind: "conversation-ended",
      reason: "Summarize evidence after a meaningful conversation.",
      now: NOW,
      sourceIds: ["event_reflection_request"],
    },
    evidence: evidenceRecords(),
    ...overrides,
  };
}

test("valid fake reflection planner creates evidence-linked reflection memory writes", async () => {
  const input = reflectionInput();
  const planner: ReflectionPlanner<EvidenceMetadata, InsightMetadata> = {
    reflect: () => ({
      source: "deterministic",
      reason: "Two memories point to a quiet rehearsal preference.",
      insights: [
        {
          content: "Elysia should remember that Eden may prefer a quieter rehearsal setting.",
          evidenceMemoryIds: ["memory_garden", "memory_promise"],
          importance: 8,
          tags: ["eden", "rehearsal"],
          metadata: { theme: "relationship" },
        },
      ],
    }),
  };

  const result = await runReflection(input, planner);

  assert.equal(result.status, "completed");
  assert.equal(result.memoryWrites.length, 1);
  assert.equal(result.diagnostics[0]?.status, "completed");
  assert.deepEqual(result.diagnostics[0]?.evidenceMemoryIds, ["memory_garden", "memory_promise"]);

  const write = result.memoryWrites[0];
  assert.equal(write?.kind, "reflection");
  assert.equal(write?.createdAt, NOW);
  assert.equal(write?.content, "Elysia should remember that Eden may prefer a quieter rehearsal setting.");
  assert.equal(write?.importance, 8);
  assert.deepEqual(write?.sourceIds, ["event_reflection_request"]);
  assert.deepEqual(write?.relatedMemoryIds, ["memory_garden", "memory_promise"]);
  assert.deepEqual(write?.tags, ["eden", "rehearsal"]);
  assert.deepEqual(write?.metadata, { theme: "relationship" });
});

test("sync reflection planner creates evidence-linked reflection memory writes", () => {
  const input = reflectionInput();
  const planner: ReflectionPlanner<EvidenceMetadata, InsightMetadata> = {
    reflect: () => ({
      source: "deterministic",
      reason: "Sync policy over deterministic evidence.",
      insights: [
        {
          content: "Elysia should carry the quiet rehearsal preference forward.",
          evidenceMemoryIds: ["memory_garden", "memory_promise"],
          importance: 7,
          tags: ["eden", "reflection"],
          metadata: { theme: "sync-policy" },
        },
      ],
    }),
  };

  const result = runReflectionSync(input, planner);

  assert.equal(result.status, "completed");
  assert.equal(result.memoryWrites.length, 1);
  assert.equal(result.memoryWrites[0]?.kind, "reflection");
  assert.deepEqual(result.memoryWrites[0]?.relatedMemoryIds, ["memory_garden", "memory_promise"]);
  assert.deepEqual(result.memoryWrites[0]?.metadata, { theme: "sync-policy" });
});

test("sync reflection fails visibly for async planner misuse", () => {
  const planner: ReflectionPlanner<EvidenceMetadata, InsightMetadata> = {
    reflect: async () => ({
      source: "deterministic",
      reason: "Async planner must use runReflection.",
      insights: [
        {
          content: "This async output should not be accepted by the sync path.",
          evidenceMemoryIds: ["memory_garden"],
          importance: 5,
          metadata: { theme: "async-misuse" },
        },
      ],
    }),
  };

  const result = runReflectionSync(reflectionInput(), planner);

  assert.equal(result.status, "failed");
  assert.equal(result.memoryWrites.length, 0);
  assert.match(result.diagnostics[0]?.message ?? "", /sync reflection received an async planner result/);
});

test("malformed planner output fails visibly and creates no memory writes", async () => {
  const planner = {
    reflect: () => null,
  } as unknown as ReflectionPlanner<EvidenceMetadata, InsightMetadata>;

  const result = await runReflection(reflectionInput(), planner);

  assert.equal(result.status, "failed");
  assert.equal(result.memoryWrites.length, 0);
  assert.match(result.diagnostics[0]?.message ?? "", /plannerOutput must be an object/);
});

test("reflection validation rejects empty insights missing evidence ids and invalid importance", async () => {
  const input = reflectionInput();
  const emptyInsightsPlanner: ReflectionPlanner<EvidenceMetadata, InsightMetadata> = {
    reflect: () => ({
      source: "deterministic",
      reason: "Empty insights should be rejected.",
      insights: [],
    }),
  };
  const invalidInsightPlanner: ReflectionPlanner<EvidenceMetadata, InsightMetadata> = {
    reflect: () => ({
      source: "deterministic",
      reason: "Malformed output should be rejected.",
      insights: [
        {
          content: "This output omits evidence and uses an invalid importance.",
          evidenceMemoryIds: [],
          importance: 12,
          metadata: { theme: "bad-output" },
        },
      ],
    }),
  };

  const emptyInsightsResult = await runReflection(input, emptyInsightsPlanner);
  assert.equal(emptyInsightsResult.status, "failed");
  assert.equal(emptyInsightsResult.memoryWrites.length, 0);
  assert.ok(emptyInsightsResult.diagnostics.some((diagnostic) => diagnostic.message.includes("insights")));

  const result = await runReflection(input, invalidInsightPlanner);

  assert.equal(result.status, "failed");
  assert.equal(result.memoryWrites.length, 0);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("evidenceMemoryIds")));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("importance")));
});

test("unknown evidence memory ids fail visibly", async () => {
  const planner: ReflectionPlanner<EvidenceMetadata, InsightMetadata> = {
    reflect: () => ({
      source: "deterministic",
      reason: "Reference unknown evidence.",
      insights: [
        {
          content: "This should not be accepted because the evidence id is absent.",
          evidenceMemoryIds: ["memory_missing"],
          importance: 4,
          metadata: { theme: "bad-evidence" },
        },
      ],
    }),
  };

  const result = await runReflection(reflectionInput(), planner);

  assert.equal(result.status, "failed");
  assert.equal(result.memoryWrites.length, 0);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.evidenceMemoryIds?.includes("memory_missing")));
});

test("reflection planner errors are visible failures", async () => {
  const planner: ReflectionPlanner<EvidenceMetadata, InsightMetadata> = {
    reflect: async () => {
      throw new Error("fake planner unavailable");
    },
  };

  const result = await runReflection(reflectionInput(), planner);

  assert.equal(result.status, "failed");
  assert.equal(result.memoryWrites.length, 0);
  assert.equal(result.diagnostics[0]?.phase, "planner");
  assert.match(result.diagnostics[0]?.message ?? "", /fake planner unavailable/);
});

test("input validation rejects empty evidence source ids and wrong-agent evidence", async () => {
  const planner: ReflectionPlanner<EvidenceMetadata, InsightMetadata> = {
    reflect: () => ({
      source: "deterministic",
      reason: "Should not be called for invalid input.",
      insights: [],
    }),
  };

  const emptyEvidence = await runReflection(reflectionInput({ evidence: [] }), planner);
  assert.equal(emptyEvidence.status, "failed");
  assert.equal(emptyEvidence.memoryWrites.length, 0);
  assert.ok(emptyEvidence.diagnostics.some((diagnostic) => diagnostic.message.includes("input.evidence")));

  const emptySourceIds = await runReflection(
    reflectionInput({
      trigger: {
        kind: "scheduled",
        reason: "Missing source IDs should fail.",
        now: NOW,
        sourceIds: [],
      },
    }),
    planner,
  );
  assert.equal(emptySourceIds.status, "failed");
  assert.equal(emptySourceIds.memoryWrites.length, 0);
  assert.ok(emptySourceIds.diagnostics.some((diagnostic) => diagnostic.message.includes("sourceIds")));

  const wrongAgentEvidence = await runReflection(reflectionInput({ evidence: evidenceRecords(OTHER_AGENT_ID) }), planner);
  assert.equal(wrongAgentEvidence.status, "failed");
  assert.equal(wrongAgentEvidence.memoryWrites.length, 0);
  assert.ok(wrongAgentEvidence.diagnostics.some((diagnostic) => diagnostic.message.includes("input.agentId")));
});

test("reflection memory writes defensively copy source evidence tags and metadata", async () => {
  const sourceIds = ["event_reflection_request"];
  const evidenceMemoryIds = ["memory_garden"];
  const tags = ["eden"];
  const metadata: InsightMetadata = { theme: "relationship" };
  const input = reflectionInput({
    trigger: {
      kind: "user-requested",
      reason: "Check defensive copies.",
      now: NOW,
      sourceIds,
    },
  });
  const planner: ReflectionPlanner<EvidenceMetadata, InsightMetadata> = {
    reflect: () => ({
      source: "deterministic",
      reason: "Return mutable arrays from the fake planner.",
      insights: [
        {
          content: "Elysia should remember the garden cue.",
          evidenceMemoryIds,
          importance: 6,
          tags,
          metadata,
        },
      ],
    }),
  };

  const result = await runReflection(input, planner);

  sourceIds.push("mutated_source");
  evidenceMemoryIds.push("mutated_evidence");
  tags.push("mutated_tag");
  metadata.theme = "mutated";

  const write = result.memoryWrites[0];
  assert.deepEqual(write?.sourceIds, ["event_reflection_request"]);
  assert.deepEqual(write?.relatedMemoryIds, ["memory_garden"]);
  assert.deepEqual(write?.tags, ["eden"]);
  assert.deepEqual(write?.metadata, { theme: "relationship" });
});
