// Post-conversation affect analysis driven by an LlmPort.
//
// The LLM is asked for a strict JSON object; parsing failures surface as
// `analysis: "failed"` with the reason, never as a fake neutral result. Value
// bounds are defended at this system boundary: affinity deltas clamp to the
// per-turn limit and mood intensity clamps to [0, 1], with clamping noted in
// the reason so it stays observable.

import type { AffectState, AgentMood, RelationshipAffect } from "../affect/affectRecords.js";
import { MOOD_INTENSITY_MAX, MOOD_INTENSITY_MIN } from "../affect/affectRecords.js";
import type { LlmPort, LlmRequestOptionsLike } from "../ports/ports.js";
import { parseLlmJson, truncate } from "../llm/llmJson.js";
import { describeAffectState } from "./conversationPrompt.js";
import type {
  RealmConversationAffectV1,
  RealmConversationTurnV1,
} from "../service/realmConversationV1.js";

/** Bound for a single conversation exchange's proposed affinity movement. */
export const MAX_CONVERSATION_AFFINITY_DELTA = 10;

export interface AffectAnalysisInput {
  agentDisplayName: string;
  participantDisplayName: string;
  relationship?: RelationshipAffect;
  mood?: AgentMood;
  /** Plot-driven emotional state, when the host tracks one; grounds mood proposals. */
  affect?: AffectState;
  /** The exchange to analyze, oldest first, including the agent's new reply. */
  turns: readonly RealmConversationTurnV1[];
}

export function buildAffectAnalysisMessages(input: AffectAnalysisInput): {
  system: string;
  user: string;
} {
  const relationshipLine = input.relationship
    ? `current affinity ${input.relationship.affinity} on a -100..100 scale`
    : "no established relationship yet (affinity starts at 0)";
  const moodLine = input.mood
    ? `current mood "${input.mood.mood}" at intensity ${input.mood.intensity.toFixed(2)}`
    : "no established mood";
  const affectLine = input.affect ? `; emotional state ${describeAffectState(input.affect)}` : "";

  const transcript = input.turns
    .map((turn) =>
      `${turn.role === "agent" ? input.agentDisplayName : input.participantDisplayName}: ${turn.content}`,
    )
    .join("\n");

  return {
    system: [
      "You analyze how a roleplayed character's feelings shift after a conversation exchange.",
      "Respond with a single JSON object and nothing else, using this shape:",
      `{"affinityDelta": number in [-${MAX_CONVERSATION_AFFINITY_DELTA}, ${MAX_CONVERSATION_AFFINITY_DELTA}], "mood": string, "moodIntensity": number in [0, 1], "memoryImportance": integer in [0, 9], "emotion": {"valence": number in [-1, 1], "arousal": number in [0, 1]}, "reason": string}`,
      "affinityDelta is the change in how the character feels about the participant caused by this exchange alone.",
      "emotion is the feeling this exchange leaves the character with right now: valence negative..positive, arousal calm..intense (e.g. thrilled = 0.9/0.8, quietly content = 0.5/0.2, frustrated = -0.6/0.7, drained = -0.4/0.1).",
      "memoryImportance rates how much this exchange deserves to be remembered:",
      "7-9 promises, plans, confessions, or major personal revelations; 5-6 emotionally significant moments or new facts about each other; 3-4 ordinary topical conversation; 1-2 small talk and greetings.",
    ].join("\n"),
    user: [
      `Character: ${input.agentDisplayName}; ${relationshipLine}; ${moodLine}${affectLine}.`,
      `Participant: ${input.participantDisplayName}.`,
      "Exchange:",
      transcript,
    ].join("\n"),
  };
}

export async function runAffectAnalysis(
  llm: LlmPort,
  input: AffectAnalysisInput,
  options?: LlmRequestOptionsLike,
): Promise<RealmConversationAffectV1> {
  let content: string;
  try {
    const messages = buildAffectAnalysisMessages(input);
    const completion = await llm.completeChat(
      {
        messages: [
          { role: "system", content: messages.system },
          { role: "user", content: messages.user },
        ],
        temperature: 0,
      },
      options,
    );
    content = completion.content;
  } catch (error) {
    return {
      analysis: "failed",
      reason: `affect analysis request failed: ${errorMessage(error)}`,
    };
  }

  return parseAffectAnalysis(content);
}

