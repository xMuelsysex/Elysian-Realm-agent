// Determinism guard (core invariant #4): the core must never generate time —
// it receives `at`/`now` from callers. Mechanized: no-arg time generation
// (`Date.now()`, `new Date()`) is only allowed at the clock-authority
// boundaries: the host's injected-clock default and the two pi adapter seams
// (which stamp pi SDK message shapes). `new Date(expr)` (parsing/deriving
// from a given value) is always fine.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(ROOT, "src");

/** Files allowed to generate wall-clock time (no-arg Date.now() / new Date()). */
const TIME_AUTHORITY_ALLOWLIST = new Set([
  "host/realmHost.ts", // injected-clock default (the host owns the clock)
  "llm/piAiLlmPort.ts", // pi SDK message timestamps
  "conversation/piConversationReplyPort.ts", // pi SDK message timestamps
]);

function walkTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTsFiles(path));
    } else if (entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

test("core code never generates wall-clock time", () => {
  const violations: string[] = [];
  let allowlistFilesSeen = 0;

  for (const file of walkTsFiles(SRC)) {
    const rel = relative(SRC, file);
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      // No-arg time generation only; new Date(expr) / Date.parse are pure.
      const match =
        /(?:Date\.now\(\)|new Date\(\))/.exec(line);
      if (match === null) {
        continue;
      }
      if (TIME_AUTHORITY_ALLOWLIST.has(rel)) {
        allowlistFilesSeen += 1;
      } else {
        violations.push(`${rel}:${index + 1}: ${line.trim()}`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `time generation outside the authority boundaries:\n${violations.join("\n")}`,
  );
  assert.ok(
    allowlistFilesSeen >= TIME_AUTHORITY_ALLOWLIST.size,
    "every allowlisted authority file must actually generate time (guards against a vacuous test)",
  );
});
