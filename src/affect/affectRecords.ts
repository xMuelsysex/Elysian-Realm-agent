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
