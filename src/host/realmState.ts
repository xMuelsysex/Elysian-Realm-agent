// Realm host state: the authoritative, persisted world state for a running
// realm — persona/user configuration, memory streams, affect snapshots, and
// conversation histories.
//
// Storage layout under the data directory (default ./realm-data):
//   realm.json     persona + user configuration (hand-editable)
//   realm.sqlite   memory streams, affect snapshots, conversation histories,
//                  tick state — SQLite (node:sqlite), one transaction per
//                  mutation, incremental row writes (no full snapshots)
//
// Legacy full-snapshot JSON files (memories.json / affect.json /
// conversations.json / tick.json) are imported once on first open and then
// left untouched.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { InMemoryAffectStore } from "../affect/inMemoryAffectStore.js";
import type {
  AffectLabelStrengths,
  AffectState,
  AgentMood,
  RelationshipAffect,
} from "../affect/affectRecords.js";
import { InMemoryMemoryStore } from "../memory/inMemoryMemoryStore.js";
import type {
  EmotionSignature,
  MemoryRecord,
  MemoryWrite,
} from "../memory/memoryRecords.js";
import type { RealmConversationTurnV1 } from "../service/realmConversationV1.js";
import type { RealmAffectProposalV1 } from "../service/realmStepV1.js";
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
  affectStates: AffectState[];
}

export interface RealmTickState {
  /** Local calendar date, e.g. "2026-07-26". */
  date: string;
  period: RealmRoutinePeriodV1;
}

/** Non-destructive store statistics for growth diagnostics. */
export interface RealmStoreStats {
  agents: Array<{
    agentId: string;
    displayName: string;
    memories: number;
    conversationTurns: number;
    /** Oldest memory creation time, or undefined when the agent has none. */
    oldestMemoryAt?: string;
    /** Memories untouched for at least 90 days — pruning candidates. */
    staleMemories: number;
  }>;
  totals: {
    memories: number;
    conversationTurns: number;
    relationships: number;
    moods: number;
    affectStates: number;
    staleMemories: number;
  };
  /** Size of the SQLite store file in bytes. */
  dbBytes: number;
}

/** Memories untouched for at least this long count as stale (prune candidates). */
export const MEMORY_STALE_DAYS = 90;

interface MemoryRow {
  agent_id: string;
  id: string;
  kind: string;
  content: string;
  created_at: string;
  last_accessed_at: string;
  importance: number;
  source_ids: string;
  related_memory_ids: string;
  visibility: string;
  tags: string;
  emotion: string | null;
  metadata: string;
}

