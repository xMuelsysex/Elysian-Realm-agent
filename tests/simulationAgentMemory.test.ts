import test from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryMemoryStore,
  MemoryValidationError,
  type MemoryRetrievalHit,
  type MemoryWrite,
} from "@elysian/simulation-agent";

const AGENT_ID = "agent_elysia";
const OTHER_AGENT_ID = "agent_eden";
const NOW = "2026-07-04T12:00:00.000Z";

function memoryWrite(overrides: Partial<MemoryWrite> = {}): MemoryWrite {
  return {
    id: "memory_base",
    kind: "observation",
    content: "Elysia noticed a quiet garden routine.",
    createdAt: "2026-07-04T09:00:00.000Z",
    importance: 3,
    sourceIds: ["event_garden_1"],
    tags: ["garden", "routine"],
    ...overrides,
  };
}

function seedStore(): InMemoryMemoryStore {
  const store = new InMemoryMemoryStore();
  store.remember(
    AGENT_ID,
    memoryWrite({
      id: "memory_old_relevant",
      content: "The garden meeting included a music rehearsal.",
      createdAt: "2026-07-01T12:00:00.000Z",
      importance: 2,
      tags: ["garden", "music"],
      sourceIds: ["event_music"],
    }),
  );
  store.remember(
    AGENT_ID,
    memoryWrite({
      id: "memory_recent",
      content: "A recent meal happened near the lounge.",
      createdAt: "2026-07-04T11:30:00.000Z",
      importance: 1,
      tags: ["lounge"],
      sourceIds: ["event_meal"],
    }),
  );
  store.remember(
    AGENT_ID,
    memoryWrite({
      id: "memory_important",
      content: "An important promise was made by the fountain.",
      createdAt: "2026-07-02T12:00:00.000Z",
      importance: 9,
      tags: ["promise"],
      sourceIds: ["event_promise"],
    }),
  );
  store.remember(
    OTHER_AGENT_ID,
    memoryWrite({
      id: "memory_other_agent",
      content: "Garden music from another agent perspective.",
      createdAt: "2026-07-04T11:45:00.000Z",
      importance: 9,
      tags: ["garden", "music"],
      sourceIds: ["event_other"],
    }),
  );
  return store;
}

function hitIds(hits: readonly MemoryRetrievalHit[]): string[] {
  return hits.map((hit) => hit.record.id);
}

test("in-memory memory store appends valid records with defaults and defensive copies", () => {
  const store = new InMemoryMemoryStore<{ mood?: string }>();

  const stored = store.remember(AGENT_ID, {
    kind: "observation",
    content: "A new observation was recorded.",
    createdAt: NOW,
    importance: 4,
    sourceIds: ["event_1"],
    metadata: { mood: "calm" },
  });

  assert.equal(stored.id, "memory_0001");
  assert.equal(stored.agentId, AGENT_ID);
  assert.equal(stored.visibility, "private");
  assert.deepEqual(stored.relatedMemoryIds, []);
  assert.deepEqual(stored.tags, []);
  assert.deepEqual(stored.metadata, { mood: "calm" });

  (stored.sourceIds as string[]).push("mutated");
  assert.deepEqual(store.list(AGENT_ID)[0]?.sourceIds, ["event_1"]);
});

test("invalid memory writes fail visibly and do not store fake records", () => {
  const store = new InMemoryMemoryStore();

  assert.throws(
    () =>
      store.remember(AGENT_ID, {
        kind: "observation",
        content: "missing source",
        createdAt: NOW,
        importance: 4,
        sourceIds: [],
      }),
    (error) => {
      assert.ok(error instanceof MemoryValidationError);
      assert.match(error.message, /sourceIds/);
      return true;
    },
  );

  assert.equal(store.list(AGENT_ID).length, 0);
});

test("duplicate memory ids are rejected without overwriting existing records", () => {
  const store = new InMemoryMemoryStore();

  store.remember(AGENT_ID, memoryWrite({ id: "memory_duplicate" }));

  assert.throws(
    () => store.remember(AGENT_ID, memoryWrite({ id: "memory_duplicate", content: "replacement attempt" })),
    /memory id already exists/,
  );
  assert.deepEqual(
    store.list(AGENT_ID).map((record) => record.content),
    ["Elysia noticed a quiet garden routine."],
  );
});

test("retrieval is deterministic for identical records queries and weights", () => {
  const first = seedStore().retrieve(AGENT_ID, {
    text: "garden music",
    now: NOW,
    topK: 3,
    weights: { relevance: 1, recency: 1, importance: 1 },
  });
  const second = seedStore().retrieve(AGENT_ID, {
    text: "garden music",
    now: NOW,
    topK: 3,
    weights: { relevance: 1, recency: 1, importance: 1 },
  });

  assert.deepEqual(hitIds(first.hits), hitIds(second.hits));
  assert.deepEqual(first.diagnostics.candidateScores, second.diagnostics.candidateScores);
});

