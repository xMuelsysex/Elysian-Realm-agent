/**
 * Pure contracts for the host-owned self-concept projection.
 *
 * A self-concept is derived from memories and approved by the host; it is not
 * an event memory, persona patch, or affect state. This module deliberately
 * has no database, clock, LLM, or pi dependency.
 */

export const SELF_CONCEPT_PROPOSAL_SCHEMA_VERSION = "realm-self-concept-proposal.v1" as const;
export const SELF_CONCEPT_SNAPSHOT_SCHEMA_VERSION = "realm-self-concept-snapshot.v1" as const;
export const SELF_CONCEPT_AUDIT_SCHEMA_VERSION = "realm-self-concept-audit.v1" as const;

export const SELF_CONCEPT_MAX_PROPOSAL_ID_LENGTH = 128;
export const SELF_CONCEPT_MAX_BELIEF_ID_LENGTH = 64;
export const SELF_CONCEPT_MAX_MEMORY_ID_LENGTH = 128;
export const SELF_CONCEPT_MAX_SUMMARY_LENGTH = 500;
export const SELF_CONCEPT_MAX_STATEMENT_LENGTH = 500;
export const SELF_CONCEPT_MAX_BELIEFS = 12;
export const SELF_CONCEPT_MAX_SOURCE_MEMORY_IDS = 32;
export const SELF_CONCEPT_MAX_BELIEF_SOURCE_MEMORY_IDS = 8;
export const SELF_CONCEPT_MAX_JSON_BYTES = 16 * 1024;

const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

export interface SelfConceptBeliefV1 {
  beliefId: string;
  statement: string;
  /** Provenance only; this does not prove the statement is true. */
  sourceMemoryIds: readonly string[];
}

export interface SelfConceptProposalV1 {
  schemaVersion: typeof SELF_CONCEPT_PROPOSAL_SCHEMA_VERSION;
  proposalId: string;
  expectedRevision: number;
  summary: string;
  sourceMemoryIds: readonly string[];
  beliefs: readonly SelfConceptBeliefV1[];
}

export interface SelfConceptSnapshotV1 {
  schemaVersion: typeof SELF_CONCEPT_SNAPSHOT_SCHEMA_VERSION;
  revision: number;
  acceptedAt: string;
  proposalId: string;
  summary: string;
  sourceMemoryIds: readonly string[];
  beliefs: readonly SelfConceptBeliefV1[];
}

export type SelfConceptAuditEventTypeV1 =
  | "attempt_started"
  | "accepted"
  | "rejected"
  | "evidence_invalid"
  | "revision_conflict"
  | "parse_failure"
  | "storage_failure";

export interface SelfConceptAuditPayloadV1 {
  schemaVersion: typeof SELF_CONCEPT_AUDIT_SCHEMA_VERSION;
  beliefCount?: number;
  sourceMemoryCount?: number;
  expectedRevision?: number;
  observedRevision?: number;
  acceptedRevision?: number;
  invalidFields?: readonly string[];
  failureClass?: string;
}

/** A redacted append-only decision record exposed by the host for diagnostics. */
export interface SelfConceptAuditEventV1 {
  eventId: number;
  agentId: string;
  attemptId: string;
  proposalId?: string;
  eventType: SelfConceptAuditEventTypeV1;
  expectedRevision?: number;
  observedRevision?: number;
  acceptedRevision?: number;
  occurredAt: string;
  diagnosticCode?: string;
  diagnosticSummary?: string;
  payload: SelfConceptAuditPayloadV1;
}

export type SelfConceptDecisionReportV1 =
  | { outcome: "absent" }
  | { outcome: "accepted"; revision: number; proposalId: string }
  | { outcome: "rejected"; code: string; proposalId?: string }
  | { outcome: "evidence_invalid"; code: string; proposalId: string }
  | {
      outcome: "revision_conflict";
      expectedRevision: number;
      observedRevision: number;
      proposalId: string;
    }
  | { outcome: "parse_failure"; code: string }
  | { outcome: "storage_failure"; code: string; proposalId?: string };

export class SelfConceptValidationError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(code: string, message: string, path?: string) {
    super(message);
    this.name = "SelfConceptValidationError";
    this.code = code;
    this.path = path;
  }
}

