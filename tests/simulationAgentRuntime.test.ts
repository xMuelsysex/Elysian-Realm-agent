import test from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryMemoryStore,
  SimulationAgentRuntime,
  type MemoryRetrievalHit,
  type MemoryRetrievalQuery,
  type MemoryWrite,
  type PhaseDiagnostic,
  type PlanningPort,
  type ReflectionInput,
  type ReflectionPlanner,
} from "@elysian/simulation-agent";

const AGENT_ID = "agent_elysia";
const NOW = "2026-07-04T12:30:00.000Z";

interface DemoMetadata {
  theme?: string;
  proposalKind?: string;
}

interface DemoPerception {
  agentId: string;
  now: string;
  eventId: string;
  text: string;
}

interface DemoProposal {
  kind: "check-in";
  targetAgentId: string;
  intent: string;
  evidenceMemoryIds: readonly string[];
}

type DemoHit = MemoryRetrievalHit<DemoMetadata>;
type DemoWrite = MemoryWrite<DemoMetadata>;
type DemoPlanningPort = PlanningPort<DemoPerception, DemoHit, DemoProposal>;

function seedStore(): InMemoryMemoryStore<DemoMetadata> {
  const store = new InMemoryMemoryStore<DemoMetadata>();
  store.remember(AGENT_ID, {
    id: "memory_garden",
    kind: "observation",
    content: "Elysia noticed Eden returning to the garden after music practice.",
    createdAt: "2026-07-04T09:00:00.000Z",
    importance: 5,
    sourceIds: ["event_garden"],
    tags: ["garden", "music", "eden"],
    metadata: { theme: "observation" },
  });
  store.remember(AGENT_ID, {
    id: "memory_promise",
    kind: "conversation",
    content: "Elysia promised to check whether Eden wanted a quieter rehearsal.",
    createdAt: "2026-07-04T11:00:00.000Z",
    importance: 7,
    sourceIds: ["event_promise"],
    relatedMemoryIds: ["memory_garden"],
    tags: ["promise", "eden", "rehearsal"],
    metadata: { theme: "conversation" },
  });
  return store;
}

function createRuntime(
  options: {
    persistReflectionWrites?: boolean;
    includeReflectionMemory?: boolean;
    planning?: DemoPlanningPort;
  } = {},
): {
  runtime: SimulationAgentRuntime<
    DemoPerception,
    MemoryRetrievalQuery,
    DemoHit,
    DemoWrite,
    DemoProposal,
    DemoMetadata
  >;
  store: InMemoryMemoryStore<DemoMetadata>;
  submittedActions: Array<{ agentId: string; proposal: DemoProposal }>;
} {
  const store = seedStore();
  const submittedActions: Array<{ agentId: string; proposal: DemoProposal }> = [];
  const runtime = new SimulationAgentRuntime<
    DemoPerception,
    MemoryRetrievalQuery,
    DemoHit,
    DemoWrite,
    DemoProposal,
    DemoMetadata
  >(
    {
      perception: {
        perceive: (agentId, now) => ({
          agentId,
          now,
          eventId: "event_eden_quiet_after_rehearsal",
          text: "Eden is quiet after rehearsal and walks back toward the garden.",
        }),
      },
      memory: store.toPort(),
      planning: options.planning ?? {
        plan: ({ memories }) => ({
          source: "deterministic",
          reason: `retrieved ${memories.length} relevant memories about Eden`,
          proposal: {
            kind: "check-in",
            targetAgentId: "agent_eden",
            intent: "Ask whether Eden wants a quieter rehearsal setting.",
            evidenceMemoryIds: memories.map((hit) => hit.record.id),
          },
        }),
      },
      actionSink: {
        submit: (agentId, proposal) => {
          submittedActions.push({ agentId, proposal });
        },
      },
      buildMemoryQuery: (perception) => ({
        text: perception.text,
        now: perception.now,
        topK: 2,
        weights: { relevance: 0.6, recency: 0.1, importance: 0.3 },
      }),
      buildMemoryWrite: (perception, plan) => ({
        kind: "plan",
        content: `Plan proposed after seeing: ${perception.text}`,
        createdAt: perception.now,
        importance: 4,
        sourceIds: [perception.eventId],
        relatedMemoryIds: plan.proposal?.evidenceMemoryIds ?? [],
        tags: ["plan", "eden", "rehearsal"],
        metadata: { proposalKind: plan.proposal?.kind },
      }),
      reflectionMemory: options.includeReflectionMemory === false ? undefined : store,
    },
    { persistReflectionWrites: options.persistReflectionWrites },
  );
  return { runtime, store, submittedActions };
}

function reflectionInput(evidence: readonly DemoHit[] | readonly { record: DemoHit["record"] }[]): ReflectionInput<DemoMetadata> {
  return {
    agentId: AGENT_ID,
    trigger: {
      kind: "conversation-ended",
      reason: "Synthesize evidence after the check-in proposal.",
      now: "2026-07-04T12:45:00.000Z",
      sourceIds: ["event_reflection_request"],
    },
    evidence: evidence.map((hit) => hit.record),
  };
}

