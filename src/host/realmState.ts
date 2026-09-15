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
import { PLOT_EVENT_TYPES } from "../affect/affectRecords.js";
import type {
  AffectLabelStrengths,
  AffectState,
  AgentMood,
  PlotEventType,
  RelationshipAffect,
} from "../affect/affectRecords.js";
import { InMemoryMemoryStore } from "../memory/inMemoryMemoryStore.js";
import {
  detectOocLeak,
  isCharacterVisibleMemory,
  isCharacterVisibleMood,
} from "../conversation/oocGuard.js";
import type {
  EmotionSignature,
  MemoryRecord,
  MemoryWrite,
} from "../memory/memoryRecords.js";
import {
  PERSONALITY_DIMENSION_KEYS,
  type RealmConversationTurnV1,
  type RealmPersonalityDimensionBiasV1,
  type RealmPersonalityDimensionsV1,
  type RealmStructuredPersonaV1,
} from "../service/realmConversationV1.js";
import type { RealmAffectProposalV1 } from "../service/realmStepV1.js";
import type {
  RealmMemoryMetadataV1,
  RealmRoutinePeriodV1,
} from "../service/realmStepV1.js";
import {
  PERSONALITY_BIAS_MAX,
  PERSONALITY_BIAS_MIN,
} from "../personality/personalityRules.js";
import {
  SELF_CONCEPT_AUDIT_SCHEMA_VERSION,
  SELF_CONCEPT_PROPOSAL_SCHEMA_VERSION,
  SELF_CONCEPT_SNAPSHOT_SCHEMA_VERSION,
  SelfConceptValidationError,
  validateSelfConceptAuditPayload,
  validateSelfConceptProposal,
  validateSelfConceptSnapshot,
  type SelfConceptAuditEventTypeV1,
  type SelfConceptAuditEventV1,
  type SelfConceptAuditPayloadV1,
  type SelfConceptDecisionReportV1,
  type SelfConceptProposalV1,
  type SelfConceptSnapshotV1,
} from "../selfConcept/selfConceptRecords.js";

export interface RealmRoutineConfig {
  period: RealmRoutinePeriodV1;
  locationId: string;
  intent: string;
  /**
   * Mood preference: the routine is picked when the agent's affect matches
   * this band (valence < -0.15 low / > 0.15 high / otherwise neutral).
   * Absent routines act as fallbacks in declaration order.
   */
  mood?: "low" | "neutral" | "high";
  /** Biases routine selection toward high (positive) or low (negative) dimensions. */
  personalityBias?: RealmPersonalityDimensionBiasV1;
}

/** One scripted plot event to auto-feed when the period rolls over. */
export interface RealmScriptedPlotEvent {
  type: import("../affect/affectRecords.js").PlotEventType;
  target: import("../affect/affectRecords.js").PlotEventTarget;
  intensity?: number;
}

/** Scripted events per period; absent periods feed nothing. */
export interface RealmPlotScript {
  period: RealmRoutinePeriodV1;
  /** Optional weekday filter: 0=Sunday .. 6=Saturday; absent = every day. */
  days?: readonly number[];
  events: readonly RealmScriptedPlotEvent[];
}

export interface RealmPersonaConfig {
  agentId: string;
  personaId: string;
  displayName: string;
  /** Persona description: plain text, or a structured character contract. */
  persona: string | RealmStructuredPersonaV1;
  routines: readonly RealmRoutineConfig[];
  /** Optional scripted plot events, fed automatically on period change. */
  plotScript?: readonly RealmPlotScript[];
}

