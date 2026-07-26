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

test("ticks run on period changes and accumulate routine memories", () => {
  const dir = tempDataDir();
  const state = new RealmStateStore(dir);
  // Local-time constructor: periodOf follows the host's wall clock.
  let clock = new Date(2026, 6, 26, 9, 0, 0);
  const host = new RealmHost(state, () => undefined, { now: () => clock });

  const first = host.tickIfPeriodChanged();
  assert.ok(first, "first check runs a tick");
  assert.equal(first.period, "morning");
  assert.ok(first.added > 0, "tick produces routine memories");

  const skipped = host.tickIfPeriodChanged();
  assert.equal(skipped, undefined, "same period does not tick again");

  const before = state.memoriesFor(AGENT_ID).length;
  clock = new Date(2026, 6, 26, 13, 0, 0);
  const second = host.tickIfPeriodChanged();
  assert.ok(second && second.added > 0, "period change ticks again");
  assert.equal(second.period, "day");
  assert.ok(state.memoriesFor(AGENT_ID).length > before);

  // Tick memories survive a reload.
  const restored = new RealmStateStore(dir);
  assert.equal(restored.memoriesFor(AGENT_ID).length, state.memoriesFor(AGENT_ID).length);

  // Restart safety: a fresh host over the same data dir must not double-tick
  // the same (date, period) — the tick state is persisted.
  const restartedHost = new RealmHost(restored, () => undefined, { now: () => clock });
  assert.equal(restartedHost.tickIfPeriodChanged(), undefined);
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
  const stateBody = stateResult?.body as { user: { displayName: string }; agents: Array<{ agentId: string }> };
  assert.equal(stateBody.user.displayName, "主人");
  assert.equal(stateBody.agents[0].agentId, AGENT_ID);

  const chatResult = await handler("POST", "/v1/host/chat", {
    agentId: AGENT_ID,
    content: "你好！",
  });
  assert.equal(chatResult?.status, 200);
  assert.equal((chatResult?.body as { reply: string }).reply, "好呀好呀♪");

  const historyResult = await handler("GET", `/v1/host/history/${AGENT_ID}`, undefined);
  assert.equal(historyResult?.status, 200);
  assert.equal((historyResult?.body as { turns: unknown[] }).turns.length, 2);

  const badChat = await handler("POST", "/v1/host/chat", { agentId: "nope", content: "hi" });
  assert.equal(badChat?.status, 400);
  const badHistory = await handler("GET", "/v1/host/history/nope", undefined);
  assert.equal(badHistory?.status, 400);
  assert.equal(await handler("GET", "/v1/host/unknown", undefined), undefined);
});
