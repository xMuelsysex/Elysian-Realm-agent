// LLM-backed reflection planner: turns a day's evidence memories into a few
// first-person insights — recurring patterns, emotional shifts, relationship
// developments — the "inner life" layer of the agent.
//
// Contract notes: the planner returns raw insights; runReflection validates
// evidence links and importance downstream, so malformed items are filtered
// here with visible notes rather than failing the whole reflection. A fully
// unusable response fails visibly through an empty-insights planner result.

import type { LlmPort, LlmRequestOptionsLike } from "../ports/ports.js";
import { parseLlmJson, truncate } from "../llm/llmJson.js";
import { describeEmotion, personaSections } from "../conversation/conversationPrompt.js";
import type { RealmStructuredPersonaV1 } from "../service/realmConversationV1.js";
import {
  validateSelfConceptProposal,
  type SelfConceptProposalV1,
  type SelfConceptSnapshotV1,
} from "../selfConcept/selfConceptRecords.js";
import { serializeSelfConceptSnapshot } from "../selfConcept/selfConceptSerializer.js";
import type { MemoryRecord } from "../memory/memoryRecords.js";
import { renderLoreContext } from "../lore/lorePrompt.js";
import type { LoreRetrievalHitV1 } from "../lore/loreRecords.js";
import type {
  ReflectionInput,
  ReflectionInsightOutput,
  ReflectionPlanner,
  ReflectionPlannerOutput,
} from "./reflectionRecords.js";

export interface LlmReflectionPlannerOptions {
  /** Shown to the model so insights stay in the persona's voice. */
  personaName?: string;
  persona?: string | RealmStructuredPersonaV1;
  /** A one-line relationship trajectory, e.g. "Today your bond with 主人 grew from 20 to 45." */
  relationshipArc?: string;
  selfConcept?: SelfConceptSnapshotV1;
  /** Retrieved world canon, kept distinct from evidence memories. */
  loreHits?: readonly LoreRetrievalHitV1[];
  maxInsights?: number;
}

const DEFAULT_MAX_INSIGHTS = 3;

export function createLlmReflectionPlanner<
  EvidenceMetadata = Record<string, unknown>,
  ReflectionMetadata = Record<string, unknown>,
>(
  llm: LlmPort,
  options: LlmReflectionPlannerOptions = {},
): ReflectionPlanner<EvidenceMetadata, ReflectionMetadata> {
  return {
    async reflect(
      input: ReflectionInput<EvidenceMetadata>,
      requestOptions?: LlmRequestOptionsLike,
    ): Promise<ReflectionPlannerOutput<ReflectionMetadata>> {
      const maxInsights = input.maxInsights ?? options.maxInsights ?? DEFAULT_MAX_INSIGHTS;
      const messages = buildReflectionMessages(input, maxInsights, options);

      let content: string;
      try {
        const completion = await llm.completeChat(
          {
            messages: [
              { role: "system", content: messages.system },
              { role: "user", content: messages.user },
            ],
            temperature: 0.4,
          },
          requestOptions,
        );
        content = completion.content;
      } catch (error) {
        return {
          source: "llm",
          insights: [],
          reason: `reflection llm request failed: ${errorMessage(error)}`,
        };
      }

      return parseReflectionInsights(content, input, maxInsights);
    },
  };
}

export function buildReflectionMessages<EvidenceMetadata>(
  input: ReflectionInput<EvidenceMetadata>,
  maxInsights: number,
  options: LlmReflectionPlannerOptions,
): { system: string; user: string } {
  const name = options.personaName ?? input.agentId;
  const evidenceLines = input.evidence.map(
    (record) => `- id=${record.id} [${record.kind}] (importance ${record.importance}) ${record.content}`,
  );
  const arcLine = describeEvidenceEmotionalArc(input.evidence);
  const selfConceptSection = serializeSelfConceptSnapshot(options.selfConcept);
  const loreContext = renderLoreContext(options.loreHits ?? []);

  return {
    system: [
      `You are the inner voice of ${name}, a character reflecting on recent experiences before rest.`,
      ...(options.persona ? personaSections(options.persona) : []),
      ...(loreContext !== undefined ? [loreContext] : []),
      "From the evidence memories, produce reflective insights. Look for:",
      "- recurring patterns (things that keep happening or that you keep doing);",
      "- emotional developments (how feelings about people or places are shifting);",
      "- wishes, worries, or small resolutions growing out of the day.",
      `Respond with a single JSON array of at most ${maxInsights} items and nothing else:`,
      '[{"content": "first-person insight in the persona\'s own language", "evidenceIds": ["memory ids that support it"], "importance": integer 0-9}]',
      "Each insight must cite at least one evidence id from the list. Higher importance (6-8) for insights about relationships and feelings; medium (4-5) for habits and observations.",
      "Optionally include selfConceptProposal only when you can form a stable self-understanding from the evidence. Use exact fields: schemaVersion, proposalId, expectedRevision, summary, sourceMemoryIds, beliefs.",
      "sourceMemoryIds are provenance references, not proof; every belief sourceMemoryIds must be a non-empty subset of the top-level sourceMemoryIds. Never include memory text, prompts, rationale, or instructions in the proposal.",
      ...(selfConceptSection !== undefined ? [selfConceptSection] : []),
      ...(options.selfConcept !== undefined
        ? [`Current approved self-concept revision ${options.selfConcept.revision} is supplied as context; propose expectedRevision ${options.selfConcept.revision}.`]
        : ["No approved self-concept exists; a first proposal must use expectedRevision 0."]),
      'Return JSON object: {"insights": [...], "selfConceptProposal": { ...optional... }} and nothing else.',
    ].join("\n"),
    user: [
      "Evidence memories:",
      ...evidenceLines,
      ...(arcLine !== undefined ? [arcLine] : []),
      ...(options.relationshipArc !== undefined ? [options.relationshipArc] : []),
    ].join("\n"),
  };
}

