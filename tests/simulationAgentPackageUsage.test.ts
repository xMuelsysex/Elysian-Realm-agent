import test from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryMemoryStore,
  SimulationAgentRuntime,
  type MemoryRetrievalHit,
  type MemoryRetrievalQuery,
  type MemoryWrite,
  type ReflectionPlanner,
} from "@elysian/simulation-agent";

const AGENT_ID = "agent_demo";
const NOW = "2026-07-04T10:00:00.000Z";
const REFLECTION_TIME = "2026-07-04T10:30:00.000Z";

interface ExampleMetadata {
  topic?: string;
}

interface ExamplePerception {
  agentId: string;
  now: string;
  eventId: string;
  observation: string;
}

interface ExampleProposal {
  kind: "visit";
  summary: string;
  evidenceMemoryIds: readonly string[];
}

type ExampleHit = MemoryRetrievalHit<ExampleMetadata>;
type ExampleWrite = MemoryWrite<ExampleMetadata>;

test("package usage example composes runtime tick memory and explicit reflection through the public API", async () => {
  const store = new InMemoryMemoryStore<ExampleMetadata>();
  store.remember(AGENT_ID, {
    id: "memory_garden",
    kind: "observation",
    content: "The agent noticed a quiet garden conversation.",
    createdAt: "2026-07-04T09:00:00.000Z",
    importance: 5,
    sourceIds: ["event_garden"],
    tags: ["garden", "quiet"],
    metadata: { topic: "observation" },
  });

  const submitted: ExampleProposal[] = [];
  const runtime = new SimulationAgentRuntime<
    ExamplePerception,
    MemoryRetrievalQuery,
    ExampleHit,
    ExampleWrite,
    ExampleProposal,
    ExampleMetadata
  >(
    {
      perception: {
        perceive: (agentId, now) => ({
          agentId,
          now,
          eventId: "event_current_garden",
          observation: "The garden is quiet again.",
        }),
      },
      memory: store.toPort(),
      planning: {
        plan: ({ memories }) => ({
          source: "deterministic",
          reason: `retrieved ${memories.length} relevant memory hit(s)`,
          proposal: {
            kind: "visit",
            summary: "Visit the garden gently.",
            evidenceMemoryIds: memories.map((hit) => hit.record.id),
          },
        }),
      },
      actionSink: {
        submit: (_agentId, proposal) => {
          submitted.push(proposal);
        },
      },
      buildMemoryQuery: (perception) => ({
        text: perception.observation,
        now: perception.now,
        topK: 3,
      }),
      buildMemoryWrite: (perception, plan) => ({
        kind: "plan",
        content: `Plan created from observation: ${perception.observation}`,
        createdAt: perception.now,
        importance: 4,
        sourceIds: [perception.eventId],
        relatedMemoryIds: plan.proposal?.evidenceMemoryIds ?? [],
        tags: ["plan", "garden"],
        metadata: { topic: "plan" },
      }),
      reflectionMemory: store,
    },
    { persistReflectionWrites: true },
  );

  const tick = runtime.tickSync(AGENT_ID, NOW);

  assert.equal(tick.agentId, AGENT_ID);
  assert.equal(tick.proposal?.kind, "visit");
  assert.deepEqual(submitted, [tick.proposal]);
  assert.equal(store.list(AGENT_ID).filter((record) => record.kind === "plan").length, 1);

  const evidence = store.retrieve(AGENT_ID, {
    text: "garden quiet plan",
    now: REFLECTION_TIME,
    topK: 3,
  }).hits;
  const planner: ReflectionPlanner<ExampleMetadata, ExampleMetadata> = {
    reflect: (input) => ({
      source: "deterministic",
      reason: "The evidence repeats a garden preference pattern.",
      insights: [
        {
          content: "The agent may prefer gentle visits when the garden is quiet.",
          evidenceMemoryIds: input.evidence.map((memory) => memory.id),
          importance: 6,
          tags: ["reflection", "garden"],
          metadata: { topic: "reflection" },
        },
      ],
    }),
  };

  const reflection = await runtime.reflect(
    {
      agentId: AGENT_ID,
      trigger: {
        kind: "scheduled",
        reason: "Daily reflection window.",
        now: REFLECTION_TIME,
        sourceIds: ["event_reflection_window"],
      },
      evidence: evidence.map((hit) => hit.record),
    },
    planner,
  );

  assert.equal(reflection.status, "completed");
  assert.equal(reflection.persistedRecords.length, 1);
  assert.equal(reflection.persistedRecords[0]?.kind, "reflection");
  assert.deepEqual(
    reflection.persistedRecords[0]?.relatedMemoryIds,
    evidence.map((hit) => hit.record.id),
  );
  assert.equal(store.list(AGENT_ID).filter((record) => record.kind === "reflection").length, 1);
});
