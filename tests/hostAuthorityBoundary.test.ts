// Host-authority guard (core invariant #2): the service layer only returns
// proposals (proposal / memoryWrites / affinityDelta / mood) — the host
// decides whether to apply them. The executors must stay pure: no
// persistence (node:fs / node:sqlite), no host state (../host/*). If an
// executor starts writing world state directly, this guard fails.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

const EXECUTOR_FILES = [
  "service/realmStepExecutor.ts",
  "service/realmConversationExecutor.ts",
];

const FORBIDDEN_IMPORTS = [
  /from ["']node:fs["']/,
  /from ["']node:sqlite["']/,
  /from ["']\.\.\/host\//,
  /from ["']\.\.\/\.\.\/host\//,
];

test("executors stay pure: no persistence or host-state imports", () => {
  const violations: string[] = [];

  for (const rel of EXECUTOR_FILES) {
    const source = readFileSync(join(SRC, rel), "utf8");
    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!/^\s*import\b/.test(line)) {
        continue;
      }
      for (const forbidden of FORBIDDEN_IMPORTS) {
        if (forbidden.test(line)) {
          violations.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `executors must not touch persistence or host state:\n${violations.join("\n")}`,
  );
});
