// LLM-backed reflection planner: turns a day's evidence memories into a few
// first-person insights — recurring patterns, emotional shifts, relationship
// developments — the "inner life" layer of the agent.
//
// Contract notes: the planner returns raw insights; runReflection validates
// evidence links and importance downstream, so malformed items are filtered
// here with visible notes rather than failing the whole reflection. A fully
// unusable response fails visibly through an empty-insights planner result.

import type { LlmPort, LlmRequestOptionsLike } from "../ports/ports.js";
import type {
  ReflectionInput,
  ReflectionInsightOutput,
  ReflectionPlanner,
  ReflectionPlannerOutput,
} from "./reflectionRecords.js";

export interface LlmReflectionPlannerOptions {
  /** Shown to the model so insights stay in the persona's voice. */
  personaName?: string;
  persona?: string;
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

  return {
    system: [
      `You are the inner voice of ${name}, a character reflecting on recent experiences before rest.`,
      ...(options.persona ? [`Persona:\n${options.persona}`] : []),
      "From the evidence memories, produce reflective insights. Look for:",
      "- recurring patterns (things that keep happening or that you keep doing);",
      "- emotional developments (how feelings about people or places are shifting);",
      "- wishes, worries, or small resolutions growing out of the day.",
      `Respond with a single JSON array of at most ${maxInsights} items and nothing else:`,
      '[{"content": "first-person insight in the persona\'s own language", "evidenceIds": ["memory ids that support it"], "importance": integer 0-9}]',
      "Each insight must cite at least one evidence id from the list. Higher importance (6-8) for insights about relationships and feelings; medium (4-5) for habits and observations.",
    ].join("\n"),
    user: ["Evidence memories:", ...evidenceLines].join("\n"),
  };
}

export function parseReflectionInsights<EvidenceMetadata, ReflectionMetadata = Record<string, unknown>>(
  content: string,
  input: ReflectionInput<EvidenceMetadata>,
  maxInsights: number,
): ReflectionPlannerOutput<ReflectionMetadata> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch {
    return {
      source: "llm",
      insights: [],
      reason: `reflection returned non-JSON content: ${truncate(content, 120)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return { source: "llm", insights: [], reason: "reflection JSON must be an array" };
  }

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

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}
