// Life narrative: turns a deterministic routine slot into a first-person
// diary moment via an LLM, so the agent's daily life reads as lived
// experience instead of schedule entries. A narrative failure only skips the
// narrative — the deterministic tick memories are already in place.
//
// No pi imports: driven through the LlmPort interface.

import type { LlmPort, LlmRequestOptionsLike } from "../ports/ports.js";
import type { EmotionSignature, MemoryWrite } from "../memory/memoryRecords.js";
import { personaSections, describeAffectState } from "../conversation/conversationPrompt.js";
import type { AffectState } from "../affect/affectRecords.js";
import type { RealmStructuredPersonaV1 } from "../service/realmConversationV1.js";
import type { RealmMemoryMetadataV1, RealmRoutinePeriodV1 } from "../service/realmStepV1.js";

export const LIFE_NARRATIVE_IMPORTANCE = 4;

export interface LifeNarrativeInput {
  agentId: string;
  displayName: string;
  persona: string | RealmStructuredPersonaV1;
  period: RealmRoutinePeriodV1;
  locationId: string;
  intent: string;
  now: string;
  /** A couple of recent narrative memories, oldest first, for continuity. */
  recentNarratives?: readonly string[];
  /** How the agent feels right now, stamped onto the narrative memory. */
  emotion?: EmotionSignature;
  /** Current affect snapshot; injected so the diary matches the mood. */
  affect?: AffectState;
  /** One-line relationship trajectory for the day, when it moved. */
  relationshipArc?: string;
}

export function buildLifeNarrativeMessages(input: LifeNarrativeInput): {
  system: string;
  user: string;
} {
  return {
    system: [
      `You write one tiny diary moment in the voice of ${input.displayName}.`,
      ...personaSections(input.persona),
      "Rules:",
      "- 1-2 sentences, first person, in the persona's own language.",
      "- Ground it in the given activity and place, but invent one small, concrete, sensory detail or micro-event (something noticed, a tiny surprise, a passing feeling).",
      "- Vary from the recent moments; never repeat their phrasing.",
      "- Output the diary moment only, no quotes, no commentary.",
    ].join("\n"),
    user: [
      `Time of day: ${input.period}. Place: ${input.locationId}. Activity: ${input.intent}`,
      ...(input.affect !== undefined
        ? [`Your current emotional state: ${describeAffectState(input.affect)}.`]
        : []),
      ...(input.relationshipArc !== undefined ? [input.relationshipArc] : []),
      ...(input.recentNarratives && input.recentNarratives.length > 0
        ? ["Recent moments:", ...input.recentNarratives.map((entry) => `- ${entry}`)]
        : []),
    ].join("\n"),
  };
}

/**
 * Generate one narrative memory write, or undefined when the LLM fails or
 * returns empty content. Failures are reported through the returned error
 * field so the caller can log them without aborting the tick.
 */
export async function runLifeNarrative(
  llm: LlmPort,
  input: LifeNarrativeInput,
  options?: LlmRequestOptionsLike,
): Promise<
  | { write: MemoryWrite<RealmMemoryMetadataV1> }
  | { error: string }
> {
  const messages = buildLifeNarrativeMessages(input);
  let content: string;
  try {
    const completion = await llm.completeChat(
      {
        messages: [
          { role: "system", content: messages.system },
          { role: "user", content: messages.user },
        ],
        temperature: 0.9,
        maxTokens: 200,
      },
      options,
    );
    content = completion.content.trim();
  } catch (error) {
    return { error: `life narrative request failed: ${errorMessage(error)}` };
  }

  if (content.length === 0) {
    return { error: "life narrative returned empty content" };
  }

  return {
    write: {
      kind: "observation",
      content,
      createdAt: input.now,
      importance: LIFE_NARRATIVE_IMPORTANCE,
      sourceIds: [input.agentId],
      visibility: "private",
      tags: [input.agentId, input.period, input.locationId, "life-narrative"],
      ...(input.emotion !== undefined ? { emotion: input.emotion } : {}),
      metadata: {
        source: "engine",
        period: input.period,
        locationId: input.locationId,
      },
    },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}
