import test from "node:test";
import assert from "node:assert/strict";

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createPiConversationReplyPort } from "@elysian/simulation-agent/conversation/pi";

const NOW = "2026-07-26T12:00:00.000Z";

function fakeModel(): Model<Api> {
  return {
    id: "test-model",
    name: "Test Model",
    api: "anthropic-messages",
    provider: "test-provider",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4_096,
  } as unknown as Model<Api>;
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "A reply." }],
    api: "anthropic-messages",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1_700_000_000_000,
    ...overrides,
  } as AssistantMessage;
}

function fakeStream(message: AssistantMessage): { streamFn: StreamFn; contexts: Context[] } {
  const contexts: Context[] = [];
  const streamFn: StreamFn = (_model, context) => {
    contexts.push(context);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } else {
      stream.push({ type: "done", reason: "stop", message });
    }
    return stream;
  };
  return { streamFn, contexts };
}

function replyInput() {
  return {
    conversationId: "conv_1",
    agentId: "agent_elysia",
    now: NOW,
    systemPrompt: "You are Elysia.",
    history: [
      { role: "participant" as const, content: "Hi!" },
      { role: "agent" as const, content: "Hello there." },
    ],
    message: "Shall we go to the garden?",
  };
}

test("streams reply text deltas and resolves with the full content", async () => {
  const finalMessage = assistantMessage({
    content: [{ type: "text", text: "Yes, let us go!" }],
  });
  const contexts: Context[] = [];
  const streamFn: StreamFn = (_model, context) => {
    contexts.push(context);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: finalMessage });
    stream.push({ type: "text_start", contentIndex: 0, partial: finalMessage });
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: "Yes, ",
      partial: finalMessage,
    });
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: "let us go!",
      partial: finalMessage,
    });
    stream.push({
      type: "text_end",
      contentIndex: 0,
      content: "Yes, let us go!",
      partial: finalMessage,
    });
    stream.push({ type: "done", reason: "stop", message: finalMessage });
    return stream;
  };
  const port = createPiConversationReplyPort({ streamFn, model: fakeModel() });

  const deltas: string[] = [];
  const reply = await port.generateReplyStream!(replyInput(), (text) => deltas.push(text));

  assert.equal(reply.content, "Yes, let us go!");
  assert.deepEqual(deltas, ["Yes, ", "let us go!"]);
  assert.equal(contexts.length, 1);
});

test("generates a reply and passes system prompt plus converted history to the model", async () => {
  const { streamFn, contexts } = fakeStream(
    assistantMessage({ content: [{ type: "text", text: "Yes, let us go!" }] }),
  );
  const port = createPiConversationReplyPort({ streamFn, model: fakeModel() });

  const reply = await port.generateReply(replyInput());

  assert.equal(reply.content, "Yes, let us go!");
  assert.equal(contexts.length, 1);
  const context = contexts[0];
  assert.equal(context.systemPrompt, "You are Elysia.");
  assert.equal(context.messages.length, 3);
  assert.equal(context.messages[0].role, "user");
  assert.equal(context.messages[0].content, "Hi!");
  assert.equal(context.messages[1].role, "assistant");
  const historyReply = context.messages[1];
  if (historyReply.role === "assistant") {
    assert.deepEqual(historyReply.content, [{ type: "text", text: "Hello there." }]);
  }
  assert.equal(context.messages[2].role, "user");
  assert.deepEqual(context.messages[2].content, [
    { type: "text", text: "Shall we go to the garden?" },
  ]);
});

test("re-raises error completions as visible failures", async () => {
  const { streamFn } = fakeStream(
    assistantMessage({ stopReason: "error", errorMessage: "provider exploded", content: [] }),
  );
  const port = createPiConversationReplyPort({ streamFn, model: fakeModel() });

  await assert.rejects(port.generateReply(replyInput()), /pi agent reply error: provider exploded/);
});

test("rejects replies with no text content", async () => {
  const { streamFn } = fakeStream(assistantMessage({ content: [{ type: "text", text: "  " }] }));
  const port = createPiConversationReplyPort({ streamFn, model: fakeModel() });

  await assert.rejects(port.generateReply(replyInput()), /no text content/);
});
