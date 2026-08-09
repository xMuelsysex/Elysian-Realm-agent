import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConversationRunner } from "../src/conversation/conversationRunner.js";
import {
  REALM_CONVERSATION_SCHEMA_VERSION,
  type RealmConversationRequestV1,
} from "../src/service/realmConversationV1.js";
import { createHostApiHandler } from "../src/host/hostApi.js";
import { CHAT_PAGE_HTML } from "../src/host/chatPage.js";
import { ADMIN_PAGE_HTML } from "../src/service/adminPage.js";
import { RealmHost, periodOf } from "../src/host/realmHost.js";
import { RealmStateStore, RealmStateError } from "../src/host/realmState.js";

const AGENT_ID = "agent_elysia";

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "elysian-realm-"));
}

function fakeRunner(reply = "好呀好呀♪"): {
  runner: ConversationRunner;
  requests: RealmConversationRequestV1[];
} {
  const requests: RealmConversationRequestV1[] = [];
  return {
    requests,
    runner: {
      run(request) {
        requests.push(request);
        return Promise.resolve({
          schemaVersion: REALM_CONVERSATION_SCHEMA_VERSION,
          conversationId: request.conversationId,
          agentId: request.agent.agentId,
          reply: { content: reply },
          affect: {
            analysis: "llm",
            reason: "test analysis",
            affinityDelta: 3,
            mood: { mood: "开心", intensity: 0.8 },
          },
          memoryWrites: [
            {
              kind: "conversation",
              content: `${request.participant.displayName}: ${request.message.content}`,
              createdAt: request.now,
              importance: 3,
              sourceIds: [request.participant.participantId],
              tags: ["conversation"],
              metadata: {
                source: "conversation",
                conversationId: request.conversationId,
                messageId: request.message.messageId,
                messageRole: "incoming",
              },
            },
          ],
        });
      },
    },
  };
}

test("served page scripts are syntactically valid", () => {
  // Template-literal escapes can silently corrupt the inline page JS (e.g.
  // \n inside a template becoming a real newline, or \b in a regex becoming
  // a backspace control char); compile both pages' scripts and reject control
  // chars that would break embedded regexes at runtime.
  for (const html of [CHAT_PAGE_HTML, ADMIN_PAGE_HTML]) {
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    assert.ok(script, "page must embed a script block");
    assert.doesNotThrow(() => {
      // eslint-disable-next-line no-new-func
      new Function(script);
    }, "page script must compile");
    assert.ok(!/\u0008/.test(script), "page script must not contain backspace control chars (unescaped \\b)");
  }
  // The status-classification regex must survive template rendering as real
  // backslash escapes — a literal `\b`/`\d` match must stay a word boundary
  // and digit class in the browser, otherwise every error lands in the
  // generic bucket.
  assert.ok(
    CHAT_PAGE_HTML.includes(String.raw`\b([45]\d{2})\b`),
    "chat page must embed the rendered status-classification regex",
  );
});

test("first run seeds the default realm with a hand-editable config", () => {
  const dir = tempDataDir();
  const state = new RealmStateStore(dir);

  assert.equal(state.config.agents[0].agentId, AGENT_ID);
  assert.equal(state.config.agents[0].displayName, "爱莉希雅");
  assert.equal(state.config.agents[0].routines.length, 4);
  assert.equal(state.relationship(AGENT_ID), undefined);

  // The seeded config must be loadable by a second instance.
  const again = new RealmStateStore(dir);
  assert.equal(again.config.user.participantId, "user_master");
});

test("broken realm config fails visibly", () => {
  const dir = tempDataDir();
  writeFileSync(join(dir, "realm.json"), "{broken");
  assert.throws(() => new RealmStateStore(dir), RealmStateError);

  const dir2 = tempDataDir();
  writeFileSync(join(dir2, "realm.json"), JSON.stringify({ user: {}, agents: [] }));
  assert.throws(() => new RealmStateStore(dir2), /user\.participantId/);
});

