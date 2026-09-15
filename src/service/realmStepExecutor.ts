import {
  InMemoryMemoryStore,
  SimulationAgentRuntime,
  runReflectionSync,
  type MemoryRetrievalHit,
  type MemoryRetrievalQuery,
  type MemoryWrite,
  type ReflectionDiagnostic,
  type ReflectionPlanner,
} from "../index.js";
import { AffectValidationError, validateAffectState, validatePlotEvent } from "../affect/affectValidation.js";
import type { AffectState, PlotEvent } from "../affect/affectRecords.js";
import {
  applyPlotEvents,
  computeAffinityDelta,
  createInitialAffectState,
} from "../affect/plotRules.js";
import {
  REALM_AGENT_STEP_SCHEMA_VERSION,
  type RealmActiveRoutineV1,
  type RealmAffectProposalV1,
  type RealmAgentPerceptionV1,
  type RealmAgentStepInputV1,
  type RealmAgentStepOutputV1,
  type RealmAgentStepRequestV1,
  type RealmAgentStepResponseV1,
  type RealmMemoryMetadataV1,
  type RealmMemoryRecordV1,
  type RealmPlanActionV1,
  type RealmReflectionDiagnosticV1,
  type RealmRoutinePeriodV1,
} from "./realmStepV1.js";

const REFLECTION_EVIDENCE_LIMIT = 3;
const ROUTINE_PERIODS = new Set<RealmRoutinePeriodV1>(["morning", "day", "evening", "night"]);

export class RealmAgentStepValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealmAgentStepValidationError";
  }
}

export function executeRealmAgentStepV1(input: unknown): RealmAgentStepResponseV1 {
  const request = validateRealmAgentStepRequestV1(input);
  return {
    schemaVersion: REALM_AGENT_STEP_SCHEMA_VERSION,
    stepId: request.stepId,
    agents: request.agents.map((agent) => executeAgent(request, agent)),
  };
}

export function validateRealmAgentStepRequestV1(input: unknown): RealmAgentStepRequestV1 {
  if (!isRecord(input)) {
    throw new RealmAgentStepValidationError("request must be an object");
  }
  if (input.schemaVersion !== REALM_AGENT_STEP_SCHEMA_VERSION) {
    throw new RealmAgentStepValidationError(`schemaVersion must be ${REALM_AGENT_STEP_SCHEMA_VERSION}`);
  }

  const stepId = requireString(input.stepId, "stepId");
  const now = requireIsoDate(input.now, "now");
  if (!Array.isArray(input.agents) || input.agents.length === 0) {
    throw new RealmAgentStepValidationError("agents must be a non-empty array");
  }

  const agents = input.agents.map((candidate, index) => validateAgentInput(candidate, index));
  const agentIds = agents.map((agent) => agent.perception.agentId);
  if (new Set(agentIds).size !== agentIds.length) {
    throw new RealmAgentStepValidationError("agents must contain unique perception.agentId values");
  }

  return {
    schemaVersion: REALM_AGENT_STEP_SCHEMA_VERSION,
    stepId,
    now,
    agents,
  };
}

