// Validation for affect state operations. Mirrors the memory module's
// collect-then-throw style; the tiny string/date primitives are intentionally
// kept private per domain until a third domain motivates a shared module.

import {
  AFFINITY_MAX,
  AFFINITY_MIN,
  MOOD_INTENSITY_MAX,
  MOOD_INTENSITY_MIN,
  type AgentMood,
  type AgentMoodWrite,
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

function throwIfErrors(errors: readonly string[]): void {
  if (errors.length > 0) {
    throw new AffectValidationError(errors);
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
