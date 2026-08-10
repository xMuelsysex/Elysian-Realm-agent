// realm-conversation.v1: stateless single-turn conversation contract.
//
// The host owns conversation history, memory streams, and affect state; each
// request carries everything needed. The service returns the reply plus
// PROPOSED affect changes and memory writes — the host stays authoritative
// and decides whether to apply them, mirroring the realm-agent-step contract.

import type { AffectState, AgentMood, RelationshipAffect } from "../affect/affectRecords.js";
import type { EmotionSignature, MemoryWrite } from "../memory/memoryRecords.js";
import type { RealmMemoryMetadataV1, RealmMemoryRecordV1 } from "./realmStepV1.js";

export const REALM_CONVERSATION_SCHEMA_VERSION = "realm-conversation.v1" as const;

/** Default retrieval depth for conversation memory injection. */
export const DEFAULT_CONVERSATION_MEMORY_TOP_K = 5;

/**
 * Structured character contract, borrowed from the field-organization of
 * SillyTavern character-card-spec and CharacterGLM's layered persona: each
 * facet keeps a single source of truth and gets its own prompt section.
 */
export interface RealmStructuredPersonaV1 {
  /** Who the character is: name, origin, canonical facts. */
  identity: string;
  /** Stable personality traits. */
  personality: string;
  /** What the character holds dear; drives stance and reactions. */
  values: string;
  /** Speech habits: catchphrases, sentence rhythm, address style. */
  speechStyle: string;
  /** Out-of-character red lines; the character must never cross these. */
  boundaries: readonly string[];
  /** Stable behavior tendencies that steer tone and initiative. */
  behaviorTraits: readonly string[];
  /** A few in-voice sample lines anchoring the style (few-shot). */
  exampleLines: readonly string[];
  /**
   * Temperament baseline (ACT fundamental sentiments): where the affect
   * state decays back to. Absent means the engine default (0.2 / 0.3).
   */
  baseline?: { valence: number; arousal: number };
  /**
   * Per-event-type emotional response multipliers (e.g. praise: 0.5 shrugs
   * off praise, criticism: 2.0 is wounded deeply). Absent = 1 for all.
   */
  affectModifiers?: Partial<Record<import("../affect/affectRecords.js").PlotEventType, number>>;
}

export interface RealmConversationAgentV1 {
  agentId: string;
  personaId: string;
  displayName: string;
  /** Persona description: plain text, or a structured character contract. */
  persona: string | RealmStructuredPersonaV1;
}

export interface RealmConversationParticipantV1 {
  participantId: string;
  displayName: string;
}

export interface RealmConversationTurnV1 {
  role: "participant" | "agent";
  content: string;
  /** ISO timestamp of the turn, when the host tracks it; enables "time since last chat". */
  at?: string;
}

export interface RealmConversationMessageV1 {
  messageId: string;
  content: string;
}

export interface RealmConversationOptionsV1 {
  memoryTopK?: number;
}

export interface RealmConversationRequestV1 {
  schemaVersion: typeof REALM_CONVERSATION_SCHEMA_VERSION;
  conversationId: string;
  now: string;
  agent: RealmConversationAgentV1;
  participant: RealmConversationParticipantV1;
  /** The agent's memory stream as owned by the host. */
  memories: readonly RealmMemoryRecordV1[];
  /** How the agent currently feels about the participant, if established. */
  relationship?: RelationshipAffect;
  /** The agent's current mood, if established. */
  mood?: AgentMood;
  /** The agent's current plot-driven emotional state, if established. */
  affect?: AffectState;
  /** Prior turns of this conversation, oldest first. */
  history: readonly RealmConversationTurnV1[];
  /** The new incoming participant message to answer. */
  message: RealmConversationMessageV1;
  options?: RealmConversationOptionsV1;
}

export type RealmConversationAnalysisStatus = "llm" | "skipped" | "failed";

/**
 * Post-conversation affect analysis. `failed` keeps the reply usable while
 * making the analysis failure visible instead of swallowing it.
 */
export interface RealmConversationAffectV1 {
  analysis: RealmConversationAnalysisStatus;
  reason: string;
  /** Proposed affinity delta, already clamped to the per-turn bound. */
  affinityDelta?: number;
  /** Proposed mood update. */
  mood?: { mood: string; intensity: number };
  /**
   * Proposed importance (0-9) for this exchange's conversation memories:
   * promises and major events high, small talk low.
   */
  memoryImportance?: number;
  /**
   * The emotional signature this exchange leaves on the character: how the
   * agent felt at this moment. Stamped onto conversation memories when present.
   */
  emotion?: EmotionSignature;
}

export interface RealmConversationResponseV1 {
  schemaVersion: typeof REALM_CONVERSATION_SCHEMA_VERSION;
  conversationId: string;
  agentId: string;
  reply: { content: string };
  affect: RealmConversationAffectV1;
  /** Proposed memory writes for this exchange; the host applies them. */
  memoryWrites: readonly MemoryWrite<RealmMemoryMetadataV1>[];
}
