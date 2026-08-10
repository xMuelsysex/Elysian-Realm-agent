// Validation and execution entry for the realm-conversation.v1 contract.
// Mirrors realmStepExecutor's style: shallow shape validation with visible
// single-message errors; deep memory validation happens at store import inside
// the runner, matching the step contract's behavior.

import {
  AffectValidationError,
  validateAffectState,
  validateImportedMood,
  validateImportedRelationship,
} from "../affect/affectValidation.js";
import { PLOT_EVENT_TYPES } from "../affect/affectRecords.js";
import type { AffectState, AgentMood, PlotEventType, RelationshipAffect } from "../affect/affectRecords.js";
import type {
  ConversationRunner,
} from "../conversation/conversationRunner.js";
import {
  REALM_CONVERSATION_SCHEMA_VERSION,
  type RealmConversationAgentV1,
  type RealmConversationMessageV1,
  type RealmConversationOptionsV1,
  type RealmConversationParticipantV1,
  type RealmConversationRequestV1,
  type RealmConversationResponseV1,
  type RealmConversationTurnV1,
  type RealmStructuredPersonaV1,
} from "./realmConversationV1.js";
import type { RealmMemoryRecordV1 } from "./realmStepV1.js";

export class RealmConversationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealmConversationValidationError";
  }
}

export async function executeRealmConversationV1(
  input: unknown,
  runner: ConversationRunner,
): Promise<RealmConversationResponseV1> {
  const request = validateRealmConversationRequestV1(input);
  return runner.run(request);
}

export function validateRealmConversationRequestV1(input: unknown): RealmConversationRequestV1 {
  if (!isRecord(input)) {
    throw new RealmConversationValidationError("request must be an object");
  }
  if (input.schemaVersion !== REALM_CONVERSATION_SCHEMA_VERSION) {
    throw new RealmConversationValidationError(
      `schemaVersion must be ${REALM_CONVERSATION_SCHEMA_VERSION}`,
    );
  }

  const conversationId = requireString(input.conversationId, "conversationId");
  const now = requireIsoDate(input.now, "now");
  const agent = validateAgent(input.agent);
  const participant = validateParticipant(input.participant);
  if (agent.agentId === participant.participantId) {
    throw new RealmConversationValidationError(
      "participant.participantId must differ from agent.agentId",
    );
  }

  const memories = validateMemories(input.memories, agent.agentId);
  const relationship = validateRelationship(input.relationship, agent, participant);
  const relationshipHistory = validateRelationshipHistory(input.relationshipHistory);
  const mood = validateMood(input.mood, agent);
  const affect = validateAffect(input.affect, agent);
  const history = validateHistory(input.history);
  const message = validateMessage(input.message);
  const options = validateOptions(input.options);

  return {
    schemaVersion: REALM_CONVERSATION_SCHEMA_VERSION,
    conversationId,
    now,
    agent,
    participant,
    memories,
    ...(relationship ? { relationship } : {}),
    ...(relationshipHistory ? { relationshipHistory } : {}),
    ...(mood ? { mood } : {}),
    ...(affect ? { affect } : {}),
    history,
    message,
    ...(options ? { options } : {}),
  };
}

function validateRelationshipHistory(
  input: unknown,
): readonly { affinity: number; at: string }[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    throw new RealmConversationValidationError("relationshipHistory must be an array");
  }
  return input.map((entry, index) => {
    const record = entry as Record<string, unknown>;
    if (
      typeof record.affinity !== "number" || !Number.isFinite(record.affinity) ||
      typeof record.at !== "string" || Number.isNaN(Date.parse(record.at))
    ) {
      throw new RealmConversationValidationError(
        `relationshipHistory[${index}] needs a finite affinity and an ISO at`,
      );
    }
    return { affinity: record.affinity, at: record.at };
  });
}