/** Validate and normalize an untrusted proposal without silently dropping data. */
export function validateSelfConceptProposal(input: unknown): SelfConceptProposalV1 {
  const record = requireRecord(input, "proposal must be an object");
  requireExactKeys(record, ["schemaVersion", "proposalId", "expectedRevision", "summary", "sourceMemoryIds", "beliefs"]);
  if (record.schemaVersion !== SELF_CONCEPT_PROPOSAL_SCHEMA_VERSION) {
    fail("invalid_schema", `schemaVersion must be ${SELF_CONCEPT_PROPOSAL_SCHEMA_VERSION}`, "schemaVersion");
  }
  const proposalId = validateId(record.proposalId, "proposalId", SELF_CONCEPT_MAX_PROPOSAL_ID_LENGTH);
  const expectedRevision = validateRevision(record.expectedRevision, "expectedRevision");
  const summary = validateText(record.summary, "summary", SELF_CONCEPT_MAX_SUMMARY_LENGTH);
  const sourceMemoryIds = validateIds(
    record.sourceMemoryIds,
    "sourceMemoryIds",
    SELF_CONCEPT_MAX_SOURCE_MEMORY_IDS,
  );
  const beliefs = validateBeliefs(record.beliefs, sourceMemoryIds);
  const normalized: SelfConceptProposalV1 = {
    schemaVersion: SELF_CONCEPT_PROPOSAL_SCHEMA_VERSION,
    proposalId,
    expectedRevision,
    summary,
    sourceMemoryIds,
    beliefs,
  };
  assertJsonSize(normalized, "proposal");
  return normalized;
}

/** Validate a stored snapshot before it is exposed to a prompt consumer. */
export function validateSelfConceptSnapshot(input: unknown): SelfConceptSnapshotV1 {
  const record = requireRecord(input, "snapshot must be an object");
  requireExactKeys(record, ["schemaVersion", "revision", "acceptedAt", "proposalId", "summary", "sourceMemoryIds", "beliefs"]);
  if (record.schemaVersion !== SELF_CONCEPT_SNAPSHOT_SCHEMA_VERSION) {
    fail("invalid_schema", `schemaVersion must be ${SELF_CONCEPT_SNAPSHOT_SCHEMA_VERSION}`, "schemaVersion");
  }
  const revision = validateRevision(record.revision, "revision");
  if (revision < 1) {
    fail("invalid_revision", "revision must be at least 1", "revision");
  }
  const acceptedAt = validateIsoDate(record.acceptedAt, "acceptedAt");
  const proposalId = validateId(record.proposalId, "proposalId", SELF_CONCEPT_MAX_PROPOSAL_ID_LENGTH);
  const summary = validateText(record.summary, "summary", SELF_CONCEPT_MAX_SUMMARY_LENGTH);
  const sourceMemoryIds = validateIds(
    record.sourceMemoryIds,
    "sourceMemoryIds",
    SELF_CONCEPT_MAX_SOURCE_MEMORY_IDS,
  );
  const beliefs = validateBeliefs(record.beliefs, sourceMemoryIds);
  const normalized: SelfConceptSnapshotV1 = {
    schemaVersion: SELF_CONCEPT_SNAPSHOT_SCHEMA_VERSION,
    revision,
    acceptedAt,
    proposalId,
    summary,
    sourceMemoryIds,
    beliefs,
  };
  assertJsonSize(normalized, "snapshot");
  return normalized;
}

/** Ensure an audit payload contains metadata only, never raw model/user text. */
export function validateSelfConceptAuditPayload(input: unknown): SelfConceptAuditPayloadV1 {
  const record = requireRecord(input, "audit payload must be an object");
  requireExactKeys(record, [
    "schemaVersion",
    "beliefCount",
    "sourceMemoryCount",
    "expectedRevision",
    "observedRevision",
    "acceptedRevision",
    "invalidFields",
    "failureClass",
  ], true);
  if (record.schemaVersion !== SELF_CONCEPT_AUDIT_SCHEMA_VERSION) {
    fail("invalid_schema", `schemaVersion must be ${SELF_CONCEPT_AUDIT_SCHEMA_VERSION}`, "schemaVersion");
  }
  const output: SelfConceptAuditPayloadV1 = { schemaVersion: SELF_CONCEPT_AUDIT_SCHEMA_VERSION };
  for (const field of ["beliefCount", "sourceMemoryCount", "expectedRevision", "observedRevision", "acceptedRevision"] as const) {
    const value = record[field];
    if (value !== undefined) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        fail("invalid_audit_payload", `${field} must be a non-negative safe integer`, field);
      }
      output[field] = value;
    }
  }
  if (record.invalidFields !== undefined) {
    if (!Array.isArray(record.invalidFields) || record.invalidFields.length > 16 || record.invalidFields.some((v) => typeof v !== "string" || v.length === 0 || v.length > 128 || CONTROL_CHARACTERS.test(v))) {
      fail("invalid_audit_payload", "invalidFields must contain at most 16 short field paths", "invalidFields");
    }
    output.invalidFields = [...record.invalidFields] as string[];
  }
  if (record.failureClass !== undefined) {
    output.failureClass = validateText(record.failureClass, "failureClass", 128);
  }
  assertJsonSize(output, "audit payload");
  return output;
}