export function parseAffectAnalysis(content: string): RealmConversationAffectV1 {
  const parsedResult = parseLlmJson(content);
  if (!parsedResult.ok) {
    return {
      analysis: "failed",
      reason: `affect analysis returned non-JSON content: ${truncate(content, 120)}`,
    };
  }
  const parsed = parsedResult.value;

  if (!isRecord(parsed)) {
    return { analysis: "failed", reason: "affect analysis JSON must be an object" };
  }

  const notes: string[] = [];
  const affinityDelta = readAffinityDelta(parsed, notes);
  const mood = readMood(parsed, notes);
  const memoryImportance = readMemoryImportance(parsed, notes);
  const emotion = readEmotion(parsed, notes);

  if (affinityDelta === undefined && mood === undefined) {
    return {
      analysis: "failed",
      reason: "affect analysis produced neither a usable affinityDelta nor a usable mood",
    };
  }

  const reason = typeof parsed.reason === "string" && parsed.reason.trim().length > 0
    ? parsed.reason
    : "llm affect analysis";

  return {
    analysis: "llm",
    reason: notes.length > 0 ? `${reason} (${notes.join("; ")})` : reason,
    ...(affinityDelta !== undefined ? { affinityDelta } : {}),
    ...(mood !== undefined ? { mood } : {}),
    ...(memoryImportance !== undefined ? { memoryImportance } : {}),
    ...(emotion !== undefined ? { emotion } : {}),
  };
}

function readAffinityDelta(parsed: Record<string, unknown>, notes: string[]): number | undefined {
  const raw = parsed.affinityDelta;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    notes.push("ignored non-numeric affinityDelta");
    return undefined;
  }
  const clamped = Math.min(
    MAX_CONVERSATION_AFFINITY_DELTA,
    Math.max(-MAX_CONVERSATION_AFFINITY_DELTA, raw),
  );
  if (clamped !== raw) {
    notes.push(`affinityDelta clamped from ${raw} to ${clamped}`);
  }
  return clamped;
}

function readMood(
  parsed: Record<string, unknown>,
  notes: string[],
): { mood: string; intensity: number } | undefined {
  const rawMood = parsed.mood;
  if (rawMood === undefined || rawMood === null) return undefined;
  if (typeof rawMood !== "string" || rawMood.trim().length === 0) {
    notes.push("ignored empty or non-string mood");
    return undefined;
  }

  const rawIntensity = parsed.moodIntensity;
  if (typeof rawIntensity !== "number" || !Number.isFinite(rawIntensity)) {
    notes.push("mood present but moodIntensity missing or non-numeric; ignored mood");
    return undefined;
  }
  const intensity = Math.min(MOOD_INTENSITY_MAX, Math.max(MOOD_INTENSITY_MIN, rawIntensity));
  if (intensity !== rawIntensity) {
    notes.push(`moodIntensity clamped from ${rawIntensity} to ${intensity}`);
  }

  return { mood: rawMood, intensity };
}

function readMemoryImportance(parsed: Record<string, unknown>, notes: string[]): number | undefined {
  const raw = parsed.memoryImportance;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    notes.push("ignored non-numeric memoryImportance");
    return undefined;
  }
  const clamped = Math.min(9, Math.max(0, Math.round(raw)));
  if (clamped !== raw) {
    notes.push(`memoryImportance normalized from ${raw} to ${clamped}`);
  }
  return clamped;
}

function readEmotion(
  parsed: Record<string, unknown>,
  notes: string[],
): { valence: number; arousal: number } | undefined {
  const raw = parsed.emotion;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    notes.push("ignored non-object emotion");
    return undefined;
  }

  const { valence, arousal } = raw as Record<string, unknown>;
  if (typeof valence !== "number" || !Number.isFinite(valence) ||
      typeof arousal !== "number" || !Number.isFinite(arousal)) {
    notes.push("ignored emotion with non-numeric valence or arousal");
    return undefined;
  }

  const clampedValence = Math.min(1, Math.max(-1, valence));
  const clampedArousal = Math.min(1, Math.max(0, arousal));
  if (clampedValence !== valence) {
    notes.push(`emotion.valence clamped from ${valence} to ${clampedValence}`);
  }
  if (clampedArousal !== arousal) {
    notes.push(`emotion.arousal clamped from ${arousal} to ${clampedArousal}`);
  }

  return { valence: clampedValence, arousal: clampedArousal };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}
