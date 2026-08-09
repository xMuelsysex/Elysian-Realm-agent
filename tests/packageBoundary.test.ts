// Package boundary guard: the root entrypoint's transitive re-export graph
// must stay free of pi imports (core invariant #1). The pi packages are
// reachable only through the explicit ./llm/pi-ai, ./conversation/pi, and
// ./service/bootstrap subpaths. This test walks the compiled dist graph so
// the invariant is enforced mechanically instead of by convention.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The compiled test lives under .test-dist/tests/, so dist sits two levels up.
const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");
const PI_PACKAGES = ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core"];

function reExportsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const targets: string[] = [];
  const pattern =
    /export\s+(?:\*\s+from|(?:{[^}]*}\s+from))\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    targets.push(match[1]);
  }
  return targets;
}

function importsPi(source: string): string | undefined {
  for (const pkg of PI_PACKAGES) {
    if (source.includes(`from "${pkg}"`) || source.includes(`from '${pkg}'`)) {
      return pkg;
    }
  }
  return undefined;
}

test("root entrypoint graph imports no pi packages", () => {
  const visited = new Set<string>();
  const queue = [join(DIST, "index.js")];
  const violations: string[] = [];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file) || !file.startsWith(DIST)) {
      continue;
    }
    visited.add(file);
    const source = readFileSync(file, "utf8");
    const pi = importsPi(source);
    if (pi !== undefined) {
      violations.push(`${file}: imports ${pi}`);
    }
    for (const target of reExportsOf(file)) {
      if (target.startsWith(".")) {
        queue.push(join(dirname(file), target));
      }
    }
  }

  assert.deepEqual(violations, [], "root graph must stay pi-free");
  assert.ok(
    visited.size > 10,
    `graph walk must actually cover the package (visited ${visited.size} files)`,
  );
});

test("the three pi subpaths import pi packages (positive control)", () => {
  // The compiled js erases type-only pi imports, so check the sources: the
  // pi code must live exactly in these three subpaths.
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
  const entrypoints = [
    join(SRC, "llm", "piAiLlmPort.ts"),
    join(SRC, "conversation", "piConversationReplyPort.ts"),
    join(SRC, "service", "conversationBootstrap.ts"),
  ];
  for (const file of entrypoints) {
    const pi = importsPi(readFileSync(file, "utf8"));
    assert.ok(pi !== undefined, `${file} must import a pi package`);
  }
});