function reflectionPlanner(): ReflectionPlanner<DemoMetadata, DemoMetadata> {
  return {
    reflect: (input) => ({
      source: "deterministic",
      reason: "Evidence repeatedly links Eden, rehearsal, and quiet garden context.",
      insights: [
        {
          content: "Elysia infers that Eden may prefer being approached gently after rehearsal.",
          evidenceMemoryIds: input.evidence.map((memory) => memory.id),
          importance: 8,
          tags: ["eden", "rehearsal", "garden"],
          metadata: { theme: "relationship-preference" },
        },
      ],
    }),
  };
}

function phaseStatus(phases: readonly PhaseDiagnostic[], phase: PhaseDiagnostic["phase"]): PhaseDiagnostic {
  const found = phases.find((entry) => entry.phase === phase);
  assert.ok(found, `expected diagnostic for phase ${phase}`);
  return found;
}

test("runtime tick delegates to the cognitive loop and records memory through the configured store", async () => {
  const { runtime, store, submittedActions } = createRuntime();

  const result = await runtime.tick(AGENT_ID, NOW);

  assert.equal(result.agentId, AGENT_ID);
  assert.equal(phaseStatus(result.phases, "perceive").status, "ran");
  assert.equal(phaseStatus(result.phases, "retrieve").status, "ran");
  assert.equal(phaseStatus(result.phases, "plan").status, "ran");
  assert.equal(phaseStatus(result.phases, "act").status, "ran");
  assert.equal(phaseStatus(result.phases, "remember").status, "ran");
  assert.equal(phaseStatus(result.phases, "reflect").status, "skipped");
  assert.deepEqual(result.proposal, submittedActions[0]?.proposal);
  assert.equal(submittedActions[0]?.proposal.kind, "check-in");

  const records = store.list(AGENT_ID);
  assert.equal(records.length, 3);
  const planMemory = records.find((record) => record.kind === "plan");
  assert.ok(planMemory);
  assert.deepEqual(planMemory.relatedMemoryIds, submittedActions[0]?.proposal.evidenceMemoryIds);
});

test("runtime tickSync delegates to the sync cognitive loop and records memory through the configured store", () => {
  const { runtime, store, submittedActions } = createRuntime();

  const result = runtime.tickSync(AGENT_ID, NOW);

  assert.equal(result.agentId, AGENT_ID);
  assert.equal(phaseStatus(result.phases, "perceive").status, "ran");
  assert.equal(phaseStatus(result.phases, "retrieve").status, "ran");
  assert.equal(phaseStatus(result.phases, "plan").status, "ran");
  assert.equal(phaseStatus(result.phases, "act").status, "ran");
  assert.equal(phaseStatus(result.phases, "remember").status, "ran");
  assert.equal(phaseStatus(result.phases, "reflect").status, "skipped");
  assert.deepEqual(result.proposal, submittedActions[0]?.proposal);

  const planMemory = store.list(AGENT_ID).find((record) => record.kind === "plan");
  assert.ok(planMemory);
  assert.deepEqual(planMemory.relatedMemoryIds, submittedActions[0]?.proposal.evidenceMemoryIds);
});

test("runtime tickSync exposes async-planner misuse as a failed diagnostic", () => {
  const { runtime, submittedActions } = createRuntime({
    planning: {
      plan: async () => ({
        source: "deterministic",
        reason: "async planner should use runtime.tick",
        proposal: {
          kind: "check-in",
          targetAgentId: "agent_eden",
          intent: "This async proposal must not be accepted by tickSync.",
          evidenceMemoryIds: [],
        },
      }),
    },
  });

  const result = runtime.tickSync(AGENT_ID, NOW);

  assert.equal(result.proposal, undefined);
  assert.deepEqual(submittedActions, []);
  const plan = phaseStatus(result.phases, "plan");
  assert.equal(plan.status, "failed");
  assert.match(plan.detail, /sync cognitive tick received an async plan result/);
  assert.equal(phaseStatus(result.phases, "act").status, "skipped");
});

test("runtime reflection dry-run returns candidate writes without persisting them", async () => {
  const { runtime, store } = createRuntime();
  const evidence = store.retrieve(AGENT_ID, {
    text: "Eden garden quiet rehearsal",
    now: NOW,
    topK: 2,
  }).hits;
  const beforeCount = store.list(AGENT_ID).length;

  const result = await runtime.reflect(reflectionInput(evidence), reflectionPlanner());

  assert.equal(result.status, "completed");
  assert.equal(result.memoryWrites.length, 1);
  assert.deepEqual(result.persistedRecords, []);
  assert.equal(store.list(AGENT_ID).length, beforeCount);
});

test("runtime reflection persists completed writes when configured", async () => {
  const { runtime, store } = createRuntime({ persistReflectionWrites: true });
  const evidence = store.retrieve(AGENT_ID, {
    text: "Eden garden quiet rehearsal",
    now: NOW,
    topK: 2,
  }).hits;

  const result = await runtime.reflect(reflectionInput(evidence), reflectionPlanner());

  assert.equal(result.status, "completed");
  assert.equal(result.memoryWrites.length, 1);
  assert.equal(result.persistedRecords.length, 1);
  assert.equal(result.persistedRecords[0]?.kind, "reflection");
  assert.deepEqual(result.persistedRecords[0]?.relatedMemoryIds, evidence.map((hit) => hit.record.id));
  assert.equal(store.list(AGENT_ID).filter((record) => record.kind === "reflection").length, 1);
});

