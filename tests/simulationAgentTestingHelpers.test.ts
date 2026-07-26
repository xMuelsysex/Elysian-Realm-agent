import test from "node:test";
import assert from "node:assert/strict";

import {
  createActionCollector,
  createMemoryPortStub,
  createStaticPerceptionPort,
  createStaticPlanningPort,
  runCognitiveTickSync,
  type PhaseDiagnostic,
} from "@elysian/simulation-agent";

const NOW = "2026-07-04T11:00:00.000Z";

interface TestPerception {
  agentId: string;
  now: string;
  eventId: string;
  text: string;
}

interface TestQuery {
  text: string;
}

interface TestHit {
  id: string;
  content: string;
}

interface TestWrite {
  content: string;
  sourceId: string;
}

interface TestProposal {
  id: string;
  memoryIds: readonly string[];
}

function phase(phases: readonly PhaseDiagnostic[], name: PhaseDiagnostic["phase"]): PhaseDiagnostic {
  const found = phases.find((entry) => entry.phase === name);
  assert.ok(found, `expected ${name} phase`);
  return found;
}

test("testing helpers compose deterministic ports with the sync cognitive loop", () => {
  const memory = createMemoryPortStub<TestQuery, TestHit, TestWrite>({
    hits: [{ id: "memory_1", content: "Garden context" }],
  });
  const actions = createActionCollector<TestProposal>();

  const result = runCognitiveTickSync("agent_1", NOW, {
    perception: createStaticPerceptionPort<TestPerception>((agentId, now) => ({
      agentId,
      now,
      eventId: "event_1",
      text: "Garden is quiet.",
    })),
    memory: memory.port,
    planning: createStaticPlanningPort<TestPerception, TestHit, TestProposal>(({ memories }) => ({
      source: "deterministic",
      reason: "testing helper proposal",
      proposal: {
        id: "proposal_1",
        memoryIds: memories.map((hit) => hit.id),
      },
    })),
    actionSink: actions.actionSink,
    buildMemoryQuery: (perception) => ({ text: perception.text }),
    buildMemoryWrite: (perception) => ({
      content: `Remembered ${perception.text}`,
      sourceId: perception.eventId,
    }),
  });

  assert.equal(result.proposal?.id, "proposal_1");
  assert.deepEqual(actions.records(), [{ agentId: "agent_1", proposal: result.proposal }]);
  assert.deepEqual(actions.proposals(), [result.proposal]);
  assert.deepEqual(memory.retrievals(), [{ agentId: "agent_1", query: { text: "Garden is quiet." } }]);
  assert.deepEqual(memory.writes(), [
    { agentId: "agent_1", write: { content: "Remembered Garden is quiet.", sourceId: "event_1" } },
  ]);
  assert.equal(phase(result.phases, "remember").status, "ran");

  const recordsBeforeClear = actions.records();
  actions.clear();
  memory.clear();

  assert.equal(recordsBeforeClear.length, 1);
  assert.deepEqual(actions.records(), []);
  assert.deepEqual(memory.retrievals(), []);
  assert.deepEqual(memory.writes(), []);
});

test("testing helpers support skipped plans and replaceable memory hits", () => {
  const memory = createMemoryPortStub<TestQuery, TestHit, TestWrite>();
  memory.setHits((agentId, query) => [{ id: `${agentId}:${query.text}`, content: "Factory hit" }]);
  const actions = createActionCollector<TestProposal>();

  const result = runCognitiveTickSync("agent_2", NOW, {
    perception: createStaticPerceptionPort<TestPerception>({
      agentId: "agent_2",
      now: NOW,
      eventId: "event_2",
      text: "No action needed.",
    }),
    memory: memory.port,
    planning: createStaticPlanningPort<TestPerception, TestHit, TestProposal>({
      source: "skipped",
      reason: "test fixture skip",
    }),
    actionSink: actions.actionSink,
    buildMemoryQuery: (perception) => ({ text: perception.text }),
  });

  assert.equal(result.proposal, undefined);
  assert.deepEqual(actions.records(), []);
  assert.deepEqual(memory.retrievals(), [{ agentId: "agent_2", query: { text: "No action needed." } }]);
  assert.equal(phase(result.phases, "act").status, "skipped");
  assert.equal(phase(result.phases, "remember").status, "skipped");
});
