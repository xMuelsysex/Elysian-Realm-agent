import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmPort } from "../src/ports/ports.js";
import { RealmHost } from "../src/host/realmHost.js";
import { RealmStateStore } from "../src/host/realmState.js";
import { SELF_CONCEPT_PROPOSAL_SCHEMA_VERSION } from "../src/selfConcept/selfConceptRecords.js";

const AGENT = "agent_elysia";
const NIGHT = new Date(2026, 7, 23, 23, 0, 0);
const NOW = NIGHT.toISOString();

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "elysian-self-concept-host-"));
}

function seedEvidence(state: RealmStateStore): void {
  state.applyMemoryWrites(AGENT, [{
    id: "evidence_nightly",
    kind: "conversation",
    content: "主人记得我们的约定。",
    createdAt: NOW,
    importance: 8,
    sourceIds: ["user_master"],
    visibility: "private",
    tags: ["conversation"],
    metadata: { source: "conversation" },
  }]);
}

test("nightly reflection persists valid reflection memory and self-concept snapshot independently", async () => {
  const state = new RealmStateStore(dataDir());
  seedEvidence(state);
  const llm: LlmPort = {
    name: "fake",
    model: "fake",
    completeChat(request) {
      const system = String(request.messages[0]?.content ?? "");
      if (system.includes("Return JSON object")) {
        return Promise.resolve({
          content: JSON.stringify({
            insights: [{ content: "我开始珍惜共同经历。", evidenceIds: ["evidence_nightly"], importance: 7 }],
            selfConceptProposal: {
              schemaVersion: SELF_CONCEPT_PROPOSAL_SCHEMA_VERSION,
              proposalId: "night_1",
              expectedRevision: 0,
              summary: "我开始理解自己珍惜共同经历。",
              sourceMemoryIds: ["evidence_nightly"],
              beliefs: [{ beliefId: "belief_1", statement: "我会珍惜约定。", sourceMemoryIds: ["evidence_nightly"] }],
            },
          }),
        });
      }
      return Promise.resolve({ content: "夜风拂过花园，我想起了我们的约定。" });
    },
  };
  const host = new RealmHost(state, () => undefined, {
    now: () => new Date(NIGHT),
    llm: () => llm,
  });

  const report = await host.tickIfPeriodChanged();
  assert.equal(report?.period, "night");
  assert.ok((report?.reflections ?? 0) >= 1);
  assert.equal(state.getSelfConceptSnapshot(AGENT)?.revision, 1);
  assert.equal(state.getSelfConceptSnapshot(AGENT)?.proposalId, "night_1");
  assert.equal(
    state.memoriesFor(AGENT).filter((memory) => memory.kind === "reflection" && memory.content.includes("我开始珍惜共同经历")).length,
    1,
  );
  assert.deepEqual(
    state.listSelfConceptAudit(AGENT).map((event) => event.eventType),
    ["attempt_started", "accepted"],
  );
});

test("invalid self-concept proposal keeps valid nightly reflection memory", async () => {
  const state = new RealmStateStore(dataDir());
  seedEvidence(state);
  const llm: LlmPort = {
    name: "fake",
    model: "fake",
    completeChat(request) {
      const system = String(request.messages[0]?.content ?? "");
      if (system.includes("Return JSON object")) {
        return Promise.resolve({
          content: JSON.stringify({
            insights: [{ content: "我会记住这次约定。", evidenceIds: ["evidence_nightly"], importance: 6 }],
            selfConceptProposal: { proposalId: "invalid", expectedRevision: 0 },
          }),
        });
      }
      return Promise.resolve({ content: "夜色很安静。" });
    },
  };
  const host = new RealmHost(state, () => undefined, { now: () => new Date(NIGHT), llm: () => llm });  const report = await host.tickIfPeriodChanged();
  assert.ok((report?.reflections ?? 0) >= 1);
  assert.equal(state.getSelfConceptSnapshot(AGENT), undefined);
  assert.equal(state.memoriesFor(AGENT).filter((memory) => memory.kind === "reflection" && memory.content.includes("我会记住这次约定")).length, 1);
  assert.equal(state.listSelfConceptAudit(AGENT)[0]?.eventType, "parse_failure");
});
