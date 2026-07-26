import type { CognitivePhase, PhaseDiagnostic, PhaseStatus } from "../ports/ports.js";

/** Construct a phase diagnostic entry. */
export function phaseDiagnostic(phase: CognitivePhase, status: PhaseStatus, detail: string): PhaseDiagnostic {
  return { phase, status, detail };
}

export function ranPhase(phase: CognitivePhase, detail: string): PhaseDiagnostic {
  return phaseDiagnostic(phase, "ran", detail);
}

export function skippedPhase(phase: CognitivePhase, reason: string): PhaseDiagnostic {
  return phaseDiagnostic(phase, "skipped", reason);
}

export function failedPhase(phase: CognitivePhase, error: string): PhaseDiagnostic {
  return phaseDiagnostic(phase, "failed", error);
}

/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return String(value);
}
