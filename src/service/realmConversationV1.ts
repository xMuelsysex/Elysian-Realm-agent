// realm-conversation.v1: stateless single-turn conversation contract.
//
// The host owns conversation history, memory streams, and affect state; each
// request carries everything needed. The service returns the reply plus
// PROPOSED affect changes and memory writes — the host stays authoritative
// and decides whether to apply them, mirroring the realm-agent-step contract.

import type { AgentMood, RelationshipAffect } from "../affect/affectRecords.js";
import type { MemoryWrite } from "../memory/memoryRecords.js";
import type { RealmMemoryMetadataV1, RealmMemoryRecordV1 } from "./realmStepV1.js";

export const REALM_CONVERSATION_SCHEMA_VERSION = "realm-conversation.v1" as const;

/** Default retrieval depth for conversation memory injection. */
export const DEFAULT_CONVERSATION_MEMORY_TOP_K = 5;

export interface RealmConversationAgentV1 {
  agentId: string;
  personaId: string;
  displayName: string;
  /** Persona description injected into the system prompt. */
  persona: string;
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