test("chat flows state into the runner and applies the returned proposals", async () => {
  const dir = tempDataDir();
  const state = new RealmStateStore(dir);
  const { runner, requests } = fakeRunner();
  const host = new RealmHost(state, () => runner, {
    now: () => new Date("2026-07-26T12:00:00.000Z"),
  });

  const first = await host.chat(AGENT_ID, "你好呀！");
  assert.equal(first.reply, "好呀好呀♪");
  assert.equal(first.affinity, 3);
  assert.equal(first.mood?.mood, "开心");

  // Request carried persona, empty history, and no relationship yet.
  assert.equal(requests[0].agent.displayName, "爱莉希雅");
  assert.equal(requests[0].relationship, undefined);
  assert.equal(requests[0].history.length, 0);

  const second = await host.chat(AGENT_ID, "今天做了什么？");
  assert.equal(second.affinity, 6, "affinity accumulates across exchanges");
  // Second request sees the applied state: relationship, mood, prior turns, memory.
  assert.equal(requests[1].relationship?.affinity, 3);
  assert.equal(requests[1].mood?.mood, "开心");
  assert.equal(requests[1].history.length, 2);
  assert.ok(requests[1].memories.length >= 1);

  // Persistence: a fresh instance sees the accumulated world.
  const restored = new RealmStateStore(dir);
  assert.equal(restored.relationship(AGENT_ID)?.affinity, 6);
  assert.equal(restored.mood(AGENT_ID)?.mood, "开心");
  assert.equal(restored.historyFor(AGENT_ID).length, 4);
  assert.equal(restored.memoriesFor(AGENT_ID).length, 2);
});

test("chatStream falls back to one delta when the runner has no runStream", async () => {
  const state = new RealmStateStore(tempDataDir());
  const { runner } = fakeRunner("逐字回复");
  const host = new RealmHost(state, () => runner, {
    now: () => new Date("2026-07-26T12:00:00.000Z"),
  });

  const deltas: string[] = [];
  const replies: string[] = [];
  const result = await host.chatStream(
    AGENT_ID,
    "你好",
    (text) => deltas.push(text),
    (text) => replies.push(text),
  );

  assert.deepEqual(deltas, ["逐字回复"], "non-streaming runner emits the whole reply once");
  assert.deepEqual(replies, ["逐字回复"], "fallback also fires onReply");
  assert.equal(result.reply, "逐字回复");
  assert.equal(result.affinity, 3);
  assert.equal(result.mood?.mood, "开心");
});

test("chatStream forwards deltas from a streaming runner and applies proposals", async () => {
  const state = new RealmStateStore(tempDataDir());
  const base = fakeRunner();
  const streamingRunner: ConversationRunner = {
    ...base.runner,
    async runStream(request, onDelta, onReply) {
      onDelta("好呀");
      onDelta("好呀♪");
      onReply?.("好呀好呀♪");
      return this.run(request);
    },
  };
  const host = new RealmHost(state, () => streamingRunner, {
    now: () => new Date("2026-07-26T12:00:00.000Z"),
  });

  const deltas: string[] = [];
  const replies: string[] = [];
  const result = await host.chatStream(AGENT_ID, "你好", (text) => deltas.push(text), (text) =>
    replies.push(text),
  );

  assert.deepEqual(deltas, ["好呀", "好呀♪"]);
  assert.deepEqual(replies, ["好呀好呀♪"], "onReply fires once with the full reply");
  assert.equal(result.reply, "好呀好呀♪");
  assert.equal(result.affinity, 3);
  assert.equal(result.mood?.mood, "开心");
});

test("chat without a configured llm fails with a pointer to /admin", async () => {
  const state = new RealmStateStore(tempDataDir());
  const host = new RealmHost(state, () => undefined);
  await assert.rejects(host.chat(AGENT_ID, "hi"), /open \/admin/);
  await assert.rejects(
    new RealmHost(state, () => fakeRunner().runner).chat(AGENT_ID, "   "),
    /must not be empty/,
  );
});

test("periodOf maps the real clock onto realm periods", () => {
  assert.equal(periodOf(6), "morning");
  assert.equal(periodOf(10), "morning");
  assert.equal(periodOf(11), "day");
  assert.equal(periodOf(16), "day");
  assert.equal(periodOf(17), "evening");
  assert.equal(periodOf(21), "evening");
  assert.equal(periodOf(22), "night");
  assert.equal(periodOf(3), "night");
});

