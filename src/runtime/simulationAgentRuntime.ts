import { runCognitiveTick, runCognitiveTickSync } from "../loop/cognitiveLoop.js";
import type {
  CognitiveLoopDeps,
  CognitiveTickResult,
  LlmRequestOptionsLike,
} from "../ports/ports.js";
import type { MemoryRecord, MemoryWrite } from "../memory/memoryRecords.js";
import { cloneMemoryRecord } from "../memory/retrieval.js";
import { runReflection, runReflectionSync } from "../reflection/reflectionPlanner.js";
import type {
  ReflectionInput,
  ReflectionPlanner,
  ReflectionResult,
} from "../reflection/reflectionRecords.js";
import { failedDiagnostic } from "../reflection/reflectionValidation.js";

export interface ReflectionMemoryWriter<ReflectionMetadata = Record<string, unknown>> {
  remember(
    agentId: string,
    write: MemoryWrite<ReflectionMetadata>,
  ): MemoryRecord<ReflectionMetadata> | void;
}

export type SimulationAgentRuntimeDeps<
  Perception,
  MemoryQuery,
  MemoryHit,
  MemoryWritePayload,
  ActionProposal,
  ReflectionMetadata = Record<string, unknown>,
> = CognitiveLoopDeps<Perception, MemoryQuery, MemoryHit, MemoryWritePayload, ActionProposal> & {
  reflectionMemory?: ReflectionMemoryWriter<ReflectionMetadata>;
};

export interface SimulationAgentRuntimeOptions {
  persistReflectionWrites?: boolean;
}

export interface RuntimeReflectionOptions {
  request?: LlmRequestOptionsLike;
  persistWrites?: boolean;
}

export interface RuntimeReflectionResult<ReflectionMetadata = Record<string, unknown>>
  extends ReflectionResult<ReflectionMetadata> {
  persistedRecords: readonly MemoryRecord<ReflectionMetadata>[];
}

export class SimulationAgentRuntime<
  Perception,
  MemoryQuery,
  MemoryHit,
  MemoryWritePayload,
  ActionProposal,
  ReflectionMetadata = Record<string, unknown>,
> {
  private readonly deps: SimulationAgentRuntimeDeps<
    Perception,
    MemoryQuery,
    MemoryHit,
    MemoryWritePayload,
    ActionProposal,
    ReflectionMetadata
  >;

  private readonly options: SimulationAgentRuntimeOptions;

  constructor(
    deps: SimulationAgentRuntimeDeps<
      Perception,
      MemoryQuery,
      MemoryHit,
      MemoryWritePayload,
      ActionProposal,
      ReflectionMetadata
    >,
    options: SimulationAgentRuntimeOptions = {},
  ) {
    this.deps = deps;
    this.options = options;
  }

  tick(agentId: string, now: string): Promise<CognitiveTickResult<ActionProposal>> {
    return runCognitiveTick(agentId, now, this.deps);
  }

  tickSync(agentId: string, now: string): CognitiveTickResult<ActionProposal> {
    return runCognitiveTickSync(agentId, now, this.deps);
  }

  async reflect<EvidenceMetadata = Record<string, unknown>>(
    input: ReflectionInput<EvidenceMetadata>,
    planner: ReflectionPlanner<EvidenceMetadata, ReflectionMetadata>,
    options: RuntimeReflectionOptions = {},
  ): Promise<RuntimeReflectionResult<ReflectionMetadata>> {
    const reflection = await runReflection(input, planner, options.request);
    return this.finalizeReflection(input.agentId, reflection, options);
  }

  reflectSync<EvidenceMetadata = Record<string, unknown>>(
    input: ReflectionInput<EvidenceMetadata>,
    planner: ReflectionPlanner<EvidenceMetadata, ReflectionMetadata>,
    options: RuntimeReflectionOptions = {},
  ): RuntimeReflectionResult<ReflectionMetadata> {
    const reflection = runReflectionSync(input, planner, options.request);
    return this.finalizeReflection(input.agentId, reflection, options);
  }

  private finalizeReflection(
    agentId: string,
    reflection: ReflectionResult<ReflectionMetadata>,
    options: RuntimeReflectionOptions,
  ): RuntimeReflectionResult<ReflectionMetadata> {
    if (reflection.status !== "completed") {
      return {
        ...reflection,
        persistedRecords: [],
      };
    }

    const shouldPersist = options.persistWrites ?? this.options.persistReflectionWrites ?? false;
    if (!shouldPersist) {
      return {
        ...reflection,
        persistedRecords: [],
      };
    }

    if (!this.deps.reflectionMemory) {
      return {
        status: "failed",
        memoryWrites: [],
        persistedRecords: [],
        diagnostics: [
          ...reflection.diagnostics,
          failedDiagnostic("output", "reflection persistence requested but no reflectionMemory writer is configured"),
        ],
      };
    }

    const persistedRecords: Array<MemoryRecord<ReflectionMetadata>> = [];
    try {
      for (const write of reflection.memoryWrites) {
        const record = this.deps.reflectionMemory.remember(agentId, write);
        if (record) {
          persistedRecords.push(cloneMemoryRecord(record));
        }
      }
    } catch (error) {
      return {
        status: "failed",
        memoryWrites: [],
        persistedRecords,
        diagnostics: [
          ...reflection.diagnostics,
          failedDiagnostic("output", `reflection persistence failed: ${errorMessage(error)}`),
        ],
      };
    }

    return {
      ...reflection,
      persistedRecords,
    };
  }
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
