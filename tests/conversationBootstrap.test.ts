import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConversationRunner, LlmPort } from "@elysian/simulation-agent";
import {
  buildConversationRuntime,
  createConversationHub,
  loadLlmConfig,
  saveLlmConfig,
  type ConversationRuntime,
  type StoredLlmConfig,
} from "@elysian/simulation-agent/service/bootstrap";

function tempConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), "elysian-hub-")), "credentials.json");
}

function fakeRuntimeFactory(): {
  buildRuntime: (config: StoredLlmConfig) => ConversationRuntime;
  built: StoredLlmConfig[];
  probeReplies: string[];
} {
  const built: StoredLlmConfig[] = [];
  const probeReplies: string[] = [];
  return {
    built,
    probeReplies,
    buildRuntime(config) {
      if (config.model === "unknown-model") {
        throw new Error(`model "${config.model}" is not in the pi-ai catalog`);
      }
      built.push(config);
      const runner: ConversationRunner = {
        run: () => Promise.reject(new Error("not used in this test")),
      };
      const probeLlm: LlmPort = {
        name: `fake:${config.provider}`,
        model: config.model,
        completeChat(request) {
          probeReplies.push(String(request.messages[0]?.content));
          if (config.apiKey === "bad-key") {
            return Promise.reject(new Error("401 invalid api key"));
          }
          return Promise.resolve({ content: "pong" });
        },
      };
      return { runner, probeLlm };
    },
  };
}

test("hub starts unconfigured when neither env nor credentials file exist", () => {
  const factory = fakeRuntimeFactory();
  const hub = createConversationHub({}, {
    credentialsPath: tempConfigPath(),
    buildRuntime: factory.buildRuntime,
  });
  assert.equal(hub.getRunner(), undefined);
  assert.deepEqual(hub.getStatus(), { configured: false, configSource: "none", keySource: "none" });
});

test("env config takes priority and pins admin updates", async () => {
  const factory = fakeRuntimeFactory();
  const path = tempConfigPath();
  saveLlmConfig(path, { provider: "file-provider", model: "file-model" });

  const hub = createConversationHub(
    { ELYSIAN_LLM_PROVIDER: "env-provider", ELYSIAN_LLM_MODEL: "env-model" },
    { credentialsPath: path, buildRuntime: factory.buildRuntime },
  );

  assert.ok(hub.getRunner());
  const status = hub.getStatus();
  assert.equal(status.provider, "env-provider");
  assert.equal(status.configSource, "env");
  assert.equal(status.keySource, "env");

  const handler = hub.createAdminHandler();
  const result = await handler("POST", "/v1/admin/llm-config", {
    provider: "x",
    model: "y",
  });
  assert.equal(result?.status, 409);
});

test("credentials file configures the hub when env is absent", () => {
  const factory = fakeRuntimeFactory();
  const path = tempConfigPath();
  saveLlmConfig(path, { provider: "anthropic", model: "some-model", apiKey: "sk-stored" });

  const hub = createConversationHub({}, {
    credentialsPath: path,
    buildRuntime: factory.buildRuntime,
  });

  assert.ok(hub.getRunner());
  const status = hub.getStatus();
  assert.equal(status.configSource, "file");
  assert.equal(status.keySource, "stored");
  assert.deepEqual(factory.built[0], {
    provider: "anthropic",
    model: "some-model",
    apiKey: "sk-stored",
  });
});

test("a broken credentials file degrades to unconfigured instead of crashing", () => {
  const factory = fakeRuntimeFactory();
  const path = tempConfigPath();
  writeFileSync(path, "{broken");

  const hub = createConversationHub({}, {
    credentialsPath: path,
    buildRuntime: factory.buildRuntime,
  });
  assert.equal(hub.getRunner(), undefined);
  assert.equal(hub.getStatus().configured, false);
});

test("half-configured env fails fast", () => {
  const factory = fakeRuntimeFactory();
  assert.throws(
    () =>
      createConversationHub(
        { ELYSIAN_LLM_PROVIDER: "anthropic" },
        { credentialsPath: tempConfigPath(), buildRuntime: factory.buildRuntime },
      ),
    /must both be set/,
  );
});

test("admin save validates, persists 0600, and hot-swaps the runner", async () => {
  const factory = fakeRuntimeFactory();
  const path = tempConfigPath();
  const hub = createConversationHub({}, {
    credentialsPath: path,
    buildRuntime: factory.buildRuntime,
  });
  const handler = hub.createAdminHandler();

  assert.equal(hub.getRunner(), undefined);

  const saved = await handler("POST", "/v1/admin/llm-config", {
    provider: "anthropic",
    model: "good-model",
    apiKey: "sk-new",
  });
  assert.equal(saved?.status, 200);
  assert.ok(hub.getRunner(), "runner must be live immediately after save");
  assert.equal(hub.getStatus().configSource, "admin");
  assert.equal(hub.getStatus().keySource, "stored");

  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(loadLlmConfig(path), {
    provider: "anthropic",
    model: "good-model",
    apiKey: "sk-new",
  });
});

test("admin save rejects unknown models without persisting or swapping", async () => {
  const factory = fakeRuntimeFactory();
  const path = tempConfigPath();
  const hub = createConversationHub({}, {
    credentialsPath: path,
    buildRuntime: factory.buildRuntime,
  });
  const handler = hub.createAdminHandler();

  const result = await handler("POST", "/v1/admin/llm-config", {
    provider: "anthropic",
    model: "unknown-model",
  });
  assert.equal(result?.status, 400);
  assert.match(
    String(
      result !== undefined && "body" in result
        ? (result.body as { error: { message: string } }).error.message
        : "",
    ),
    /not in the pi-ai catalog/,
  );
  assert.equal(hub.getRunner(), undefined);
  assert.equal(loadLlmConfig(path), undefined, "rejected config must not be persisted");
});