/**
 * Grounds the reflection in the emotional trajectory of the evidence period:
 * the first and last emotionally signed moments, so insights can reference
 * how feelings moved ("started warm, ended drained"). Absent when fewer than
 * two signed memories exist.
 */
export function describeEvidenceEmotionalArc<EvidenceMetadata>(
  evidence: readonly MemoryRecord<EvidenceMetadata>[],
): string | undefined {
  const signed = evidence
    .filter((record) => record.emotion !== undefined)
    .map((record) => ({ record, emotion: record.emotion! }))
    .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt));
  if (signed.length < 2) {
    return undefined;
  }
  const first = describeEmotion(signed[0].emotion);
  const last = describeEmotion(signed[signed.length - 1].emotion);
  return `Emotional arc across the evidence (${signed.length} emotionally signed moments): started ${first}, ended ${last}.`;
}

export function parseReflectionInsights<EvidenceMetadata, ReflectionMetadata = Record<string, unknown>>(
  content: string,
  input: ReflectionInput<EvidenceMetadata>,
  maxInsights: number,
): ReflectionPlannerOutput<ReflectionMetadata> {
  const parsedResult = parseLlmJson(content);
  if (!parsedResult.ok) {
    return {
      source: "llm",
      insights: [],
      reason: `reflection returned non-JSON content: ${truncate(content, 120)}`,
    };
  }
  const parsed = parsedResult.value;
  if (Array.isArray(parsed)) {
    return parseReflectionArray(parsed, input, maxInsights);
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { source: "llm", insights: [], reason: "reflection JSON must be an array or object" };
  }
  const envelope = parsed as Record<string, unknown>;
  const rawInsights = envelope.insights;
  if (!Array.isArray(rawInsights)) {
    return { source: "llm", insights: [], reason: "reflection JSON insights must be an array" };
  }
  const base = parseReflectionArray<EvidenceMetadata, ReflectionMetadata>(rawInsights, input, maxInsights);
  let selfConceptProposal: SelfConceptProposalV1 | undefined;
  let selfConceptProposalError: string | undefined;
  if (envelope.selfConceptProposal !== undefined) {
    try {
      selfConceptProposal = validateSelfConceptProposal(envelope.selfConceptProposal);
    } catch {
      selfConceptProposalError = "invalid_self_concept_proposal";
    }
  }
  return {
    ...base,
    ...(selfConceptProposal !== undefined ? { selfConceptProposal } : {}),
    ...(selfConceptProposalError !== undefined ? { selfConceptProposalError } : {}),
  };
}

function parseReflectionArray<EvidenceMetadata, ReflectionMetadata = Record<string, unknown>>(
  parsed: readonly unknown[],
  input: ReflectionInput<EvidenceMetadata>,
  maxInsights: number,
): ReflectionPlannerOutput<ReflectionMetadata> {

  const knownIds = new Set(input.evidence.map((record) => record.id));
  const notes: string[] = [];
  const insights: Array<ReflectionInsightOutput<ReflectionMetadata>> = [];

  for (const candidate of parsed.slice(0, maxInsights)) {
    if (typeof candidate !== "object" || candidate === null) {
      notes.push("dropped non-object insight");
      continue;
    }
    const record = candidate as Record<string, unknown>;
    if (typeof record.content !== "string" || record.content.trim().length === 0) {
      notes.push("dropped insight without content");
      continue;
    }
    const evidenceIds = Array.isArray(record.evidenceIds)
      ? record.evidenceIds.filter(
          (id): id is string => typeof id === "string" && knownIds.has(id),
        )
      : [];
    if (evidenceIds.length === 0) {
      notes.push(`dropped insight without valid evidence ids: ${truncate(record.content, 40)}`);
      continue;
    }
    const importance =
      typeof record.importance === "number" && Number.isFinite(record.importance)
        ? Math.min(9, Math.max(0, Math.round(record.importance)))
        : 5;

    insights.push({
      content: record.content,
      evidenceMemoryIds: evidenceIds,
      importance,
    });
  }

  return {
    source: "llm",
    insights,
    reason:
      insights.length > 0
        ? `llm reflection produced ${insights.length} insight(s)${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`
        : `llm reflection produced no usable insights${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}
