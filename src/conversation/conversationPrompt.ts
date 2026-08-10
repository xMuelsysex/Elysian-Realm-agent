// Conversation prompt assembly: pure, deterministic functions that turn the
// agent's persona, affect state, and retrieved memories into a system prompt.
// No LLM or pi dependency lives here.

import type { AffectState, AgentMood, RelationshipAffect } from "../affect/affectRecords.js";
import { EMOTION_LABELS, type EmotionLabel } from "../affect/affectRecords.js";
import type { EmotionSignature, MemoryRetrievalHit } from "../memory/memoryRecords.js";
import type {
  RealmConversationAgentV1,
  RealmConversationParticipantV1,
  RealmStructuredPersonaV1,
} from "../service/realmConversationV1.js";

export interface ConversationPromptInput<Metadata = Record<string, unknown>> {
  agent: RealmConversationAgentV1;
  participant: RealmConversationParticipantV1;
  relationship?: RelationshipAffect;
  /** Affinity history (oldest first); renders a trajectory line when it moved. */
  relationshipHistory?: readonly { affinity: number; at: string }[];
  mood?: AgentMood;
  /** Plot-driven emotional state snapshot, when the host tracks one. */
  affect?: AffectState;
  memoryHits: readonly MemoryRetrievalHit<Metadata>[];
  /** Current time; enables relative timestamps on memories and "time since last chat". */
  now?: string;
  /** Timestamp of the previous conversation turn, if the host tracks turns. */
  lastTurnAt?: string;
}

/** Deterministic affinity band label for prompt injection. */
export function describeAffinity(affinity: number): string {
  if (affinity >= 75) return "devoted";
  if (affinity >= 40) return "close";
  if (affinity >= 15) return "friendly";
  if (affinity > -15) return "neutral";
  if (affinity > -40) return "wary";
  if (affinity > -75) return "hostile";
  return "resentful";
}

/** Coarse, human-shaped relative time: "just now", "3 hours ago", "5 days ago". */
export function describeRelativeTime(from: string, to: string): string {
  const deltaMs = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return "just now";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

/**
 * Human-shaped description of a memory's emotional signature: quadrant label
 * with an intensity modifier, e.g. "strongly joyful and energized".
 */
export function describeEmotion(emotion: EmotionSignature): string {
  const { valence, arousal } = emotion;

  let core: string;
  if (valence >= 0.2) {
    core = arousal >= 0.55 ? "joyful and energized" : "warm and content";
  } else if (valence <= -0.2) {
    core = arousal >= 0.55 ? "tense and unsettled" : "heavy and low";
  } else {
    core = arousal >= 0.55 ? "alert and stirred" : "calm and neutral";
  }

  const modifier = Math.abs(valence) >= 0.7 ? "strongly " : "";
  return `${modifier}${core}`;
}

/**
 * Human-shaped description of an affect snapshot: the mood quadrant (shared
 * with memory signatures) plus the prominent GoEmotions labels, e.g.
 * "tense and unsettled; prominent feelings: fear (0.60), nervousness (0.40)".
 */
export function describeAffectState(affect: AffectState): string {
  const core = describeEmotion({ valence: affect.valence, arousal: affect.arousal });
  const prominent = prominentEmotionLabels(affect);
  if (prominent.length === 0) {
    return core;
  }
  const labels = prominent
    .map((entry) => `${entry.label} (${entry.strength.toFixed(2)})`)
    .join(", ");
  return `${core}; prominent feelings: ${labels}`;
}

/** Strongest non-neutral labels at or above this strength count as prominent. */
export const PROMINENT_EMOTION_MIN_STRENGTH = 0.25;

/** Strongest non-neutral labels, strength >= 0.25, most intense first. */
export function prominentEmotionLabels(
  affect: AffectState,
  limit = 2,
): { label: EmotionLabel; strength: number }[] {
  return EMOTION_LABELS
    .filter((label) => label !== "neutral")
    .map((label) => ({ label, strength: affect.emotionLabels[label] }))
    .filter((entry) => entry.strength >= PROMINENT_EMOTION_MIN_STRENGTH)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, limit);
}

/**
 * Deterministic expression constraints derived from the affect snapshot,
 * injected as guidance so the reply's tone follows the emotional state.
 */
export function affectExpressionGuidance(affect: AffectState): readonly string[] {
  const guidance: string[] = [];
  if (affect.arousal >= 0.7) {
    guidance.push("you are highly stirred — answer in shorter, more urgent sentences");
  }
  if (affect.valence <= -0.4) {
    guidance.push("weigh your words; the tone is subdued and heavy");
  }
  if (affect.emotionLabels.fear >= 0.55) {
    guidance.push("you feel uneasy — keep answers guarded and avoid dwelling on what frightens you");
  }
  if (affect.emotionLabels.anger >= 0.55) {
    guidance.push("you are irritated — your words carry a sharp edge");
  }
  return guidance;
}

