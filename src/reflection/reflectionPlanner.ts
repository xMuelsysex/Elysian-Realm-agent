import type { LlmRequestOptionsLike } from "../ports/ports.js";
import type { MemoryWrite } from "../memory/memoryRecords.js";
import {
  type ReflectionInput,
  type ReflectionPlanner,
  type ReflectionPlannerOutput,
  type ReflectionResult,
} from "./reflectionRecords.js";
import {
  completedReflectionDiagnostic,
  failedDiagnostic,
  validateReflectionInput,
  validateReflectionPlannerOutput,
} from "./reflectionValidation.js";

const SYNC_REFLECTION_PROMISE_ERROR = "sync reflection received an async planner result; use runReflection for async planners";

export async function runReflection<
  EvidenceMetadata = Record<string, unknown>,
  ReflectionMetadata = Record<string, unknown>,
>(
  input: ReflectionInput<EvidenceMetadata>,
  planner: ReflectionPlanner<EvidenceMetadata, ReflectionMetadata>,
  options?: LlmRequestOptionsLike,
): Promise<ReflectionResult<ReflectionMetadata>> {
  const inputDiagnostics = validateReflectionInput(input);
  if (inputDiagnostics.length > 0) {
    return {
      status: "failed",
      memoryWrites: [],
      diagnostics: inputDiagnostics,
    };
  }

  let plannerOutput;
  try {
    plannerOutput = await planner.reflect(input, options);
  } catch (error) {
    return {
      status: "failed",
      memoryWrites: [],
      diagnostics: [failedDiagnostic("planner", `reflection planner failed: ${errorMessage(error)}`)],
    };
  }

  return buildReflectionResult(input, plannerOutput);
}

export function runReflectionSync<
  EvidenceMetadata = Record<string, unknown>,
  ReflectionMetadata = Record<string, unknown>,
>(
  input: ReflectionInput<EvidenceMetadata>,
  planner: ReflectionPlanner<EvidenceMetadata, ReflectionMetadata>,
  options?: LlmRequestOptionsLike,
): ReflectionResult<ReflectionMetadata> {
  const inputDiagnostics = validateReflectionInput(input);
  if (inputDiagnostics.length > 0) {
    return {
      status: "failed",
      memoryWrites: [],
      diagnostics: inputDiagnostics,
    };
  }

  let plannerOutput: ReflectionPlannerOutput<ReflectionMetadata> | Promise<ReflectionPlannerOutput<ReflectionMetadata>>;
  try {
    plannerOutput = planner.reflect(input, options);
    if (isPromiseLike(plannerOutput)) {
      void Promise.resolve(plannerOutput).catch(() => undefined);
      return {
        status: "failed",
        memoryWrites: [],
        diagnostics: [failedDiagnostic("planner", SYNC_REFLECTION_PROMISE_ERROR)],
      };
    }
  } catch (error) {
    return {
      status: "failed",
      memoryWrites: [],
      diagnostics: [failedDiagnostic("planner", `reflection planner failed: ${errorMessage(error)}`)],
    };
  }

  return buildReflectionResult(input, plannerOutput);
}

function buildReflectionResult<
  EvidenceMetadata,
  ReflectionMetadata = Record<string, unknown>,
>(
  input: ReflectionInput<EvidenceMetadata>,
  plannerOutput: unknown,
): ReflectionResult<ReflectionMetadata> {
  const validation = validateReflectionPlannerOutput<EvidenceMetadata, ReflectionMetadata>(input, plannerOutput);
  if (!validation.output) {
    return {
      status: "failed",
      memoryWrites: [],
      diagnostics: validation.diagnostics,
    };
  }

  const memoryWrites: Array<MemoryWrite<ReflectionMetadata>> = validation.output.insights.map((insight) => ({
    kind: "reflection",
    content: insight.content,
    createdAt: input.trigger.now,
    importance: insight.importance,
    sourceIds: [...input.trigger.sourceIds],
    relatedMemoryIds: [...insight.evidenceMemoryIds],
    visibility: "private",
    tags: [...insight.tags],
    metadata: cloneMetadata(insight.metadata),
  }));
  const evidenceMemoryIds = [...new Set(memoryWrites.flatMap((write) => write.relatedMemoryIds ?? []))];

  return {
    status: "completed",
    memoryWrites,
    diagnostics: [
      completedReflectionDiagnostic(memoryWrites.length, evidenceMemoryIds, validation.output.source),
    ],
  };
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "unknown error";
}

function cloneMetadata<Metadata>(metadata: Metadata): Metadata {
  if (Array.isArray(metadata)) {
    return [...metadata] as Metadata;
  }
  if (typeof metadata === "object" && metadata !== null) {
    return { ...metadata };
  }
  return metadata;
}
