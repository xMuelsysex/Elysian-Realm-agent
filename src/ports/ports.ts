// simulation-agent port interfaces and loop types.
//
// Hard constraint: this package is port-converged and MUST stay free of any
// host-application imports. Everything is parameterized by generics so the
// cognitive loop never depends on a concrete domain. Host-specific type binding
// lives in adapter layers, not here.

/**
 * Perception: read the visible context for an agent at a given tick.
 * Implementations return a read-only projection; the loop never mutates world
 * state through this port.
 */
export interface PerceptionPort<Perception> {
  perceive(agentId: string, now: string): Perception;
}

/**
 * Memory: retrieve relevant memories and record new ones. In Phase A the
 * implementation may be an in-memory stub; `retrieve` can return deterministic
 * stub hits and `remember` records observations.
 */
export interface MemoryPort<MemoryQuery, MemoryHit, MemoryWrite> {
  retrieve(agentId: string, query: MemoryQuery): readonly MemoryHit[];
  remember(agentId: string, write: MemoryWrite): void;
}

/**
 * Planning: produce an action intent. May be driven by deterministic rules or
 * by an LLM. The planner itself may depend on an `LlmPort`, but the cognitive
 * loop only depends on this `PlanningPort`.
 */
export interface PlanningPort<Perception, MemoryHit, ActionProposal> {
  plan(input: PlanInput<Perception, MemoryHit>): Promise<PlanResult<ActionProposal>> | PlanResult<ActionProposal>;
}

export interface PlanInput<Perception, MemoryHit> {
  agentId: string;
  now: string;
  perception: Perception;
  memories: readonly MemoryHit[];
}

/**
 * Action sink: submit a typed action proposal. The loop never mutates world
 * state directly; the owning engine applies proposals.
 */
export interface ActionSink<ActionProposal> {
  submit(agentId: string, proposal: ActionProposal): void;
}

export type PlanSource = "deterministic" | "llm" | "skipped";

export interface PlanResult<ActionProposal> {
  /** "deterministic" = rule hit; "llm" = model hit; "skipped" = no action. */
  source: PlanSource;
  proposal?: ActionProposal;
  reason: string;
}

/**
 * Optional planner dependency type, aligned with the existing `LlmProvider`
 * shape. The cognitive loop does not depend on this; it is provided here so an
 * LLM-backed planner can declare the dependency without importing a host
 * application's provider.
 */
export interface LlmChatMessageLike {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmChatRequestLike {
  messages: readonly LlmChatMessageLike[];
  responseFormat?: unknown;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmRequestOptionsLike {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface LlmChatCompletionLike {
  content: string;
  finishReason?: string;
  providerResponseId?: string;
  usage?: Record<string, number | undefined>;
}

export interface LlmPort {
  readonly name: string;
  readonly model: string;
  completeChat(
    request: LlmChatRequestLike,
    options?: LlmRequestOptionsLike,
  ): Promise<LlmChatCompletionLike>;
}

export type CognitivePhase = "perceive" | "retrieve" | "plan" | "act" | "remember" | "reflect";

export type PhaseStatus = "ran" | "skipped" | "failed";

export interface PhaseDiagnostic {
  phase: CognitivePhase;
  status: PhaseStatus;
  detail: string;
}

export interface CognitiveLoopDeps<P, MQ, MH, MW, A> {
  perception: PerceptionPort<P>;
  memory: MemoryPort<MQ, MH, MW>;
  planning: PlanningPort<P, MH, A>;
  actionSink: ActionSink<A>;
  buildMemoryQuery: (perception: P) => MQ;
  /** Optional Phase A hook; Remember stays skipped unless a write is produced. */
  buildMemoryWrite?: (perception: P, plan: PlanResult<A>) => MW | undefined;
}

export interface CognitiveTickResult<A> {
  agentId: string;
  phases: PhaseDiagnostic[];
  /** Present only when the plan produced a proposal that the act phase emitted. */
  proposal?: A;
}