function validateBeliefs(input: unknown, proposalSourceIds: readonly string[]): readonly SelfConceptBeliefV1[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > SELF_CONCEPT_MAX_BELIEFS) {
    fail("invalid_beliefs", `beliefs must contain 1..${SELF_CONCEPT_MAX_BELIEFS} items`, "beliefs");
  }
  const sourceSet = new Set(proposalSourceIds);
  const beliefIds = new Set<string>();
  return input.map((candidate, index) => {
    const path = `beliefs[${index}]`;
    const record = requireRecord(candidate, `${path} must be an object`);
    requireExactKeys(record, ["beliefId", "statement", "sourceMemoryIds"]);
    const beliefId = validateId(record.beliefId, `${path}.beliefId`, SELF_CONCEPT_MAX_BELIEF_ID_LENGTH);
    if (beliefIds.has(beliefId)) {
      fail("duplicate_belief_id", `duplicate beliefId: ${beliefId}`, `${path}.beliefId`);
    }
    beliefIds.add(beliefId);
    const statement = validateText(record.statement, `${path}.statement`, SELF_CONCEPT_MAX_STATEMENT_LENGTH);
    const sourceMemoryIds = validateIds(
      record.sourceMemoryIds,
      `${path}.sourceMemoryIds`,
      SELF_CONCEPT_MAX_BELIEF_SOURCE_MEMORY_IDS,
    );
    for (const id of sourceMemoryIds) {
      if (!sourceSet.has(id)) {
        fail("belief_source_not_subset", `${path}.sourceMemoryIds must be a subset of sourceMemoryIds`, `${path}.sourceMemoryIds`);
      }
    }
    return { beliefId, statement, sourceMemoryIds };
  });
}

function validateIds(input: unknown, path: string, max: number): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > max) {
    fail("invalid_ids", `${path} must contain 1..${max} ids`, path);
  }
  const seen = new Set<string>();
  return input.map((value, index) => {
    const id = validateId(value, `${path}[${index}]`, SELF_CONCEPT_MAX_MEMORY_ID_LENGTH);
    if (seen.has(id)) {
      fail("duplicate_id", `${path} contains duplicate id: ${id}`, path);
    }
    seen.add(id);
    return id;
  });
}

function validateId(input: unknown, path: string, maxLength: number): string {
  if (typeof input !== "string" || input.length === 0 || input.length > maxLength || !SAFE_ID.test(input) || CONTROL_CHARACTERS.test(input)) {
    fail("invalid_id", `${path} must be a short ASCII-safe identifier`, path);
  }
  return input;
}

function validateText(input: unknown, path: string, maxCodePoints: number): string {
  if (typeof input !== "string") {
    fail("invalid_text", `${path} must be a string`, path);
  }
  const value = input.trim();
  if (value.length === 0 || Array.from(value).length > maxCodePoints || CONTROL_CHARACTERS.test(value)) {
    fail("invalid_text", `${path} must be non-empty, short, and free of control characters`, path);
  }
  return value;
}

function validateRevision(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    fail("invalid_revision", `${path} must be a non-negative safe integer`, path);
  }
  return input;
}

function validateIsoDate(input: unknown, path: string): string {
  if (typeof input !== "string" || input.trim().length === 0 || Number.isNaN(Date.parse(input))) {
    fail("invalid_date", `${path} must be a valid ISO date`, path);
  }
  return input;
}

function requireRecord(input: unknown, message: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("invalid_object", message);
  }
  return input as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], allowOptional = false): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      fail("unknown_field", `unknown field: ${key}`, key);
    }
  }
  if (!allowOptional) {
    for (const key of keys) {
      if (!(key in record)) {
        fail("missing_field", `missing field: ${key}`, key);
      }
    }
  }
}

function assertJsonSize(value: unknown, label: string): void {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > SELF_CONCEPT_MAX_JSON_BYTES) {
    fail("payload_too_large", `${label} exceeds ${SELF_CONCEPT_MAX_JSON_BYTES} bytes`, label);
  }
}

function fail(code: string, message: string, path?: string): never {
  throw new SelfConceptValidationError(code, message, path);
}