function executeAgent(
  request: RealmAgentStepRequestV1,
  input: RealmAgentStepInputV1,
): RealmAgentStepOutputV1 {
  const perception = input.perception;
  const memoryStore = new InMemoryMemoryStore<RealmMemoryMetadataV1>(input.memories);
  const affectProposal = buildAffectProposal(input, request.now);
  if (input.skipCognitiveTick) {
    return {
      agentId: perception.agentId,
      phases: [],
      memories: memoryStore.list(perception.agentId),
      reflection: runReflectionPolicy(perception, request, memoryStore),
      ...(affectProposal ? { affectProposal } : {}),
    };
  }

  const submitted: RealmPlanActionV1[] = [];
  const runtime = new SimulationAgentRuntime<
    RealmAgentPerceptionV1,
    MemoryRetrievalQuery,
    MemoryRetrievalHit<RealmMemoryMetadataV1>,
    MemoryWrite<RealmMemoryMetadataV1>,
    RealmPlanActionV1,
    RealmMemoryMetadataV1
  >({
    perception: {
      perceive: () => clonePerception(perception),
    },
    memory: memoryStore.toPort(),
    planning: createDeterministicRoutinePlanner(request.now),
    actionSink: {
      submit: (_agentId, proposal) => {
        submitted.push({ ...proposal });
      },
    },
    buildMemoryQuery: (projected) => ({
      text: [
        projected.agentId,
        projected.personaId,
        projected.status,
        projected.locationId,
        projected.period,
        projected.activeRoutine?.intent,
      ].filter(isNonEmptyString).join(" "),
      now: request.now,
      topK: 3,
      tags: [projected.agentId, projected.personaId, projected.locationId, projected.period],
    }),
    buildMemoryWrite: (projected, plan) => buildPlanMemoryWrite(
      projected,
      plan.proposal,
      request.now,
      request.stepId,
    ),
  });

  const tick = runtime.tickSync(perception.agentId, request.now);
  const proposal = tick.proposal ?? submitted[0];
  const reflection = runReflectionPolicy(perception, request, memoryStore);

  return {
    agentId: perception.agentId,
    phases: tick.phases.map((phase) => ({ ...phase })),
    ...(proposal ? { proposal: { ...proposal } } : {}),
    ...(proposal && perception.activeRoutine
      ? { activeRoutine: cloneActiveRoutine(perception.activeRoutine) }
      : {}),
    memories: memoryStore.list(perception.agentId),
    reflection,
    ...(affectProposal ? { affectProposal } : {}),
  };
}

/**
 * Deterministic affect proposal: decay the carried state toward its baseline,
 * apply the plot events, and propose the resulting affinity shift. Present
 * only when the step carried affect state or plot events.
 */
function buildAffectProposal(
  input: RealmAgentStepInputV1,
  now: string,
): RealmAffectProposalV1 | undefined {
  const events = input.plotEvents ?? [];
  if (input.affectState === undefined && events.length === 0) {
    return undefined;
  }
  const current =
    input.affectState ?? createInitialAffectState(input.perception.agentId, now);
  return {
    affect: applyPlotEvents(current, events, now),
    affinityDelta: computeAffinityDelta(events),
  };
}

function createDeterministicRoutinePlanner(startsAt: string) {
  return {
    plan: ({ perception }: { perception: RealmAgentPerceptionV1 }) => {
      if (perception.inProgressOperationId) {
        return {
          source: "skipped" as const,
          reason: `agent already has in-flight operation ${perception.inProgressOperationId}`,
        };
      }

      const routine = perception.activeRoutine;
      if (!routine) {
        return { source: "skipped" as const, reason: "no configured routine for current period" };
      }

      if (perception.currentActionId === routine.routineId && perception.locationId === routine.locationId) {
        return { source: "skipped" as const, reason: "agent is already following the active routine" };
      }

      return {
        source: "deterministic" as const,
        proposal: {
          id: routine.routineId,
          kind: "performActivity",
          startsAt,
          locationId: routine.locationId,
          intent: routine.intent,
        },
        reason: "configured routine fallback",
      };
    },
  };
}

function buildPlanMemoryWrite(
  perception: RealmAgentPerceptionV1,
  proposal: RealmPlanActionV1 | undefined,
  now: string,
  stepId: string,
): MemoryWrite<RealmMemoryMetadataV1> | undefined {
  if (!proposal) {
    return undefined;
  }

  return {
    id: sanitizeMemoryId(`memory_${stepId}_${perception.agentId}_plan`),
    kind: "plan",
    content: `我把今天的安排记下了：${proposal.intent}`,
    createdAt: now,
    importance: 4,
    sourceIds: [stepId],
    visibility: "system",
    tags: [perception.agentId, perception.personaId, perception.locationId, perception.period, proposal.kind],
    metadata: {
      stepId,
      source: "engine",
      period: perception.period,
      locationId: proposal.locationId ?? perception.locationId,
      proposalKind: proposal.kind,
      planId: proposal.id,
    },
  };
}

