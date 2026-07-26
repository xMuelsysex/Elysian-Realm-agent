// Env-driven conversation runner bootstrap using the pi-ai model catalog.
//
// This module imports the full built-in provider registry, so it stays out of
// the "./service" barrel: embedders that only need the deterministic tick
// service never load pi code. It is exported via "./service/bootstrap" and
// used by the service process entrypoint.
//
// Model selection is configuration (ELYSIAN_LLM_PROVIDER + ELYSIAN_LLM_MODEL);
// credentials stay in the provider's standard environment variables and are
// resolved by pi-ai at request time. A configured-but-unknown model fails at
// startup instead of at the first conversation.

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  createConversationRunner,
  type ConversationRunner,
} from "../conversation/conversationRunner.js";
import { createPiConversationReplyPort } from "../conversation/piConversationReplyPort.js";
import { createPiAiLlmPort } from "../llm/piAiLlmPort.js";

export interface ConversationLlmConfig {
  provider: string;
  model: string;
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

/**
 * Build a ConversationRunner from environment configuration, or return
 * undefined when conversation support is not configured at all.
 */
export function createConversationRunnerFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConversationRunner | undefined {
  const config = parseConversationLlmConfig(env);
  if (config === undefined) {
    return undefined;
  }

  const models = builtinModels();
  const model = models.getModel(config.provider, config.model);
  if (!model) {
    throw new Error(
      `model "${config.model}" of provider "${config.provider}" is not in the pi-ai catalog`,
    );
  }

  return createConversationRunner({
    reply: createPiConversationReplyPort({
      streamFn: models.streamSimple.bind(models),
      model,
    }),
    analysisLlm: createPiAiLlmPort(models, model),
  });
}