interface ConversationRow {
  agent_id: string;
  seq: number;
  role: "participant" | "agent";
  content: string;
  at: string | null;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  agent_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  importance INTEGER NOT NULL,
  source_ids TEXT NOT NULL,
  related_memory_ids TEXT NOT NULL,
  visibility TEXT NOT NULL,
  tags TEXT NOT NULL,
  emotion TEXT,
  metadata TEXT NOT NULL,
  PRIMARY KEY (agent_id, id)
) STRICT;
CREATE TABLE IF NOT EXISTS conversations (
  agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  at TEXT,
  PRIMARY KEY (agent_id, seq)
) STRICT;
CREATE TABLE IF NOT EXISTS relationships (
  agent_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  affinity INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, target_id)
) STRICT;
CREATE TABLE IF NOT EXISTS moods (
  agent_id TEXT NOT NULL PRIMARY KEY,
  mood TEXT NOT NULL,
  intensity REAL NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS affect_states (
  agent_id TEXT NOT NULL PRIMARY KEY,
  valence REAL NOT NULL,
  arousal REAL NOT NULL,
  emotion_labels TEXT NOT NULL,
  baseline_valence REAL NOT NULL,
  baseline_arousal REAL NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS tick_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  date TEXT NOT NULL,
  period TEXT NOT NULL
) STRICT;
`;

/**
 * Authoritative host state. Mutations go through apply* methods which persist
 * immediately; readers get defensive copies from the underlying stores.
 */
export class RealmStateStore {
  readonly config: RealmConfig;
  private readonly dataDir: string;
  private readonly db: DatabaseSync;
  private readonly memories = new Map<string, InMemoryMemoryStore<RealmMemoryMetadataV1>>();
  private affect!: InMemoryAffectStore;
  private readonly conversations = new Map<string, RealmConversationTurnV1[]>();
  private lastTick?: RealmTickState;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });

    this.config = this.loadConfig();
    this.db = new DatabaseSync(join(dataDir, "realm.sqlite"));
    this.db.exec(SCHEMA_SQL);
    this.migrateLegacyJson();
    this.loadState();
  }

  tickState(): RealmTickState | undefined {
    return this.lastTick ? { ...this.lastTick } : undefined;
  }

  setTickState(state: RealmTickState): void {
    this.lastTick = { ...state };
    this.inTransaction(() => {
      this.db
        .prepare(
          "INSERT INTO tick_state (id, date, period) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET date = excluded.date, period = excluded.period",
        )
        .run(state.date, state.period);
    });
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

  affectState(agentId: string): AffectState | undefined {
    return this.affect.getAffectState(agentId);
  }

  /**
   * Non-destructive store statistics: counts, file size, and retention
   * diagnostics (oldest memory, 90-day-unused prune candidates). The caller
   * supplies `now` so the host clock stays the single time authority.
   */
  stats(now: string): RealmStoreStats {
    const staleBefore = new Date(Date.parse(now) - MEMORY_STALE_DAYS * 86_400_000).toISOString();
    const agents = this.config.agents.map((agent) => {
      const records = this.memoryStore(agent.agentId).list(agent.agentId);
      const oldest = records.reduce(
        (oldestAt, record) =>
          oldestAt === undefined || record.createdAt < oldestAt ? record.createdAt : oldestAt,
        undefined as string | undefined,
      );
      return {
        agentId: agent.agentId,
        displayName: agent.displayName,
        memories: records.length,
        conversationTurns: (this.conversations.get(agent.agentId) ?? []).length,
        ...(oldest !== undefined ? { oldestMemoryAt: oldest } : {}),
        staleMemories: records.filter((record) => record.lastAccessedAt < staleBefore).length,
      };
    });
    const relationships = this.config.agents.reduce(
      (total, agent) => total + this.affect.listRelationships(agent.agentId).length,
      0,
    );
    const moods = this.config.agents.filter(
      (agent) => this.affect.getMood(agent.agentId) !== undefined,
    ).length;
    const affectStates = this.config.agents.filter(
      (agent) => this.affect.getAffectState(agent.agentId) !== undefined,
    ).length;
    return {
      agents,
      totals: {
        memories: agents.reduce((total, agent) => total + agent.memories, 0),
        conversationTurns: agents.reduce((total, agent) => total + agent.conversationTurns, 0),
        relationships,
        moods,
        affectStates,
        staleMemories: agents.reduce((total, agent) => total + agent.staleMemories, 0),
      },
      dbBytes: statSync(join(this.dataDir, "realm.sqlite")).size,
    };
  }

  /**
   * Apply a proposed affect movement from a tick: replace the emotional state
   * and move affinity toward the host participant, then persist. The host
   * stays authoritative — the proposal is applied only here.
   */
  applyAffectProposal(agentId: string, proposal: RealmAffectProposalV1, now: string): void {
    this.affect.setAffectState(proposal.affect);
    if (proposal.affinityDelta !== 0) {
      this.affect.applyAffinityDelta(
        agentId,
        this.config.user.participantId,
        proposal.affinityDelta,
        now,
      );
    }
    this.inTransaction(() => {
      this.syncAffect(agentId);
    });
  }

  historyFor(agentId: string, limit?: number): readonly RealmConversationTurnV1[] {
    const turns = this.conversations.get(agentId) ?? [];
    return limit !== undefined ? turns.slice(-limit) : [...turns];
  }

  /** Apply proposed conversation outputs atomically: mutate, then persist in one transaction. */
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
    const written: MemoryRecord<RealmMemoryMetadataV1>[] = [];
    for (const write of outputs.memoryWrites) {
      written.push(store.remember(agentId, write));
    }

    const turns = this.conversations.get(agentId) ?? [];
    const baseSeq = turns.length;
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

    this.inTransaction(() => {
      this.upsertMemories(written);
      this.upsertTurns(agentId, outputs.turns, baseSeq);
      this.syncAffect(agentId);
    });
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
    this.inTransaction(() => {
      this.upsertMemories(records);
    });
    return records;
  }

  /** Apply tick-produced memories (only records the store does not know yet). */
  applyTickMemories(
    agentId: string,
    records: readonly MemoryRecord<RealmMemoryMetadataV1>[],
  ): number {
    const store = this.memoryStore(agentId);
    const known = new Set(store.list(agentId).map((record) => record.id));
    const added: MemoryRecord<RealmMemoryMetadataV1>[] = [];
    for (const record of records) {
      if (known.has(record.id)) {
        continue;
      }
      added.push(
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
        }),
      );
    }
    if (added.length > 0) {
      this.inTransaction(() => {
        this.upsertMemories(added);
      });
    }
    return added.length;
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
        this.writeConfigJson(DEFAULT_REALM_CONFIG);
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

  private writeConfigJson(value: unknown): void {
    writeConfigJsonSync(join(this.dataDir, "realm.json"), value);
  }

  private loadState(): void {
    const memoryRows = this.db
      .prepare(
        "SELECT agent_id, id, kind, content, created_at, last_accessed_at, importance, source_ids, related_memory_ids, visibility, tags, emotion, metadata FROM memories ORDER BY agent_id, created_at, id",
      )
      .all() as unknown as MemoryRow[];
    const conversationRows = this.db
      .prepare(
        "SELECT agent_id, seq, role, content, at FROM conversations ORDER BY agent_id, seq",
      )
      .all() as unknown as ConversationRow[];
    const relationships = this.db
      .prepare("SELECT agent_id, target_id, affinity, updated_at FROM relationships ORDER BY agent_id, target_id")
      .all() as unknown as Array<{ agent_id: string; target_id: string; affinity: number; updated_at: string }>;
    const moods = this.db
      .prepare("SELECT agent_id, mood, intensity, updated_at FROM moods ORDER BY agent_id")
      .all() as unknown as Array<{ agent_id: string; mood: string; intensity: number; updated_at: string }>;
    const affectStates = this.db
      .prepare("SELECT agent_id, valence, arousal, emotion_labels, baseline_valence, baseline_arousal, updated_at FROM affect_states ORDER BY agent_id")
      .all() as unknown as Array<{
      agent_id: string;
      valence: number;
      arousal: number;
      emotion_labels: string;
      baseline_valence: number;
      baseline_arousal: number;
      updated_at: string;
    }>;
    const tickRow = this.db
      .prepare("SELECT date, period FROM tick_state WHERE id = 1")
      .get() as { date: string; period: RealmRoutinePeriodV1 } | undefined;

    for (const agent of this.config.agents) {
      this.memories.set(
        agent.agentId,
        new InMemoryMemoryStore(
          memoryRows
            .filter((row) => row.agent_id === agent.agentId)
            .map((row) => this.memoryRowToRecord(row)),
        ),
      );
      this.conversations.set(
        agent.agentId,
        conversationRows
          .filter((row) => row.agent_id === agent.agentId)
          .map((row) => ({
            role: row.role,
            content: row.content,
            ...(row.at !== null ? { at: row.at } : {}),
          })),
      );
    }
    this.affect = new InMemoryAffectStore({
      relationships: relationships.map((row) => ({
        agentId: row.agent_id,
        targetId: row.target_id,
        affinity: row.affinity,
        updatedAt: row.updated_at,
      })),
      moods: moods.map((row) => ({
        agentId: row.agent_id,
        mood: row.mood,
        intensity: row.intensity,
        updatedAt: row.updated_at,
      })),
      affectStates: affectStates.map((row) => ({
        agentId: row.agent_id,
        valence: row.valence,
        arousal: row.arousal,
        emotionLabels: this.parseJson<AffectLabelStrengths>(
          row.emotion_labels,
          "affect_states.emotion_labels",
        ),
        baseline: {
          valence: row.baseline_valence,
          arousal: row.baseline_arousal,
        },
        updatedAt: row.updated_at,
      })),
    });
    this.lastTick = tickRow;
  }

  private memoryRowToRecord(row: MemoryRow): MemoryRecord<RealmMemoryMetadataV1> {
    return {
      agentId: row.agent_id,
      id: row.id,
      kind: row.kind as MemoryRecord<RealmMemoryMetadataV1>["kind"],
      content: row.content,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
      importance: row.importance,
      sourceIds: this.parseJsonArray(row.source_ids, `memories.${row.id}.source_ids`),
      relatedMemoryIds: this.parseJsonArray(
        row.related_memory_ids,
        `memories.${row.id}.related_memory_ids`,
      ),
      visibility: row.visibility as MemoryRecord<RealmMemoryMetadataV1>["visibility"],
      tags: this.parseJsonArray(row.tags, `memories.${row.id}.tags`),
      ...(row.emotion !== null
        ? { emotion: this.parseJson<EmotionSignature>(row.emotion, `memories.${row.id}.emotion`) }
        : {}),
      metadata: this.parseJson<RealmMemoryMetadataV1>(row.metadata, `memories.${row.id}.metadata`),
    };
  }

  private parseJsonArray(raw: string, where: string): string[] {
    const value = this.parseJson<unknown>(raw, where);
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw new RealmStateError(`realm state ${where} must be a JSON array of strings`);
    }
    return value;
  }

  private parseJson<T>(raw: string, where: string): T {
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new RealmStateError(`realm state ${where} is not valid JSON`);
    }
  }

  /**
   * One-shot import of the legacy full-snapshot JSON files (memories.json,
   * affect.json, conversations.json, tick.json) into the SQLite store. Runs
   * only when the store is empty and legacy files exist; legacy files are
   * left untouched.
   */
  private migrateLegacyJson(): void {
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number };
    if (count.n > 0) {
      return;
    }
    const memories = this.loadJsonFile<MemoryRecord<RealmMemoryMetadataV1>[]>(
      "memories.json",
      undefined,
    );
    if (memories === undefined) {
      return;
    }
    const affectData = this.loadJsonFile<AffectFileShape>("affect.json", undefined) ?? {
      relationships: [],
      moods: [],
      affectStates: [],
    };
    // Legacy files may predate affect states; missing keys mean empty.
    const affectRelationships = affectData.relationships ?? [];
    const affectMoods = affectData.moods ?? [];
    const affectStates = affectData.affectStates ?? [];
    const conversationData =
      this.loadJsonFile<Record<string, RealmConversationTurnV1[]>>("conversations.json", undefined) ??
      {};
    const tick = this.loadJsonFile<RealmTickState | undefined>("tick.json", undefined);

    this.inTransaction(() => {
      this.upsertMemories(memories);
      for (const [agentId, turns] of Object.entries(conversationData)) {
        this.upsertTurns(agentId, turns, 0);
      }
      for (const relationship of affectRelationships) {
        this.db
          .prepare(
            "INSERT INTO relationships (agent_id, target_id, affinity, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id, target_id) DO UPDATE SET affinity = excluded.affinity, updated_at = excluded.updated_at",
          )
          .run(relationship.agentId, relationship.targetId, relationship.affinity, relationship.updatedAt);
      }
      for (const mood of affectMoods) {
        this.db
          .prepare(
            "INSERT INTO moods (agent_id, mood, intensity, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET mood = excluded.mood, intensity = excluded.intensity, updated_at = excluded.updated_at",
          )
          .run(mood.agentId, mood.mood, mood.intensity, mood.updatedAt);
      }
      for (const state of affectStates) {
        this.db
          .prepare(
            "INSERT INTO affect_states (agent_id, valence, arousal, emotion_labels, baseline_valence, baseline_arousal, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET valence = excluded.valence, arousal = excluded.arousal, emotion_labels = excluded.emotion_labels, baseline_valence = excluded.baseline_valence, baseline_arousal = excluded.baseline_arousal, updated_at = excluded.updated_at",
          )
          .run(
            state.agentId,
            state.valence,
            state.arousal,
            JSON.stringify(state.emotionLabels),
            state.baseline.valence,
            state.baseline.arousal,
            state.updatedAt,
          );
      }
      if (tick !== undefined) {
        this.db
          .prepare("INSERT INTO tick_state (id, date, period) VALUES (1, ?, ?)")
          .run(tick.date, tick.period);
      }
    });
  }

  private loadJsonFile<T>(name: string, fallback: T | undefined): T | undefined {
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

  private upsertMemories(records: readonly MemoryRecord<RealmMemoryMetadataV1>[]): void {
    if (records.length === 0) {
      return;
    }
    const statement = this.db.prepare(
      `INSERT INTO memories (agent_id, id, kind, content, created_at, last_accessed_at, importance, source_ids, related_memory_ids, visibility, tags, emotion, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, id) DO UPDATE SET
         kind = excluded.kind,
         content = excluded.content,
         created_at = excluded.created_at,
         last_accessed_at = excluded.last_accessed_at,
         importance = excluded.importance,
         source_ids = excluded.source_ids,
         related_memory_ids = excluded.related_memory_ids,
         visibility = excluded.visibility,
         tags = excluded.tags,
         emotion = excluded.emotion,
         metadata = excluded.metadata`,
    );
    for (const record of records) {
      statement.run(
        record.agentId,
        record.id,
        record.kind,
        record.content,
        record.createdAt,
        record.lastAccessedAt,
        record.importance,
        JSON.stringify(record.sourceIds),
        JSON.stringify(record.relatedMemoryIds),
        record.visibility,
        JSON.stringify(record.tags),
        record.emotion !== undefined ? JSON.stringify(record.emotion) : null,
        JSON.stringify(record.metadata),
      );
    }
  }

  private upsertTurns(
    agentId: string,
    turns: readonly RealmConversationTurnV1[],
    baseSeq: number,
  ): void {
    if (turns.length === 0) {
      return;
    }
    const statement = this.db.prepare(
      `INSERT INTO conversations (agent_id, seq, role, content, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, seq) DO UPDATE SET role = excluded.role, content = excluded.content, at = excluded.at`,
    );
    turns.forEach((turn, index) => {
      statement.run(agentId, baseSeq + index, turn.role, turn.content, turn.at ?? null);
    });
  }

  private syncAffect(agentId: string): void {
    const state = this.affect.getAffectState(agentId);
    if (state !== undefined) {
      this.db
        .prepare(
          `INSERT INTO affect_states (agent_id, valence, arousal, emotion_labels, baseline_valence, baseline_arousal, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET
             valence = excluded.valence,
             arousal = excluded.arousal,
             emotion_labels = excluded.emotion_labels,
             baseline_valence = excluded.baseline_valence,
             baseline_arousal = excluded.baseline_arousal,
             updated_at = excluded.updated_at`,
        )
        .run(
          state.agentId,
          state.valence,
          state.arousal,
          JSON.stringify(state.emotionLabels),
          state.baseline.valence,
          state.baseline.arousal,
          state.updatedAt,
        );
    }
    const relationship = this.affect.getRelationship(agentId, this.config.user.participantId);
    if (relationship !== undefined) {
      this.db
        .prepare(
          `INSERT INTO relationships (agent_id, target_id, affinity, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(agent_id, target_id) DO UPDATE SET affinity = excluded.affinity, updated_at = excluded.updated_at`,
        )
        .run(
          relationship.agentId,
          relationship.targetId,
          relationship.affinity,
          relationship.updatedAt,
        );
    }
    const mood = this.affect.getMood(agentId);
    if (mood !== undefined) {
      this.db
        .prepare(
          `INSERT INTO moods (agent_id, mood, intensity, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET mood = excluded.mood, intensity = excluded.intensity, updated_at = excluded.updated_at`,
        )
        .run(mood.agentId, mood.mood, mood.intensity, mood.updatedAt);
    }
  }

  private inTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function writeConfigJsonSync(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
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