function runReflectionPolicy(
  perception: RealmAgentPerceptionV1,
  request: RealmAgentStepRequestV1,
  memoryStore: InMemoryMemoryStore<RealmMemoryMetadataV1>,
): RealmReflectionDiagnosticV1 {
  const records = memoryStore.list(perception.agentId);
  const currentPlanMemories = records.filter((memory) => (
    memory.kind === "plan" &&
    memory.metadata.source === "engine" &&
    memory.metadata.stepId === request.stepId &&
    memory.metadata.llmOperationId === undefined
  ));
  if (currentPlanMemories.length === 0) {
    return skippedReflection(perception.agentId, "no current-step plan memory");
  }

  if (records.some((memory) => (
    memory.kind === "reflection" &&
    memory.metadata.source === "engine" &&
    memory.metadata.stepId === request.stepId
  ))) {
    return skippedReflection(perception.agentId, "reflection already recorded for current step");
  }

  const evidence = selectReflectionEvidence(records, currentPlanMemories);
  if (evidence.length === 0) {
    return skippedReflection(perception.agentId, "no eligible non-reflection evidence");
  }

  const trigger = {
    kind: "importance-threshold" as const,
    reason: "current step produced a plan memory that crossed the reflection threshold",
    now: request.now,
    sourceIds: [...new Set([request.stepId, ...currentPlanMemories.flatMap((memory) => memory.sourceIds)])],
  };
  const result = runReflectionSync(
    {
      agentId: perception.agentId,
      trigger,
      evidence,
      maxInsights: 1,
    },
    createDeterministicReflectionPlanner(perception, request.stepId),
  );

  if (result.status !== "completed") {
    return {
      agentId: perception.agentId,
      status: result.status,
      evidenceMemoryIds: evidence.map((memory) => memory.id),
      persistedMemoryIds: [],
      diagnostics: cloneReflectionDiagnostics(result.diagnostics),
      reason: result.diagnostics[0]?.message ?? trigger.reason,
      trigger,
    };
  }

  const persistedMemoryIds: string[] = [];
  try {
    result.memoryWrites.forEach((write, index) => {
      const persisted = memoryStore.remember(perception.agentId, {
        ...write,
        id: createReflectionMemoryId(request.stepId, perception.agentId, index),
      });
      persistedMemoryIds.push(persisted.id);
    });
  } catch (error) {
    return {
      agentId: perception.agentId,
      status: "failed",
      evidenceMemoryIds: evidence.map((memory) => memory.id),
      persistedMemoryIds,
      diagnostics: [
        ...cloneReflectionDiagnostics(result.diagnostics),
        {
          status: "failed",
          phase: "output",
          message: `reflection persistence failed: ${errorMessage(error)}`,
          evidenceMemoryIds: evidence.map((memory) => memory.id),
        },
      ],
      reason: `reflection persistence failed: ${errorMessage(error)}`,
      trigger,
    };
  }

  return {
    agentId: perception.agentId,
    status: result.status,
    evidenceMemoryIds: evidence.map((memory) => memory.id),
    persistedMemoryIds,
    diagnostics: cloneReflectionDiagnostics(result.diagnostics),
    reason: result.diagnostics[0]?.message ?? trigger.reason,
    trigger,
  };
}

function createDeterministicReflectionPlanner(
  perception: RealmAgentPerceptionV1,
  stepId: string,
): ReflectionPlanner<RealmMemoryMetadataV1, RealmMemoryMetadataV1> {
  return {
    reflect: (input) => {
      const evidenceIds = input.evidence.map((memory) => memory.id);
      const plan = input.evidence.find((memory) => memory.kind === "plan");
      const importance = Math.min(9, Math.max(6, ...input.evidence.map((memory) => memory.importance + 1)));
      const activity = plan?.content.replace(/^[^：:]+[：:]\s*/, "") ?? "最近的活动";
      return {
        source: "deterministic",
        reason: `bounded engine reflection over ${evidenceIds.length} memory record(s)`,
        insights: [
          {
            content: `我把${activity}留在今天的记忆里，之后再看看它会带来什么变化。`,
            evidenceMemoryIds: evidenceIds,
            importance,
            tags: [perception.agentId, perception.personaId, "reflection", perception.period, perception.locationId],
            metadata: {
              stepId,
              source: "engine",
              period: perception.period,
              locationId: perception.locationId,
              triggerKind: input.trigger.kind,
              reflectionSource: "deterministic",
            },
          },
        ],
      };
    },
  };
}