test("ticks run on period changes and accumulate routine memories", async () => {
  const dir = tempDataDir();
  const state = new RealmStateStore(dir);
  // Local-time constructor: periodOf follows the host's wall clock.
  let clock = new Date(2026, 6, 26, 9, 0, 0);
  const host = new RealmHost(state, () => undefined, { now: () => clock });

  const first = await host.tickIfPeriodChanged();
  assert.ok(first, "first check runs a tick");
  assert.equal(first.period, "morning");
  assert.ok(first.added > 0, "tick produces routine memories");
  assert.equal(first.narratives, 0, "no llm means no narratives");

  const skipped = await host.tickIfPeriodChanged();
  assert.equal(skipped, undefined, "same period does not tick again");

  const before = state.memoriesFor(AGENT_ID).length;
  clock = new Date(2026, 6, 26, 13, 0, 0);
  const second = await host.tickIfPeriodChanged();
  assert.ok(second && second.added > 0, "period change ticks again");
  assert.equal(second.period, "day");
  assert.ok(state.memoriesFor(AGENT_ID).length > before);

  // Tick memories survive a reload.
  const restored = new RealmStateStore(dir);
  assert.equal(restored.memoriesFor(AGENT_ID).length, state.memoriesFor(AGENT_ID).length);

  // Restart safety: a fresh host over the same data dir must not double-tick
  // the same (date, period) — the tick state is persisted.
  const restartedHost = new RealmHost(restored, () => undefined, { now: () => clock });
  assert.equal(await restartedHost.tickIfPeriodChanged(), undefined);
});

test("host stats reports non-destructive store counts after chat and tick", async () => {
  const state = new RealmStateStore(tempDataDir());
  const { runner } = fakeRunner();
  const host = new RealmHost(state, () => runner, {
    now: () => new Date("2026-07-26T12:00:00.000Z"),
  });

  await host.chat(AGENT_ID, "你好呀");
  const stats = host.stats();

  assert.equal(stats.agents.length, 1);
  const agent = stats.agents[0];
  assert.equal(agent.agentId, AGENT_ID);
  assert.equal(agent.displayName, "爱莉希雅");
  assert.ok(agent.conversationTurns >= 2, "chat persists both turns");
  assert.ok(agent.memories >= 1, "chat persists conversation memories");
  assert.equal(stats.totals.memories, agent.memories);
  assert.equal(stats.totals.conversationTurns, agent.conversationTurns);
  assert.equal(stats.totals.moods, 1, "fake runner applies a mood");
  assert.equal(stats.totals.relationships, 1, "fake runner moves affinity");
  assert.equal(stats.totals.affectStates, 0);
  assert.ok(stats.dbBytes > 0, "sqlite store file exists");
});

test("host stats reports retention diagnostics for governance decisions", () => {
  const state = new RealmStateStore(tempDataDir());
  const now = new Date("2026-07-26T12:00:00.000Z");
  state.applyTickMemories(AGENT_ID, [
    {
      id: "memory_old_unused",
      agentId: AGENT_ID,
      kind: "observation",
      content: "很久以前的观察。",
      createdAt: "2026-03-01T12:00:00.000Z",
      lastAccessedAt: "2026-03-02T12:00:00.000Z",
      importance: 2,
      sourceIds: ["tick"],
      relatedMemoryIds: [],
      visibility: "private",
      tags: [],
      metadata: { source: "seed" },
    },
    {
      id: "memory_recent",
      agentId: AGENT_ID,
      kind: "observation",
      content: "最近的观察。",
      createdAt: "2026-07-20T12:00:00.000Z",
      lastAccessedAt: "2026-07-21T12:00:00.000Z",
      importance: 3,
      sourceIds: ["tick"],
      relatedMemoryIds: [],
      visibility: "private",
      tags: [],
      metadata: { source: "seed" },
    },
  ]);

  const stats = state.stats(now.toISOString());
  const agent = stats.agents[0];
  assert.equal(agent.oldestMemoryAt, "2026-03-01T12:00:00.000Z");
  assert.equal(agent.staleMemories, 1, "the 5-month-old unused memory is a prune candidate");
  assert.equal(stats.totals.staleMemories, 1);
});

test("host api serves store stats", async () => {
  const state = new RealmStateStore(tempDataDir());
  const host = new RealmHost(state, () => undefined, {
    now: () => new Date("2026-07-26T12:00:00.000Z"),
  });
  const handler = createHostApiHandler(host);

  const result = await handler("GET", "/v1/host/stats", undefined);
  assert.equal(result?.status, 200);
  const body = result !== undefined && "body" in result
    ? (result.body as { agents: Array<{ agentId: string }>; totals: { memories: number }; dbBytes: number })
    : undefined;
  assert.equal(body?.agents[0].agentId, AGENT_ID);
  assert.equal(body?.totals.memories, 0);
  assert.ok((body?.dbBytes ?? 0) > 0);
});

