import test from "node:test";
import assert from "node:assert/strict";

import {
  runCognitiveTick,
  runCognitiveTickSync,
  type ActionSink,
  type CognitiveLoopDeps,
  type MemoryPort,
  type PerceptionPort,
  type PhaseDiagnostic,
  type PlanResult,
  type PlanningPort,
} from "@elysian/simulation-agent";

// Fully fake, Elysian-free port set for deterministic loop testing.
interface FakePerception {
  agentId: string;
  now: string;
}
type FakeQuery = { topic: string };
type FakeHit = { id: string };
type FakeWrite = { note: string };
type FakeProposal = { action: string };

const NOW = "2026-06-30T00:00:00.000Z";

function fakePerception(perceive?: PerceptionPort<FakePerception>["perceive"]): PerceptionPort<FakePerception> {
  return { perceive: perceive ?? ((agentId, now) => ({ agentId, now })) };
}

function fakeMemory(hits: readonly FakeHit[] = []): { port: MemoryPort<FakeQuery, FakeHit, FakeWrite>; writes: FakeWrite[] } {
  const writes: FakeWrite[] = [];
  return {
    writes,
    port: {
      retrieve: () => hits,
      remember: (_agentId, write) => {
        writes.push(write);
      },
    },
  };
}

function fakeSink(): { port: ActionSink<FakeProposal>; submitted: Array<{ agentId: string; proposal: FakeProposal }> } {
  const submitted: Array<{ agentId: string; proposal: FakeProposal }> = [];
  return {
    submitted,
    port: { submit: (agentId, proposal) => submitted.push({ agentId, proposal }) },
  };
}

function planningReturning(result: PlanResult<FakeProposal>): PlanningPort<FakePerception, FakeHit, FakeProposal> {
  return { plan: () => result };
}

function buildDeps(overrides: Partial<CognitiveLoopDeps<FakePerception, FakeQuery, FakeHit, FakeWrite, FakeProposal>>): {
  deps: CognitiveLoopDeps<FakePerception, FakeQuery, FakeHit, FakeWrite, FakeProposal>;
  sink: ReturnType<typeof fakeSink>;
  memory: ReturnType<typeof fakeMemory>;
} {
  const sink = fakeSink();
  const memory = fakeMemory();
  const deps: CognitiveLoopDeps<FakePerception, FakeQuery, FakeHit, FakeWrite, FakeProposal> = {
    perception: fakePerception(),
    memory: memory.port,
    planning: planningReturning({ source: "deterministic", proposal: { action: "wait" }, reason: "routine" }),
    actionSink: sink.port,
    buildMemoryQuery: () => ({ topic: "default" }),
    ...overrides,
  };
  return { deps, sink, memory };
}

function phaseStatus(phases: readonly PhaseDiagnostic[], phase: PhaseDiagnostic["phase"]): PhaseDiagnostic {
  const found = phases.find((entry) => entry.phase === phase);
  assert.ok(found, `expected diagnostic for phase ${phase}`);
  return found;
}

test("cognitive loop runs all six phases in order with proposal passthrough", async () => {
  const { deps, sink } = buildDeps({});

  const result = await runCognitiveTick("agent_1", NOW, deps);

  assert.equal(result.agentId, "agent_1");
  assert.deepEqual(
    result.phases.map((entry) => entry.phase),
    ["perceive", "retrieve", "plan", "act", "remember", "reflect"],
  );
  assert.equal(result.phases.length, 6);

  // Deterministic plan hit: proposal passes through to the action sink.
  assert.deepEqual(result.proposal, { action: "wait" });
  assert.equal(sink.submitted.length, 1);
  assert.deepEqual(sink.submitted[0], { agentId: "agent_1", proposal: { action: "wait" } });
  assert.equal(phaseStatus(result.phases, "act").status, "ran");
});

