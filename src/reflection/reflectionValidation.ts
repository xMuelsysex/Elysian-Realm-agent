import {
  MEMORY_IMPORTANCE_MAX,
  MEMORY_IMPORTANCE_MIN,
} from "../memory/memoryRecords.js";
import {
  REFLECTION_OUTPUT_SOURCES,
  REFLECTION_TRIGGER_KINDS,
  type NormalizedReflectionInsight,
  type NormalizedReflectionPlannerOutput,
  type ReflectionDiagnostic,
  type ReflectionInput,
  type ReflectionOutputSource,
  type ReflectionTriggerKind,
} from "./reflectionRecords.js";

interface PlannerOutputValidationResult<ReflectionMetadata> {
  diagnostics: readonly ReflectionDiagnostic[];
  output?: NormalizedReflectionPlannerOutput<ReflectionMetadata>;
}

interface PlannerOutputCandidate {
  source?: unknown;
  insights?: unknown;
  reason?: unknown;
}

interface ReflectionInsightCandidate<ReflectionMetadata> {
  content?: unknown;
  evidenceMemoryIds?: unknown;
  importance?: unknown;
  tags?: unknown;
  metadata?: ReflectionMetadata;
}

export function validateReflectionInput<EvidenceMetadata>(
  input: ReflectionInput<EvidenceMetadata>,
): readonly ReflectionDiagnostic[] {
  const diagnostics: ReflectionDiagnostic[] = [];

  pushNonEmptyStringDiagnostic(input.agentId, "input", "input.agentId", diagnostics);
  validateTriggerKind(input.trigger.kind, diagnostics);
  pushNonEmptyStringDiagnostic(input.trigger.reason, "input", "input.trigger.reason", diagnostics);
  pushIsoDateDiagnostic(input.trigger.now, "input", "input.trigger.now", diagnostics);
  pushStringArrayDiagnostic(input.trigger.sourceIds, "input", "input.trigger.sourceIds", diagnostics, { required: true });

  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    diagnostics.push(failedDiagnostic("input", "input.evidence must be a non-empty memory array"));
  } else {
    for (const evidence of input.evidence) {
      if (evidence.agentId !== input.agentId) {
        diagnostics.push(
          failedDiagnostic("input", `evidence memory ${evidence.id} must belong to input.agentId`, [evidence.id]),
        );
      }
    }
  }

  if (input.maxInsights !== undefined && (!Number.isInteger(input.maxInsights) || input.maxInsights <= 0)) {
    diagnostics.push(failedDiagnostic("input", "input.maxInsights must be a positive integer"));
  }

  return diagnostics;
}

export function validateReflectionPlannerOutput<
  EvidenceMetadata,
  ReflectionMetadata = Record<string, unknown>,
>(
  input: ReflectionInput<EvidenceMetadata>,
  output: unknown,
): PlannerOutputValidationResult<ReflectionMetadata> {
  const diagnostics: ReflectionDiagnostic[] = [];
  const plannerOutput = asPlannerOutput(output);

  if (!plannerOutput) {
    return {
      diagnostics: [failedDiagnostic("output", "plannerOutput must be an object")],
    };
  }

  const source = validateOutputSource(plannerOutput.source, diagnostics);
  pushNonEmptyStringDiagnostic(plannerOutput.reason, "output", "plannerOutput.reason", diagnostics, source);
  const reason = typeof plannerOutput.reason === "string" ? plannerOutput.reason : "";

  const plannerInsights = Array.isArray(plannerOutput.insights) ? plannerOutput.insights : [];

  if (plannerInsights.length === 0) {
    diagnostics.push(failedDiagnostic("output", "plannerOutput.insights must be a non-empty array", undefined, source));
  }

  const evidenceIds = new Set(input.evidence.map((memory) => memory.id));
  const maxInsights = input.maxInsights ?? plannerInsights.length;
  const normalizedInsights: Array<NormalizedReflectionInsight<ReflectionMetadata>> = [];

  if (plannerInsights.length > 0) {
    plannerInsights.slice(0, maxInsights).forEach((insight, index) => {
      const normalized = normalizeInsight<EvidenceMetadata, ReflectionMetadata>(
        input,
        evidenceIds,
        insight,
        index,
        diagnostics,
        source,
      );
      if (normalized) {
        normalizedInsights.push(normalized);
      }
    });
  }

  if (diagnostics.length > 0) {
    return { diagnostics };
  }

  return {
    diagnostics: [],
    output: {
      source,
      reason,
      insights: normalizedInsights,
    },
  };
}

export function completedReflectionDiagnostic(
  writeCount: number,
  evidenceMemoryIds: readonly string[],
  source: ReflectionOutputSource,
): ReflectionDiagnostic {
  return {
    status: "completed",
    phase: "output",
    message: `created ${writeCount} reflection memory write(s)`,
    evidenceMemoryIds: [...evidenceMemoryIds],
    source,
  };
}

export function failedDiagnostic(
  phase: ReflectionDiagnostic["phase"],
  message: string,
  evidenceMemoryIds?: readonly string[],
  source?: ReflectionOutputSource,
): ReflectionDiagnostic {
  return {
    status: "failed",
    phase,
    message,
    evidenceMemoryIds: evidenceMemoryIds ? [...evidenceMemoryIds] : undefined,
    source,
  };
}

