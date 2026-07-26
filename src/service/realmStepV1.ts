import type {
  MemoryRecord,
  PhaseDiagnostic,
  ReflectionDiagnostic,
  ReflectionStatus,
  ReflectionTrigger,
} from "../index.js";

export const REALM_AGENT_STEP_SCHEMA_VERSION = "realm-agent-step.v1" as const;

export type RealmRoutinePeriodV1 = "morning" | "day" | "evening" | "night";

export interface RealmActiveRoutineV1 {
  personaId: string;
  period: RealmRoutinePeriodV1;
  index: number;
  routineId: string;
  planId: string;
  locationId: string;
  intent: string;
}

export interface RealmPlanActionV1 {
  id: string;
  kind: string;
  startsAt?: string;
  endsAt?: string;
  locationId?: string;
  targetAgentId?: string;
  intent: string;
}

export interface RealmAgentPerceptionV1 {
  agentId: string;
  personaId: string;
  displayName: string;
  status: string;
  locationId: string;
  period: RealmRoutinePeriodV1;
  currentActionId?: string;
  inProgressOperationId?: string;
  nearbyAgentIds: readonly string[];
  activeRoutine?: RealmActiveRoutineV1;
}

export interface RealmMemoryMetadataV1 {
  /** Present on step-produced memories; conversation memories carry conversationId instead. */
  stepId?: string;
  source: "engine" | "seed" | "conversation";
  period?: RealmRoutinePeriodV1;
  locationId?: string;
  proposalKind?: string;
  planId?: string;
  llmOperationId?: string;
  reviewedBy?: string;
  proposalAction?: string;
  triggerKind?: string;
  reflectionSource?: "deterministic";
  conversationId?: string;
  messageId?: string;
  inputId?: string;
  messageRole?: "incoming" | "response";
  responseProvenance?: "user-reviewed-llm-conversation";
  responseTone?: string;
  shouldContinue?: boolean;
}

export type RealmMemoryRecordV1 = MemoryRecord<RealmMemoryMetadataV1>;

export interface RealmAgentStepInputV1 {
  perception: RealmAgentPerceptionV1;
  memories: readonly RealmMemoryRecordV1[];
  skipCognitiveTick?: boolean;
}

export interface RealmAgentStepRequestV1 {
  schemaVersion: typeof REALM_AGENT_STEP_SCHEMA_VERSION;
  stepId: string;
  now: string;
  agents: readonly RealmAgentStepInputV1[];
}

export interface RealmReflectionDiagnosticV1 {
  agentId: string;
  status: ReflectionStatus;
  evidenceMemoryIds: readonly string[];
  persistedMemoryIds: readonly string[];
  diagnostics: readonly ReflectionDiagnostic[];
  reason?: string;
  trigger?: ReflectionTrigger;
}

export interface RealmAgentStepOutputV1 {
  agentId: string;
  phases: readonly PhaseDiagnostic[];
  proposal?: RealmPlanActionV1;
  activeRoutine?: RealmActiveRoutineV1;
  memories: readonly RealmMemoryRecordV1[];
  reflection: RealmReflectionDiagnosticV1;
}

export interface RealmAgentStepResponseV1 {
  schemaVersion: typeof REALM_AGENT_STEP_SCHEMA_VERSION;
  stepId: string;
  agents: readonly RealmAgentStepOutputV1[];
}

export interface AgentServiceErrorBody {
  error: {
    code: string;
    message: string;
  };
}
