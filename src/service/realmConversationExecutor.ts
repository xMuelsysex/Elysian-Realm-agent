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
import type { AffectState, AgentMood, RelationshipAffect } from "../affect/affectRecords.js";
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
    ...(mood ? { mood } : {}),
    ...(affect ? { affect } : {}),
    history,
    message,
    ...(options ? { options } : {}),
  };
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
  return {
    identity: input.identity as string,
    personality: input.personality as string,
    values: input.values as string,
    speechStyle: input.speechStyle as string,
    boundaries: stringArray("boundaries"),
    behaviorTraits: stringArray("behaviorTraits"),
    exampleLines: stringArray("exampleLines"),
  };
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
