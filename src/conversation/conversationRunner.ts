// Conversation runner: orchestrates one stateless conversation exchange.
//
// Pipeline: retrieve memories -> build system prompt -> generate the reply via
// the injected ConversationReplyPort -> run optional affect analysis -> build
// proposed memory writes. Reply failure fails the whole exchange (the reply is
// the core output); analysis failure stays visible in `affect` while the reply
// remains usable.

import type { LlmPort, LlmRequestOptionsLike } from "../ports/ports.js";
import type { MemoryWrite } from "../memory/memoryRecords.js";
import { InMemoryMemoryStore } from "../memory/inMemoryMemoryStore.js";
import {
  DEFAULT_CONVERSATION_MEMORY_TOP_K,
  REALM_CONVERSATION_SCHEMA_VERSION,
  type RealmConversationRequestV1,
  type RealmConversationResponseV1,
  type RealmConversationTurnV1,
} from "../service/realmConversationV1.js";
import type { RealmMemoryMetadataV1 } from "../service/realmStepV1.js";
import { buildConversationSystemPrompt } from "./conversationPrompt.js";
import { runAffectAnalysis } from "./affectAnalysis.js";

/** Base importance for routine conversation memories. */
export const CONVERSATION_MEMORY_IMPORTANCE = 3;

export interface ConversationReplyInput {
  conversationId: string;
  agentId: string;
  now: string;
  systemPrompt: string;
  /** Prior turns, oldest first. */
  history: readonly RealmConversationTurnV1[];
  /** The new participant message to answer. */
  message: string;
}

/** Reply generation port; the pi-agent-core adapter implements this. */
export interface ConversationReplyPort {
  generateReply(input: ConversationReplyInput): Promise<{ content: string }>;
}

export interface ConversationRunner {
  run(request: RealmConversationRequestV1): Promise<RealmConversationResponseV1>;
}

export interface ConversationRunnerDeps {
  reply: ConversationReplyPort;
  /** Optional affect analysis LLM; when absent, analysis reports "skipped". */
  analysisLlm?: LlmPort;
  analysisRequestOptions?: LlmRequestOptionsLike;
}

export function createConversationRunner(deps: ConversationRunnerDeps): ConversationRunner {
  return {
    async run(request: RealmConversationRequestV1): Promise<RealmConversationResponseV1> {
      const memoryStore = new InMemoryMemoryStore<RealmMemoryMetadataV1>(request.memories);
      const retrieval = memoryStore.retrieve(request.agent.agentId, {
        text: request.message.content,
        now: request.now,
        topK: request.options?.memoryTopK ?? DEFAULT_CONVERSATION_MEMORY_TOP_K,
      });

      const systemPrompt = buildConversationSystemPrompt({
        agent: request.agent,
        participant: request.participant,
        relationship: request.relationship,
        mood: request.mood,
        memoryHits: retrieval.hits,
      });

      const reply = await deps.reply.generateReply({
        conversationId: request.conversationId,
        agentId: request.agent.agentId,
        now: request.now,
        systemPrompt,
        history: request.history,
        message: request.message.content,
      });

      const analyzedTurns: RealmConversationTurnV1[] = [
        ...request.history.slice(-4),
        { role: "participant", content: request.message.content },
        { role: "agent", content: reply.content },
      ];
      const affect = deps.analysisLlm
        ? await runAffectAnalysis(
            deps.analysisLlm,
            {
              agentDisplayName: request.agent.displayName,
              participantDisplayName: request.participant.displayName,
              relationship: request.relationship,
              mood: request.mood,
              turns: analyzedTurns,
            },
            deps.analysisRequestOptions,
          )
        : { analysis: "skipped" as const, reason: "no affect analysis llm configured" };

      return {
        schemaVersion: REALM_CONVERSATION_SCHEMA_VERSION,
        conversationId: request.conversationId,
        agentId: request.agent.agentId,
        reply: { content: reply.content },
        affect,
        memoryWrites: buildConversationMemoryWrites(request, reply.content),
      };
    },
  };
}

export function buildConversationMemoryWrites(
  request: RealmConversationRequestV1,
  replyContent: string,
): readonly MemoryWrite<RealmMemoryMetadataV1>[] {
  const shared = {
    kind: "conversation" as const,
    createdAt: request.now,
    importance: CONVERSATION_MEMORY_IMPORTANCE,
    tags: [
      "conversation",
      request.agent.agentId,
      request.participant.participantId,
    ],
  };

  return [
    {
      ...shared,
      content: `${request.participant.displayName}: ${request.message.content}`,
      sourceIds: [request.participant.participantId],
      metadata: {
        source: "conversation",
        conversationId: request.conversationId,
        messageId: request.message.messageId,
        messageRole: "incoming",
      },
    },
    {
      ...shared,
      content: `${request.agent.displayName}: ${replyContent}`,
      sourceIds: [request.agent.agentId],
      metadata: {
        source: "conversation",
        conversationId: request.conversationId,
        messageId: `${request.message.messageId}:reply`,
        messageRole: "response",
      },
    },
  ];
}