test("retrieval ranking can be relevance dominant", () => {
  const result = seedStore().retrieve(AGENT_ID, {
    text: "garden music",
    now: NOW,
    topK: 3,
    weights: { relevance: 1, recency: 0, importance: 0 },
  });

  assert.equal(result.hits[0]?.record.id, "memory_old_relevant");
  assert.equal(result.hits[0]?.score.relevance, 1);
});

test("retrieval ranking can be recency dominant", () => {
  const result = seedStore().retrieve(AGENT_ID, {
    text: "garden music",
    now: NOW,
    topK: 3,
    weights: { relevance: 0, recency: 1, importance: 0 },
  });

  assert.equal(result.hits[0]?.record.id, "memory_recent");
});

test("retrieval ranking can be importance dominant", () => {
  const result = seedStore().retrieve(AGENT_ID, {
    text: "garden music",
    now: NOW,
    topK: 3,
    weights: { relevance: 0, recency: 0, importance: 1 },
  });

  assert.equal(result.hits[0]?.record.id, "memory_important");
  assert.equal(result.hits[0]?.score.importance, 1);
});

test("retrieval diagnostics expose candidates selected scores query and excluded records", () => {
  const result = seedStore().retrieve(AGENT_ID, {
    text: "garden",
    now: NOW,
    topK: 2,
    tags: ["music"],
    sourceIds: ["event_music"],
  });

  assert.deepEqual(result.diagnostics.query.tags, ["music"]);
  assert.deepEqual(result.diagnostics.query.sourceIds, ["event_music"]);
  assert.equal(result.diagnostics.selectedIds.length, 2);
  assert.ok(result.diagnostics.candidateIds.includes("memory_old_relevant"));
  assert.ok(result.diagnostics.candidateScores.every((entry) => Number.isFinite(entry.score.finalScore)));
  assert.deepEqual(result.diagnostics.excluded, [{ memoryId: "memory_other_agent", reason: "different agentId" }]);
});

test("retrieval touches only selected records", () => {
  const store = seedStore();

  const before = store.list(AGENT_ID);
  assert.equal(before.find((record) => record.id === "memory_old_relevant")?.lastAccessedAt, "2026-07-01T12:00:00.000Z");
  assert.equal(before.find((record) => record.id === "memory_important")?.lastAccessedAt, "2026-07-02T12:00:00.000Z");

  store.retrieve(AGENT_ID, {
    text: "garden music",
    now: NOW,
    topK: 1,
    weights: { relevance: 1, recency: 0, importance: 0 },
  });

  const after = store.list(AGENT_ID);
  assert.equal(after.find((record) => record.id === "memory_old_relevant")?.lastAccessedAt, NOW);
  assert.equal(after.find((record) => record.id === "memory_important")?.lastAccessedAt, "2026-07-02T12:00:00.000Z");
});

test("memory store exposes a cognitive loop MemoryPort adapter", () => {
  const store = new InMemoryMemoryStore();
  const port = store.toPort();

  port.remember(
    AGENT_ID,
    memoryWrite({
      id: "memory_port",
      content: "The port stored this observation.",
      tags: ["port"],
    }),
  );
  const hits = port.retrieve(AGENT_ID, {
    text: "port observation",
    now: NOW,
    topK: 1,
  });

  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.record.id, "memory_port");
  assert.ok(hits[0]?.score.finalScore);
});

test("in-memory memory store can rehydrate existing records defensively", () => {
  const original = new InMemoryMemoryStore<{ source: string }>();
  const imported = original.remember(AGENT_ID, {
    id: "memory_rehydrate",
    kind: "plan",
    content: "A stored plan memory should survive rehydration.",
    createdAt: NOW,
    importance: 5,
    sourceIds: ["step_001"],
    tags: ["plan"],
    metadata: { source: "test" },
  });

  const rehydrated = new InMemoryMemoryStore([imported]);
  (imported.sourceIds as string[]).push("mutated");

  assert.deepEqual(rehydrated.list(AGENT_ID)[0]?.sourceIds, ["step_001"]);
  assert.equal(rehydrated.retrieve(AGENT_ID, { text: "stored plan", now: NOW, topK: 1 }).hits[0]?.record.id, "memory_rehydrate");
  const generated = rehydrated.remember(AGENT_ID, {
    kind: "observation",
    content: "A new generated id skips imported duplicates.",
    createdAt: NOW,
    importance: 2,
    sourceIds: ["step_002"],
  });
  assert.equal(generated.id, "memory_0001");
});

test("memory store rehydration rejects duplicate or invalid records visibly", () => {
  const record = {
    id: "memory_duplicate_rehydrate",
    agentId: AGENT_ID,
    kind: "observation" as const,
    content: "Duplicate import.",
    createdAt: NOW,
    lastAccessedAt: NOW,
    importance: 2,
    sourceIds: ["event_1"],
    relatedMemoryIds: [],
    visibility: "private" as const,
    tags: [],
    metadata: {},
  };

  assert.throws(() => new InMemoryMemoryStore([record, record]), /memory id already exists/);
  assert.throws(() => new InMemoryMemoryStore([{ ...record, id: "memory_bad_access", lastAccessedAt: "not-a-date" }]), /lastAccessedAt/);
});
