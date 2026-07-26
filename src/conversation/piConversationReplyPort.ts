// pi-agent-core adapter for the ConversationReplyPort.
//
// Boundary: this module is the only place in the package that imports
// @earendil-works/pi-agent-core, exported solely via the "./conversation/pi"
// subpath so the root entrypoint stays free of pi imports.
//
// Each generateReply call builds a fresh Agent (the service is stateless; the
// host owns conversation history). The pi stream contract encodes failures in
// the final assistant message, so error/aborted stop reasons are re-raised
// here as visible errors.

import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
  ConversationReplyInput,
  ConversationReplyPort,
} from "./conversationRunner.js";
import type { RealmConversationTurnV1 } from "../service/realmConversationV1.js";

export interface PiConversationReplyPortDeps {
  /** Production: `models.streamSimple.bind(models)`. Tests: a fake stream. */
  streamFn: StreamFn;
  model: Model<Api>;
}

export function createPiConversationReplyPort(
  deps: PiConversationReplyPortDeps,
): ConversationReplyPort {
  return {
    async generateReply(input: ConversationReplyInput): Promise<{ content: string }> {
      const agent = new Agent({
        initialState: {
          systemPrompt: input.systemPrompt,
          model: deps.model,
          messages: input.history.map((turn) => toAgentMessage(turn, deps.model)),
        },
        streamFn: deps.streamFn,
        sessionId: input.conversationId,
      });

      await agent.prompt(input.message);

      const reply = [...agent.state.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      if (!reply || reply.role !== "assistant") {
        throw new Error("pi agent completed without producing an assistant reply");
      }
      if (reply.stopReason === "error" || reply.stopReason === "aborted") {
        const detail = reply.errorMessage ?? "no error message provided";
        throw new Error(`pi agent reply ${reply.stopReason}: ${detail}`);
      }

      const content = reply.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (content.trim().length === 0) {
        throw new Error("pi agent reply contained no text content");
      }

      return { content };
    },
  };
}

function toAgentMessage(turn: RealmConversationTurnV1, model: Model<Api>): AgentMessage {
  if (turn.role === "participant") {
    return { role: "user", content: turn.content, timestamp: Date.now() };
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: turn.content }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