function validateAgent(input: unknown): RealmConversationAgentV1 {
  if (!isRecord(input)) {
    throw new RealmConversationValidationError("agent must be an object");
  }
  return {
    agentId: requireString(input.agentId, "agent.agentId"),
    personaId: requireString(input.personaId, "agent.personaId"),
    displayName: requireString(input.displayName, "agent.displayName"),
    persona: validatePersona(input.persona),
  };
}

function validatePersona(input: unknown): string | RealmStructuredPersonaV1 {
  if (typeof input === "string") {
    if (input.trim().length === 0) {
      throw new RealmConversationValidationError("agent.persona must be a non-empty string or structured persona");
    }
    return input;
  }
  if (!isRecord(input)) {
    throw new RealmConversationValidationError("agent.persona must be a non-empty string or structured persona");
  }
  for (const field of ["identity", "personality", "values", "speechStyle"] as const) {
    if (typeof input[field] !== "string" || (input[field] as string).trim().length === 0) {
      throw new RealmConversationValidationError(`agent.persona.${field} must be a non-empty string`);
    }
  }
  const stringArray = (field: string): readonly string[] => {
    const value = input[field];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw new RealmConversationValidationError(`agent.persona.${field} must be an array of strings`);
    }
    return value;
  };
  let baseline: { valence: number; arousal: number } | undefined;
  const rawBaseline = input.baseline;
  if (rawBaseline !== undefined) {
    if (!isRecord(rawBaseline)) {
      throw new RealmConversationValidationError("agent.persona.baseline must be an object");
    }
    if (
      typeof rawBaseline.valence !== "number" || rawBaseline.valence < -1 || rawBaseline.valence > 1 ||
      typeof rawBaseline.arousal !== "number" || rawBaseline.arousal < 0 || rawBaseline.arousal > 1
    ) {
      throw new RealmConversationValidationError("agent.persona.baseline needs valence -1..1 and arousal 0..1");
    }
    baseline = { valence: rawBaseline.valence, arousal: rawBaseline.arousal };
  }
  const affectModifiers = validateAffectModifiers(input.affectModifiers);
  const emotionResponsiveness = validateEmotionResponsiveness(input.emotionResponsiveness);
  return {
    identity: input.identity as string,
    personality: input.personality as string,
    values: input.values as string,
    speechStyle: input.speechStyle as string,
    boundaries: stringArray("boundaries"),
    behaviorTraits: stringArray("behaviorTraits"),
    exampleLines: stringArray("exampleLines"),
    ...(baseline !== undefined ? { baseline } : {}),
    ...(affectModifiers !== undefined ? { affectModifiers } : {}),
    ...(emotionResponsiveness !== undefined ? { emotionResponsiveness } : {}),
  };
}

function validateAffectModifiers(
  input: unknown,
): Partial<Record<PlotEventType, number>> | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!isRecord(input)) {
    throw new RealmConversationValidationError("agent.persona.affectModifiers must be an object");
  }
  const out: Partial<Record<PlotEventType, number>> = {};
  for (const [type, value] of Object.entries(input)) {
    if (!PLOT_EVENT_TYPES.includes(type as PlotEventType)) {
      throw new RealmConversationValidationError(
        `agent.persona.affectModifiers.${type} is not a plot event type`,
      );
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new RealmConversationValidationError(
        `agent.persona.affectModifiers.${type} must be a non-negative finite number`,
      );
    }
    out[type as PlotEventType] = value;
  }
  return out;
}

function validateEmotionResponsiveness(input: unknown): number | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0 || input > 1) {
    throw new RealmConversationValidationError(
      "agent.persona.emotionResponsiveness must be a number from 0 to 1",
    );
  }
  return input;
}

function validateParticipant(input: unknown): RealmConversationParticipantV1 {
  if (!isRecord(input)) {
    throw new RealmConversationValidationError("participant must be an object");
  }
  return {
    participantId: requireString(input.participantId, "participant.participantId"),
    displayName: requireString(input.displayName, "participant.displayName"),
  };
}