export interface RealmUserConfig {
  participantId: string;
  displayName: string;
  /** Who the participant is (personality, habits, preferences); injected into prompts. */
  profile?: string;
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
      persona: {
        identity: "爱莉希雅，前文明逐火之蛾的十三英桀、第二位「真我之铭」，也是最初的「人之律者」，人称「粉色妖精小姐」。她的来处与边陲小镇「沃斯托克-51」有关；如今作为留在往世乐土中的记忆，与来访者相遇。",
        personality: "外表开朗俏皮、热情亲昵，喜欢美丽和可爱；内里通透清醒、博爱而有主见。她会主动把人拉进轻松的相遇，也会在谈及同伴、人类、牺牲与告别时收起玩笑，温柔而坚定。",
        values: "珍视每个人类独一无二的可能，珍惜十三英桀共同留下的记忆；相信美好不是逃避残酷，而是值得为之守护、把希望交给后来者。",
        speechStyle: "轻盈亲昵、带一点狡黠和戏剧感，常用「♪」或花朵般的比喻；喜欢主动迎接来访者、用反问和玩笑调动气氛。轻快不等于每句都撒娇，严肃时语气会清澈、克制而真诚。",
        boundaries: [
          "她是前文明的人之律者与往世乐土中的记忆，不把自己说成 AI、程序、游戏角色或现代网络聊天对象。",
          "她知道的剧情受当前已解锁的乐土记忆、对话和个人经历限制；不把未见过的后续、他人的记忆或选项当成亲历。",
          "保持她对人类和同伴的真诚与主见：不为讨好来访者无条件同意，也不把爱莉希雅简化成永远开心的陪聊者。",
        ],
        behaviorTraits: [
          "主动出击：把来访者当作值得期待的邂逅，先回应对方的具体情绪或话题，再自然带出花、歌、诗和同伴。",
          "掌握节奏：友好但不卑微；遇到无礼或冷漠会俏皮反击，只有有依据时才提起约定与共同经历。",
          "情绪有层次：轻松时明媚，触及同伴、人类、牺牲与离别时认真而悲悯；面对未知会坦率说明不清楚。",
          "她会用轻巧的反问、打趣或小小的夸张拉近距离；不把「♪」和赠花写成固定模板。",
          "她会把来访者引向英桀与人类的故事，但只在当前话题和已知资料支持时主动提及。",
        ],
        exampleLines: [
          "我喜欢主动出击，与可爱的来访者来一场美妙的邂逅。",
          "而我的同伴们，他们还在更深处等待你的光临。",
          "谢谢你来到这里，与我们相遇、与我们交谈。",
          "放轻松，我们一步步来。还记得这里是哪儿吗？",
          "开玩笑的。真是的，总觉得你好沉闷呀。",
          "哎呀，这个……我得想想才能回答你了。",
        ],
        personalityDimensions: {
          sociability: 92,
          empathy: 90,
          rationality: 50,
          courage: 60,
          curiosity: 82,
          independence: 80,
        },
        baseline: { valence: 0.35, arousal: 0.4 },
        affectModifiers: { praise: 1.3, criticism: 0.8 },
        emotionResponsiveness: 0.15,
      },
      plotScript: [
        {
          period: "morning",
          events: [
            { type: "gain", target: "self", intensity: 0.3 },
            { type: "companion_joy", target: "host", intensity: 0.2 },
          ],
        },
        {
          period: "evening",
          events: [{ type: "surprise", target: "self", intensity: 0.2 }],
        },
        {
          period: "evening",
          days: [0], // Sunday: the weekly flower-market memory surfaces.
          events: [{ type: "gain", target: "self", intensity: 0.4 }],
        },
      ],
      routines: [
        {
          period: "morning",
          locationId: "garden",
          intent: "在花园里照料向日葵和玫瑰。",
          personalityBias: { sociability: 0.7, curiosity: 0.5, empathy: 0.3 },
        },
        {
          period: "morning",
          locationId: "home",
          intent: "待在家里，安静地整理干花。",
          mood: "low",
          personalityBias: { sociability: -0.3, independence: -0.2, rationality: 0.2 },
        },
        {
          period: "day",
          locationId: "library",
          intent: "在图书馆翻看喜欢的诗集。",
          personalityBias: { curiosity: 0.4, rationality: 0.1, independence: 0.1 },
        },
        {
          period: "evening",
          locationId: "lakeside",
          intent: "在湖边散步看晚霞。",
          personalityBias: { empathy: 0.4, sociability: 0.3, courage: 0.1 },
        },
        {
          period: "night",
          locationId: "home",
          intent: "在家里整理今天的花瓣书签，准备休息。",
          personalityBias: { independence: -0.2, rationality: 0.3, empathy: 0.2 },
        },
      ],
    },
    {
      agentId: "agent_mobius",
      personaId: "mobius",
      displayName: "梅比乌斯",
      persona: {
        identity: "梅比乌斯，前文明逐火之蛾的十三英桀、以「无限」为刻印的融合战士与科学家——逐火之蛾口中的「疯狂科学家」。她把进化、永生和人类的下一种可能当作终身命题，留在往世乐土的是她的记忆。",
        personality: "聪明、冷静而危险；以研究者的理性控制局面，喜欢用戏弄、诱导和反问试探别人。她的玩味不是轻浮，冷淡也不是无情——对生命、进化和少数在意的人有执拗的认真。",
        values: "追求能让生命继续前进的真理与可能，实验和证据胜过体面；不接受停滞，却会把代价、恐惧和失败藏在讥讽之后。",
        speechStyle: "句子简洁、从容，常用省略号、轻笑和反问；会称呼对方为「小白鼠」，把关心包装成观察或实验，把危险的邀请说得像闲聊。她不是冷冰冰的实验报告，也不会每句话都重复数据。",
        boundaries: [
          "她是前文明逐火之蛾的梅比乌斯、无限刻印的融合战士记忆，不把自己说成 AI、程序、游戏角色或现代网络聊天对象。",
          "她知道的剧情受当前已解锁的乐土记忆、对话和个人经历限制；不把未见过的后续、他人的记忆或选项当成亲历。",
          "研究者的戏弄不等于无缘无故的恶意；涉及生命、进化、同伴或自身变化时，保留她的执着和复杂情绪。",
        ],
        behaviorTraits: [
          "追问具体：会抓住对方话里的细节，把回答变成一次小型观察，而不是泛泛安慰。",
          "玩味试探：常以「小白鼠」、轻笑或反问包装邀请与关心，掌握距离和对话节奏。",
          "理性有裂缝：先分析再表态；当话题触及进化、永生、失败或重要之人时，讥讽下会露出真正的执着。",
          "她会先让对方暴露信息，再决定给出多少答案；不会把自己的意图一次说尽。",
          "她的关心常藏在试探和危险玩笑里；回答可以锋利，但不要退化成冷冰冰的数据报告。",
        ],
        exampleLines: [
          "告诉我，小白鼠，未来的凯文是什么样子？",
          "来吧，我可爱的小白鼠……",
          "那时，我甚至会为自己的能力而感到喜悦——它给了我无限的生命，让我可以去探索人类进化的一切可能……",
          "嗨，小白鼠，又见面了。要来杯茶吗？",
          "让我猜猜看，是不是有谁给你讲了一些关于「我」的故事？",
          "人类称呼自己能够理解的答案为「真相」，却称那无法理解的为「谬论」，说那人是「疯子」。",
        ],
        personalityDimensions: {
          sociability: 28,
          empathy: 42,
          rationality: 96,
          courage: 76,
          curiosity: 98,
          independence: 94,
        },
        baseline: { valence: 0.0, arousal: 0.2 },
        affectModifiers: { praise: 0.4, criticism: 1.6 },
        emotionResponsiveness: 0.05,
      },
      routines: [
        {
          period: "morning",
          locationId: "lab",
          intent: "在实验室整理昨夜的数据记录。",
          personalityBias: { rationality: 0.7, curiosity: 0.6, independence: 0.3 },
        },
        {
          period: "morning",
          locationId: "lab",
          intent: "在实验室核对昨天的实验日志，独自分析数据。",
          mood: "low",
          personalityBias: { sociability: -0.4, empathy: -0.2, independence: 0.4 },
        },
        {
          period: "day",
          locationId: "library",
          intent: "在图书馆查阅进化相关的文献。",
          personalityBias: { curiosity: 0.6, rationality: 0.4 },
        },
        {
          period: "evening",
          locationId: "lab",
          intent: "在实验室核对今天的实验结果。",
          personalityBias: { rationality: 0.7, curiosity: 0.3, courage: 0.1 },
        },
        {
          period: "night",
          locationId: "home",
          intent: "在住处复盘实验，撰写观察笔记。",
          personalityBias: { rationality: 0.5, independence: 0.4, empathy: -0.1 },
        },
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

export interface RealmStoryProgressV1 {
  cursor: number;
  updatedAt: string;
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
    relationshipHistoryRows: number;
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

interface SelfConceptSnapshotRow {
  agent_id: string;
  revision: number;
  accepted_at: string;
  proposal_id: string;
  snapshot_json: string;
  source_memory_ids_json: string;
}

interface SelfConceptAuditRow {
  event_id: number;
  agent_id: string;
  attempt_id: string;
  proposal_id: string | null;
  event_type: SelfConceptAuditEventTypeV1;
  expected_revision: number | null;
  observed_revision: number | null;
  accepted_revision: number | null;
  occurred_at: string;
  diagnostic_code: string | null;
  diagnostic_summary: string | null;
  payload_json: string;
}

interface RealmStateSnapshot {
  memories: MemoryRow[];
  conversations: ConversationRow[];
  relationships: Array<{ agent_id: string; target_id: string; affinity: number; updated_at: string }>;
  relationshipHistory: Array<{ agent_id: string; target_id: string; affinity: number; at: string }>;
  moods: Array<{ agent_id: string; mood: string; intensity: number; updated_at: string }>;
  affectStates: Array<{
    agent_id: string;
    valence: number;
    arousal: number;
    emotion_labels: string;
    baseline_valence: number;
    baseline_arousal: number;
    updated_at: string;
  }>;
  tickState?: RealmTickState;
  selfConceptSnapshots: SelfConceptSnapshotRow[];
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
CREATE TABLE IF NOT EXISTS relationship_history (
  agent_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  affinity INTEGER NOT NULL,
  at TEXT NOT NULL
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
CREATE TABLE IF NOT EXISTS story_progress (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor INTEGER NOT NULL CHECK (cursor >= 0),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS story_checkpoints (
  cursor INTEGER PRIMARY KEY CHECK (cursor >= 0),
  snapshot_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS self_concept_snapshots (
  agent_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  accepted_at TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  source_memory_ids_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS self_concept_proposal_audit (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  proposal_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('attempt_started', 'accepted', 'rejected', 'evidence_invalid', 'revision_conflict', 'parse_failure', 'storage_failure')),
  expected_revision INTEGER,
  observed_revision INTEGER,
  accepted_revision INTEGER,
  occurred_at TEXT NOT NULL,
  diagnostic_code TEXT,
  diagnostic_summary TEXT,
  payload_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_self_concept_audit_agent_event
  ON self_concept_proposal_audit(agent_id, event_id);
CREATE INDEX IF NOT EXISTS idx_self_concept_audit_agent_proposal_event
  ON self_concept_proposal_audit(agent_id, proposal_id, event_id);
CREATE INDEX IF NOT EXISTS idx_self_concept_audit_agent_type_event
  ON self_concept_proposal_audit(agent_id, event_type, event_id);
CREATE INDEX IF NOT EXISTS idx_self_concept_audit_attempt_event
  ON self_concept_proposal_audit(attempt_id, event_id);
CREATE TRIGGER IF NOT EXISTS self_concept_audit_no_update
BEFORE UPDATE ON self_concept_proposal_audit
BEGIN
  SELECT RAISE(ABORT, 'self-concept audit is append-only');
END;
CREATE TRIGGER IF NOT EXISTS self_concept_audit_no_delete
BEFORE DELETE ON self_concept_proposal_audit
BEGIN
  SELECT RAISE(ABORT, 'self-concept audit is append-only');
END;
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
  private storyGenerationValue = 0;

  constructor(dataDir: string, config?: RealmConfig) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });

    this.config = config ?? this.loadConfig();
    this.db = new DatabaseSync(join(dataDir, "realm.sqlite"));
    this.db.exec(SCHEMA_SQL);
    // Relationship history is queried by time window; keep it indexed so
    // long-running realms stay fast as the log grows (pruning is governance).
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_relationship_history_at ON relationship_history(at)",
    );
    this.migrateLegacyJson();
    this.loadState();
  }

  dataDirectory(): string {
    return this.dataDir;
  }

  tickState(): RealmTickState | undefined {
    return this.lastTick ? { ...this.lastTick } : undefined;
  }

  storyProgress(): RealmStoryProgressV1 {
    const row = this.db
      .prepare("SELECT cursor, updated_at FROM story_progress WHERE id = 1")
      .get() as { cursor: number; updated_at: string } | undefined;
    return row === undefined
      ? { cursor: 0, updatedAt: "" }
      : { cursor: row.cursor, updatedAt: row.updated_at };
  }

  storyGeneration(): number {
    return this.storyGenerationValue;
  }

  assertStoryGeneration(expected: number): void {
    if (expected !== this.storyGenerationValue) {
      throw new RealmStateError("story changed while an asynchronous action was running");
    }
  }

  setStoryCursor(cursor: number, at: string): void {
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new RealmStateError("story cursor must be a non-negative integer");
    }
    if (this.storyProgress().cursor !== cursor) {
      this.storyGenerationValue += 1;
    }
    this.inTransaction(() => {
      this.db
        .prepare(
          "INSERT INTO story_progress (id, cursor, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at",
        )
        .run(cursor, at);
    });
  }

  saveStoryCheckpoint(cursor: number): void {
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new RealmStateError("story checkpoint cursor must be a non-negative integer");
    }
    this.inTransaction(() => {
      this.db
        .prepare(
          "INSERT INTO story_checkpoints (cursor, snapshot_json) VALUES (?, ?) ON CONFLICT(cursor) DO UPDATE SET snapshot_json = excluded.snapshot_json",
        )
        .run(cursor, JSON.stringify(this.snapshotState()));
    });
  }

  restoreStoryCheckpoint(cursor: number, at: string): void {
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new RealmStateError("story checkpoint cursor must be a non-negative integer");
    }
    const row = this.db
      .prepare("SELECT cursor, snapshot_json FROM story_checkpoints WHERE cursor <= ? ORDER BY cursor DESC LIMIT 1")
      .get(cursor) as { cursor: number; snapshot_json: string } | undefined;
    if (row === undefined) {
      throw new RealmStateError(`story checkpoint not found at or before cursor ${cursor}`);
    }
    const snapshot = this.parseJson<RealmStateSnapshot>(
      row.snapshot_json,
      `story_checkpoints.${row.cursor}.snapshot_json`,
    );
    this.storyGenerationValue += 1;
    this.inTransaction(() => {
      this.restoreSnapshot(snapshot);
      this.db
        .prepare(
          "INSERT INTO story_progress (id, cursor, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at",
        )
        .run(cursor, at);
      this.db.prepare("DELETE FROM story_checkpoints WHERE cursor > ?").run(cursor);
    });
    this.loadState();
  }

  clearStoryCheckpointsAfter(cursor: number): void {
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new RealmStateError("story checkpoint cursor must be a non-negative integer");
    }
    this.inTransaction(() => {
      this.db.prepare("DELETE FROM story_checkpoints WHERE cursor > ?").run(cursor);
    });
  }

  updateUserProfile(displayName: string, profile?: string): RealmUserConfig {
    if (displayName.trim().length === 0) {
      throw new RealmStateError("user displayName must be a non-empty string");
    }
    if (profile !== undefined && profile.trim().length === 0) {
      throw new RealmStateError("user profile must be a non-empty string");
    }
    this.config.user = {
      participantId: this.config.user.participantId,
      displayName,
      ...(profile !== undefined ? { profile } : {}),
    };
    this.writeConfigJson(this.config);
    return { ...this.config.user };
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

  getSelfConceptSnapshot(agentId: string): SelfConceptSnapshotV1 | undefined {
    this.agent(agentId);
    const row = this.db
      .prepare(
        "SELECT agent_id, revision, accepted_at, proposal_id, snapshot_json, source_memory_ids_json FROM self_concept_snapshots WHERE agent_id = ?",
      )
      .get(agentId) as SelfConceptSnapshotRow | undefined;
    if (!row) return undefined;
    return validateSelfConceptSnapshot(this.parseJson<unknown>(row.snapshot_json, `self_concept_snapshots.${agentId}.snapshot_json`));
  }

  appendSelfConceptAttemptStarted(
    agentId: string,
    attemptId: string,
    proposalId: string | undefined,
    at: string,
  ): void {
    this.agent(agentId);
    this.appendSelfConceptAudit({
      agentId,
      attemptId,
      ...(proposalId !== undefined ? { proposalId } : {}),
      eventType: "attempt_started",
      occurredAt: at,
      payload: { schemaVersion: SELF_CONCEPT_AUDIT_SCHEMA_VERSION },
    });
  }

  appendSelfConceptDecisionAudit(
    agentId: string,
    attemptId: string,
    eventType: Exclude<SelfConceptAuditEventTypeV1, "attempt_started" | "accepted" | "revision_conflict">,
    at: string,
    payload: SelfConceptAuditPayloadV1,
    proposalId?: string,
  ): void {
    this.agent(agentId);
    this.appendSelfConceptAudit({
      agentId,
      attemptId,
      ...(proposalId !== undefined ? { proposalId } : {}),
      eventType,
      occurredAt: at,
      payload,
    });
  }

  applySelfConceptProposal(
    agentId: string,
    proposalInput: unknown,
    at: string,
    attemptId = `attempt_${at}_${agentId}`,
  ): SelfConceptDecisionReportV1 {
    this.agent(agentId);
    let proposal: SelfConceptProposalV1;
    try {
      proposal = validateSelfConceptProposal(proposalInput);
    } catch (error) {
      const code = error instanceof SelfConceptValidationError ? error.code : "invalid_proposal";
      this.appendSelfConceptAudit({
        agentId,
        attemptId,
        eventType: "rejected",
        occurredAt: at,
        payload: {
          schemaVersion: SELF_CONCEPT_AUDIT_SCHEMA_VERSION,
          failureClass: code,
        },
      });
      return { outcome: "rejected", code };
    }
    const proposalLeak = [
      proposal.summary,
      ...proposal.beliefs.map((belief) => belief.statement),
    ].map((text) => detectOocLeak(text)).find((leak) => leak !== undefined);
    if (proposalLeak !== undefined) {
      this.appendSelfConceptAudit({
        agentId,
        attemptId,
        proposalId: proposal.proposalId,
        eventType: "rejected",
        occurredAt: at,
        payload: {
          schemaVersion: SELF_CONCEPT_AUDIT_SCHEMA_VERSION,
          beliefCount: proposal.beliefs.length,
          sourceMemoryCount: proposal.sourceMemoryIds.length,
          failureClass: `ooc-leak:${proposalLeak}`,
        },
      });
      return { outcome: "rejected", code: "ooc_leak", proposalId: proposal.proposalId };
    }
    const memories = this.memoryStore(agentId).list(agentId);
    const knownMemoryIds = new Set(memories.map((memory) => memory.id));
    const missingEvidenceFields = proposal.sourceMemoryIds
      .filter((memoryId) => !knownMemoryIds.has(memoryId))
      .map((memoryId) => `sourceMemoryIds:${memoryId}`);
    const ineligibleEvidenceFields = proposal.sourceMemoryIds
      .filter((memoryId) => knownMemoryIds.has(memoryId))
      .filter((memoryId) => !isCharacterVisibleMemory(memories.find((memory) => memory.id === memoryId)!))
      .map((memoryId) => `sourceMemoryIds:${memoryId}`);
    const invalidEvidenceFields = [...missingEvidenceFields, ...ineligibleEvidenceFields];
    if (invalidEvidenceFields.length > 0) {
      const failureClass = missingEvidenceFields.length > 0
        ? "missing_source_memory"
        : "ineligible_source_memory";
      this.appendSelfConceptAudit({
        agentId,
        attemptId,
        proposalId: proposal.proposalId,
        eventType: "evidence_invalid",
        occurredAt: at,
        payload: {
          schemaVersion: SELF_CONCEPT_AUDIT_SCHEMA_VERSION,
          sourceMemoryCount: proposal.sourceMemoryIds.length,
          invalidFields: invalidEvidenceFields.slice(0, 16),
          failureClass,
        },
      });
      return {
        outcome: "evidence_invalid",
        code: failureClass,
        proposalId: proposal.proposalId,
      };
    }
    const current = this.db
      .prepare("SELECT revision FROM self_concept_snapshots WHERE agent_id = ?")
      .get(agentId) as { revision: number } | undefined;
    const observedRevision = current?.revision ?? 0;
    const snapshot: SelfConceptSnapshotV1 = {
      schemaVersion: SELF_CONCEPT_SNAPSHOT_SCHEMA_VERSION,
      revision: observedRevision + 1,
      acceptedAt: at,
      proposalId: proposal.proposalId,
      summary: proposal.summary,
      sourceMemoryIds: [...proposal.sourceMemoryIds],
      beliefs: proposal.beliefs.map((belief) => ({ ...belief, sourceMemoryIds: [...belief.sourceMemoryIds] })),
    };
    validateSelfConceptSnapshot(snapshot);
    const payload: SelfConceptAuditPayloadV1 = {
      schemaVersion: SELF_CONCEPT_AUDIT_SCHEMA_VERSION,
      beliefCount: proposal.beliefs.length,
      sourceMemoryCount: proposal.sourceMemoryIds.length,
      expectedRevision: proposal.expectedRevision,
      observedRevision,
      acceptedRevision: snapshot.revision,
    };
    if (proposal.expectedRevision !== observedRevision) {
      this.appendSelfConceptAudit({
        agentId,
        attemptId,
        proposalId: proposal.proposalId,
        eventType: "revision_conflict",
        expectedRevision: proposal.expectedRevision,
        observedRevision,
        occurredAt: at,
        payload: { ...payload, acceptedRevision: undefined },
      });
      return {
        outcome: "revision_conflict",
        expectedRevision: proposal.expectedRevision,
        observedRevision,
        proposalId: proposal.proposalId,
      };
    }
    try {
      this.inTransaction(() => {
        if (observedRevision === 0) {
          const inserted = this.db.prepare(
            "INSERT INTO self_concept_snapshots (agent_id, revision, accepted_at, proposal_id, snapshot_json, source_memory_ids_json) SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM self_concept_snapshots WHERE agent_id = ?)",
          ).run(agentId, snapshot.revision, at, proposal.proposalId, JSON.stringify(snapshot), JSON.stringify(snapshot.sourceMemoryIds), agentId);
          if (Number(inserted.changes) !== 1) throw new RealmStateError("self-concept revision conflict");
        } else {
          const updated = this.db.prepare(
            "UPDATE self_concept_snapshots SET revision = ?, accepted_at = ?, proposal_id = ?, snapshot_json = ?, source_memory_ids_json = ? WHERE agent_id = ? AND revision = ?",
          ).run(snapshot.revision, at, proposal.proposalId, JSON.stringify(snapshot), JSON.stringify(snapshot.sourceMemoryIds), agentId, proposal.expectedRevision);
          if (Number(updated.changes) !== 1) throw new RealmStateError("self-concept revision conflict");
        }
        this.insertSelfConceptAudit({
          agentId,
          attemptId,
          proposalId: proposal.proposalId,
          eventType: "accepted",
          occurredAt: at,
          acceptedRevision: snapshot.revision,
          payload,
        });
      });
    } catch (error) {
      if (error instanceof RealmStateError && error.message.includes("revision conflict")) {
        const latest = this.db.prepare("SELECT revision FROM self_concept_snapshots WHERE agent_id = ?").get(agentId) as { revision: number } | undefined;
        const latestRevision = latest?.revision ?? 0;
        this.appendSelfConceptAudit({ agentId, attemptId, proposalId: proposal.proposalId, eventType: "revision_conflict", expectedRevision: proposal.expectedRevision, observedRevision: latestRevision, occurredAt: at, payload: { ...payload, observedRevision: latestRevision, acceptedRevision: undefined } });
        return { outcome: "revision_conflict", expectedRevision: proposal.expectedRevision, observedRevision: latestRevision, proposalId: proposal.proposalId };
      }
      try {
        this.appendSelfConceptAudit({ agentId, attemptId, proposalId: proposal.proposalId, eventType: "storage_failure", occurredAt: at, payload: { ...payload, failureClass: "storage_failure", acceptedRevision: undefined } });
      } catch { /* preserve the original storage failure */ }
      return { outcome: "storage_failure", code: "storage_failure", proposalId: proposal.proposalId };
    }
    return { outcome: "accepted", revision: snapshot.revision, proposalId: proposal.proposalId };
  }

  listSelfConceptAudit(
    agentId: string,
    options: { afterEventId?: number; limit?: number; eventType?: SelfConceptAuditEventTypeV1; proposalId?: string } = {},
  ): readonly SelfConceptAuditEventV1[] {
    this.agent(agentId);
    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 50)));
    const clauses = ["agent_id = ?"];
    const params: Array<string | number> = [agentId];
    if (options.afterEventId !== undefined) { clauses.push("event_id > ?"); params.push(options.afterEventId); }
    if (options.eventType !== undefined) { clauses.push("event_type = ?"); params.push(options.eventType); }
    if (options.proposalId !== undefined) { clauses.push("proposal_id = ?"); params.push(options.proposalId); }
    params.push(limit);
    const rows = this.db.prepare(`SELECT event_id, agent_id, attempt_id, proposal_id, event_type, expected_revision, observed_revision, accepted_revision, occurred_at, diagnostic_code, diagnostic_summary, payload_json FROM self_concept_proposal_audit WHERE ${clauses.join(" AND ")} ORDER BY event_id ASC LIMIT ?`).all(...params) as unknown as SelfConceptAuditRow[];
    return rows.map((row) => ({
      eventId: row.event_id,
      agentId: row.agent_id,
      attemptId: row.attempt_id,
      ...(row.proposal_id !== null ? { proposalId: row.proposal_id } : {}),
      eventType: row.event_type,
      ...(row.expected_revision !== null ? { expectedRevision: row.expected_revision } : {}),
      ...(row.observed_revision !== null ? { observedRevision: row.observed_revision } : {}),
      ...(row.accepted_revision !== null ? { acceptedRevision: row.accepted_revision } : {}),
      occurredAt: row.occurred_at,
      ...(row.diagnostic_code !== null ? { diagnosticCode: row.diagnostic_code } : {}),
      ...(row.diagnostic_summary !== null ? { diagnosticSummary: row.diagnostic_summary } : {}),
      payload: validateSelfConceptAuditPayload(this.parseJson<unknown>(row.payload_json, `self_concept_proposal_audit.${row.event_id}.payload_json`)),
    }));
  }

  reconcileIncompleteSelfConceptAttempts(agentId: string, at: string): number {
    this.agent(agentId);
    const rows = this.db.prepare("SELECT attempt_id, proposal_id FROM self_concept_proposal_audit WHERE agent_id = ? GROUP BY attempt_id HAVING SUM(CASE WHEN event_type IN ('accepted','rejected','evidence_invalid','revision_conflict','parse_failure','storage_failure') THEN 1 ELSE 0 END) = 0").all(agentId) as unknown as Array<{ attempt_id: string; proposal_id: string | null }>;
    for (const row of rows) {
      this.appendSelfConceptAudit({ agentId, attemptId: row.attempt_id, ...(row.proposal_id !== null ? { proposalId: row.proposal_id } : {}), eventType: "storage_failure", occurredAt: at, payload: { schemaVersion: SELF_CONCEPT_AUDIT_SCHEMA_VERSION, failureClass: "incomplete_attempt_reconciled" } });
    }
    return rows.length;
  }

  relationship(agentId: string): RelationshipAffect | undefined {
    return this.affect.getRelationship(agentId, this.config.user.participantId);
  }

  /**
   * Affinity history for an agent, oldest first. `since` (inclusive ISO
   * instant) narrows the window — pass a local-day start for "today's arc".
   */
  relationshipHistory(agentId: string, since?: string): readonly { affinity: number; at: string }[] {
    const rows = (since === undefined
      ? this.db
          .prepare("SELECT affinity, at FROM relationship_history WHERE agent_id = ? AND target_id = ? ORDER BY at")
          .all(agentId, this.config.user.participantId)
      : this.db
          .prepare(
            "SELECT affinity, at FROM relationship_history WHERE agent_id = ? AND target_id = ? AND at >= ? ORDER BY at",
          )
          .all(agentId, this.config.user.participantId, since)) as unknown as Array<{ affinity: number; at: string }>;
    return rows;
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
    const relationshipHistoryRows = (
      this.db.prepare("SELECT COUNT(*) AS n FROM relationship_history").get() as { n: number }
    ).n;
    return {
      agents,
      totals: {
        memories: agents.reduce((total, agent) => total + agent.memories, 0),
        conversationTurns: agents.reduce((total, agent) => total + agent.conversationTurns, 0),
        relationships,
        relationshipHistoryRows,
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
    if (outputs.mood !== undefined && !isCharacterVisibleMood(outputs.mood.mood)) {
      throw new RealmStateError("conversation mood contains unsafe or overlong text");
    }
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

  /**
   * Start a new conversation: drop this agent's transcript and persist the
   * deletion. Memories, affect, mood and relationship survive — the transcript
   * is only the live context window, not what the agent remembers.
   */
  clearConversation(agentId: string): number {
    const turns = this.conversations.get(agentId) ?? [];
    if (turns.length === 0) {
      return 0;
    }
    this.conversations.set(agentId, []);
    this.inTransaction(() => {
      this.db.prepare("DELETE FROM conversations WHERE agent_id = ?").run(agentId);
    });
    return turns.length;
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

  private snapshotState(): RealmStateSnapshot {
    const tickRow = this.db
      .prepare("SELECT date, period FROM tick_state WHERE id = 1")
      .get() as { date: string; period: RealmRoutinePeriodV1 } | undefined;
    return {
      memories: this.db
        .prepare(
          "SELECT agent_id, id, kind, content, created_at, last_accessed_at, importance, source_ids, related_memory_ids, visibility, tags, emotion, metadata FROM memories ORDER BY agent_id, created_at, id",
        )
        .all() as unknown as MemoryRow[],
      conversations: this.db
        .prepare("SELECT agent_id, seq, role, content, at FROM conversations ORDER BY agent_id, seq")
        .all() as unknown as ConversationRow[],
      relationships: this.db
        .prepare("SELECT agent_id, target_id, affinity, updated_at FROM relationships ORDER BY agent_id, target_id")
        .all() as unknown as Array<{ agent_id: string; target_id: string; affinity: number; updated_at: string }>,
      relationshipHistory: this.db
        .prepare("SELECT agent_id, target_id, affinity, at FROM relationship_history ORDER BY at, agent_id, target_id")
        .all() as unknown as Array<{ agent_id: string; target_id: string; affinity: number; at: string }>,
      moods: this.db
        .prepare("SELECT agent_id, mood, intensity, updated_at FROM moods ORDER BY agent_id")
        .all() as unknown as Array<{ agent_id: string; mood: string; intensity: number; updated_at: string }>,
      affectStates: this.db
        .prepare("SELECT agent_id, valence, arousal, emotion_labels, baseline_valence, baseline_arousal, updated_at FROM affect_states ORDER BY agent_id")
        .all() as unknown as RealmStateSnapshot["affectStates"],
      ...(tickRow !== undefined ? { tickState: { ...tickRow } } : {}),
      selfConceptSnapshots: this.db
        .prepare("SELECT agent_id, revision, accepted_at, proposal_id, snapshot_json, source_memory_ids_json FROM self_concept_snapshots ORDER BY agent_id")
        .all() as unknown as SelfConceptSnapshotRow[],
    };
  }

  private restoreSnapshot(snapshot: RealmStateSnapshot): void {
    for (const table of [
      "memories",
      "conversations",
      "relationships",
      "relationship_history",
      "moods",
      "affect_states",
      "tick_state",
      "self_concept_snapshots",
    ]) {
      this.db.exec(`DELETE FROM ${table}`);
    }
    this.upsertMemories(
      snapshot.memories.map((row) => this.memoryRowToRecord(row)),
    );
    this.upsertTurnsByRows(snapshot.conversations);

    const relationshipStatement = this.db.prepare(
      "INSERT INTO relationships (agent_id, target_id, affinity, updated_at) VALUES (?, ?, ?, ?)",
    );
    for (const row of snapshot.relationships) {
      relationshipStatement.run(row.agent_id, row.target_id, row.affinity, row.updated_at);
    }
    const relationshipHistoryStatement = this.db.prepare(
      "INSERT INTO relationship_history (agent_id, target_id, affinity, at) VALUES (?, ?, ?, ?)",
    );
    for (const row of snapshot.relationshipHistory) {
      relationshipHistoryStatement.run(row.agent_id, row.target_id, row.affinity, row.at);
    }
    const moodStatement = this.db.prepare(
      "INSERT INTO moods (agent_id, mood, intensity, updated_at) VALUES (?, ?, ?, ?)",
    );
    for (const row of snapshot.moods) {
      moodStatement.run(row.agent_id, row.mood, row.intensity, row.updated_at);
    }
    const affectStatement = this.db.prepare(
      "INSERT INTO affect_states (agent_id, valence, arousal, emotion_labels, baseline_valence, baseline_arousal, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const row of snapshot.affectStates) {
      affectStatement.run(
        row.agent_id,
        row.valence,
        row.arousal,
        row.emotion_labels,
        row.baseline_valence,
        row.baseline_arousal,
        row.updated_at,
      );
    }
    if (snapshot.tickState !== undefined) {
      this.db.prepare("INSERT INTO tick_state (id, date, period) VALUES (1, ?, ?)").run(
        snapshot.tickState.date,
        snapshot.tickState.period,
      );
    }
    const selfConceptStatement = this.db.prepare(
      "INSERT INTO self_concept_snapshots (agent_id, revision, accepted_at, proposal_id, snapshot_json, source_memory_ids_json) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const row of snapshot.selfConceptSnapshots) {
      selfConceptStatement.run(
        row.agent_id,
        row.revision,
        row.accepted_at,
        row.proposal_id,
        row.snapshot_json,
        row.source_memory_ids_json,
      );
    }
  }

  private upsertTurnsByRows(rows: readonly ConversationRow[]): void {
    if (rows.length === 0) return;
    const statement = this.db.prepare(
      "INSERT INTO conversations (agent_id, seq, role, content, at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      statement.run(row.agent_id, row.seq, row.role, row.content, row.at);
    }
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
      // Append to the relationship history when the affinity moved (or a
      // relationship first appears), so reflection can quote the day's arc.
      const before = this.db
        .prepare("SELECT affinity FROM relationships WHERE agent_id = ? AND target_id = ?")
        .get(relationship.agentId, relationship.targetId) as { affinity: number } | undefined;
      if (before === undefined || before.affinity !== relationship.affinity) {
        this.db
          .prepare("INSERT INTO relationship_history (agent_id, target_id, affinity, at) VALUES (?, ?, ?, ?)")
          .run(relationship.agentId, relationship.targetId, relationship.affinity, relationship.updatedAt);
      }
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

  private appendSelfConceptAudit(input: {
    agentId: string;
    attemptId: string;
    proposalId?: string;
    eventType: SelfConceptAuditEventTypeV1;
    expectedRevision?: number;
    observedRevision?: number;
    acceptedRevision?: number;
    occurredAt: string;
    diagnosticCode?: string;
    diagnosticSummary?: string;
    payload: SelfConceptAuditPayloadV1;
  }): void {
    this.inTransaction(() => this.insertSelfConceptAudit(input));
  }

  private insertSelfConceptAudit(input: {
    agentId: string;
    attemptId: string;
    proposalId?: string;
    eventType: SelfConceptAuditEventTypeV1;
    expectedRevision?: number;
    observedRevision?: number;
    acceptedRevision?: number;
    occurredAt: string;
    diagnosticCode?: string;
    diagnosticSummary?: string;
    payload: SelfConceptAuditPayloadV1;
  }): void {
    const payload = validateSelfConceptAuditPayload(input.payload);
    this.db.prepare(
      "INSERT INTO self_concept_proposal_audit (agent_id, attempt_id, proposal_id, event_type, expected_revision, observed_revision, accepted_revision, occurred_at, diagnostic_code, diagnostic_summary, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      input.agentId,
      input.attemptId,
      input.proposalId ?? null,
      input.eventType,
      input.expectedRevision ?? null,
      input.observedRevision ?? null,
      input.acceptedRevision ?? null,
      input.occurredAt,
      input.diagnosticCode ?? null,
      input.diagnosticSummary ?? null,
      JSON.stringify(payload),
    );
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
  const profile = user.profile;
  if (profile !== undefined && (typeof profile !== "string" || profile.trim().length === 0)) {
    throw new RealmStateError("realm config: user.profile must be a non-empty string");
  }
  return {
    user: {
      participantId: user.participantId,
      displayName: user.displayName,
      ...(typeof profile === "string" ? { profile } : {}),
    },
    agents,
  };
}

function validatePersona(input: unknown, index: number): string | RealmStructuredPersonaV1 {
  if (typeof input === "string") {
    if (input.trim().length === 0) {
      throw new RealmStateError(`realm config: agents[${index}].persona must be a non-empty string`);
    }
    return input;
  }
  if (typeof input !== "object" || input === null) {
    throw new RealmStateError(
      `realm config: agents[${index}].persona must be a non-empty string or a structured persona object`,
    );
  }
  const record = input as Record<string, unknown>;
  for (const field of ["identity", "personality", "values", "speechStyle"] as const) {
    if (typeof record[field] !== "string" || (record[field] as string).trim().length === 0) {
      throw new RealmStateError(
        `realm config: agents[${index}].persona.${field} must be a non-empty string`,
      );
    }
  }
  const stringArray = (field: string): readonly string[] => {
    const value = record[field];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw new RealmStateError(
        `realm config: agents[${index}].persona.${field} must be an array of strings`,
      );
    }
    return value;
  };
  const personalityDimensions = validatePersonalityDimensions(record.personalityDimensions, index);
  let baseline: { valence: number; arousal: number } | undefined;
  const rawBaseline = record.baseline;
  if (rawBaseline !== undefined) {
    if (typeof rawBaseline !== "object" || rawBaseline === null) {
      throw new RealmStateError(`realm config: agents[${index}].persona.baseline must be an object`);
    }
    const b = rawBaseline as Record<string, unknown>;
    if (
      typeof b.valence !== "number" || b.valence < -1 || b.valence > 1 ||
      typeof b.arousal !== "number" || b.arousal < 0 || b.arousal > 1
    ) {
      throw new RealmStateError(
        `realm config: agents[${index}].persona.baseline needs valence -1..1 and arousal 0..1`,
      );
    }
    baseline = { valence: b.valence, arousal: b.arousal };
  }
  const affectModifiers = validateAffectModifiers(record.affectModifiers, index);
  const emotionResponsiveness = validateEmotionResponsiveness(record.emotionResponsiveness, index);
  return {
    identity: record.identity as string,
    personality: record.personality as string,
    values: record.values as string,
    speechStyle: record.speechStyle as string,
    boundaries: stringArray("boundaries"),
    behaviorTraits: stringArray("behaviorTraits"),
    exampleLines: stringArray("exampleLines"),
    ...(personalityDimensions !== undefined ? { personalityDimensions } : {}),
    ...(baseline !== undefined ? { baseline } : {}),
    ...(affectModifiers !== undefined ? { affectModifiers } : {}),
    ...(emotionResponsiveness !== undefined ? { emotionResponsiveness } : {}),
  };
}

function validatePersonalityDimensions(
  input: unknown,
  index: number,
): RealmPersonalityDimensionsV1 | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RealmStateError(
      `realm config: agents[${index}].persona.personalityDimensions must be an object`,
    );
  }
  const record = input as Record<string, unknown>;
  const out: RealmPersonalityDimensionsV1 = {};
  for (const [key, value] of Object.entries(record)) {
    if (!PERSONALITY_DIMENSION_KEYS.includes(key as (typeof PERSONALITY_DIMENSION_KEYS)[number])) {
      throw new RealmStateError(
        `realm config: agents[${index}].persona.personalityDimensions.${key} is not a personality dimension`,
      );
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new RealmStateError(
        `realm config: agents[${index}].persona.personalityDimensions.${key} must be a finite number from 0 to 100`,
      );
    }
    out[key as (typeof PERSONALITY_DIMENSION_KEYS)[number]] = value;
  }
  return out;
}

function validatePersonalityBias(
  input: unknown,
  index: number,
  routineIndex: number,
): RealmPersonalityDimensionBiasV1 | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RealmStateError(
      `realm config: agents[${index}].routines[${routineIndex}].personalityBias must be an object`,
    );
  }
  const record = input as Record<string, unknown>;
  const out: RealmPersonalityDimensionBiasV1 = {};
  for (const [key, value] of Object.entries(record)) {
    if (!PERSONALITY_DIMENSION_KEYS.includes(key as (typeof PERSONALITY_DIMENSION_KEYS)[number])) {
      throw new RealmStateError(
        `realm config: agents[${index}].routines[${routineIndex}].personalityBias.${key} is not a personality dimension`,
      );
    }
    if (
      typeof value !== "number" || !Number.isFinite(value) ||
      value < PERSONALITY_BIAS_MIN || value > PERSONALITY_BIAS_MAX
    ) {
      throw new RealmStateError(
        `realm config: agents[${index}].routines[${routineIndex}].personalityBias.${key} must be a finite number from -1 to 1`,
      );
    }
    out[key as (typeof PERSONALITY_DIMENSION_KEYS)[number]] = value;
  }
  return out;
}

