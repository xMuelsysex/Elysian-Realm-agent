// Realm host state: the authoritative, persisted world state for a running
// realm — persona/user configuration, memory streams, affect snapshots, and
// conversation histories.
//
// Storage layout under the data directory (default ./realm-data):
//   realm.json         persona + user configuration (hand-editable)
//   memories.json      all agents' memory records
//   affect.json        relationship affinity + moods
//   conversations.json per-agent conversation turns
//
// Full-snapshot JSON with temp-file + rename atomic writes: personal-scale
// state (thousands of records) where simplicity and crash safety beat
// incremental formats.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryAffectStore } from "../affect/inMemoryAffectStore.js";
import type { AgentMood, RelationshipAffect } from "../affect/affectRecords.js";
import { InMemoryMemoryStore } from "../memory/inMemoryMemoryStore.js";
import type { MemoryRecord, MemoryWrite } from "../memory/memoryRecords.js";
import type { RealmConversationTurnV1 } from "../service/realmConversationV1.js";
import type {
  RealmMemoryMetadataV1,
  RealmRoutinePeriodV1,
} from "../service/realmStepV1.js";

export interface RealmRoutineConfig {
  period: RealmRoutinePeriodV1;
  locationId: string;
  intent: string;
}

export interface RealmPersonaConfig {
  agentId: string;
  personaId: string;
  displayName: string;
  persona: string;
  routines: readonly RealmRoutineConfig[];
}

export interface RealmUserConfig {
  participantId: string;
  displayName: string;
}

export interface RealmConfig {
  user: RealmUserConfig;
  agents: readonly RealmPersonaConfig[];
}

export const DEFAULT_REALM_CONFIG: RealmConfig = {
  user: { participantId: "user_master", displayName: "主人" },
  agents: [
    {
      agentId: "agent_elysia",
      personaId: "elysia",
      displayName: "爱莉希雅",
      persona:
        "爱莉希雅，乐园的粉色妖精小姐♪ 开朗俏皮，说话轻快带点小狡黠，真诚地喜欢眼前的人。喜欢花、阳光和一切美好的事物，偶尔用「♪」结尾。会记得和对方的约定与共同经历，并自然地提起。",
      routines: [
        { period: "morning", locationId: "garden", intent: "在花园里照料向日葵和玫瑰。" },
        { period: "day", locationId: "library", intent: "在图书馆翻看喜欢的诗集。" },
        { period: "evening", locationId: "lakeside", intent: "在湖边散步看晚霞。" },
        { period: "night", locationId: "home", intent: "在家里整理今天的花瓣书签，准备休息。" },
      ],
    },
  ],
};

export class RealmStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealmStateError";
  }
}

interface AffectFileShape {
  relationships: RelationshipAffect[];
  moods: AgentMood[];
}

export interface RealmTickState {
  /** Local calendar date, e.g. "2026-07-26". */
  date: string;
  period: RealmRoutinePeriodV1;
}

/**
 * Authoritative host state. Mutations go through apply* methods which persist
 * immediately; readers get defensive copies from the underlying stores.
 */
