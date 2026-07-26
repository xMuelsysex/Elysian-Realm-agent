import test from "node:test";
import assert from "node:assert/strict";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  createConversationRunnerFromEnv,
  parseConversationLlmConfig,
} from "@elysian/simulation-agent/service/bootstrap";

test("returns undefined when conversation llm env is entirely absent", () => {
  assert.equal(parseConversationLlmConfig({}), undefined);
  assert.equal(createConversationRunnerFromEnv({}), undefined);
});

test("rejects half-configured or empty llm env visibly", () => {
  assert.throws(
    () => parseConversationLlmConfig({ ELYSIAN_LLM_PROVIDER: "anthropic" }),
    /must both be set/,
  );
  assert.throws(
    () => parseConversationLlmConfig({ ELYSIAN_LLM_MODEL: "some-model" }),
    /must both be set/,
  );
  assert.throws(
    () =>
      parseConversationLlmConfig({
        ELYSIAN_LLM_PROVIDER: " ",
        ELYSIAN_LLM_MODEL: "some-model",
      }),
    /must both be set/,
  );
});

test("fails at startup for models missing from the pi-ai catalog", () => {
  assert.throws(
    () =>
      createConversationRunnerFromEnv({
        ELYSIAN_LLM_PROVIDER: "anthropic",
        ELYSIAN_LLM_MODEL: "definitely-not-a-model",
      }),
    /"definitely-not-a-model" of provider "anthropic" is not in the pi-ai catalog/,
  );
  assert.throws(
    () =>
      createConversationRunnerFromEnv({
        ELYSIAN_LLM_PROVIDER: "no-such-provider",
        ELYSIAN_LLM_MODEL: "whatever",
      }),
    /not in the pi-ai catalog/,
  );
});

test("builds a runner for a catalog model without touching the network", () => {
  const anyAnthropicModel = builtinModels().getModels("anthropic")[0];
  assert.ok(anyAnthropicModel, "pi-ai catalog must list anthropic models");

  const runner = createConversationRunnerFromEnv({
    ELYSIAN_LLM_PROVIDER: "anthropic",
    ELYSIAN_LLM_MODEL: anyAnthropicModel.id,
  });
  assert.ok(runner);
  assert.equal(typeof runner.run, "function");
});
