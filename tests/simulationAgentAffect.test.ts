import test from "node:test";
import assert from "node:assert/strict";

import {
  AFFINITY_MAX,
  AFFINITY_MIN,
  AffectValidationError,
  InMemoryAffectStore,
  type AgentMood,
  type RelationshipAffect,
} from "@elysian/simulation-agent";

const AT_1 = "2026-07-26T10:00:00.000Z";
const AT_2 = "2026-07-26T11:00:00.000Z";

test("first affinity delta creates the relationship from the initial value", () => {
  const store = new InMemoryAffectStore();
  const change = store.applyAffinityDelta("ana", "bruno", 3, AT_1);

  assert.equal(change.before, undefined);
  assert.equal(change.after.affinity, 3);
  assert.equal(change.after.updatedAt, AT_1);
  assert.equal(change.clamped, false);
  assert.deepEqual(store.getRelationship("ana", "bruno"), change.after);
});

test("deltas accumulate and clamp visibly at both boundaries", () => {
  const store = new InMemoryAffectStore();
  store.applyAffinityDelta("ana", "bruno", 90, AT_1);

  const up = store.applyAffinityDelta("ana", "bruno", 50, AT_2);
  assert.equal(up.after.affinity, AFFINITY_MAX);
  assert.equal(up.clamped, true);
  assert.equal(up.before?.affinity, 90);

  const down = store.applyAffinityDelta("ana", "bruno", -500, AT_2);
  assert.equal(down.after.affinity, AFFINITY_MIN);
  assert.equal(down.clamped, true);
});

test("setAffinity overwrites and clamps out-of-range values", () => {
  const store = new InMemoryAffectStore();
  const first = store.setAffinity("ana", "bruno", 42, AT_1);
  assert.equal(first.after.affinity, 42);
  assert.equal(first.clamped, false);

  const clamped = store.setAffinity("ana", "bruno", 1_000, AT_2);
  assert.equal(clamped.after.affinity, AFFINITY_MAX);
  assert.equal(clamped.clamped, true);
  assert.equal(clamped.before?.affinity, 42);
});

test("relationships are directed and listed deterministically by targetId", () => {
  const store = new InMemoryAffectStore();
  store.applyAffinityDelta("ana", "carla", 1, AT_1);
  store.applyAffinityDelta("ana", "bruno", 2, AT_1);
  store.applyAffinityDelta("bruno", "ana", 9, AT_1);

  const anaRelations = store.listRelationships("ana");
  assert.deepEqual(
    anaRelations.map((entry) => entry.targetId),
    ["bruno", "carla"],
  );
  assert.equal(store.getRelationship("bruno", "ana")?.affinity, 9);
  assert.equal(store.getRelationship("carla", "ana"), undefined);
});

test("mood set and get round-trip with before/after visibility", () => {
  const store = new InMemoryAffectStore();
  assert.equal(store.getMood("ana"), undefined);

  const first = store.setMood("ana", { mood: "calm", intensity: 0.4 }, AT_1);
  assert.equal(first.before, undefined);
  assert.equal(first.after.mood, "calm");

  const second = store.setMood("ana", { mood: "cheerful", intensity: 0.9 }, AT_2);
  assert.equal(second.before?.mood, "calm");
  assert.equal(second.after.updatedAt, AT_2);
  assert.equal(store.getMood("ana")?.mood, "cheerful");
});

test("returned snapshots are copies; mutating them does not affect the store", () => {
  const store = new InMemoryAffectStore();
  store.applyAffinityDelta("ana", "bruno", 5, AT_1);
  store.setMood("ana", { mood: "calm", intensity: 0.5 }, AT_1);

  const relationship = store.getRelationship("ana", "bruno");
  assert.ok(relationship);
  relationship.affinity = 999;
  assert.equal(store.getRelationship("ana", "bruno")?.affinity, 5);

  const mood = store.getMood("ana");
  assert.ok(mood);
  mood.mood = "corrupted";
  assert.equal(store.getMood("ana")?.mood, "calm");
});

test("constructor imports validated snapshots and rejects invalid ones", () => {
  const relationships: RelationshipAffect[] = [
    { agentId: "ana", targetId: "bruno", affinity: 12, updatedAt: AT_1 },
  ];
  const moods: AgentMood[] = [{ agentId: "ana", mood: "calm", intensity: 0.3, updatedAt: AT_1 }];

  const store = new InMemoryAffectStore({ relationships, moods });
  assert.equal(store.getRelationship("ana", "bruno")?.affinity, 12);
  assert.equal(store.getMood("ana")?.intensity, 0.3);

  assert.throws(
    () =>
      new InMemoryAffectStore({
        relationships: [{ agentId: "ana", targetId: "bruno", affinity: 500, updatedAt: AT_1 }],
      }),
    AffectValidationError,
  );
  assert.throws(
    () =>
      new InMemoryAffectStore({
        moods: [{ agentId: "ana", mood: "", intensity: 0.3, updatedAt: AT_1 }],
      }),
    AffectValidationError,
  );
});

test("invalid inputs fail visibly with collected errors", () => {
  const store = new InMemoryAffectStore();

  assert.throws(() => store.applyAffinityDelta("", "bruno", 1, AT_1), AffectValidationError);
  assert.throws(() => store.applyAffinityDelta("ana", "ana", 1, AT_1), AffectValidationError);
  assert.throws(
    () => store.applyAffinityDelta("ana", "bruno", Number.NaN, AT_1),
    AffectValidationError,
  );
  assert.throws(() => store.setAffinity("ana", "bruno", 1, "not-a-date"), AffectValidationError);
  assert.throws(() => store.setMood("ana", { mood: "calm", intensity: 1.5 }, AT_1), AffectValidationError);
  assert.throws(() => store.setMood("ana", { mood: " ", intensity: 0.5 }, AT_1), AffectValidationError);

  try {
    store.applyAffinityDelta("", "", Number.POSITIVE_INFINITY, "bad");
    assert.fail("expected AffectValidationError");
  } catch (error) {
    assert.ok(error instanceof AffectValidationError);
    assert.ok(error.errors.length >= 2);
  }
});

test("distinct id pairs never collide in storage", () => {
  const store = new InMemoryAffectStore();
  store.applyAffinityDelta("a b", "c", 1, AT_1);
  store.applyAffinityDelta("a", "b c", 7, AT_1);

  assert.equal(store.getRelationship("a b", "c")?.affinity, 1);
  assert.equal(store.getRelationship("a", "b c")?.affinity, 7);
});
