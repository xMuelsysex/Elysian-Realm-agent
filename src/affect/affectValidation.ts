// Validation for affect state operations. Mirrors the memory module's
// collect-then-throw style; the tiny string/date primitives are intentionally
// kept private per domain until a third domain motivates a shared module.

import {
  AFFECT_AROUSAL_MAX,
  AFFECT_AROUSAL_MIN,
  AFFECT_LABEL_MAX,
  AFFECT_LABEL_MIN,
  AFFECT_VALENCE_MAX,
  AFFECT_VALENCE_MIN,
  AFFINITY_MAX,
  AFFINITY_MIN,
  EMOTION_LABELS,
  MOOD_INTENSITY_MAX,
  MOOD_INTENSITY_MIN,
  PLOT_EVENT_TARGETS,
  PLOT_EVENT_TYPES,
  type AffectState,
  type AgentMood,
  type AgentMoodWrite,
  type PlotEvent,
  type RelationshipAffect,
} from "./affectRecords.js";

export class AffectValidationError extends Error {
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(errors.join("; "));
    this.name = "AffectValidationError";
    this.errors = [...errors];
  }
}

export function validateRelationshipRef(agentId: string, targetId: string): void {
  const errors: string[] = [];
  validateNonEmptyString(agentId, "agentId", errors);
  validateNonEmptyString(targetId, "targetId", errors);
  if (errors.length === 0 && agentId === targetId) {
    errors.push("targetId must differ from agentId; self-directed affect is not supported");
  }
  throwIfErrors(errors);
}

export function validateAffinityInput(value: number, path: string, at: string): void {
  const errors: string[] = [];
  if (!Number.isFinite(value)) {
    errors.push(`${path} must be a finite number`);
  }
  validateIsoDate(at, "at", errors);
  throwIfErrors(errors);
}

export function validateMoodWrite(agentId: string, write: AgentMoodWrite, at: string): void {
  const errors: string[] = [];
  validateNonEmptyString(agentId, "agentId", errors);
  validateNonEmptyString(write.mood, "write.mood", errors);
  if (
    !Number.isFinite(write.intensity) ||
    write.intensity < MOOD_INTENSITY_MIN ||
    write.intensity > MOOD_INTENSITY_MAX
  ) {
    errors.push(
      `write.intensity must be a number from ${MOOD_INTENSITY_MIN} to ${MOOD_INTENSITY_MAX}`,
    );
  }
  validateIsoDate(at, "at", errors);
  throwIfErrors(errors);
}

export function validateImportedRelationship(record: RelationshipAffect): void {
  const errors: string[] = [];
  validateNonEmptyString(record.agentId, "relationship.agentId", errors);
  validateNonEmptyString(record.targetId, "relationship.targetId", errors);
  if (errors.length === 0 && record.agentId === record.targetId) {
    errors.push("relationship.targetId must differ from relationship.agentId");
  }
  if (
    !Number.isFinite(record.affinity) ||
    record.affinity < AFFINITY_MIN ||
    record.affinity > AFFINITY_MAX
  ) {
    errors.push(`relationship.affinity must be a number from ${AFFINITY_MIN} to ${AFFINITY_MAX}`);
  }
  validateIsoDate(record.updatedAt, "relationship.updatedAt", errors);
  throwIfErrors(errors);
}

export function validateImportedMood(record: AgentMood): void {
  const errors: string[] = [];
  validateNonEmptyString(record.agentId, "mood.agentId", errors);
  validateNonEmptyString(record.mood, "mood.mood", errors);
  if (
    !Number.isFinite(record.intensity) ||
    record.intensity < MOOD_INTENSITY_MIN ||
    record.intensity > MOOD_INTENSITY_MAX
  ) {
    errors.push(`mood.intensity must be a number from ${MOOD_INTENSITY_MIN} to ${MOOD_INTENSITY_MAX}`);
  }
  validateIsoDate(record.updatedAt, "mood.updatedAt", errors);
  throwIfErrors(errors);
}

export function validateAffectState(record: AffectState): void {
  const errors: string[] = [];
  validateNonEmptyString(record.agentId, "affectState.agentId", errors);
  validateBoundedNumber(
    record.valence,
    "affectState.valence",
    AFFECT_VALENCE_MIN,
    AFFECT_VALENCE_MAX,
    errors,
  );
  validateBoundedNumber(
    record.arousal,
    "affectState.arousal",
    AFFECT_AROUSAL_MIN,
    AFFECT_AROUSAL_MAX,
    errors,
  );
  validateBoundedNumber(
    record.baseline.valence,
    "affectState.baseline.valence",
    AFFECT_VALENCE_MIN,
    AFFECT_VALENCE_MAX,
    errors,
  );
  validateBoundedNumber(
    record.baseline.arousal,
    "affectState.baseline.arousal",
    AFFECT_AROUSAL_MIN,
    AFFECT_AROUSAL_MAX,
    errors,
  );
  for (const label of EMOTION_LABELS) {
    validateBoundedNumber(
      record.emotionLabels[label],
      `affectState.emotionLabels.${label}`,
      AFFECT_LABEL_MIN,
      AFFECT_LABEL_MAX,
      errors,
    );
  }
  validateIsoDate(record.updatedAt, "affectState.updatedAt", errors);
  throwIfErrors(errors);
}

export function validatePlotEvent(event: PlotEvent): void {
  const errors: string[] = [];
  validateNonEmptyString(event.id, "plotEvent.id", errors);
  if (!PLOT_EVENT_TYPES.includes(event.type)) {
    errors.push(`plotEvent.type must be one of: ${PLOT_EVENT_TYPES.join(", ")}`);
  }
  if (!PLOT_EVENT_TARGETS.includes(event.target)) {
    errors.push(`plotEvent.target must be one of: ${PLOT_EVENT_TARGETS.join(", ")}`);
  }
  validateBoundedNumber(event.intensity, "plotEvent.intensity", 0, 1, errors);
  validateIsoDate(event.at, "plotEvent.at", errors);
  throwIfErrors(errors);
}

function throwIfErrors(errors: readonly string[]): void {
  if (errors.length > 0) {
    throw new AffectValidationError(errors);
  }
}

function validateBoundedNumber(
  value: unknown,
  path: string,
  min: number,
  max: number,
  errors: string[],
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${path} must be a finite number`);
  } else if (value < min || value > max) {
    errors.push(`${path} must be a number from ${min} to ${max}`);
  }
}

function validateNonEmptyString(value: string, path: string, errors: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${path} must be a non-empty string`);
  }
}

function validateIsoDate(value: string, path: string, errors: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0 || Number.isNaN(Date.parse(value))) {
    errors.push(`${path} must be a valid ISO date string`);
  }
}
