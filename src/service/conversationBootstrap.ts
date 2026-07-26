// Conversation runtime hub: single mutable source for the conversation
// runner, fed by (in priority order) environment variables, the persisted
// credentials file, and runtime admin updates.
//
// This module imports the full built-in provider registry, so it stays out of
// the "./service" barrel: embedders that only need the deterministic tick
// service never load pi code. It is exported via "./service/bootstrap".
//
// Admin flow: when the LLM selection comes from environment variables it is
// pinned — admin saves are rejected with a clear error instead of silently
// being overridden on the next restart. Credentials saved via admin land in
// the 0600 credentials file and are applied to the running service instantly.

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createModels, createProvider, type ProviderHeaders, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createConversationRunner,
  type ConversationRunner,
} from "../conversation/conversationRunner.js";
import { createPiConversationReplyPort } from "../conversation/piConversationReplyPort.js";
import { createPiAiLlmPort } from "../llm/piAiLlmPort.js";
import type { LlmPort } from "../ports/ports.js";
import type { AdminRequestHandler, AdminRequestResult } from "./agentService.js";
import {
  LlmConfigError,
  defaultLlmConfigPath,
  loadLlmConfig,
  saveLlmConfig,
  validateLlmConfig,
  type StoredLlmConfig,
} from "./llmConfigStore.js";

export {
  CUSTOM_LLM_APIS,
  LlmConfigError,
  defaultLlmConfigPath,
  loadLlmConfig,
  saveLlmConfig,
  validateLlmConfig,
  type CustomLlmApi,
  type StoredLlmConfig,
} from "./llmConfigStore.js";
export { ADMIN_PAGE_HTML } from "./adminPage.js";

export interface ConversationLlmConfig {
  provider: string;
  model: string;
}

export type LlmKeySource = "env" | "stored" | "none";

export interface ConversationHubStatus {
  configured: boolean;
  provider?: string;
  model?: string;
  /** Custom relay mode: the configured endpoint base URL. */
  baseUrl?: string;
  /** Where the active configuration came from. */
  configSource: "env" | "file" | "admin" | "none";
  /** Where provider auth comes from: provider env vars or the stored key. */
  keySource: LlmKeySource;
}

export interface ConversationHub {
  getRunner(): ConversationRunner | undefined;
  getStatus(): ConversationHubStatus;
  /** Validate, build, and hot-swap a runner from the given config (no persistence). */
  applyConfig(config: StoredLlmConfig, source: "file" | "admin"): void;
  createAdminHandler(): AdminRequestHandler;
}

export interface ConversationRuntime {
  runner: ConversationRunner;
  /** Analysis-shaped port reused by the connectivity test endpoint. */
  probeLlm: LlmPort;
}

export interface ConversationHubOptions {
  credentialsPath?: string;
  /** Test seam: build the runtime without touching real providers. */
  buildRuntime?: (config: StoredLlmConfig) => ConversationRuntime;
}

export function parseConversationLlmConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConversationLlmConfig | undefined {
  const provider = env.ELYSIAN_LLM_PROVIDER;
  const model = env.ELYSIAN_LLM_MODEL;
  if (provider === undefined && model === undefined) {
    return undefined;
  }
  if (
    provider === undefined ||
    model === undefined ||
    provider.trim().length === 0 ||
    model.trim().length === 0
  ) {
    throw new Error(
      "ELYSIAN_LLM_PROVIDER and ELYSIAN_LLM_MODEL must both be set to non-empty values to enable conversations",
    );
  }
  return { provider, model };
}

