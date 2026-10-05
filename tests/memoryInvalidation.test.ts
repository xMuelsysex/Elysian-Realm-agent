// Memory lifecycle: retiring a memory beats deleting it, and a reflection must
// cite evidence that actually exists. Invalidation is one mechanism — a stored
// flag honoured by retrieval and by the character-visible projection — so a
// retired memory can never be recalled, recapped or cited again.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmPort } from "../src/ports/ports.js";
import { InMemoryMemoryStore } from "../src/memory/inMemoryMemoryStore.js";
import type { MemoryRecord } from "../src/memory/memoryRecords.js";
import { isCharacterVisibleMemory } from "../src/conversation/oocGuard.js";
import {
  isEngineDiagnosticRecord,
  isEngineTemplateRecord,
  MEMORY_RETIRE_MIN_IMPORTANCE,
  MEMORY_STALE_DAYS,
  RealmStateStore,
} from "../src/host/realmState.js";
import { createHostApiHandler } from "../src/host/hostApi.js";
import { RealmHost } from "../src/host/realmHost.js";

const AGENT_ID = "agent_elysia";
const PROFILE_ID = "user_master";
const NOW = "2026-07-26T12:00:00.000Z";
const DAY = 86_400_000;

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "elysian-invalidate-"));
}

function liveRecord(id: string, content: string, at = NOW, importance = 4) {
  return {
    id,
    agentId: AGENT_ID,
    kind: "observation" as const,
    content,
    createdAt: at,
    lastAccessedAt: at,
    importance,
    sourceIds: [AGENT_ID],
    relatedMemoryIds: [],
    visibility: "private" as const,
    tags: [],
    metadata: { source: "engine" as const },
  };
}

test("retrieval and the character projection both skip invalidated memories", () => {
  const store = new InMemoryMemoryStore<Record<string, unknown>>([
    liveRecord("m1", "花园里的向日葵开了。"),
    liveRecord("m2", "我把花瓣做成了书签。"),
  ]);

  const before = store.retrieve(AGENT_ID, { text: "向日葵", now: NOW, topK: 5 });
  assert.ok(before.hits.some((hit) => hit.record.id === "m1"));

  assert.equal(store.invalidate(AGENT_ID, ["m1"], NOW), 1);
  assert.equal(store.invalidate(AGENT_ID, ["m1"], NOW), 0, "invalidating twice changes nothing");

  const after = store.retrieve(AGENT_ID, { text: "向日葵", now: NOW, topK: 5 });
  assert.equal(after.hits.some((hit) => hit.record.id === "m1"), false);
  assert.deepEqual(
    after.diagnostics.excluded.map((entry) => [entry.memoryId, entry.reason]),
    [["m1", "invalidated"]],
  );

  // Provenance survives: the record is still there, just retired.
  const retired = store.list(AGENT_ID).find((record) => record.id === "m1");
  assert.equal(retired?.invalidAt, NOW);
  assert.equal(retired?.content, "花园里的向日葵开了。");
  assert.equal(isCharacterVisibleMemory(retired as MemoryRecord<Record<string, unknown>>), false);
  assert.equal(
    isCharacterVisibleMemory(store.list(AGENT_ID).find((record) => record.id === "m2") as MemoryRecord<Record<string, unknown>>),
    true,
  );
});

test("invalidated memories survive a store round-trip and stay retired", () => {
  const dir = tempDataDir();
  const state = new RealmStateStore(dir);
  const [written] = state.applyMemoryWrites(AGENT_ID, [
    { kind: "observation", content: "今天在花园里照料向日葵。", createdAt: NOW, importance: 4, sourceIds: [AGENT_ID], metadata: { source: "engine" } },
  ]);
  assert.equal(state.invalidateMemories(AGENT_ID, [written!.id], NOW), 1);

  const reopened = new RealmStateStore(dir);
  const record = reopened.memoriesFor(AGENT_ID).find((entry) => entry.id === written!.id);
  assert.equal(record?.invalidAt, NOW);
  assert.equal(isCharacterVisibleMemory(record!), false);
  assert.equal(reopened.stats(NOW).agents[0]?.invalidatedMemories, 1);
  assert.equal(reopened.stats(NOW).totals.invalidatedMemories, 1);
});