function selectReflectionEvidence(
  records: readonly RealmMemoryRecordV1[],
  currentPlanMemories: readonly RealmMemoryRecordV1[],
): RealmMemoryRecordV1[] {
  const selectedIds = new Set(currentPlanMemories.map((memory) => memory.id));
  const supplemental = records
    .filter((memory) => memory.kind !== "reflection" && !selectedIds.has(memory.id))
    .sort(compareReflectionEvidence)
    .slice(0, Math.max(0, REFLECTION_EVIDENCE_LIMIT - currentPlanMemories.length));
  return [...currentPlanMemories, ...supplemental]
    .slice(0, REFLECTION_EVIDENCE_LIMIT)
    .map((memory) => ({
      ...memory,
      sourceIds: [...memory.sourceIds],
      relatedMemoryIds: [...memory.relatedMemoryIds],
      tags: [...memory.tags],
      metadata: { ...memory.metadata },
    }));
}

function compareReflectionEvidence(left: RealmMemoryRecordV1, right: RealmMemoryRecordV1): number {
  const importanceDelta = right.importance - left.importance;
  if (importanceDelta !== 0) return importanceDelta;
  const createdDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (createdDelta !== 0) return createdDelta;
  return left.id.localeCompare(right.id);
}

function skippedReflection(agentId: string, reason: string): RealmReflectionDiagnosticV1 {
  return {
    agentId,
    status: "skipped",
    reason,
    evidenceMemoryIds: [],
    persistedMemoryIds: [],
    diagnostics: [],
  };
}

function validateAgentInput(input: unknown, index: number): RealmAgentStepInputV1 {
  const path = `agents[${index}]`;
  if (!isRecord(input)) {
    throw new RealmAgentStepValidationError(`${path} must be an object`);
  }
  const perception = validatePerception(input.perception, `${path}.perception`);
  if (!Array.isArray(input.memories)) {
    throw new RealmAgentStepValidationError(`${path}.memories must be an array`);
  }
  for (const memory of input.memories) {
    if (!isRecord(memory) || memory.agentId !== perception.agentId) {
      throw new RealmAgentStepValidationError(`${path}.memories must belong to perception.agentId`);
    }
  }

  if (input.skipCognitiveTick !== undefined && typeof input.skipCognitiveTick !== "boolean") {
    throw new RealmAgentStepValidationError(`${path}.skipCognitiveTick must be a boolean`);
  }

  const affectState = validateAffectStateInput(input.affectState, `${path}.affectState`);
  const plotEvents = validatePlotEventsInput(input.plotEvents, `${path}.plotEvents`);

  return {
    perception,
    memories: input.memories as unknown as readonly RealmMemoryRecordV1[],
    ...(input.skipCognitiveTick === true ? { skipCognitiveTick: true } : {}),
    ...(affectState !== undefined ? { affectState } : {}),
    ...(plotEvents !== undefined ? { plotEvents } : {}),
  };
}

function validateAffectStateInput(input: unknown, path: string): AffectState | undefined {
  if (input === undefined) {
    return undefined;
  }
  try {
    validateAffectState(input as AffectState);
  } catch (error) {
    throw toValidationError(error, path);
  }
  return input as AffectState;
}

function validatePlotEventsInput(input: unknown, path: string): readonly PlotEvent[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    throw new RealmAgentStepValidationError(`${path} must be an array`);
  }
  const events = input.map((candidate, eventIndex) => {
    try {
      validatePlotEvent(candidate as PlotEvent);
    } catch (error) {
      throw toValidationError(error, `${path}[${eventIndex}]`);
    }
    return candidate as PlotEvent;
  });
  return events;
}

function toValidationError(error: unknown, path: string): RealmAgentStepValidationError {
  if (error instanceof AffectValidationError) {
    return new RealmAgentStepValidationError(`${path} is invalid: ${error.message}`);
  }
  throw error;
}

