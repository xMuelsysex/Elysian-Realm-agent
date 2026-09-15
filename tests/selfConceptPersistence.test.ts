import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RealmStateStore } from "../src/host/realmState.js";
import {
  SELF_CONCEPT_PROPOSAL_SCHEMA_VERSION,
  type SelfConceptProposalV1,
} from "../src/selfConcept/selfConceptRecords.js";

const AGENT = "agent_elysia";
const AT = "2026-08-23T12:00:00.000Z";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "elysian-self-concept-"));
}

function proposal(overrides: Partial<SelfConceptProposalV1> = {}): SelfConceptProposalV1 {
  return {
    schemaVersion: SELF_CONCEPT_PROPOSAL_SCHEMA_VERSION,
    proposalId: "night_1",
    expectedRevision: 0,
    summary: "我开始理解自己珍惜共同经历。",
    sourceMemoryIds: ["evidence_1"],
    beliefs: [{ beliefId: "belief_1", statement: "我会珍惜约定。", sourceMemoryIds: ["evidence_1"] }],
    ...overrides,
  };
}

function seedEvidence(store: RealmStateStore): void {
  store.applyMemoryWrites(AGENT, [{
    id: "evidence_1",
    kind: "conversation",
    content: "主人记得我们的约定。",
    createdAt: AT,
    importance: 6,
    sourceIds: ["user_master"],
    visibility: "private",
    tags: ["conversation"],
    metadata: { source: "conversation" },
  }]);
}

test("self-concept snapshot starts absent, applies 0 to 1, and survives restart", () => {
  const dataDir = dir();
  const store = new RealmStateStore(dataDir);
  seedEvidence(store);
  assert.equal(store.getSelfConceptSnapshot(AGENT), undefined);

  const result = store.applySelfConceptProposal(AGENT, proposal(), AT, "attempt_1");
  assert.deepEqual(result, { outcome: "accepted", revision: 1, proposalId: "night_1" });
  assert.equal(store.getSelfConceptSnapshot(AGENT)?.revision, 1);
  assert.equal(store.listSelfConceptAudit(AGENT).map((event) => event.eventType).join(","), "accepted");

  const reopened = new RealmStateStore(dataDir);
  assert.deepEqual(reopened.getSelfConceptSnapshot(AGENT), store.getSelfConceptSnapshot(AGENT));
  assert.equal(reopened.listSelfConceptAudit(AGENT).length, 1);
});

test("stale revision is rejected without changing the snapshot", () => {
  const store = new RealmStateStore(dir());
  seedEvidence(store);
  store.applySelfConceptProposal(AGENT, proposal(), AT, "attempt_1");
  const before = store.getSelfConceptSnapshot(AGENT);
  const result = store.applySelfConceptProposal(
    AGENT,
    proposal({ proposalId: "night_2", expectedRevision: 0 }),
    "2026-08-24T12:00:00.000Z",
    "attempt_2",
  );
  assert.deepEqual(result, {
    outcome: "revision_conflict",
    expectedRevision: 0,
    observedRevision: 1,
    proposalId: "night_2",
  });
  assert.deepEqual(store.getSelfConceptSnapshot(AGENT), before);
  assert.equal(store.listSelfConceptAudit(AGENT).at(-1)?.eventType, "revision_conflict");
});

test("invalid proposals are rejected and audit payload excludes content", () => {
  const store = new RealmStateStore(dir());
  const result = store.applySelfConceptProposal(
    AGENT,
    { ...proposal(), summary: "bad\u0000text" },
    AT,
    "attempt_invalid",
  );
  assert.deepEqual(result, { outcome: "rejected", code: "invalid_text" });
  const event = store.listSelfConceptAudit(AGENT)[0];
  assert.equal(event.eventType, "rejected");
  assert.equal(JSON.stringify(event.payload).includes("bad"), false);
  assert.equal(store.getSelfConceptSnapshot(AGENT), undefined);
});

test("missing source memories produce an evidence-invalid decision without writing a snapshot", () => {
  const store = new RealmStateStore(dir());
  const result = store.applySelfConceptProposal(AGENT, proposal(), AT, "attempt_missing_evidence");
  assert.deepEqual(result, {
    outcome: "evidence_invalid",
    code: "missing_source_memory",
    proposalId: "night_1",
  });
  assert.equal(store.getSelfConceptSnapshot(AGENT), undefined);
  const event = store.listSelfConceptAudit(AGENT)[0];
  assert.equal(event.eventType, "evidence_invalid");
  assert.equal(event.payload.failureClass, "missing_source_memory");
  assert.deepEqual(event.payload.invalidFields, ["sourceMemoryIds:evidence_1"]);
});

test("audit is append-only and attempt reconciliation is idempotent", () => {
  const store = new RealmStateStore(dir());
  store.appendSelfConceptAttemptStarted(AGENT, "attempt_crashed", "night_crashed", AT);
  assert.equal(store.reconcileIncompleteSelfConceptAttempts(AGENT, "2026-08-24T00:00:00.000Z"), 1);
  assert.equal(store.reconcileIncompleteSelfConceptAttempts(AGENT, "2026-08-25T00:00:00.000Z"), 0);
  assert.deepEqual(store.listSelfConceptAudit(AGENT).map((event) => event.eventType), ["attempt_started", "storage_failure"]);
});

test("audit query supports bounded keyset pagination and filters", () => {
  const store = new RealmStateStore(dir());
  store.appendSelfConceptAttemptStarted(AGENT, "a1", undefined, AT);
  store.applySelfConceptProposal(AGENT, { ...proposal(), summary: "bad\u0000text" }, AT, "a2");
  const first = store.listSelfConceptAudit(AGENT, { limit: 1 });
  assert.equal(first.length, 1);
  const rest = store.listSelfConceptAudit(AGENT, { afterEventId: first[0].eventId, limit: 1000 });
  assert.equal(rest.length, 1);
  assert.equal(store.listSelfConceptAudit(AGENT, { eventType: "rejected" }).length, 1);
});
