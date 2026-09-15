import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RealmStateStore } from "../src/host/realmState.js";
import { SELF_CONCEPT_PROPOSAL_SCHEMA_VERSION } from "../src/selfConcept/selfConceptRecords.js";

const AGENT = "agent_elysia";
const AT = "2026-08-23T12:00:00.000Z";

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "elysian-self-concept-cas-"));
}

function proposal(id: string, expectedRevision = 0) {
  return {
    schemaVersion: SELF_CONCEPT_PROPOSAL_SCHEMA_VERSION,
    proposalId: id,
    expectedRevision,
    summary: `自我理解 ${id}`,
    sourceMemoryIds: ["evidence"],
    beliefs: [{ beliefId: `belief_${id}`, statement: "我会珍惜约定。", sourceMemoryIds: ["evidence"] }],
  } as const;
}

function seed(state: RealmStateStore): void {
  state.applyMemoryWrites(AGENT, [{
    id: "evidence",
    kind: "conversation",
    content: "约定",
    createdAt: AT,
    importance: 5,
    sourceIds: ["user_master"],
    visibility: "private",
    tags: [],
    metadata: { source: "conversation" },
  }]);
}

test("two state connections accept only one first revision", () => {
  const dir = dataDir();
  const left = new RealmStateStore(dir);
  const right = new RealmStateStore(dir);
  seed(left);
  // Reopen the second connection after the evidence row exists so both have the same evidence view.
  const refreshedRight = new RealmStateStore(dir);
  const first = left.applySelfConceptProposal(AGENT, proposal("left"), AT, "attempt_left");
  const second = refreshedRight.applySelfConceptProposal(AGENT, proposal("right"), AT, "attempt_right");
  assert.equal(first.outcome, "accepted");
  assert.equal(second.outcome, "revision_conflict");
  assert.equal(left.getSelfConceptSnapshot(AGENT)?.revision, 1);
  assert.equal(refreshedRight.getSelfConceptSnapshot(AGENT)?.revision, 1);
});

test("audit update and delete are rejected by database triggers", () => {
  const dir = dataDir();
  const state = new RealmStateStore(dir);
  state.appendSelfConceptAttemptStarted(AGENT, "attempt", undefined, AT);
  const db = new DatabaseSync(join(dir, "realm.sqlite"));
  assert.throws(
    () => db.prepare("UPDATE self_concept_proposal_audit SET diagnostic_code = 'tamper' WHERE event_id = 1").run(),
    /append-only/,
  );
  assert.throws(
    () => db.prepare("DELETE FROM self_concept_proposal_audit WHERE event_id = 1").run(),
    /append-only/,
  );
  db.close();
});