test("govern retires stale and template memories, dry run by default", () => {
  const dir = tempDataDir();
  const state = new RealmStateStore(dir);
  const longAgo = new Date(Date.parse(NOW) - (MEMORY_STALE_DAYS + 10) * DAY).toISOString();

  state.applyMemoryWrites(AGENT_ID, [
    { kind: "observation", content: "很久以前的琐事。", createdAt: longAgo, importance: MEMORY_RETIRE_MIN_IMPORTANCE - 1, sourceIds: [AGENT_ID], metadata: { source: "engine" } },
    { kind: "observation", content: "很久以前但很重要的事。", createdAt: longAgo, importance: 8, sourceIds: [AGENT_ID], metadata: { source: "engine" } },
    { kind: "observation", content: "刚刚发生的事。", createdAt: NOW, importance: 2, sourceIds: [AGENT_ID], metadata: { source: "engine" } },
  ]);
  // A legacy template record: written before the marker existed.
  state.applyTickMemories(AGENT_ID, [
    {
      ...liveRecord("legacy_plan", "我把今天的安排记下了：在图书馆翻看诗集。", NOW, 4),
      kind: "plan",
      visibility: "system",
      metadata: { source: "engine", stepId: "step_legacy" },
    },
  ]);
  const before = state.memoriesFor(AGENT_ID).length;

  const host = new RealmHost(state, () => undefined, { now: () => new Date(NOW) });
  const dry = host.govern({ dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.candidates, { stale: 1, engineTemplates: 1 });
  assert.deepEqual(dry.invalidated, { stale: 0, engineTemplates: 0 });
  assert.equal(state.memoriesFor(AGENT_ID).length, before, "a dry run changes nothing");

  const applied = host.govern({ dryRun: false });
  assert.deepEqual(applied.invalidated, { stale: 1, engineTemplates: 1 });
  assert.equal(state.memoriesFor(AGENT_ID).length, before, "nothing was deleted");
  const retired = state.memoriesFor(AGENT_ID).filter((record) => record.invalidAt !== undefined);
  assert.equal(retired.length, 2);
  assert.equal(
    retired.some((record) => record.content.includes("很重要的事")),
    false,
    "important memories are never retired",
  );
  assert.equal(host.listAgents()[0]?.memoryCount, before - 2, "retired memories are not memories she has");
  assert.deepEqual(host.govern({ dryRun: true }).candidates, { stale: 0, engineTemplates: 0 });
});

test("the template predicate recognizes legacy engine text", () => {
  assert.equal(isEngineTemplateRecord({ kind: "plan", metadata: { source: "engine" } }), true);
  assert.equal(
    isEngineTemplateRecord({ kind: "reflection", metadata: { source: "engine", reflectionSource: "deterministic" } }),
    true,
  );
  assert.equal(
    isEngineTemplateRecord({ kind: "observation", metadata: { source: "engine" } }),
    false,
    "lived records are not templates",
  );
  assert.equal(
    isEngineTemplateRecord({ kind: "reflection", metadata: { source: "engine", triggerKind: "scheduled" } }),
    false,
    "an llm reflection is not a template",
  );
  assert.equal(
    isEngineDiagnosticRecord({ metadata: { source: "engine", engineDiagnostic: true } }),
    true,
  );
});

test("host api governs memories with an explicit dry run", async () => {
  const state = new RealmStateStore(tempDataDir());
  const host = new RealmHost(state, () => undefined, { now: () => new Date(NOW) });
  const handler = createHostApiHandler(host);

  const defaulted = await handler("POST", "/v1/host/govern", undefined);
  assert.equal(defaulted?.status, 200);
  assert.equal(
    defaulted !== undefined && "body" in defaulted
      ? (defaulted.body as { dryRun: boolean; profileId: string }).dryRun
      : undefined,
    true,
    "governance is a dry run unless the caller says otherwise",
  );

  const applied = await handler("POST", "/v1/host/govern", { dryRun: false });
  assert.equal(applied?.status, 200);
  assert.equal(
    applied !== undefined && "body" in applied
      ? (applied.body as { dryRun: boolean }).dryRun
      : undefined,
    false,
  );
  assert.equal((await handler("POST", "/v1/host/govern", { dryRun: "yes" }))?.status, 400);
});

// ── 反思必须引用真实证据 ────────────────────────────────────────────────

test("a reflection citing evidence that does not exist is rejected at the host boundary", async () => {
  const dir = tempDataDir();
  let clock = new Date(2026, 6, 26, 9, 0, 0);
  const state = new RealmStateStore(dir);
  let citation = "memory_does_not_exist";
  const llm: LlmPort = {
    name: "fake",
    model: "fake",
    completeChat(request) {
      const system = String(request.messages[0]?.content ?? "");
      if (system.includes("JSON array")) {
        const realId = /id=(\S+)/.exec(String(request.messages[1]?.content ?? ""))?.[1];
        return Promise.resolve({
          content: JSON.stringify([
            { content: "没有证据的幻想。", evidenceIds: [citation], importance: 7 },
            ...(realId === undefined
              ? []
              : [{ content: "我开始期待和主人一起看花。", evidenceIds: [realId], importance: 7 }]),
          ]),
        });
      }
      return Promise.resolve({ content: "花园里的风带着玫瑰香，我偷偷许了个愿♪" });
    },
  };
  const host = new RealmHost(state, () => undefined, { now: () => clock, llm: () => llm });

  await host.tickIfPeriodChanged(); // morning: narrative becomes the day's evidence
  clock = new Date(2026, 6, 26, 23, 0, 0);
  const night = await host.tickIfPeriodChanged();
  assert.equal(night?.period, "night");

  const reflections = state.memoriesFor(AGENT_ID).filter((record) => record.kind === "reflection");
  assert.equal(
    reflections.some((record) => record.content.includes("没有证据的幻想")),
    false,
    "an insight without real evidence is dropped",
  );
  assert.equal(
    reflections.some((record) => record.content.includes("一起看花")),
    true,
    "an insight citing the evidence it was given is kept",
  );
});
