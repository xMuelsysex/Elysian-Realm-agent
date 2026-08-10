// Plot-driven affect engine: deterministic, pure rules that turn plot events
// into emotional state transitions.
//
// Design provenance (verified 2026-08-08):
// - Event -> impression shift + regression toward a baseline mirrors Affect
//   Control Theory's deflection concept (transient impressions move away from
//   fundamental sentiments and settle back); concrete reference
//   implementations: ekmaloney/inteRact, ahcombs/actdata, nikozoe/ACTING.
//   We borrow the semantics, not the EPA dictionary machinery.
// - The discrete label dimension uses Google's GoEmotions taxonomy
//   (Apache-2.0; 27 fine-grained categories + neutral).
//
// The engine is a pure function of (state, events, at): the host passes time,
// no clock lives here, and identical inputs always produce identical outputs.

import {
  AFFECT_AROUSAL_MAX,
  AFFECT_AROUSAL_MIN,
  AFFECT_DEFAULT_BASELINE,
  AFFECT_LABEL_MAX,
  AFFECT_LABEL_MIN,
  AFFECT_VALENCE_MAX,
  AFFECT_VALENCE_MIN,
  EMOTION_LABELS,
  type AffectBaseline,
  type AffectLabelStrengths,
  type AffectState,
  type EmotionLabel,
  type PlotEvent,
  type PlotEventType,
} from "./affectRecords.js";

/** Fraction of the gap to baseline closed per application (per tick / per event call). */
export const AFFECT_DECAY_RATE = 0.15;

/** Bound for a single call's proposed affinity movement toward the host. */
export const MAX_TICK_AFFINITY_DELTA = 10;

/** Deterministic affect shift produced by one unit of a plot event type. */
export interface PlotEventRule {
  valenceDelta: number;
  arousalDelta: number;
  /** Affinity movement when the event targets the host participant. */
  affinityDelta: number;
  /** Label activation weights; absent labels get no direct activation. */
  labels: Partial<Record<EmotionLabel, number>>;
}

/**
 * Event-type -> affect shift table. Values are conservative, tunable
 * calibration constants (ACT-style impression equations reduced to a table);
 * intensity scales each rule linearly.
 */
export const PLOT_EVENT_RULES: Record<PlotEventType, PlotEventRule> = {
  kind_act: {
    valenceDelta: 0.3,
    arousalDelta: 0.1,
    affinityDelta: 3,
    labels: { gratitude: 0.5, caring: 0.3 },
  },
  hostile_act: {
    valenceDelta: -0.35,
    arousalDelta: 0.2,
    affinityDelta: -5,
    labels: { anger: 0.6, annoyance: 0.4 },
  },
  praise: {
    valenceDelta: 0.3,
    arousalDelta: 0.15,
    affinityDelta: 4,
    labels: { pride: 0.5, joy: 0.4 },
  },
  criticism: {
    valenceDelta: -0.25,
    arousalDelta: 0.05,
    affinityDelta: -3,
    labels: { disappointment: 0.5, sadness: 0.2 },
  },
  loss: {
    valenceDelta: -0.4,
    arousalDelta: -0.05,
    affinityDelta: 0,
    labels: { grief: 0.6, sadness: 0.5 },
  },
  gain: {
    valenceDelta: 0.35,
    arousalDelta: 0.15,
    affinityDelta: 0,
    labels: { joy: 0.5, optimism: 0.3 },
  },
  threat: {
    valenceDelta: -0.3,
    arousalDelta: 0.35,
    affinityDelta: -1,
    labels: { fear: 0.6, nervousness: 0.4 },
  },
  surprise: {
    valenceDelta: 0.05,
    arousalDelta: 0.25,
    affinityDelta: 0,
    labels: { surprise: 0.5, curiosity: 0.3 },
  },
  companion_joy: {
    valenceDelta: 0.2,
    arousalDelta: 0.1,
    affinityDelta: 1,
    labels: { joy: 0.4, admiration: 0.2 },
  },
  companion_sad: {
    valenceDelta: -0.1,
    arousalDelta: -0.05,
    affinityDelta: 1,
    labels: { caring: 0.4, sadness: 0.3 },
  },
  neutral: {
    valenceDelta: 0,
    arousalDelta: 0,
    affinityDelta: 0,
    labels: {},
  },
};

/** A fresh state at rest: temperament as the starting point, all labels quiet. */
export function createInitialAffectState(
  agentId: string,
  at: string,
  baseline: AffectBaseline = AFFECT_DEFAULT_BASELINE,
): AffectState {
  return {
    agentId,
    valence: baseline.valence,
    arousal: baseline.arousal,
    emotionLabels: emptyLabelStrengths(),
    baseline: { ...baseline },
    updatedAt: at,
  };
}

