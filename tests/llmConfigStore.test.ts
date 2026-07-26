import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LlmConfigError,
  defaultLlmConfigPath,
  loadLlmConfig,
  saveLlmConfig,
} from "@elysian/simulation-agent/service/bootstrap";

function tempConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), "elysian-cred-")), "credentials.json");
}

test("save and load round-trip with owner-only permissions", () => {
  const path = tempConfigPath();
  saveLlmConfig(path, { provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "sk-test" });

  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600, "credentials file must be 0600");

  const loaded = loadLlmConfig(path);
  assert.deepEqual(loaded, {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    apiKey: "sk-test",
  });
});

test("apiKey is optional in the stored config", () => {
  const path = tempConfigPath();
  saveLlmConfig(path, { provider: "openai", model: "gpt-4o-mini" });
  assert.deepEqual(loadLlmConfig(path), { provider: "openai", model: "gpt-4o-mini" });
});

test("missing file loads as undefined; broken content fails visibly", () => {
  const path = tempConfigPath();
  assert.equal(loadLlmConfig(path), undefined);

  writeFileSync(path, "not json at all");
  assert.throws(() => loadLlmConfig(path), LlmConfigError);

  writeFileSync(path, JSON.stringify({ provider: "anthropic" }));
  assert.throws(() => loadLlmConfig(path), /model must be a non-empty string/);

  writeFileSync(path, JSON.stringify({ provider: "anthropic", model: "m", apiKey: " " }));
  assert.throws(() => loadLlmConfig(path), /apiKey must be a non-empty string/);
});

test("save validates before writing anything", () => {
  const path = tempConfigPath();
  assert.throws(
    () => saveLlmConfig(path, { provider: " ", model: "m" }),
    /provider must be a non-empty string/,
  );
  assert.equal(loadLlmConfig(path), undefined, "invalid config must not be persisted");
});

test("default path honors ELYSIAN_CREDENTIALS_PATH override", () => {
  assert.equal(defaultLlmConfigPath({ ELYSIAN_CREDENTIALS_PATH: "/tmp/x.json" }), "/tmp/x.json");
  assert.match(defaultLlmConfigPath({}), /\.elysian-realm[/\\]credentials\.json$/);
});

test("stored file content is human-readable json", () => {
  const path = tempConfigPath();
  saveLlmConfig(path, { provider: "groq", model: "some-model" });
  const raw = readFileSync(path, "utf8");
  assert.match(raw, /"provider": "groq"/);
});
