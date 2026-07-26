import test from "node:test";
import assert from "node:assert/strict";

import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createPiAiLlmPort,
  type PiAiCompletionClient,
} from "@elysian/simulation-agent/llm/pi-ai";

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

function fakeCompletion(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    api: "anthropic-messages",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 11,
      output: 7,
      cacheRead: 2,
      cacheWrite: 3,
      totalTokens: 18,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
    },
    stopReason: "stop",
    timestamp: 1_700_000_000_000,
    ...overrides,
  } as AssistantMessage;
}

interface RecordedCall {
  model: Model<Api>;
  context: Context;
  options: SimpleStreamOptions | undefined;
}

function recordingClient(
  completion: AssistantMessage,
): { client: PiAiCompletionClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    client: {
      completeSimple(model, context, options) {
        calls.push({ model, context, options });
        return Promise.resolve(completion);
      },
    },
  };
}

test("reports provider-derived name and model, with name override", () => {
  const { client } = recordingClient(fakeCompletion());
  const port = createPiAiLlmPort(client, fakeModel());
  assert.equal(port.name, "pi-ai:test-provider");
  assert.equal(port.model, "test-model");

  const named = createPiAiLlmPort(client, fakeModel(), { name: "custom" });
  assert.equal(named.name, "custom");
});

test("maps leading system messages into systemPrompt and converts history", async () => {
  const { client, calls } = recordingClient(fakeCompletion());
  const port = createPiAiLlmPort(client, fakeModel());

  await port.completeChat({
    messages: [
      { role: "system", content: "persona rules" },
      { role: "system", content: "world rules" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello there" },
      { role: "user", content: "how are you?" },
    ],
  });

  assert.equal(calls.length, 1);
  const context = calls[0].context;
  assert.equal(context.systemPrompt, "persona rules\n\nworld rules");
  assert.equal(context.messages.length, 3);

  const [user1, assistant, user2] = context.messages;
  assert.equal(user1.role, "user");
  assert.equal(user1.content, "hi");
  assert.equal(assistant.role, "assistant");
  assert.deepEqual(assistant.content, [{ type: "text", text: "hello there" }]);
  if (assistant.role === "assistant") {
    assert.equal(assistant.provider, "test-provider");
    assert.equal(assistant.model, "test-model");
    assert.equal(assistant.stopReason, "stop");
    assert.equal(assistant.usage.totalTokens, 0);
  }
  assert.equal(user2.role, "user");
  assert.equal(user2.content, "how are you?");
});

test("omits systemPrompt and options when the request carries none", async () => {
  const { client, calls } = recordingClient(fakeCompletion());
  const port = createPiAiLlmPort(client, fakeModel());

  await port.completeChat({ messages: [{ role: "user", content: "hi" }] });

  assert.equal(calls[0].context.systemPrompt, undefined);
  assert.equal(calls[0].options, undefined);
});

test("passes temperature, maxTokens, and the abort signal through", async () => {
  const { client, calls } = recordingClient(fakeCompletion());
  const port = createPiAiLlmPort(client, fakeModel());
  const controller = new AbortController();
  controller.abort();

  await port.completeChat(
    { messages: [{ role: "user", content: "hi" }], temperature: 0.4, maxTokens: 128 },
    { signal: controller.signal },
  );

  const options = calls[0].options;
  assert.ok(options);
  assert.equal(options.temperature, 0.4);
  assert.equal(options.maxTokens, 128);
  assert.equal(options.signal, controller.signal);
});

test("combines external signal with timeoutMs into one aborted-aware signal", async () => {
  const { client, calls } = recordingClient(fakeCompletion());
  const port = createPiAiLlmPort(client, fakeModel());
  const controller = new AbortController();
  controller.abort();

  await port.completeChat(
    { messages: [{ role: "user", content: "hi" }] },
    { signal: controller.signal, timeoutMs: 60_000 },
  );

  const signal = calls[0].options?.signal;
  assert.ok(signal);
  assert.notEqual(signal, controller.signal);
  assert.equal(signal.aborted, true);
});

test("rejects responseFormat requests instead of silently dropping them", async () => {
  const { client } = recordingClient(fakeCompletion());
  const port = createPiAiLlmPort(client, fakeModel());

  await assert.rejects(
    port.completeChat({
      messages: [{ role: "user", content: "hi" }],
      responseFormat: { type: "json" },
    }),
    /does not support responseFormat/,
  );
});

test("rejects system messages after conversation has started", async () => {
  const { client } = recordingClient(fakeCompletion());
  const port = createPiAiLlmPort(client, fakeModel());

  await assert.rejects(
    port.completeChat({
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "late rules" },
      ],
    }),
    /system messages before the first/,
  );
});

test("throws on error and aborted completions with the provider detail", async () => {
  const model = fakeModel();
  const errorPort = createPiAiLlmPort(
    recordingClient(
      fakeCompletion({ stopReason: "error", errorMessage: "rate limited" }),
    ).client,
    model,
  );
  await assert.rejects(
    errorPort.completeChat({ messages: [{ role: "user", content: "hi" }] }),
    /pi-ai completion error: rate limited/,
  );

  const abortedPort = createPiAiLlmPort(
    recordingClient(fakeCompletion({ stopReason: "aborted" })).client,
    model,
  );
  await assert.rejects(
    abortedPort.completeChat({ messages: [{ role: "user", content: "hi" }] }),
    /pi-ai completion aborted: no error message provided/,
  );
});

test("maps a successful completion: text joined, thinking filtered, usage flattened", async () => {
  const completion = fakeCompletion({
    content: [
      { type: "thinking", thinking: "internal chain" },
      { type: "text", text: "part one, " },
      { type: "text", text: "part two" },
    ],
    responseId: "resp-42",
  });
  const { client } = recordingClient(completion);
  const port = createPiAiLlmPort(client, fakeModel());

  const result = await port.completeChat({
    messages: [{ role: "user", content: "hi" }],
  });

  assert.equal(result.content, "part one, part two");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.providerResponseId, "resp-42");
  assert.deepEqual(result.usage, {
    input: 11,
    output: 7,
    cacheRead: 2,
    cacheWrite: 3,
    reasoning: undefined,
    totalTokens: 18,
    costTotal: 0.3,
  });
});