/**
 * Exponential regression toward the baseline (and toward label quiet) —
 * ACT's "impressions settle back toward fundamental sentiments". Pure and
 * immutable; `updatedAt` advances to `at`.
 */
export function decayAffectState(state: AffectState, at: string): AffectState {
  const rate = AFFECT_DECAY_RATE;
  const emotionLabels: AffectLabelStrengths = {} as AffectLabelStrengths;
  for (const label of EMOTION_LABELS) {
    const current = state.emotionLabels[label];
    emotionLabels[label] = current + (AFFECT_LABEL_MIN - current) * rate;
  }
  return {
    ...state,
    valence: state.valence + (state.baseline.valence - state.valence) * rate,
    arousal: state.arousal + (state.baseline.arousal - state.arousal) * rate,
    emotionLabels,
    updatedAt: at,
  };
}

/**
 * One tick of emotional life: decay first (time passes, feelings settle), then
 * apply the plot events (new things happen), clamping every bounded value.
 * Pure and immutable. Events must already be validated at the boundary.
 */
export function applyPlotEvents(
  state: AffectState,
  events: readonly PlotEvent[],
  at: string,
  /** Per-event-type response multipliers (character temperament); absent = 1. */
  modifiers?: Readonly<Partial<Record<PlotEventType, number>>>,
): AffectState {
  const decayed = decayAffectState(state, at);
  if (events.length === 0) {
    return decayed;
  }

  let valence = decayed.valence;
  let arousal = decayed.arousal;
  const labels = { ...decayed.emotionLabels };
  for (const event of events) {
    const rule = PLOT_EVENT_RULES[event.type];
    const scale = event.intensity * (modifiers?.[event.type] ?? 1);
    valence += rule.valenceDelta * scale;
    arousal += rule.arousalDelta * scale;
    for (const label of EMOTION_LABELS) {
      const delta = rule.labels[label];
      if (delta !== undefined) {
        labels[label] += delta * scale;
      }
    }
  }

  const emotionLabels = {} as AffectLabelStrengths;
  for (const label of EMOTION_LABELS) {
    emotionLabels[label] = clampNumber(labels[label], AFFECT_LABEL_MIN, AFFECT_LABEL_MAX);
  }

  return {
    ...decayed,
    valence: clampNumber(valence, AFFECT_VALENCE_MIN, AFFECT_VALENCE_MAX),
    arousal: clampNumber(arousal, AFFECT_AROUSAL_MIN, AFFECT_AROUSAL_MAX),
    emotionLabels,
  };
}

/**
 * Proposed affinity movement toward the host participant from this batch of
 * events: host-targeted rule deltas scaled by intensity, bounded per call.
 */
export function computeAffinityDelta(
  events: readonly PlotEvent[],
  /** Per-event-type response multipliers; absent = 1. */
  modifiers?: Readonly<Partial<Record<PlotEventType, number>>>,
): number {
  let total = 0;
  for (const event of events) {
    if (event.target !== "host") {
      continue;
    }
    total += PLOT_EVENT_RULES[event.type].affinityDelta * event.intensity * (modifiers?.[event.type] ?? 1);
  }
  return clampNumber(total, -MAX_TICK_AFFINITY_DELTA, MAX_TICK_AFFINITY_DELTA);
}

export function emptyLabelStrengths(): AffectLabelStrengths {
  const labels = {} as AffectLabelStrengths;
  for (const label of EMOTION_LABELS) {
    labels[label] = 0;
  }
  return labels;
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Conversation emotional feedback: nudge the affect snapshot toward the
 * exchange's emotional signature at a small weight, so feelings carry
 * inertia between turns while plot events stay dominant. Pure and
 * deterministic; labels are untouched (signatures carry no labels).
 */
export const CONVERSATION_EMOTION_BLEND_RATE = 0.1;

export function blendConversationEmotion(
  state: AffectState,
  emotion: { valence: number; arousal: number },
  at: string,
): AffectState {
  const rate = CONVERSATION_EMOTION_BLEND_RATE;
  return {
    ...state,
    valence: clampNumber(
      state.valence + (emotion.valence - state.valence) * rate,
      AFFECT_VALENCE_MIN,
      AFFECT_VALENCE_MAX,
    ),
    arousal: clampNumber(
      state.arousal + (emotion.arousal - state.arousal) * rate,
      AFFECT_AROUSAL_MIN,
      AFFECT_AROUSAL_MAX,
    ),
    updatedAt: at,
  };
}
