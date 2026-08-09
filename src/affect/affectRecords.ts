// Affect state records: per-relationship affinity and per-agent mood.
//
// Snapshots answer "how does this agent feel right now"; the memory stream
// answers "what happened". Affinity/mood changes return before/after values so
// the caller can decide whether to journal them as memory records — the store
// itself never writes memories.

export const AFFINITY_MIN = -100;
export const AFFINITY_MAX = 100;
export const AFFINITY_INITIAL = 0;

export const MOOD_INTENSITY_MIN = 0;
export const MOOD_INTENSITY_MAX = 1;

export const AFFECT_VALENCE_MIN = -1;
export const AFFECT_VALENCE_MAX = 1;
export const AFFECT_AROUSAL_MIN = 0;
export const AFFECT_AROUSAL_MAX = 1;
export const AFFECT_LABEL_MIN = 0;
export const AFFECT_LABEL_MAX = 1;

/**
 * Discrete emotion labels from Google's GoEmotions taxonomy (27 fine-grained
 * categories plus neutral; Apache-2.0). Used for the label dimension of the
 * agent's emotional state, keeping the coarse-to-fine mapping available.
 */
export const EMOTION_LABELS = [
  "admiration",
  "amusement",
  "anger",
  "annoyance",
  "approval",
  "caring",
  "confusion",
  "curiosity",
  "desire",
  "disappointment",
  "disapproval",
  "disgust",
  "embarrassment",
  "excitement",
  "fear",
  "gratitude",
  "grief",
  "joy",
  "love",
  "nervousness",
  "optimism",
  "pride",
  "realization",
  "relief",
  "remorse",
  "sadness",
  "surprise",
  "neutral",
] as const;

export type EmotionLabel = (typeof EMOTION_LABELS)[number];

/** The character's temperament: the state emotions settle toward over time. */
export interface AffectBaseline {
  valence: number;
  arousal: number;
}

/** Default temperament: mildly warm and calm. */
export const AFFECT_DEFAULT_BASELINE: AffectBaseline = { valence: 0.2, arousal: 0.3 };

export type AffectLabelStrengths = Record<EmotionLabel, number>;

/**
 * The agent's current emotional state ("how it feels right now"). The memory
 * stream answers "what happened"; this snapshot is the plot-driven present.
 * Immutable: every transition produces a new state.
 */
export interface AffectState {
  agentId: string;
  /** Bounded to [AFFECT_VALENCE_MIN, AFFECT_VALENCE_MAX]: negative..positive. */
  valence: number;
  /** Bounded to [AFFECT_AROUSAL_MIN, AFFECT_AROUSAL_MAX]: calm..intense. */
  arousal: number;
  /** Every GoEmotions label present, each bounded to [AFFECT_LABEL_MIN, AFFECT_LABEL_MAX]. */
  emotionLabels: AffectLabelStrengths;
  baseline: AffectBaseline;
  updatedAt: string;
}

/**
 * Plot event types: what happened to the character. The rule engine maps each
 * type to deterministic affect deltas (ACT-inspired event -> impression shift).
 */
export const PLOT_EVENT_TYPES = [
  "kind_act",
  "hostile_act",
  "praise",
  "criticism",
  "loss",
  "gain",
  "threat",
  "surprise",
  "companion_joy",
  "companion_sad",
  "neutral",
] as const;

export type PlotEventType = (typeof PLOT_EVENT_TYPES)[number];

/** Chinese display labels for plot event types (single source for UIs). */
export const PLOT_EVENT_LABELS: Record<PlotEventType, string> = {
  kind_act: "善待",
  hostile_act: "恶意",
  praise: "夸赞",
  criticism: "批评",
  loss: "失去",
  gain: "获得",
  threat: "威胁",
  surprise: "意外",
  companion_joy: "同伴喜悦",
  companion_sad: "同伴悲伤",
  neutral: "平常",
};

export const PLOT_EVENT_TARGETS = ["self", "host", "other"] as const;

export type PlotEventTarget = (typeof PLOT_EVENT_TARGETS)[number];

/**
 * A single plot event fed by the host (the authoritative world state owner).
 * `target` says who the event is directed at: the agent itself (self), the
 * host participant (host), or another agent (other).
 */
export interface PlotEvent {
  id: string;
  type: PlotEventType;
  target: PlotEventTarget;
  /** Event strength, bounded to [0, 1]; scales the rule deltas linearly. */
  intensity: number;
  at: string;
}

/** Directed relationship affect: how `agentId` feels about `targetId`. */
export interface RelationshipAffect {
  agentId: string;
  targetId: string;
  /** Bounded to [AFFINITY_MIN, AFFINITY_MAX]; new relationships start at AFFINITY_INITIAL. */
  affinity: number;
  updatedAt: string;
}

/** An agent's own emotional state. */
export interface AgentMood {
  agentId: string;
  /** Free-form label, e.g. "calm", "cheerful"; never empty. */
  mood: string;
  /** Bounded to [MOOD_INTENSITY_MIN, MOOD_INTENSITY_MAX]. */
  intensity: number;
  updatedAt: string;
}

export interface AgentMoodWrite {
  mood: string;
  intensity: number;
}

/**
 * Result of an affinity mutation. `before` is undefined when the relationship
 * is created by this call. `clamped` is true when the requested change hit a
 * boundary, so callers can observe saturation instead of it being silent.
 */
export interface AffinityChange {
  before?: RelationshipAffect;
  after: RelationshipAffect;
  clamped: boolean;
}

export interface MoodChange {
  before?: AgentMood;
  after: AgentMood;
}
