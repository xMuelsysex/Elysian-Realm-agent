// Conversation runner: orchestrates one stateless conversation exchange.
//
// Pipeline: retrieve memories -> build system prompt -> generate the reply via
// the injected ConversationReplyPort -> run optional affect analysis -> build
// proposed memory writes. Reply failure fails the whole exchange (the reply is
// the core output); analysis failure stays visible in `affect` while the reply
// remains usable.

import type { LlmPort, LlmRequestOptionsLike } from "../ports/ports.js";
import type { EmotionSignature, MemoryWrite } from "../memory/memoryRecords.js";
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
  /**
   * Optional streaming variant: emits reply text chunks as they arrive and
   * resolves with the full content. The host falls back to generateReply
   * when a port does not implement it.
   */
  generateReplyStream?(
    input: ConversationReplyInput,
    onDelta: (text: string) => void,
  ): Promise<{ content: string }>;
}

export interface ConversationRunner {
  run(request: RealmConversationRequestV1): Promise<RealmConversationResponseV1>;
  /**
   * Optional streaming variant: emits reply text chunks as they arrive and
   * resolves with the full response. The host falls back to run() (emitting
   * the whole reply as one delta) when a runner does not implement it.
   */
  runStream?(
    request: RealmConversationRequestV1,
    onDelta: (text: string) => void,
    onReply?: (text: string) => void,
  ): Promise<RealmConversationResponseV1>;
}

export interface ConversationRunnerDeps {
  reply: ConversationReplyPort;
  /** Optional affect analysis LLM; when absent, analysis reports "skipped". */
  analysisLlm?: LlmPort;
  analysisRequestOptions?: LlmRequestOptionsLike;
}

export function createConversationRunner(deps: ConversationRunnerDeps): ConversationRunner {
  const run = async (request: RealmConversationRequestV1): Promise<RealmConversationResponseV1> => {
    const reply = await deps.reply.generateReply(buildReplyInput(request));
    return finishConversation(request, deps, reply.content);
  };

  return {
    run,
    async runStream(request, onDelta, onReply) {
      const reply = deps.reply.generateReplyStream
        ? await deps.reply.generateReplyStream(buildReplyInput(request), onDelta)
        : await deps.reply.generateReply(buildReplyInput(request)).then((result) => {
            onDelta(result.content);
            return result;
          });
      // The reply is complete: notify before the (second, slower) analysis
      // call so the host can unlock the UI right away.
      onReply?.(reply.content);
      return finishConversation(request, deps, reply.content);
    },
  };
}

function buildReplyInput(request: RealmConversationRequestV1): ConversationReplyInput {
  const memoryStore = new InMemoryMemoryStore<RealmMemoryMetadataV1>(request.memories);
  const retrieval = memoryStore.retrieve(request.agent.agentId, {
    text: request.message.content,
    now: request.now,
    topK: request.options?.memoryTopK ?? DEFAULT_CONVERSATION_MEMORY_TOP_K,
    // Mood-congruent recall: when the agent has an emotional state, weight
    // retrieval toward memories that match it (small, non-dominant term).
    ...(request.affect !== undefined
      ? {
          emotionBias: { valence: request.affect.valence, arousal: request.affect.arousal },
          weights: { emotion: 0.1 },
        }
      : {}),
  });

  const lastTurnAt = [...request.history].reverse().find((turn) => turn.at !== undefined)?.at;
  const systemPrompt = buildConversationSystemPrompt({
    agent: request.agent,
    participant: request.participant,
    relationship: request.relationship,
    mood: request.mood,
    affect: request.affect,
    memoryHits: retrieval.hits,
    now: request.now,
    ...(lastTurnAt !== undefined ? { lastTurnAt } : {}),
  });

  return {
    conversationId: request.conversationId,
    agentId: request.agent.agentId,
    now: request.now,
    systemPrompt,
    history: request.history,
    message: request.message.content,
  };
}

async function finishConversation(
  request: RealmConversationRequestV1,
  deps: ConversationRunnerDeps,
  replyContent: string,
): Promise<RealmConversationResponseV1> {
  const analyzedTurns: RealmConversationTurnV1[] = [
    ...request.history.slice(-4),
    { role: "participant", content: request.message.content },
    { role: "agent", content: replyContent },
  ];
  const affect = deps.analysisLlm
    ? await runAffectAnalysis(
        deps.analysisLlm,
        {
          agentDisplayName: request.agent.displayName,
          participantDisplayName: request.participant.displayName,
          relationship: request.relationship,
          mood: request.mood,
          affect: request.affect,
          turns: analyzedTurns,
        },
        deps.analysisRequestOptions,
      )
    : { analysis: "skipped" as const, reason: "no affect analysis llm configured" };

  return {
    schemaVersion: REALM_CONVERSATION_SCHEMA_VERSION,
    conversationId: request.conversationId,
    agentId: request.agent.agentId,
    reply: { content: replyContent },
    affect,
    memoryWrites: buildConversationMemoryWrites(
      request,
      replyContent,
      affect.memoryImportance,
      affect.emotion,
    ),
  };
}

export function buildConversationMemoryWrites(
  request: RealmConversationRequestV1,
  replyContent: string,
  importance: number = CONVERSATION_MEMORY_IMPORTANCE,
  emotion?: EmotionSignature,
): readonly MemoryWrite<RealmMemoryMetadataV1>[] {
  const shared = {
    kind: "conversation" as const,
    createdAt: request.now,
    importance,
    tags: [
      "conversation",
      request.agent.agentId,
      request.participant.participantId,
    ],
    ...(emotion !== undefined ? { emotion } : {}),
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
