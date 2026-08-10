import {
  AFFINITY_INITIAL,
  AFFINITY_MAX,
  AFFINITY_MIN,
  type AffinityChange,
  type AffectState,
  type AgentMood,
  type AgentMoodWrite,
  type MoodChange,
  type RelationshipAffect,
} from "./affectRecords.js";
import {
  validateAffinityInput,
  validateAffectState,
  validateImportedMood,
  validateImportedRelationship,
  validateMoodWrite,
  validateRelationshipRef,
} from "./affectValidation.js";

export interface InMemoryAffectStoreInit {
  relationships?: readonly RelationshipAffect[];
  moods?: readonly AgentMood[];
  affectStates?: readonly AffectState[];
}

/**
 * In-memory affect snapshots. Callers supply timestamps (`at`), so behavior is
 * deterministic; returned objects are copies and never expose internal state.
 */
export class InMemoryAffectStore {
  private readonly relationships = new Map<string, RelationshipAffect>();
  private readonly moods = new Map<string, AgentMood>();
  private readonly affectStates = new Map<string, AffectState>();

  constructor(init: InMemoryAffectStoreInit = {}) {
    for (const record of init.relationships ?? []) {
      validateImportedRelationship(record);
      this.relationships.set(relationKey(record.agentId, record.targetId), { ...record });
    }
    for (const record of init.moods ?? []) {
      validateImportedMood(record);
      this.moods.set(record.agentId, { ...record });
    }
    for (const record of init.affectStates ?? []) {
      validateAffectState(record);
      this.affectStates.set(record.agentId, cloneAffectState(record));
    }
  }

  getRelationship(agentId: string, targetId: string): RelationshipAffect | undefined {
    validateRelationshipRef(agentId, targetId);
    const record = this.relationships.get(relationKey(agentId, targetId));
    return record ? { ...record } : undefined;
  }

  /** All relationships held by `agentId`, sorted by targetId for determinism. */
  listRelationships(agentId: string): readonly RelationshipAffect[] {
    return [...this.relationships.values()]
      .filter((record) => record.agentId === agentId)
      .sort((a, b) => (a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0))
      .map((record) => ({ ...record }));
  }

  applyAffinityDelta(agentId: string, targetId: string, delta: number, at: string): AffinityChange {
    validateRelationshipRef(agentId, targetId);
    validateAffinityInput(delta, "delta", at);

    const before = this.relationships.get(relationKey(agentId, targetId));
    const base = before?.affinity ?? AFFINITY_INITIAL;
    return this.storeAffinity(agentId, targetId, before, base + delta, at);
  }

  setAffinity(agentId: string, targetId: string, value: number, at: string): AffinityChange {
    validateRelationshipRef(agentId, targetId);
    validateAffinityInput(value, "value", at);

    const before = this.relationships.get(relationKey(agentId, targetId));
    return this.storeAffinity(agentId, targetId, before, value, at);
  }

  getMood(agentId: string): AgentMood | undefined {
    const record = this.moods.get(agentId);
    return record ? { ...record } : undefined;
  }

  getAffectState(agentId: string): AffectState | undefined {
    const record = this.affectStates.get(agentId);
    return record ? cloneAffectState(record) : undefined;
  }

  /** Replace the agent's emotional state with a validated, defensive copy. */
  setAffectState(state: AffectState): AffectState {
    validateAffectState(state);
    const copy = cloneAffectState(state);
    this.affectStates.set(state.agentId, copy);
    return cloneAffectState(copy);
  }

  setMood(agentId: string, write: AgentMoodWrite, at: string): MoodChange {
    validateMoodWrite(agentId, write, at);

    const before = this.moods.get(agentId);
    const after: AgentMood = {
      agentId,
      mood: write.mood,
      intensity: write.intensity,
      updatedAt: at,
    };
    this.moods.set(agentId, after);

    return {
      before: before ? { ...before } : undefined,
      after: { ...after },
    };
  }

  private storeAffinity(
    agentId: string,
    targetId: string,
    before: RelationshipAffect | undefined,
    rawValue: number,
    at: string,
  ): AffinityChange {
    const bounded = Math.min(AFFINITY_MAX, Math.max(AFFINITY_MIN, rawValue));
    // Affinity is an integer scale (-100..100); round fractional deltas so
    // the value survives STRICT INTEGER persistence.
    const affinity = Math.round(bounded);
    const after: RelationshipAffect = { agentId, targetId, affinity, updatedAt: at };
    this.relationships.set(relationKey(agentId, targetId), after);

    return {
      before: before ? { ...before } : undefined,
      after: { ...after },
      clamped: bounded !== rawValue,
    };
  }
}

function relationKey(agentId: string, targetId: string): string {
  return `${agentId}\u0000${targetId}`;
}

function cloneAffectState(state: AffectState): AffectState {
  return {
    ...state,
    emotionLabels: { ...state.emotionLabels },
    baseline: { ...state.baseline },
  };
}
