// Cognitive loop orchestration.
//
// Runs Perceive -> Retrieve -> Plan -> Act, then leaves Remember/Reflect as
// visible Phase A stubs. The loop produces a typed action proposal via the
// ActionSink; it never mutates world state directly.
//
// Invariants enforced here:
// - Errors in perceive/retrieve/plan are recorded as `failed` diagnostics with
//   the error message; no proposal is produced and the ActionSink is not called.
//   Remaining phases are marked `skipped` with the aborting reason. Failures are
//   never swallowed into a fake successful action.
// - A plan with `source: "skipped"` or no proposal leaves the act phase skipped
//   and does not call the ActionSink.

import { errorMessage, failedPhase, ranPhase, skippedPhase } from "../diagnostics/diagnostics.js";
import type { CognitiveLoopDeps, CognitiveTickResult, PhaseDiagnostic, PlanResult } from "../ports/ports.js";

const ABORTED_AFTER_FAILURE = "aborted: a prior phase failed";
const SYNC_PLANNER_PROMISE_ERROR = "sync cognitive tick received an async plan result; use runCognitiveTick for async planners";

export async function runCognitiveTick<P, MQ, MH, MW, A>(
  agentId: string,
  now: string,
  deps: CognitiveLoopDeps<P, MQ, MH, MW, A>,
): Promise<CognitiveTickResult<A>> {
  const phases: PhaseDiagnostic[] = [];
  const prepared = preparePerceptionAndMemories(agentId, now, deps, phases);
  if (!prepared.ok) return { agentId, phases };

  let plan: PlanResult<A>;
  try {
    const planResult = await deps.planning.plan({
      agentId,
      now,
      perception: prepared.perception,
      memories: prepared.memories,
    });
    const parsedPlan = parsePlanResult<A>(planResult);
    if (!parsedPlan.ok) {
      phases.push(failedPhase("plan", parsedPlan.error));
      abortRemaining(phases, ["act", "remember", "reflect"]);
      return { agentId, phases };
    }
    plan = parsedPlan.plan;
    phases.push(ranPhase("plan", `source=${plan.source}: ${plan.reason}`));
  } catch (error) {
    phases.push(failedPhase("plan", errorMessage(error)));
    abortRemaining(phases, ["act", "remember", "reflect"]);
    return { agentId, phases };
  }

  return finishTick(agentId, deps, prepared.perception, plan, phases);
}

/**
 * Synchronous companion for deterministic simulation ticks.
 *
 * Future LLM-backed planners should call `runCognitiveTick`; the server
 * authoritative engine currently has a synchronous step contract, so its
 * deterministic routine adapter uses this entrypoint and fails visibly if an
 * async planner is accidentally wired in.
 */
export function runCognitiveTickSync<P, MQ, MH, MW, A>(
  agentId: string,
  now: string,
  deps: CognitiveLoopDeps<P, MQ, MH, MW, A>,
): CognitiveTickResult<A> {
  const phases: PhaseDiagnostic[] = [];
  const prepared = preparePerceptionAndMemories(agentId, now, deps, phases);
  if (!prepared.ok) return { agentId, phases };

  let plan: PlanResult<A>;
  try {
    const planResult = deps.planning.plan({
      agentId,
      now,
      perception: prepared.perception,
      memories: prepared.memories,
    });
    if (isPromiseLike(planResult)) {
      void Promise.resolve(planResult).catch(() => undefined);
      phases.push(failedPhase("plan", SYNC_PLANNER_PROMISE_ERROR));
      abortRemaining(phases, ["act", "remember", "reflect"]);
      return { agentId, phases };
    }
    const parsedPlan = parsePlanResult<A>(planResult);
    if (!parsedPlan.ok) {
      phases.push(failedPhase("plan", parsedPlan.error));
      abortRemaining(phases, ["act", "remember", "reflect"]);
      return { agentId, phases };
    }
    plan = parsedPlan.plan;
    phases.push(ranPhase("plan", `source=${plan.source}: ${plan.reason}`));
  } catch (error) {
    phases.push(failedPhase("plan", errorMessage(error)));
    abortRemaining(phases, ["act", "remember", "reflect"]);
    return { agentId, phases };
  }

  return finishTick(agentId, deps, prepared.perception, plan, phases);
}

function preparePerceptionAndMemories<P, MQ, MH, MW, A>(
  agentId: string,
  now: string,
  deps: CognitiveLoopDeps<P, MQ, MH, MW, A>,
  phases: PhaseDiagnostic[],
): { ok: true; perception: P; memories: readonly MH[] } | { ok: false } {
  let perception: P;
  try {
    perception = deps.perception.perceive(agentId, now);
    phases.push(ranPhase("perceive", "perception projected"));
  } catch (error) {
    phases.push(failedPhase("perceive", errorMessage(error)));
    abortRemaining(phases, ["retrieve", "plan", "act", "remember", "reflect"]);
    return { ok: false };
  }

  try {
    const query = deps.buildMemoryQuery(perception);
    const memories = deps.memory.retrieve(agentId, query);
    phases.push(ranPhase("retrieve", `retrieved ${memories.length} memory hit(s)`));
    return { ok: true, perception, memories };
  } catch (error) {
    phases.push(failedPhase("retrieve", errorMessage(error)));
    abortRemaining(phases, ["plan", "act", "remember", "reflect"]);
    return { ok: false };
  }
}

function finishTick<P, MQ, MH, MW, A>(
  agentId: string,
  deps: CognitiveLoopDeps<P, MQ, MH, MW, A>,
  perception: P,
  plan: PlanResult<A>,
  phases: PhaseDiagnostic[],
): CognitiveTickResult<A> {
  let proposal: A | undefined;
  if (plan.source === "skipped" || plan.proposal === undefined) {
    phases.push(skippedPhase("act", `no proposal to submit (${plan.reason})`));
  } else {
    proposal = plan.proposal;
    deps.actionSink.submit(agentId, proposal);
    phases.push(ranPhase("act", "proposal submitted to action sink"));
  }

  const write = deps.buildMemoryWrite?.(perception, plan);
  if (write === undefined) {
    phases.push(skippedPhase("remember", "Phase A: memory write not enabled"));
  } else {
    deps.memory.remember(agentId, write);
    phases.push(ranPhase("remember", "memory write recorded"));
  }

  phases.push(skippedPhase("reflect", "Phase A: reflection not implemented"));

  return { agentId, phases, proposal };
}

function abortRemaining(phases: PhaseDiagnostic[], remaining: readonly PhaseDiagnostic["phase"][]): void {
  for (const phase of remaining) {
    phases.push(skippedPhase(phase, ABORTED_AFTER_FAILURE));
  }
}

function parsePlanResult<A>(value: unknown): { ok: true; plan: PlanResult<A> } | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: "invalid plan result: expected an object" };
  }

  const source = value.source;
  if (source !== "deterministic" && source !== "llm" && source !== "skipped") {
    return { ok: false, error: "invalid plan result: source must be deterministic, llm, or skipped" };
  }

  if (typeof value.reason !== "string" || value.reason.length === 0) {
    return { ok: false, error: "invalid plan result: reason must be a non-empty string" };
  }

  if (source !== "skipped" && value.proposal === undefined) {
    return { ok: false, error: "invalid plan result: deterministic and llm plans must include a proposal" };
  }

  return { ok: true, plan: value as unknown as PlanResult<A> };
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