/**
 * Render a structured character contract into ordered prompt sections.
 * A plain-text persona keeps the legacy single-section shape.
 */
export function personaSections(persona: string | RealmStructuredPersonaV1): string[] {
  if (typeof persona === "string") {
    return [`Persona:\n${persona}`];
  }
  const sections: string[] = [
    `Identity:\n${persona.identity}`,
    `Personality:\n${persona.personality}`,
    `Values:\n${persona.values}`,
    `Speech style:\n${persona.speechStyle}`,
  ];
  // Optional arrays per the validation contract: absent means empty.
  const boundaries = persona.boundaries ?? [];
  const behaviorTraits = persona.behaviorTraits ?? [];
  const exampleLines = persona.exampleLines ?? [];
  if (boundaries.length > 0) {
    sections.push(`Character boundaries (never break these):\n${boundaries.map((line) => `- ${line}`).join("\n")}`);
  }
  if (behaviorTraits.length > 0) {
    sections.push(`Behavior tendencies:\n${behaviorTraits.map((line) => `- ${line}`).join("\n")}`);
  }
  if (exampleLines.length > 0) {
    sections.push(`Speech examples (match this voice):\n${exampleLines.map((line) => `- ${line}`).join("\n")}`);
  }
  return sections;
}

export function buildConversationSystemPrompt<Metadata>(
  input: ConversationPromptInput<Metadata>,
): string {
  const { agent, participant, relationship, relationshipHistory, mood, affect, memoryHits, now, lastTurnAt } = input;

  const sections: string[] = [
    `You are ${agent.displayName} (persona ${agent.personaId}), a character living in the Elysian Realm simulation.`,
    ...personaSections(agent.persona),
  ];

  if (now !== undefined) {
    const timeLines = [`Current time: ${formatClock(now)}.`];
    if (lastTurnAt !== undefined) {
      timeLines.push(`Your previous exchange with ${participant.displayName} was ${describeRelativeTime(lastTurnAt, now)}.`);
    }
    sections.push(timeLines.join("\n"));
  }

  const moodLine = mood
    ? `Current mood: ${mood.mood} (intensity ${mood.intensity.toFixed(2)} of 1).`
    : "Current mood: unremarkable.";
  const relationshipLine = relationship
    ? `Relationship with ${participant.displayName}: ${describeAffinity(relationship.affinity)} (affinity ${relationship.affinity} on a -100..100 scale).`
    : `Relationship with ${participant.displayName}: no established relationship yet.`;
  const profileLine = participant.profile
    ? `About ${participant.displayName}: ${participant.profile}`
    : undefined;
  sections.push([moodLine, relationshipLine, ...(profileLine !== undefined ? [profileLine] : [])].join("\n"));

  // Relationship trajectory: let the reply feel the bond evolving across
  // exchanges, not just its current level.
  if (relationshipHistory !== undefined && relationshipHistory.length >= 2) {
    const first = relationshipHistory[0].affinity;
    const last = relationshipHistory[relationshipHistory.length - 1].affinity;
    if (first !== last) {
      sections.push(
        `Relationship trajectory: your bond with ${participant.displayName} has moved from ${first} to ${last} over your recent exchanges.`,
      );
    }
  }

  if (affect) {
    const affectLines = [`Current emotional state: ${describeAffectState(affect)}.`];
    const guidance = affectExpressionGuidance(affect);
    if (guidance.length > 0) {
      affectLines.push(guidance.join("; "));
    }
    sections.push(affectLines.join("\n"));
  }

  if (memoryHits.length > 0) {
    const lines = memoryHits.map((hit) => {
      const when = now !== undefined ? `(${describeRelativeTime(hit.record.createdAt, now)}) ` : "";
      const emotion = hit.record.emotion !== undefined
        ? ` — at the time you felt ${describeEmotion(hit.record.emotion)}`
        : "";
      return `- ${when}[${hit.record.kind}] ${hit.record.content}${emotion}`;
    });
    sections.push(`Memories relevant to this conversation:\n${lines.join("\n")}`);
  } else {
    sections.push("Memories relevant to this conversation: none retrieved.");
  }

  sections.push(
    [
      `You are talking with ${participant.displayName}.`,
      `Stay in character as ${agent.displayName}; let the time of day, mood, relationship, and memories above shape tone and content.`,
      "Reply with plain conversational text only, in the language the participant is using.",
    ].join(" "),
  );

  return sections.join("\n\n");
}

function formatClock(now: string): string {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) return now;
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${weekdays[date.getDay()]} ${hh}:${mm}`;
}