test("runtime reflectSync persists completed writes when configured", () => {
  const { runtime, store } = createRuntime({ persistReflectionWrites: true });
  const evidence = store.retrieve(AGENT_ID, {
    text: "Eden garden quiet rehearsal",
    now: NOW,
    topK: 2,
  }).hits;

  const result = runtime.reflectSync(reflectionInput(evidence), reflectionPlanner());

  assert.equal(result.status, "completed");
  assert.equal(result.memoryWrites.length, 1);
  assert.equal(result.persistedRecords.length, 1);
  assert.equal(result.persistedRecords[0]?.kind, "reflection");
  assert.deepEqual(result.persistedRecords[0]?.relatedMemoryIds, evidence.map((hit) => hit.record.id));
  assert.equal(store.list(AGENT_ID).filter((record) => record.kind === "reflection").length, 1);
});

test("runtime reflectSync fails visibly for async planner misuse", () => {
  const { runtime, store } = createRuntime({ persistReflectionWrites: true });
  const evidence = store.retrieve(AGENT_ID, {
    text: "Eden garden quiet rehearsal",
    now: NOW,
    topK: 2,
  }).hits;
  const beforeCount = store.list(AGENT_ID).length;
  const asyncPlanner: ReflectionPlanner<DemoMetadata, DemoMetadata> = {
    reflect: async () => ({
      source: "deterministic",
      reason: "Async planner should use runtime.reflect.",
      insights: [
        {
          content: "This async output must not be persisted by reflectSync.",
          evidenceMemoryIds: evidence.map((hit) => hit.record.id),
          importance: 5,
          metadata: { theme: "async-misuse" },
        },
      ],
    }),
  };

  const result = runtime.reflectSync(reflectionInput(evidence), asyncPlanner);

  assert.equal(result.status, "failed");
  assert.equal(result.memoryWrites.length, 0);
  assert.deepEqual(result.persistedRecords, []);
  assert.match(result.diagnostics[0]?.message ?? "", /sync reflection received an async planner result/);
  assert.equal(store.list(AGENT_ID).length, beforeCount);
});

test("runtime reflection supports per-call dry-run over a persisting runtime", async () => {
  const { runtime, store } = createRuntime({ persistReflectionWrites: true });
  const evidence = store.retrieve(AGENT_ID, {
    text: "Eden garden quiet rehearsal",
    now: NOW,
    topK: 2,
  }).hits;
  const beforeCount = store.list(AGENT_ID).length;

  const result = await runtime.reflect(reflectionInput(evidence), reflectionPlanner(), { persistWrites: false });

  assert.equal(result.status, "completed");
  assert.equal(result.memoryWrites.length, 1);
  assert.deepEqual(result.persistedRecords, []);
  assert.equal(store.list(AGENT_ID).length, beforeCount);
});

test("runtime reflection failures do not persist fake records", async () => {
  const { runtime, store } = createRuntime({ persistReflectionWrites: true });
  const evidence = store.retrieve(AGENT_ID, {
    text: "Eden garden quiet rehearsal",
    now: NOW,
    topK: 2,
  }).hits;
  const beforeCount = store.list(AGENT_ID).length;
  const malformedPlanner = {
    reflect: () => null,
  } as unknown as ReflectionPlanner<DemoMetadata, DemoMetadata>;
  const throwingPlanner: ReflectionPlanner<DemoMetadata, DemoMetadata> = {
    reflect: () => {
      throw new Error("fake planner unavailable");
    },
  };

  const malformed = await runtime.reflect(reflectionInput(evidence), malformedPlanner);
  const thrown = await runtime.reflect(reflectionInput(evidence), throwingPlanner);

  assert.equal(malformed.status, "failed");
  assert.equal(thrown.status, "failed");
  assert.equal(malformed.memoryWrites.length, 0);
  assert.equal(thrown.memoryWrites.length, 0);
  assert.deepEqual(malformed.persistedRecords, []);
  assert.deepEqual(thrown.persistedRecords, []);
  assert.equal(store.list(AGENT_ID).length, beforeCount);
});

test("runtime reflection persistence fails visibly when no writer is configured", async () => {
  const { runtime, store } = createRuntime({ persistReflectionWrites: true, includeReflectionMemory: false });
  const evidence = store.retrieve(AGENT_ID, {
    text: "Eden garden quiet rehearsal",
    now: NOW,
    topK: 2,
  }).hits;

  const result = await runtime.reflect(reflectionInput(evidence), reflectionPlanner());

  assert.equal(result.status, "failed");
  assert.equal(result.memoryWrites.length, 0);
  assert.deepEqual(result.persistedRecords, []);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("no reflectionMemory writer")));
  assert.equal(store.list(AGENT_ID).filter((record) => record.kind === "reflection").length, 0);
});