function validateMemories(input: unknown, agentId: string): readonly RealmMemoryRecordV1[] {
  if (!Array.isArray(input)) {
    throw new RealmConversationValidationError("memories must be an array");
  }
  for (const memory of input) {
    if (!isRecord(memory) || memory.agentId !== agentId) {
      throw new RealmConversationValidationError("memories must belong to agent.agentId");
    }
  }
  return input as unknown as readonly RealmMemoryRecordV1[];
}

function validateRelationship(
  input: unknown,
  agent: RealmConversationAgentV1,
  participant: RealmConversationParticipantV1,
): RelationshipAffect | undefined {
  if (input === undefined) {
    return undefined;
  }
  const relationship = input as RelationshipAffect;
  try {
    validateImportedRelationship(relationship);
  } catch (error) {
    throw toValidationError(error, "relationship");
  }
  if (relationship.agentId !== agent.agentId || relationship.targetId !== participant.participantId) {
    throw new RealmConversationValidationError(
      "relationship must be directed from agent.agentId to participant.participantId",
    );
  }
  return relationship;
}

function validateMood(input: unknown, agent: RealmConversationAgentV1): AgentMood | undefined {
  if (input === undefined) {
    return undefined;
  }
  const mood = input as AgentMood;
  try {
    validateImportedMood(mood);
  } catch (error) {
    throw toValidationError(error, "mood");
  }
  if (mood.agentId !== agent.agentId) {
    throw new RealmConversationValidationError("mood.agentId must equal agent.agentId");
  }
  return mood;
}

function validateAffect(input: unknown, agent: RealmConversationAgentV1): AffectState | undefined {
  if (input === undefined) {
    return undefined;
  }
  const affect = input as AffectState;
  try {
    validateAffectState(affect);
  } catch (error) {
    throw toValidationError(error, "affect");
  }
  if (affect.agentId !== agent.agentId) {
    throw new RealmConversationValidationError("affect.agentId must equal agent.agentId");
  }
  return affect;
}

function validateHistory(input: unknown): readonly RealmConversationTurnV1[] {
  if (input === undefined) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw new RealmConversationValidationError("history must be an array");
  }
  return input.map((turn, index) => {
    if (!isRecord(turn)) {
      throw new RealmConversationValidationError(`history[${index}] must be an object`);
    }
    if (turn.role !== "participant" && turn.role !== "agent") {
      throw new RealmConversationValidationError(
        `history[${index}].role must be "participant" or "agent"`,
      );
    }
    return {
      role: turn.role,
      content: requireString(turn.content, `history[${index}].content`),
    };
  });
}

function validateMessage(input: unknown): RealmConversationMessageV1 {
  if (!isRecord(input)) {
    throw new RealmConversationValidationError("message must be an object");
  }
  return {
    messageId: requireString(input.messageId, "message.messageId"),
    content: requireString(input.content, "message.content"),
  };
}

function validateOptions(input: unknown): RealmConversationOptionsV1 | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!isRecord(input)) {
    throw new RealmConversationValidationError("options must be an object");
  }
  if (input.memoryTopK === undefined) {
    return {};
  }
  if (!Number.isInteger(input.memoryTopK) || (input.memoryTopK as number) <= 0) {
    throw new RealmConversationValidationError("options.memoryTopK must be a positive integer");
  }
  return { memoryTopK: input.memoryTopK as number };
}

function toValidationError(error: unknown, path: string): RealmConversationValidationError {
  if (error instanceof AffectValidationError) {
    return new RealmConversationValidationError(`${path} is invalid: ${error.message}`);
  }
  throw error;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RealmConversationValidationError(`${path} must be a non-empty string`);
  }
  return value;
}

function requireIsoDate(value: unknown, path: string): string {
  const text = requireString(value, path);
  if (Number.isNaN(Date.parse(text))) {
    throw new RealmConversationValidationError(`${path} must be a valid ISO date string`);
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