function normalizeInsight<EvidenceMetadata, ReflectionMetadata>(
  input: ReflectionInput<EvidenceMetadata>,
  evidenceIds: ReadonlySet<string>,
  insight: unknown,
  index: number,
  diagnostics: ReflectionDiagnostic[],
  source: ReflectionOutputSource,
): NormalizedReflectionInsight<ReflectionMetadata> | undefined {
  const prefix = `plannerOutput.insights[${index}]`;
  const candidate = asInsight<ReflectionMetadata>(insight);
  if (!candidate) {
    diagnostics.push(failedDiagnostic("output", `${prefix} must be an object`, undefined, source));
    return undefined;
  }

  pushNonEmptyStringDiagnostic(candidate.content, "output", `${prefix}.content`, diagnostics, source);
  const evidenceMemoryIds = pushStringArrayDiagnostic(
    candidate.evidenceMemoryIds,
    "output",
    `${prefix}.evidenceMemoryIds`,
    diagnostics,
    { required: true, source },
  );
  validateImportance(candidate.importance, `${prefix}.importance`, diagnostics, source);
  const tags = pushStringArrayDiagnostic(candidate.tags ?? [], "output", `${prefix}.tags`, diagnostics, {
    required: false,
    source,
  });
  const content = typeof candidate.content === "string" ? candidate.content : "";
  const importance = typeof candidate.importance === "number" ? candidate.importance : 0;

  for (const evidenceMemoryId of evidenceMemoryIds) {
    if (!evidenceIds.has(evidenceMemoryId)) {
      diagnostics.push(
        failedDiagnostic("output", `${prefix}.evidenceMemoryIds must reference provided evidence`, [evidenceMemoryId], source),
      );
    }
  }

  if (diagnostics.length > 0) {
    return undefined;
  }

  return {
    content,
    evidenceMemoryIds,
    importance,
    tags,
    metadata: (candidate.metadata ?? {}) as ReflectionMetadata,
  };
}

function asPlannerOutput(output: unknown): PlannerOutputCandidate | undefined {
  if (typeof output !== "object" || output === null) {
    return undefined;
  }
  return output as PlannerOutputCandidate;
}

function asInsight<ReflectionMetadata>(insight: unknown): ReflectionInsightCandidate<ReflectionMetadata> | undefined {
  if (typeof insight !== "object" || insight === null) {
    return undefined;
  }
  return insight as ReflectionInsightCandidate<ReflectionMetadata>;
}

function validateTriggerKind(value: ReflectionTriggerKind, diagnostics: ReflectionDiagnostic[]): void {
  if (typeof value !== "string" || !(REFLECTION_TRIGGER_KINDS as readonly string[]).includes(value)) {
    diagnostics.push(failedDiagnostic("input", `input.trigger.kind must be one of: ${REFLECTION_TRIGGER_KINDS.join(", ")}`));
  }
}

function validateOutputSource(value: unknown, diagnostics: ReflectionDiagnostic[]): ReflectionOutputSource {
  if (typeof value !== "string" || !(REFLECTION_OUTPUT_SOURCES as readonly string[]).includes(value)) {
    diagnostics.push(failedDiagnostic("output", `plannerOutput.source must be one of: ${REFLECTION_OUTPUT_SOURCES.join(", ")}`));
    return "deterministic";
  }
  return value as ReflectionOutputSource;
}

function pushNonEmptyStringDiagnostic(
  value: unknown,
  phase: ReflectionDiagnostic["phase"],
  path: string,
  diagnostics: ReflectionDiagnostic[],
  source?: ReflectionOutputSource,
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    diagnostics.push(failedDiagnostic(phase, `${path} must be a non-empty string`, undefined, source));
  }
}

function pushIsoDateDiagnostic(
  value: unknown,
  phase: ReflectionDiagnostic["phase"],
  path: string,
  diagnostics: ReflectionDiagnostic[],
): void {
  if (typeof value !== "string" || value.trim().length === 0 || Number.isNaN(Date.parse(value))) {
    diagnostics.push(failedDiagnostic(phase, `${path} must be a valid ISO date string`));
  }
}

function pushStringArrayDiagnostic(
  value: unknown,
  phase: ReflectionDiagnostic["phase"],
  path: string,
  diagnostics: ReflectionDiagnostic[],
  options: { required: boolean; source?: ReflectionOutputSource },
): readonly string[] {
  if (!Array.isArray(value)) {
    diagnostics.push(failedDiagnostic(phase, `${path} must be a string array`, undefined, options.source));
    return [];
  }

  if (options.required && value.length === 0) {
    diagnostics.push(failedDiagnostic(phase, `${path} must be a non-empty string array`, undefined, options.source));
  }

  const normalized = value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      diagnostics.push(failedDiagnostic(phase, `${path} must contain only non-empty strings`, undefined, options.source));
      return "";
    }
    return entry;
  });

  return normalized;
}

function validateImportance(
  value: unknown,
  path: string,
  diagnostics: ReflectionDiagnostic[],
  source: ReflectionOutputSource,
): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < MEMORY_IMPORTANCE_MIN || value > MEMORY_IMPORTANCE_MAX) {
    diagnostics.push(
      failedDiagnostic(
        "output",
        `${path} must be a number from ${MEMORY_IMPORTANCE_MIN} to ${MEMORY_IMPORTANCE_MAX}`,
        undefined,
        source,
      ),
    );
  }
}