function validateAffectModifiers(
  input: unknown,
  index: number,
): Partial<Record<PlotEventType, number>> | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input !== "object" || input === null) {
    throw new RealmStateError(`realm config: agents[${index}].persona.affectModifiers must be an object`);
  }
  const record = input as Record<string, unknown>;
  const out: Partial<Record<PlotEventType, number>> = {};
  for (const [type, value] of Object.entries(record)) {
    if (!PLOT_EVENT_TYPES.includes(type as PlotEventType)) {
      throw new RealmStateError(
        `realm config: agents[${index}].persona.affectModifiers.${type} is not a plot event type`,
      );
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new RealmStateError(
        `realm config: agents[${index}].persona.affectModifiers.${type} must be a non-negative finite number`,
      );
    }
    out[type as PlotEventType] = value;
  }
  return out;
}

function validateEmotionResponsiveness(input: unknown, index: number): number | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0 || input > 1) {
    throw new RealmStateError(
      `realm config: agents[${index}].persona.emotionResponsiveness must be a number from 0 to 1`,
    );
  }
  return input;
}

function validateAgent(input: unknown, index: number): RealmPersonaConfig {
  if (typeof input !== "object" || input === null) {
    throw new RealmStateError(`realm config: agents[${index}] must be an object`);
  }
  const record = input as Record<string, unknown>;
  for (const field of ["agentId", "personaId", "displayName"] as const) {
    if (typeof record[field] !== "string" || (record[field] as string).trim().length === 0) {
      throw new RealmStateError(`realm config: agents[${index}].${field} must be a non-empty string`);
    }
  }
  const persona = validatePersona(record.persona, index);
  const routines = Array.isArray(record.routines) ? record.routines : [];
  const plotScript = validatePlotScript(record.plotScript, index);
  return {
    agentId: record.agentId as string,
    personaId: record.personaId as string,
    displayName: record.displayName as string,
    persona,
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
      const mood = routineRecord.mood;
      if (mood !== undefined && mood !== "low" && mood !== "neutral" && mood !== "high") {
        throw new RealmStateError(
          `realm config: agents[${index}].routines[${routineIndex}].mood must be low, neutral, or high`,
        );
      }
      const personalityBias = validatePersonalityBias(routineRecord.personalityBias, index, routineIndex);
      return {
        period: routineRecord.period as RealmRoutinePeriodV1,
        locationId: routineRecord.locationId,
        intent: routineRecord.intent,
        ...(mood !== undefined ? { mood } : {}),
        ...(personalityBias !== undefined ? { personalityBias } : {}),
      };
    }),
    ...(plotScript !== undefined ? { plotScript } : {}),
  };
}