export class RealmStateStore {
  readonly config: RealmConfig;
  private readonly dataDir: string;
  private readonly memories = new Map<string, InMemoryMemoryStore<RealmMemoryMetadataV1>>();
  private affect: InMemoryAffectStore;
  private readonly conversations = new Map<string, RealmConversationTurnV1[]>();
  private lastTick?: RealmTickState;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });

    this.config = this.loadConfig();
    const memoryRecords = this.loadJson<MemoryRecord<RealmMemoryMetadataV1>[]>("memories.json", []);
    const affectData = this.loadJson<AffectFileShape>("affect.json", { relationships: [], moods: [] });
    const conversationData = this.loadJson<Record<string, RealmConversationTurnV1[]>>(
      "conversations.json",
      {},
    );

    for (const agent of this.config.agents) {
      this.memories.set(
        agent.agentId,
        new InMemoryMemoryStore(memoryRecords.filter((record) => record.agentId === agent.agentId)),
      );
      this.conversations.set(agent.agentId, conversationData[agent.agentId] ?? []);
    }
    this.affect = new InMemoryAffectStore({
      relationships: affectData.relationships,
      moods: affectData.moods,
    });
    this.lastTick = this.loadJson<RealmTickState | undefined>("tick.json", undefined);
  }

  tickState(): RealmTickState | undefined {
    return this.lastTick ? { ...this.lastTick } : undefined;
  }

  setTickState(state: RealmTickState): void {
    this.lastTick = { ...state };
    this.writeJson("tick.json", this.lastTick);
  }

  agent(agentId: string): RealmPersonaConfig {
    const agent = this.config.agents.find((entry) => entry.agentId === agentId);
    if (!agent) {
      throw new RealmStateError(`unknown agentId: ${agentId}`);
    }
    return agent;
  }

  memoriesFor(agentId: string): readonly MemoryRecord<RealmMemoryMetadataV1>[] {
    return this.memoryStore(agentId).list(agentId);
  }

  relationship(agentId: string): RelationshipAffect | undefined {
    return this.affect.getRelationship(agentId, this.config.user.participantId);
  }

  mood(agentId: string): AgentMood | undefined {
    return this.affect.getMood(agentId);
  }

  historyFor(agentId: string, limit?: number): readonly RealmConversationTurnV1[] {
    const turns = this.conversations.get(agentId) ?? [];
    return limit !== undefined ? turns.slice(-limit) : [...turns];
  }

  /** Apply proposed conversation outputs atomically-ish: mutate, then persist. */
  applyConversation(
    agentId: string,
    outputs: {
      turns: readonly RealmConversationTurnV1[];
      memoryWrites: readonly MemoryWrite<RealmMemoryMetadataV1>[];
      affinityDelta?: number;
      mood?: { mood: string; intensity: number };
    },
    now: string,
  ): { affinity: number; mood?: AgentMood } {
    const store = this.memoryStore(agentId);
    for (const write of outputs.memoryWrites) {
      store.remember(agentId, write);
    }

    const turns = this.conversations.get(agentId) ?? [];
    turns.push(...outputs.turns);
    this.conversations.set(agentId, turns);

    if (outputs.affinityDelta !== undefined && outputs.affinityDelta !== 0) {
      this.affect.applyAffinityDelta(
        agentId,
        this.config.user.participantId,
        outputs.affinityDelta,
        now,
      );
    }
    if (outputs.mood) {
      this.affect.setMood(agentId, outputs.mood, now);
    }

    this.persist();
    return {
      affinity: this.relationship(agentId)?.affinity ?? 0,
      mood: this.mood(agentId),
    };
  }

  /** Apply proposed memory writes (ids generated by the store) and persist. */
  applyMemoryWrites(
    agentId: string,
    writes: readonly MemoryWrite<RealmMemoryMetadataV1>[],
  ): readonly MemoryRecord<RealmMemoryMetadataV1>[] {
    if (writes.length === 0) {
      return [];
    }
    const store = this.memoryStore(agentId);
    const records = writes.map((write) => store.remember(agentId, write));
    this.persist();
    return records;
  }

  /** Apply tick-produced memories (only records the store does not know yet). */
  applyTickMemories(
    agentId: string,
    records: readonly MemoryRecord<RealmMemoryMetadataV1>[],
  ): number {
    const store = this.memoryStore(agentId);
    const known = new Set(store.list(agentId).map((record) => record.id));
    let added = 0;
    for (const record of records) {
      if (known.has(record.id)) {
        continue;
      }
      store.remember(agentId, {
        id: record.id,
        kind: record.kind,
        content: record.content,
        createdAt: record.createdAt,
        importance: record.importance,
        sourceIds: record.sourceIds,
        relatedMemoryIds: record.relatedMemoryIds,
        visibility: record.visibility,
        tags: record.tags,
        metadata: record.metadata,
      });
      added += 1;
    }
    if (added > 0) {
      this.persist();
    }
    return added;
  }

  persist(): void {
    const allMemories = this.config.agents.flatMap((agent) =>
      this.memoryStore(agent.agentId).list(agent.agentId),
    );
    const affectData: AffectFileShape = {
      relationships: this.config.agents.flatMap((agent) =>
        [...this.affect.listRelationships(agent.agentId)],
      ),
      moods: this.config.agents
        .map((agent) => this.affect.getMood(agent.agentId))
        .filter((mood): mood is AgentMood => mood !== undefined),
    };
    const conversationData = Object.fromEntries(this.conversations.entries());

    this.writeJson("memories.json", allMemories);
    this.writeJson("affect.json", affectData);
    this.writeJson("conversations.json", conversationData);
  }

  private memoryStore(agentId: string): InMemoryMemoryStore<RealmMemoryMetadataV1> {
    const store = this.memories.get(agentId);
    if (!store) {
      throw new RealmStateError(`unknown agentId: ${agentId}`);
    }
    return store;
  }

  private loadConfig(): RealmConfig {
    const path = join(this.dataDir, "realm.json");
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // First run: seed the default realm so the host works out of the box
        // and the user has a hand-editable file.
        this.writeJson("realm.json", DEFAULT_REALM_CONFIG);
        return DEFAULT_REALM_CONFIG;
      }
      throw new RealmStateError(`cannot read realm config: ${(error as Error).message}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new RealmStateError(`realm config ${path} is not valid JSON`);
    }
    return validateRealmConfig(parsed);
  }

  private loadJson<T>(name: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(join(this.dataDir, name), "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return fallback;
      }
      throw new RealmStateError(
        `cannot read realm state file ${name}: ${(error as Error).message}`,
      );
    }
  }

  private writeJson(name: string, value: unknown): void {
    const path = join(this.dataDir, name);
    const tmpPath = `${path}.tmp-${process.pid}`;
    writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmpPath, path);
  }
}

function validateRealmConfig(input: unknown): RealmConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RealmStateError("realm config must be a JSON object");
  }
  const record = input as Record<string, unknown>;
  const user = record.user as Record<string, unknown> | undefined;
  if (
    !user ||
    typeof user.participantId !== "string" ||
    user.participantId.trim().length === 0 ||
    typeof user.displayName !== "string" ||
    user.displayName.trim().length === 0
  ) {
    throw new RealmStateError("realm config: user.participantId and user.displayName are required");
  }
  if (!Array.isArray(record.agents) || record.agents.length === 0) {
    throw new RealmStateError("realm config: agents must be a non-empty array");
  }
  const agents = record.agents.map((candidate, index) => validateAgent(candidate, index));
  const ids = new Set(agents.map((agent) => agent.agentId));
  if (ids.size !== agents.length) {
    throw new RealmStateError("realm config: agent ids must be unique");
  }
  return {
    user: { participantId: user.participantId, displayName: user.displayName },
    agents,
  };
}

function validateAgent(input: unknown, index: number): RealmPersonaConfig {
  if (typeof input !== "object" || input === null) {
    throw new RealmStateError(`realm config: agents[${index}] must be an object`);
  }
  const record = input as Record<string, unknown>;
  for (const field of ["agentId", "personaId", "displayName", "persona"] as const) {
    if (typeof record[field] !== "string" || (record[field] as string).trim().length === 0) {
      throw new RealmStateError(`realm config: agents[${index}].${field} must be a non-empty string`);
    }
  }
  const routines = Array.isArray(record.routines) ? record.routines : [];
  return {
    agentId: record.agentId as string,
    personaId: record.personaId as string,
    displayName: record.displayName as string,
    persona: record.persona as string,
    routines: routines.map((routine, routineIndex) => {
      const routineRecord = routine as Record<string, unknown>;
      if (
        typeof routineRecord.period !== "string" ||
        typeof routineRecord.locationId !== "string" ||
        typeof routineRecord.intent !== "string"
      ) {
        throw new RealmStateError(
          `realm config: agents[${index}].routines[${routineIndex}] needs period, locationId, intent`,
        );
      }
      return {
        period: routineRecord.period as RealmRoutinePeriodV1,
        locationId: routineRecord.locationId,
        intent: routineRecord.intent,
      };
    }),
  };
}