test("remember and reflect are skipped with visible reasons in Phase A", async () => {
  const { deps } = buildDeps({});

  const result = await runCognitiveTick("agent_1", NOW, deps);

  const remember = phaseStatus(result.phases, "remember");
  const reflect = phaseStatus(result.phases, "reflect");
  assert.equal(remember.status, "skipped");
  assert.match(remember.detail, /Phase A/);
  assert.equal(reflect.status, "skipped");
  assert.match(reflect.detail, /Phase A/);
});

test("plan that throws marks plan failed, emits no proposal, and never calls the sink", async () => {
  const { deps, sink } = buildDeps({
    planning: {
      plan: () => {
        throw new Error("planner exploded");
      },
    },
  });

  const result = await runCognitiveTick("agent_1", NOW, deps);

  const plan = phaseStatus(result.phases, "plan");
  assert.equal(plan.status, "failed");
  assert.match(plan.detail, /planner exploded/);
  assert.equal(result.proposal, undefined);
  assert.equal(sink.submitted.length, 0);

  // Downstream phases are visibly skipped, not silently dropped.
  for (const phase of ["act", "remember", "reflect"] as const) {
    assert.equal(phaseStatus(result.phases, phase).status, "skipped");
  }
});

test("plan with source skipped leaves act skipped and does not call the sink", async () => {
  const { deps, sink } = buildDeps({
    planning: planningReturning({ source: "skipped", reason: "no active routine" }),
  });

  const result = await runCognitiveTick("agent_1", NOW, deps);

  const act = phaseStatus(result.phases, "act");
  assert.equal(act.status, "skipped");
  assert.match(act.detail, /no active routine/);
  assert.equal(result.proposal, undefined);
  assert.equal(sink.submitted.length, 0);
});

test("malformed plan output marks plan failed and does not call the sink", async () => {
  const { deps, sink } = buildDeps({
    planning: {
      plan: () => ({ source: "llm", reason: "missing proposal" }) as unknown as PlanResult<FakeProposal>,
    },
  });

  const result = await runCognitiveTick("agent_1", NOW, deps);

  const plan = phaseStatus(result.phases, "plan");
  assert.equal(plan.status, "failed");
  assert.match(plan.detail, /must include a proposal/);
  assert.equal(result.proposal, undefined);
  assert.equal(sink.submitted.length, 0);
  assert.equal(phaseStatus(result.phases, "act").status, "skipped");
});

test("sync cognitive tick fails visibly when wired to a rejecting async planner", async () => {
  const { deps, sink } = buildDeps({
    planning: {
      plan: async () => {
        throw new Error("async planner rejected");
      },
    },
  });

  const result = runCognitiveTickSync("agent_1", NOW, deps);
  await Promise.resolve();

  const plan = phaseStatus(result.phases, "plan");
  assert.equal(plan.status, "failed");
  assert.match(plan.detail, /sync cognitive tick received an async plan result/);
  assert.equal(result.proposal, undefined);
  assert.equal(sink.submitted.length, 0);
  assert.equal(phaseStatus(result.phases, "act").status, "skipped");
});

test("perceive failure aborts the tick with all later phases skipped", async () => {
  const { deps, sink } = buildDeps({
    perception: fakePerception(() => {
      throw new Error("sensor offline");
    }),
  });

  const result = await runCognitiveTick("agent_1", NOW, deps);

  assert.equal(phaseStatus(result.phases, "perceive").status, "failed");
  assert.match(phaseStatus(result.phases, "perceive").detail, /sensor offline/);
  for (const phase of ["retrieve", "plan", "act", "remember", "reflect"] as const) {
    assert.equal(phaseStatus(result.phases, phase).status, "skipped");
  }
  assert.equal(result.proposal, undefined);
  assert.equal(sink.submitted.length, 0);
});

test("buildMemoryWrite hook records a memory write and marks remember ran", async () => {
  const { deps, memory } = buildDeps({
    buildMemoryWrite: () => ({ note: "observed routine" }),
  });

  const result = await runCognitiveTick("agent_1", NOW, deps);

  assert.equal(phaseStatus(result.phases, "remember").status, "ran");
  assert.deepEqual(memory.writes, [{ note: "observed routine" }]);
});
