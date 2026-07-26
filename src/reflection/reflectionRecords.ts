import type { LlmRequestOptionsLike } from "../ports/ports.js";
import type { MemoryRecord, MemoryWrite } from "../memory/memoryRecords.js";

export const REFLECTION_TRIGGER_KINDS = [
  "importance-threshold",
  "scheduled",
  "conversation-ended",
  "user-requested",
] as const;

export type ReflectionTriggerKind = (typeof REFLECTION_TRIGGER_KINDS)[number];

export const REFLECTION_OUTPUT_SOURCES = ["deterministic", "llm"] as const;

export type ReflectionOutputSource = (typeof REFLECTION_OUTPUT_SOURCES)[number];

export type ReflectionStatus = "completed" | "failed" | "skipped";

export type ReflectionDiagnosticPhase = "input" | "planner" | "output";

export interface ReflectionTrigger {
  kind: ReflectionTriggerKind;
  reason: string;
  now: string;
  sourceIds: readonly string[];
}

export interface ReflectionInput<EvidenceMetadata = Record<string, unknown>> {
  agentId: string;
  trigger: ReflectionTrigger;
  evidence: readonly MemoryRecord<EvidenceMetadata>[];
  maxInsights?: number;
}

export interface ReflectionInsightOutput<ReflectionMetadata = Record<string, unknown>> {
  content: string;
  evidenceMemoryIds: readonly string[];
  importance: number;
  tags?: readonly string[];
  metadata?: ReflectionMetadata;
}

export interface ReflectionPlannerOutput<ReflectionMetadata = Record<string, unknown>> {
  source: ReflectionOutputSource;
  insights: readonly ReflectionInsightOutput<ReflectionMetadata>[];
  reason: string;
}

export interface ReflectionPlanner<
  EvidenceMetadata = Record<string, unknown>,
  ReflectionMetadata = Record<string, unknown>,
> {
  reflect(
    input: ReflectionInput<EvidenceMetadata>,
    options?: LlmRequestOptionsLike,
  ): Promise<ReflectionPlannerOutput<ReflectionMetadata>> | ReflectionPlannerOutput<ReflectionMetadata>;
}

export interface ReflectionDiagnostic {
  status: ReflectionStatus;
  phase: ReflectionDiagnosticPhase;
  message: string;
  evidenceMemoryIds?: readonly string[];
  source?: ReflectionOutputSource;
}

export interface ReflectionResult<ReflectionMetadata = Record<string, unknown>> {
  status: ReflectionStatus;
  memoryWrites: readonly MemoryWrite<ReflectionMetadata>[];
  diagnostics: readonly ReflectionDiagnostic[];
}

export interface NormalizedReflectionInsight<ReflectionMetadata = Record<string, unknown>> {
  content: string;
  evidenceMemoryIds: readonly string[];
  importance: number;
  tags: readonly string[];
  metadata: ReflectionMetadata;
}

export interface NormalizedReflectionPlannerOutput<ReflectionMetadata = Record<string, unknown>> {
  source: ReflectionOutputSource;
  insights: readonly NormalizedReflectionInsight<ReflectionMetadata>[];
  reason: string;
}
