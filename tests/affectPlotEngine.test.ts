// Plot-driven affect engine tests: deterministic rule table, intensity
// scaling, baseline decay, clamping, immutability, and the affect-store
// integration of AffectState snapshots.

import test from "node:test";
import assert from "node:assert/strict";

import {
  AFFECT_AROUSAL_MAX,
  AFFECT_AROUSAL_MIN,
  AFFECT_VALENCE_MAX,
  AFFECT_VALENCE_MIN,
  AffectValidationError,
  EMOTION_LABELS,
  InMemoryAffectStore,
  MAX_TICK_AFFINITY_DELTA,
  applyPlotEvents,
  computeAffinityDelta,
  createInitialAffectState,
  decayAffectState,
  validatePlotEvent,
  type AffectState,
  type PlotEvent,
} from "@elysian/simulation-agent";

const AT = "2026-08-08T10:00:00.000Z";
const AT_NEXT = "2026-08-08T11:00:00.000Z";

function event(overrides: Partial<PlotEvent> = {}): PlotEvent {
  return {
    id: "plot_1",
    type: "kind_act",
    target: "host",
    intensity: 1,
    at: AT,
    ...overrides,
  };
}

function freshState(agentId = "ana"): AffectState {
  return createInitialAffectState(agentId, AT);
}

test("initial affect state sits at the temperament baseline with quiet labels", () => {
  const state = freshState();
  assert.equal(state.valence, 0.2);
  assert.equal(state.arousal, 0.3);
  for (const label of EMOTION_LABELS) {
    assert.equal(state.emotionLabels[label], 0);
  }
  assert.deepEqual(state.baseline, { valence: 0.2, arousal: 0.3 });
  assert.equal(state.updatedAt, AT);
});

test("hostile events activate anger and drive valence to the floor", () => {
  const state = applyPlotEvents(
    freshState(),
    [
      event({ type: "hostile_act" }),
      event({ type: "hostile_act" }),
      event({ type: "hostile_act" }),
      event({ type: "threat" }),
    ],
    AT_NEXT,
  );
  assert.equal(state.valence, AFFECT_VALENCE_MIN);
  assert.equal(state.arousal, AFFECT_AROUSAL_MAX);
  assert.equal(state.emotionLabels.anger, 1);
  assert.equal(state.emotionLabels.fear, 0.6);
  assert.equal(state.emotionLabels.nervousness, 0.4);
  assert.equal(state.updatedAt, AT_NEXT);
});

test("intensity scales rule deltas linearly", () => {
  const state = applyPlotEvents(freshState(), [event({ type: "praise", intensity: 0.5 })], AT_NEXT);
  assert.equal(state.valence, 0.2 + 0.3 * 0.5);
  assert.equal(state.emotionLabels.pride, 0.5 * 0.5);
  assert.equal(state.emotionLabels.joy, 0.4 * 0.5);
});

test("decay regresses toward the baseline and quiets labels", () => {
  const stirred = applyPlotEvents(
    freshState(),
    [event({ type: "hostile_act" }), event({ type: "threat" })],
    AT,
  );
  const settled = decayAffectState(stirred, AT_NEXT);
  // stirred valence = 0.2 - 0.35 - 0.3 = -0.45; decay -> -0.45 + (0.2 + 0.45) * 0.15
  assert.ok(Math.abs(settled.valence - (-0.45 + 0.65 * 0.15)) < 1e-9);
  // anger 0.6 -> 0.51
  assert.ok(Math.abs(settled.emotionLabels.anger - 0.6 * 0.85) < 1e-9);
  assert.equal(settled.updatedAt, AT_NEXT);
});

test("neutral and empty event batches still decay the carried state", () => {
  const stirred = applyPlotEvents(freshState(), [event({ type: "gain" })], AT);
  const viaNeutral = applyPlotEvents(stirred, [event({ type: "neutral", id: "plot_2" })], AT_NEXT);
  const viaEmpty = applyPlotEvents(stirred, [], AT_NEXT);
  const viaDecay = decayAffectState(stirred, AT_NEXT);
  assert.deepEqual(viaNeutral, viaDecay);
  assert.deepEqual(viaEmpty, viaDecay);
});

test("applyPlotEvents never mutates its input state", () => {
  const before = freshState();
  const snapshot = structuredClone(before);
  applyPlotEvents(before, [event({ type: "hostile_act" })], AT_NEXT);
  assert.deepEqual(before, snapshot);
});

test("computeAffinityDelta sums host-targeted deltas and clamps per call", () => {
  assert.equal(computeAffinityDelta([event({ type: "kind_act" })]), 3);
  assert.equal(computeAffinityDelta([event({ type: "hostile_act" }), event({ type: "hostile_act" })]), -10);
  assert.equal(
    computeAffinityDelta([
      event({ type: "hostile_act" }),
      event({ type: "hostile_act" }),
      event({ type: "hostile_act" }),
    ]),
    -MAX_TICK_AFFINITY_DELTA,
  );
  // Self-targeted events never move host affinity.
  assert.equal(computeAffinityDelta([event({ type: "hostile_act", target: "self" })]), 0);
  // Intensity scales the shift.
  assert.equal(computeAffinityDelta([event({ type: "hostile_act", intensity: 0.5 })]), -2.5);
});

test("plot event validation rejects malformed events with collected errors", () => {
  assert.throws(() => validatePlotEvent(event({ type: "bogus" as never })), AffectValidationError);
  assert.throws(() => validatePlotEvent(event({ target: "nobody" as never })), AffectValidationError);
  assert.throws(() => validatePlotEvent(event({ intensity: 1.5 })), AffectValidationError);
  assert.throws(() => validatePlotEvent(event({ at: "not-a-date" })), AffectValidationError);
  assert.throws(() => validatePlotEvent(event({ id: " " })), AffectValidationError);
});

test("affect states round-trip through the store with defensive copies", () => {
  const store = new InMemoryAffectStore();
  assert.equal(store.getAffectState("ana"), undefined);

  const stored = store.setAffectState(freshState());
  assert.deepEqual(store.getAffectState("ana"), stored);

  const returned = store.getAffectState("ana");
  assert.ok(returned);
  returned.valence = 999;
  returned.emotionLabels.joy = 999;
  returned.baseline.arousal = 999;
  assert.equal(store.getAffectState("ana")?.valence, 0.2);
  assert.equal(store.getAffectState("ana")?.emotionLabels.joy, 0);
  assert.equal(store.getAffectState("ana")?.baseline.arousal, 0.3);
});

test("store imports validated affect states and rejects invalid ones", () => {
  const state = freshState();
  const store = new InMemoryAffectStore({ affectStates: [state] });
  assert.deepEqual(store.getAffectState("ana"), state);

  assert.throws(
    () =>
      new InMemoryAffectStore({
        affectStates: [{ ...freshState(), valence: 5 }],
      }),
    AffectValidationError,
  );
  const missingLabel = freshState();
  delete (missingLabel.emotionLabels as Record<string, number>).joy;
  assert.throws(
    () => new InMemoryAffectStore({ affectStates: [missingLabel] }),
    AffectValidationError,
  );
});

test("emotion labels always cover the full GoEmotions taxonomy", () => {
  assert.equal(EMOTION_LABELS.length, 28);
  assert.ok(EMOTION_LABELS.includes("anger"));
  assert.ok(EMOTION_LABELS.includes("neutral"));
  assert.ok(EMOTION_LABELS.includes("gratitude"));
});
