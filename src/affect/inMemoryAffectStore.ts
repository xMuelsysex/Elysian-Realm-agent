import {
  AFFINITY_INITIAL,
  AFFINITY_MAX,
  AFFINITY_MIN,
  type AffinityChange,
  type AgentMood,
  type AgentMoodWrite,
  type MoodChange,
  type RelationshipAffect,
} from "./affectRecords.js";
import {
  validateAffinityInput,
  validateImportedMood,
  validateImportedRelationship,
  validateMoodWrite,
  validateRelationshipRef,
} from "./affectValidation.js";

export interface InMemoryAffectStoreInit {
  relationships?: readonly RelationshipAffect[];
  moods?: readonly AgentMood[];
}

/**
 * In-memory affect snapshots. Callers supply timestamps (`at`), so behavior is
 * deterministic; returned objects are copies and never expose internal state.
 */
export class InMemoryAffectStore {
  private readonly relationships = new Map<string, RelationshipAffect>();
  private readonly moods = new Map<string, AgentMood>();

  constructor(init: InMemoryAffectStoreInit = {}) {
    for (const record of init.relationships ?? []) {
      validateImportedRelationship(record);
      this.relationships.set(relationKey(record.agentId, record.targetId), { ...record });
    }
    for (const record of init.moods ?? []) {
      validateImportedMood(record);
      this.moods.set(record.agentId, { ...record });
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
    const affinity = Math.min(AFFINITY_MAX, Math.max(AFFINITY_MIN, rawValue));
    const after: RelationshipAffect = { agentId, targetId, affinity, updatedAt: at };
    this.relationships.set(relationKey(agentId, targetId), after);

    return {
      before: before ? { ...before } : undefined,
      after: { ...after },
      clamped: affinity !== rawValue,
    };
  }
}

function relationKey(agentId: string, targetId: string): string {
  return `${agentId}\u0000${targetId}`;
}
