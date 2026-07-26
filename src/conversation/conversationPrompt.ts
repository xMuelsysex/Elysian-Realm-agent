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

export function buildConversationSystemPrompt<Metadata>(
  input: ConversationPromptInput<Metadata>,
): string {
  const { agent, participant, relationship, mood, memoryHits } = input;

  const sections: string[] = [
    `You are ${agent.displayName} (persona ${agent.personaId}), a character living in the Elysian Realm simulation.`,
    `Persona:\n${agent.persona}`,
  ];

  const moodLine = mood
    ? `Current mood: ${mood.mood} (intensity ${mood.intensity.toFixed(2)} of 1).`
    : "Current mood: unremarkable.";
  const relationshipLine = relationship
    ? `Relationship with ${participant.displayName}: ${describeAffinity(relationship.affinity)} (affinity ${relationship.affinity} on a -100..100 scale).`
    : `Relationship with ${participant.displayName}: no established relationship yet.`;
  sections.push(`${moodLine}\n${relationshipLine}`);

  if (memoryHits.length > 0) {
    const lines = memoryHits.map((hit) => `- [${hit.record.kind}] ${hit.record.content}`);
    sections.push(`Memories relevant to this conversation:\n${lines.join("\n")}`);
  } else {
    sections.push("Memories relevant to this conversation: none retrieved.");
  }

  sections.push(
    [
      `You are talking with ${participant.displayName}.`,
      `Stay in character as ${agent.displayName}; let the mood, relationship, and memories above shape tone and content.`,
      "Reply with plain conversational text only, in the language the participant is using.",
    ].join(" "),
  );

  return sections.join("\n\n");
}
