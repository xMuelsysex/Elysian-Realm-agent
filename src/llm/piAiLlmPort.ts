// pi-ai adapter for the LlmPort interface.
//
// Boundary: this module is the only place in the package that imports
// @earendil-works/pi-ai, and it is exported solely via the "./llm/pi-ai"
// subpath. The package root entrypoint stays free of pi imports so the core
// cognitive loop remains host-independent and offline-testable.
//
// Failure policy: unsupported request shapes (responseFormat, non-leading
// system messages) and error/aborted completions throw with the provider
// detail; nothing is silently dropped or downgraded.

import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type {
  LlmChatCompletionLike,
  LlmChatMessageLike,
  LlmChatRequestLike,
  LlmPort,
  LlmRequestOptionsLike,
} from "../ports/ports.js";

/**
 * Minimal completion surface of a pi-ai `Models` collection. Pass the real
 * collection in production; inject a fake in offline tests.
 */
export interface PiAiCompletionClient {
  completeSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): Promise<AssistantMessage>;
}

export interface PiAiLlmPortOptions {
  /** Overrides the reported port name; defaults to `pi-ai:<provider>`. */
  name?: string;
}

/**
 * Wrap a pi-ai model into the package's `LlmPort` contract.
 *
 * Provider registration, model selection, and auth stay with the host; this
 * adapter only translates the request/response shapes.
 */
export function createPiAiLlmPort(
  client: PiAiCompletionClient,
  model: Model<Api>,
  options: PiAiLlmPortOptions = {},
): LlmPort {
  return {
    name: options.name ?? `pi-ai:${model.provider}`,
    model: model.id,
    async completeChat(
      request: LlmChatRequestLike,
      requestOptions?: LlmRequestOptionsLike,
    ): Promise<LlmChatCompletionLike> {
      const context = toPiAiContext(request, model);
      const completion = await client.completeSimple(
        model,
        context,
        toPiAiOptions(request, requestOptions),
      );
      return toCompletionLike(completion);
    },
  };
}

function toPiAiContext(request: LlmChatRequestLike, model: Model<Api>): Context {
  if (request.responseFormat !== undefined) {
    throw new Error(
      "pi-ai LlmPort adapter does not support responseFormat; encode format instructions in the prompt",
    );
  }

  const systemParts: string[] = [];
  const messages: Message[] = [];
  for (const message of request.messages) {
    if (message.role === "system") {
      if (messages.length > 0) {
        throw new Error(
          "pi-ai LlmPort adapter only supports system messages before the first user or assistant message",
        );
      }
      systemParts.push(message.content);
      continue;
    }
    messages.push(toPiAiMessage(message, model));
  }

  const context: Context = { messages };
  if (systemParts.length > 0) {
    context.systemPrompt = systemParts.join("\n\n");
  }
  return context;
}

function toPiAiMessage(message: LlmChatMessageLike, model: Model<Api>): Message {
  if (message.role === "user") {
    return { role: "user", content: message.content, timestamp: Date.now() };
  }
  // Synthesized assistant history entry: pi-ai contexts are transferable
  // between providers, so a canonical zero-usage entry is a supported shape.
  return {
    role: "assistant",
    content: [{ type: "text", text: message.content }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function toPiAiOptions(
  request: LlmChatRequestLike,
  options?: LlmRequestOptionsLike,
): SimpleStreamOptions | undefined {
  const result: SimpleStreamOptions = {};
  if (request.temperature !== undefined) result.temperature = request.temperature;
  if (request.maxTokens !== undefined) result.maxTokens = request.maxTokens;
  const signal = combineSignals(options);
  if (signal) result.signal = signal;
  return Object.keys(result).length > 0 ? result : undefined;
}

function combineSignals(options?: LlmRequestOptionsLike): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (options?.signal) signals.push(options.signal);
  if (options?.timeoutMs !== undefined) signals.push(AbortSignal.timeout(options.timeoutMs));
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function toCompletionLike(completion: AssistantMessage): LlmChatCompletionLike {
  if (completion.stopReason === "error" || completion.stopReason === "aborted") {
    const detail = completion.errorMessage ?? "no error message provided";
    throw new Error(`pi-ai completion ${completion.stopReason}: ${detail}`);
  }

  const content = completion.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");

  return {
    content,
    finishReason: completion.stopReason,
    providerResponseId: completion.responseId,
    usage: toUsageRecord(completion.usage),
  };
}

function toUsageRecord(usage: AssistantMessage["usage"]): Record<string, number | undefined> {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: usage.reasoning,
    totalTokens: usage.totalTokens,
    costTotal: usage.cost.total,
  };
}

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