test("admin save without a key keeps the stored key instead of dropping it", async () => {
  const factory = fakeRuntimeFactory();
  const path = tempConfigPath();
  const hub = createConversationHub({}, {
    credentialsPath: path,
    buildRuntime: factory.buildRuntime,
  });
  const handler = hub.createAdminHandler();

  const first = await handler("POST", "/v1/admin/llm-config", {
    provider: "anthropic",
    model: "good-model",
    apiKey: "sk-stored",
  });
  assert.equal(first?.status, 200);

  // The page never echoes the stored key: a save without apiKey must keep it.
  const second = await handler("POST", "/v1/admin/llm-config", {
    provider: "anthropic",
    model: "good-model",
  });
  assert.equal(second?.status, 200);
  assert.deepEqual(loadLlmConfig(path), {
    provider: "anthropic",
    model: "good-model",
    apiKey: "sk-stored",
  });
});

test("admin test probes with the stored key when the candidate omits it", async () => {
  const factory = fakeRuntimeFactory();
  const hub = createConversationHub({}, {
    credentialsPath: tempConfigPath(),
    buildRuntime: factory.buildRuntime,
  });
  const handler = hub.createAdminHandler();

  await handler("POST", "/v1/admin/llm-config", {
    provider: "anthropic",
    model: "good-model",
    apiKey: "sk-stored",
  });
  const builtBefore = factory.built.length;

  const probed = await handler("POST", "/v1/admin/llm-config/test", {
    provider: "anthropic",
    model: "good-model",
  });
  assert.equal(probed?.status, 200);
  assert.deepEqual(
    probed !== undefined && "body" in probed ? probed.body : undefined,
    { ok: true, model: "good-model", content: "pong" },
  );
  const lastBuilt = factory.built[factory.built.length - 1];
  assert.equal(lastBuilt?.apiKey, "sk-stored", "probe runtime must carry the stored key");
  assert.ok(factory.built.length > builtBefore);
});

test("admin test endpoint probes the current or a candidate config", async () => {
  const factory = fakeRuntimeFactory();
  const hub = createConversationHub({}, {
    credentialsPath: tempConfigPath(),
    buildRuntime: factory.buildRuntime,
  });
  const handler = hub.createAdminHandler();

  const unconfigured = await handler("POST", "/v1/admin/llm-config/test", undefined);
  assert.equal(unconfigured?.status, 400);

  const candidateOk = await handler("POST", "/v1/admin/llm-config/test", {
    provider: "anthropic",
    model: "good-model",
    apiKey: "sk-probe",
  });
  assert.equal(candidateOk?.status, 200);
  assert.deepEqual(candidateOk !== undefined && "body" in candidateOk ? candidateOk.body : undefined, { ok: true, model: "good-model", content: "pong" });

  const candidateBad = await handler("POST", "/v1/admin/llm-config/test", {
    provider: "anthropic",
    model: "good-model",
    apiKey: "bad-key",
  });
  assert.equal(candidateBad?.status, 200);
  assert.deepEqual(candidateBad !== undefined && "body" in candidateBad ? candidateBad.body : undefined, {
    ok: false,
    error: "401 invalid api key",
    target: 'catalog provider "anthropic"',
  });

  const relayBad = await handler("POST", "/v1/admin/llm-config/test", {
    baseUrl: "https://relay.example.com/v1",
    model: "good-model",
    apiKey: "bad-key",
  });
  assert.equal(relayBad?.status, 200);
  assert.deepEqual(relayBad !== undefined && "body" in relayBad ? relayBad.body : undefined, {
    ok: false,
    error: "401 invalid api key",
    target: "POST https://relay.example.com/v1/chat/completions",
  });
});

test("buildConversationRuntime constructs a custom relay runtime offline", () => {
  const runtime = buildConversationRuntime({
    baseUrl: "https://relay.example.com/v1",
    model: "any-model-name",
    api: "openai-completions",
    apiKey: "sk-relay",
  });
  assert.ok(runtime.runner);
  assert.equal(runtime.probeLlm.model, "any-model-name");
  assert.equal(runtime.probeLlm.name, "pi-ai:custom-relay");

  const anthropicStyle = buildConversationRuntime({
    baseUrl: "https://relay.example.com",
    model: "claude-style-model",
    api: "anthropic-messages",
  });
  assert.equal(anthropicStyle.probeLlm.model, "claude-style-model");
});

test("buildConversationRuntime rejects catalog models that do not exist", () => {
  assert.throws(
    () => buildConversationRuntime({ provider: "anthropic", model: "definitely-not-real" }),
    /not in the pi-ai catalog/,
  );
});

test("admin catalog lists real providers and models offline", async () => {
  const factory = fakeRuntimeFactory();
  const hub = createConversationHub({}, {
    credentialsPath: tempConfigPath(),
    buildRuntime: factory.buildRuntime,
  });
  const handler = hub.createAdminHandler();

  const result = await handler("GET", "/v1/admin/catalog", undefined);
  assert.equal(result?.status, 200);
  const providers = (
    result !== undefined && "body" in result
      ? (result.body as { providers: Array<{ id: string; models: Array<{ id: string }> }> })
      : undefined
  )?.providers ?? [];
  assert.ok(providers.length > 10, "catalog must list built-in providers");
  const anthropic = providers.find((entry) => entry.id === "anthropic");
  assert.ok(anthropic && anthropic.models.length > 0, "anthropic models must be listed");

  const unknownRoute = await handler("GET", "/v1/admin/nope", undefined);
  assert.equal(unknownRoute, undefined);
});