test("host api rejects malformed percent-encoding as a client error", async () => {
  const state = new RealmStateStore(tempDataDir());
  const host = new RealmHost(state, () => undefined, {
    now: () => new Date("2026-07-26T12:00:00.000Z"),
  });
  const handler = createHostApiHandler(host);

  const result = await handler("GET", "/v1/host/history/%zz", undefined);
  assert.equal(result?.status, 400, "malformed URI must be a 400, not a thrown 500");
  assert.equal(
    result !== undefined && "body" in result
      ? (result.body as { error: { code: string } }).error.code
      : undefined,
    "INVALID_HOST_REQUEST",
  );
});

test("host api serves state, history, and chat with explicit errors", async () => {
  const state = new RealmStateStore(tempDataDir());
  const { runner } = fakeRunner();
  const host = new RealmHost(state, () => runner, {
    now: () => new Date("2026-07-26T12:00:00.000Z"),
  });
  const handler = createHostApiHandler(host);

  const stateResult = await handler("GET", "/v1/host/state", undefined);
  assert.equal(stateResult?.status, 200);
  const stateBody =
    stateResult !== undefined && "body" in stateResult
      ? (stateResult.body as { user: { displayName: string }; agents: Array<{ agentId: string }> })
      : undefined;
  assert.equal(stateBody?.user.displayName, "主人");
  assert.equal(stateBody?.agents[0].agentId, AGENT_ID);

  const chatResult = await handler("POST", "/v1/host/chat", {
    agentId: AGENT_ID,
    content: "你好！",
  });
  assert.equal(chatResult?.status, 200);
  assert.equal(
    chatResult !== undefined && "body" in chatResult
      ? (chatResult.body as { reply: string }).reply
      : undefined,
    "好呀好呀♪",
  );

  const historyResult = await handler("GET", `/v1/host/history/${AGENT_ID}`, undefined);
  assert.equal(historyResult?.status, 200);
  assert.equal(
    historyResult !== undefined && "body" in historyResult
      ? (historyResult.body as { turns: unknown[] }).turns.length
      : undefined,
    2,
  );

  const badChat = await handler("POST", "/v1/host/chat", { agentId: "nope", content: "hi" });
  assert.equal(badChat?.status, 400);
  const badHistory = await handler("GET", "/v1/host/history/nope", undefined);
  assert.equal(badHistory?.status, 400);
  assert.equal(await handler("GET", "/v1/host/unknown", undefined), undefined);
});

test("host api streams chat deltas and a done event on stream requests", async () => {
  const state = new RealmStateStore(tempDataDir());
  const { runner } = fakeRunner("流式回复♪");
  const host = new RealmHost(state, () => runner, {
    now: () => new Date("2026-07-26T12:00:00.000Z"),
  });
  const handler = createHostApiHandler(host);

  const streamResult = await handler("POST", "/v1/host/chat", {
    agentId: AGENT_ID,
    content: "你好",
    stream: true,
  });
  assert.ok(streamResult && "stream" in streamResult, "stream mode returns an SSE result");
  assert.equal(streamResult.status, 200);

  const events: Array<[string, unknown]> = [];
  await streamResult.stream((event, data) => events.push([event, data]));
  assert.deepEqual(
    events.map(([event]) => event),
    ["delta", "done", "applied"],
  );
  assert.deepEqual(events[0]?.[1], { text: "流式回复♪" });
  const done = events[1]?.[1] as { agentId: string; reply: string };
  assert.equal(done.agentId, AGENT_ID);
  assert.equal(done.reply, "流式回复♪", "done fires with the reply as soon as it completes");
  const applied = events[2]?.[1] as { reply: string; affinity: number };
  assert.equal(applied.reply, "流式回复♪");
  assert.equal(applied.affinity, 3, "applied carries the post-analysis state");
});

test("host api surfaces mid-stream chat failures as error events", async () => {
  const state = new RealmStateStore(tempDataDir());
  const host = new RealmHost(state, () => undefined, {
    now: () => new Date("2026-07-26T12:00:00.000Z"),
  });
  const handler = createHostApiHandler(host);

  const streamResult = await handler("POST", "/v1/host/chat", {
    agentId: AGENT_ID,
    content: "你好",
    stream: true,
  });
  assert.ok(streamResult && "stream" in streamResult);

  const events: Array<[string, unknown]> = [];
  await streamResult.stream((event, data) => events.push([event, data]));
  assert.equal(events[0]?.[0], "error");
  assert.match(String((events[0]?.[1] as { message: string }).message), /\/admin/);
});