function validatePerception(input: unknown, path: string): RealmAgentPerceptionV1 {
  if (!isRecord(input)) {
    throw new RealmAgentStepValidationError(`${path} must be an object`);
  }
  const period = requireString(input.period, `${path}.period`);
  if (!ROUTINE_PERIODS.has(period as RealmRoutinePeriodV1)) {
    throw new RealmAgentStepValidationError(`${path}.period must be morning, day, evening, or night`);
  }
  if (!Array.isArray(input.nearbyAgentIds) || input.nearbyAgentIds.some((value) => typeof value !== "string")) {
    throw new RealmAgentStepValidationError(`${path}.nearbyAgentIds must be a string array`);
  }

  return {
    agentId: requireString(input.agentId, `${path}.agentId`),
    personaId: requireString(input.personaId, `${path}.personaId`),
    displayName: requireString(input.displayName, `${path}.displayName`),
    status: requireString(input.status, `${path}.status`),
    locationId: requireString(input.locationId, `${path}.locationId`),
    period: period as RealmRoutinePeriodV1,
    nearbyAgentIds: [...input.nearbyAgentIds] as string[],
    ...(optionalString(input.currentActionId, `${path}.currentActionId`) !== undefined
      ? { currentActionId: optionalString(input.currentActionId, `${path}.currentActionId`) }
      : {}),
    ...(optionalString(input.inProgressOperationId, `${path}.inProgressOperationId`) !== undefined
      ? { inProgressOperationId: optionalString(input.inProgressOperationId, `${path}.inProgressOperationId`) }
      : {}),
    ...(input.activeRoutine !== undefined
      ? { activeRoutine: validateActiveRoutine(input.activeRoutine, `${path}.activeRoutine`) }
      : {}),
  };
}

function validateActiveRoutine(input: unknown, path: string): RealmActiveRoutineV1 {
  if (!isRecord(input)) {
    throw new RealmAgentStepValidationError(`${path} must be an object`);
  }
  const period = requireString(input.period, `${path}.period`);
  if (!ROUTINE_PERIODS.has(period as RealmRoutinePeriodV1)) {
    throw new RealmAgentStepValidationError(`${path}.period must be morning, day, evening, or night`);
  }
  if (!Number.isInteger(input.index) || (input.index as number) < 0) {
    throw new RealmAgentStepValidationError(`${path}.index must be a non-negative integer`);
  }
  return {
    personaId: requireString(input.personaId, `${path}.personaId`),
    period: period as RealmRoutinePeriodV1,
    index: input.index as number,
    routineId: requireString(input.routineId, `${path}.routineId`),
    planId: requireString(input.planId, `${path}.planId`),
    locationId: requireString(input.locationId, `${path}.locationId`),
    intent: requireString(input.intent, `${path}.intent`),
  };
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RealmAgentStepValidationError(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, path);
}

function requireIsoDate(value: unknown, path: string): string {
  const text = requireString(value, path);
  if (Number.isNaN(Date.parse(text))) {
    throw new RealmAgentStepValidationError(`${path} must be a valid ISO date string`);
  }
  return text;
}

function clonePerception(perception: RealmAgentPerceptionV1): RealmAgentPerceptionV1 {
  return {
    ...perception,
    nearbyAgentIds: [...perception.nearbyAgentIds],
    activeRoutine: perception.activeRoutine ? cloneActiveRoutine(perception.activeRoutine) : undefined,
  };
}

function cloneActiveRoutine(routine: RealmActiveRoutineV1): RealmActiveRoutineV1 {
  return { ...routine };
}

function cloneReflectionDiagnostics(diagnostics: readonly ReflectionDiagnostic[]): ReflectionDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    evidenceMemoryIds: diagnostic.evidenceMemoryIds ? [...diagnostic.evidenceMemoryIds] : undefined,
  }));
}

function createReflectionMemoryId(stepId: string, agentId: string, index: number): string {
  const suffix = index === 0 ? "reflection" : `reflection_${index + 1}`;
  return sanitizeMemoryId(`memory_${stepId}_${agentId}_${suffix}`);
}

function sanitizeMemoryId(value: string): string {
  return value.replace(/[^a-z0-9_]+/gi, "_").toLowerCase();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