export function createConversationHub(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: ConversationHubOptions = {},
): ConversationHub {
  const credentialsPath = options.credentialsPath ?? defaultLlmConfigPath(env);
  const buildRuntime = options.buildRuntime ?? buildConversationRuntime;

  let runtime: ConversationRuntime | undefined;
  let activeConfig: StoredLlmConfig | undefined;
  let configSource: ConversationHubStatus["configSource"] = "none";
  const envConfig = parseConversationLlmConfig(env);

  if (envConfig) {
    // Explicit env configuration fails fast on any problem.
    runtime = buildRuntime(envConfig);
    activeConfig = envConfig;
    configSource = "env";
  } else {
    // A broken credentials file must not take the tick service down: log the
    // error clearly and start without conversations; the admin page can fix it.
    try {
      const stored = loadLlmConfig(credentialsPath);
      if (stored) {
        runtime = buildRuntime(stored);
        activeConfig = stored;
        configSource = "file";
      }
    } catch (error) {
      console.error(
        `ignoring stored llm credentials (${credentialsPath}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const hub: ConversationHub = {
    getRunner: () => runtime?.runner,

    getStatus: () => ({
      configured: runtime !== undefined,
      ...(activeConfig?.provider !== undefined ? { provider: activeConfig.provider } : {}),
      ...(activeConfig?.baseUrl !== undefined
        ? { provider: "custom", baseUrl: activeConfig.baseUrl }
        : {}),
      ...(activeConfig ? { model: activeConfig.model } : {}),
      configSource,
      keySource:
        configSource === "env"
          ? "env"
          : activeConfig?.apiKey !== undefined
            ? "stored"
            : configSource === "none"
              ? "none"
              : "env",
    }),

    applyConfig: (config, source) => {
      swapRuntime(buildRuntime(config), config, source);
    },

    createAdminHandler: () => createAdminHandler(hub, {
      credentialsPath,
      buildRuntime,
      swapRuntime,
      envPinned: envConfig !== undefined,
      getRuntime: () => runtime,
      getActiveConfig: () => activeConfig,
    }),
  };

  function swapRuntime(
    next: ConversationRuntime,
    config: StoredLlmConfig,
    source: "file" | "admin",
  ): void {
    runtime = next;
    activeConfig = config;
    configSource = source;
  }

  return hub;
}

function createAdminHandler(
  hub: ConversationHub,
  context: {
    credentialsPath: string;
    buildRuntime: (config: StoredLlmConfig) => ConversationRuntime;
    swapRuntime: (next: ConversationRuntime, config: StoredLlmConfig, source: "file" | "admin") => void;
    envPinned: boolean;
    getRuntime: () => ConversationRuntime | undefined;
    getActiveConfig: () => StoredLlmConfig | undefined;
  },
): AdminRequestHandler {
  return async (method, path, body): Promise<AdminRequestResult | undefined> => {
    if (path === "/v1/admin/llm-config" && method === "GET") {
      return { status: 200, body: hub.getStatus() };
    }

    if (path === "/v1/admin/llm-config" && method === "POST") {
      if (context.envPinned) {
        return {
          status: 409,
          body: {
            error: {
              code: "LLM_CONFIG_PINNED",
              message:
                "llm selection is pinned by ELYSIAN_LLM_PROVIDER/ELYSIAN_LLM_MODEL; unset them to manage it here",
            },
          },
        };
      }
      const parsed = parseAdminConfigBody(body);
      if (!parsed.ok) {
        return adminBadRequest(parsed.message);
      }

      // Order matters: validate by building first, then persist, then swap —
      // the running service never diverges from what is on disk.
      let next: ConversationRuntime;
      try {
        next = context.buildRuntime(parsed.config);
      } catch (error) {
        return adminBadRequest(errorText(error));
      }
      try {
        saveLlmConfig(context.credentialsPath, parsed.config);
      } catch (error) {
        return {
          status: 500,
          body: { error: { code: "LLM_CONFIG_PERSIST_FAILED", message: errorText(error) } },
        };
      }
      context.swapRuntime(next, parsed.config, "admin");
      return { status: 200, body: hub.getStatus() };
    }

    if (path === "/v1/admin/llm-config/test" && method === "POST") {
      let probe: LlmPort;
      let probedConfig: StoredLlmConfig | undefined;
      try {
        if (body !== undefined && body !== null && Object.keys(body as object).length > 0) {
          const parsed = parseAdminConfigBody(body);
          if (!parsed.ok) {
            return adminBadRequest(parsed.message);
          }
          probedConfig = parsed.config;
          probe = context.buildRuntime(parsed.config).probeLlm;
        } else {
          const runtime = context.getRuntime();
          if (!runtime) {
            return adminBadRequest("no llm configuration to test; provide one in the request body");
          }
          probedConfig = context.getActiveConfig();
          probe = runtime.probeLlm;
        }
      } catch (error) {
        return adminBadRequest(errorText(error));
      }

      try {
        const completion = await probe.completeChat(
          {
            messages: [{ role: "user", content: "Reply with the single word: pong" }],
            maxTokens: 16,
          },
          { timeoutMs: 20_000 },
        );
        return {
          status: 200,
          body: { ok: true, model: probe.model, content: completion.content.slice(0, 200) },
        };
      } catch (error) {
        return {
          status: 200,
          body: {
            ok: false,
            error: errorText(error),
            // Surface the concrete request target so relay path mistakes
            // (e.g. a missing /v1 in baseUrl) are diagnosable at a glance.
            ...(probedConfig ? { target: describeRequestTarget(probedConfig) } : {}),
          },
        };
      }
    }

    if (path === "/v1/admin/catalog" && method === "GET") {
      const models = builtinModels();
      const providers = models
        .getProviders()
        .map((provider) => ({
          id: provider.id,
          models: models
            .getModels(provider.id)
            .map((model: Model<Api>) => ({ id: model.id, name: model.name })),
        }))
        .filter((provider) => provider.models.length > 0)
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      return { status: 200, body: { providers } };
    }

    return undefined;
  };
}

/** Production runtime builder: catalog mode or custom relay mode. */
export function buildConversationRuntime(config: StoredLlmConfig): ConversationRuntime {
  const { streamFn, completionClient, model } = config.baseUrl !== undefined
    ? customRelayParts(config)
    : catalogParts(config);

  const probeLlm = createPiAiLlmPort(completionClient, model, {
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
  });
  return {
    runner: createConversationRunner({
      reply: createPiConversationReplyPort({
        streamFn,
        model,
        ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
      }),
      analysisLlm: probeLlm,
    }),
    probeLlm,
  };
}

interface RuntimeParts {
  streamFn: Parameters<typeof createPiConversationReplyPort>[0]["streamFn"];
  completionClient: Parameters<typeof createPiAiLlmPort>[0];
  model: Model<Api>;
}

function catalogParts(config: StoredLlmConfig): RuntimeParts {
  const models = builtinModels();
  const model = models.getModel(config.provider as string, config.model);
  if (!model) {
    throw new LlmConfigError(
      `model "${config.model}" of provider "${config.provider}" is not in the pi-ai catalog`,
    );
  }
  return {
    streamFn: models.streamSimple.bind(models),
    completionClient: models,
    model,
  };
}

const CUSTOM_PROVIDER_ID = "custom-relay";

/**
 * Relay WAFs commonly fingerprint-block the OpenAI SDK (its `OpenAI/JS` user
 * agent and `x-stainless-*` headers trigger 403s before auth even runs), so
 * custom relay requests present a neutral user agent and suppress the SDK
 * fingerprint headers. `null` removes a default header at the SDK layer.
 */
const RELAY_HEADER_OVERRIDES: ProviderHeaders = {
  "user-agent": "Mozilla/5.0 (compatible; ElysianRealmAgent/0.1)",
  "x-stainless-lang": null,
  "x-stainless-package-version": null,
  "x-stainless-os": null,
  "x-stainless-arch": null,
  "x-stainless-runtime": null,
  "x-stainless-runtime-version": null,
  "x-stainless-retry-count": null,
  "x-stainless-timeout": null,
  "x-stainless-async": null,
  "x-stainless-helper-method": null,
  "x-stainless-raw-response": null,
};

/**
 * Custom relay mode: wrap any OpenAI- or Anthropic-compatible endpoint into a
 * pi-ai provider. Auth resolves to nothing here on purpose — the stored key is
 * passed explicitly per request and explicit keys win over provider auth.
 */
function customRelayParts(config: StoredLlmConfig): RuntimeParts {
  const api = config.api ?? "openai-completions";
  const baseUrl = config.baseUrl as string;
  const model = {
    id: config.model,
    name: config.model,
    api,
    provider: CUSTOM_PROVIDER_ID,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  } as unknown as Model<Api>;

  const provider = createProvider({
    id: CUSTOM_PROVIDER_ID,
    name: "Custom Relay",
    baseUrl,
    auth: { apiKey: { name: "Custom Relay", resolve: async () => ({ auth: {} }) } },
    models: [model],
    api: api === "anthropic-messages" ? anthropicMessagesApi() : openAICompletionsApi(),
  });

  const models = createModels();
  models.setProvider(provider);

  const withRelayHeaders = (options?: SimpleStreamOptions): SimpleStreamOptions => ({
    ...options,
    headers: { ...RELAY_HEADER_OVERRIDES, ...options?.headers },
  });

  return {
    streamFn: (streamModel, context, options) =>
      models.streamSimple(streamModel, context, withRelayHeaders(options)),
    completionClient: {
      completeSimple: (completionModel, context, options) =>
        models.completeSimple(completionModel, context, withRelayHeaders(options)),
    },
    model,
  };
}

function parseAdminConfigBody(
  body: unknown,
): { ok: true; config: StoredLlmConfig } | { ok: false; message: string } {
  try {
    return { ok: true, config: validateLlmConfig(body) };
  } catch (error) {
    return { ok: false, message: errorText(error) };
  }
}

/** Human-readable request target for diagnostics (never includes the key). */
function describeRequestTarget(config: StoredLlmConfig): string {
  if (config.baseUrl === undefined) {
    return `catalog provider "${config.provider}"`;
  }
  const base = config.baseUrl.replace(/\/+$/, "");
  return (config.api ?? "openai-completions") === "anthropic-messages"
    ? `POST ${base}/v1/messages`
    : `POST ${base}/chat/completions`;
}

function adminBadRequest(message: string): AdminRequestResult {
  return { status: 400, body: { error: { code: "INVALID_ADMIN_REQUEST", message } } };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}