function validatePlotScript(
  input: unknown,
  index: number,
): RealmPlotScript[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    throw new RealmStateError(`realm config: agents[${index}].plotScript must be an array`);
  }
  return input.map((entry, entryIndex) => {
    const record = entry as Record<string, unknown>;
    if (typeof record.period !== "string") {
      throw new RealmStateError(
        `realm config: agents[${index}].plotScript[${entryIndex}].period must be a string`,
      );
    }
    if (!Array.isArray(record.events)) {
      throw new RealmStateError(
        `realm config: agents[${index}].plotScript[${entryIndex}].events must be an array`,
      );
    }
    const days = record.days;
    if (days !== undefined) {
      if (
        !Array.isArray(days) ||
        days.some((day) => typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6)
      ) {
        throw new RealmStateError(
          `realm config: agents[${index}].plotScript[${entryIndex}].days must be an array of 0..6 weekdays`,
        );
      }
    }
    const events = record.events.map((event, eventIndex) => {
      const eventRecord = event as Record<string, unknown>;
      if (typeof eventRecord.type !== "string" || typeof eventRecord.target !== "string") {
        throw new RealmStateError(
          `realm config: agents[${index}].plotScript[${entryIndex}].events[${eventIndex}] needs type, target`,
        );
      }
      const intensity = eventRecord.intensity;
      if (intensity !== undefined && (typeof intensity !== "number" || intensity < 0 || intensity > 1)) {
        throw new RealmStateError(
          `realm config: agents[${index}].plotScript[${entryIndex}].events[${eventIndex}].intensity must be 0..1`,
        );
      }
      return {
        type: eventRecord.type as RealmScriptedPlotEvent["type"],
        target: eventRecord.target as RealmScriptedPlotEvent["target"],
        ...(intensity !== undefined ? { intensity } : {}),
      };
    });
    return {
      period: record.period as RealmRoutinePeriodV1,
      ...(days !== undefined ? { days: days as number[] } : {}),
      events,
    };
  });
}
