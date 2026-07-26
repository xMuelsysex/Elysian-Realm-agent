// Conversation prompt assembly: pure, deterministic functions that turn the
// agent's persona, affect state, and retrieved memories into a system prompt.
// No LLM or pi dependency lives here.

import type { AgentMood, RelationshipAffect } from "../affect/affectRecords.js";
import type { MemoryRetrievalHit } from "../memory/memoryRecords.js";
import type {
  RealmConversationAgentV1,
  RealmConversationParticipantV1,
} from "../service/realmConversationV1.js";

export interface ConversationPromptInput<Metadata = Record<string, unknown>> {
  agent: RealmConversationAgentV1;
  participant: RealmConversationParticipantV1;
  relationship?: RelationshipAffect;
  mood?: AgentMood;
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

export function buildConversationSystemPrompt<Metadata>(
  input: ConversationPromptInput<Metadata>,
): string {
  const { agent, participant, relationship, mood, memoryHits, now, lastTurnAt } = input;

  const sections: string[] = [
    `You are ${agent.displayName} (persona ${agent.personaId}), a character living in the Elysian Realm simulation.`,
    `Persona:\n${agent.persona}`,
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
  sections.push(`${moodLine}\n${relationshipLine}`);

  if (memoryHits.length > 0) {
    const lines = memoryHits.map((hit) => {
      const when = now !== undefined ? `(${describeRelativeTime(hit.record.createdAt, now)}) ` : "";
      return `- ${when}[${hit.record.kind}] ${hit.record.content}`;
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
