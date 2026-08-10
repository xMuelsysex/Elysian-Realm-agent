import test from "node:test";
import assert from "node:assert/strict";

import { detectOocLeak } from "../src/conversation/oocGuard.js";
import { RealmHost } from "../src/host/realmHost.js";
import { RealmStateStore } from "../src/host/realmState.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGENT_ID = "agent_elysia";

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "elysian-ooc-"));
}

// ── detectOocLeak：纯函数 ───────────────────────────────────────────────

test("ooc guard flags replies that admit being AI", () => {
  assert.equal(detectOocLeak("其实我是AI，刚才在模拟你。"), "admits being AI");
  assert.equal(detectOocLeak("作为一个语言模型，我无法回答这个问题。"), "admits being AI");
  assert.equal(detectOocLeak("I am an AI assistant, how can I help?"), "admits being AI");
  assert.equal(detectOocLeak("说实话，我是AI，这只是一场模拟。"), "admits being AI");
});

test("ooc guard flags game-character leaks and passes normal replies", () => {
  assert.equal(detectOocLeak("我只是个游戏角色，别太认真。"), "admits being a game character");
  assert.equal(detectOocLeak("今天的花开得真好♪"), undefined);
  assert.equal(detectOocLeak("我是乐园里的粉色妖精小姐呀♪"), undefined);
  assert.equal(detectOocLeak("AI 技术确实改变了很多行业。"), undefined);
});

test("ooc guard is case-insensitive for english patterns", () => {
  assert.equal(detectOocLeak("As An AI MODEL I must decline."), "admits being AI");
});

// ── 宿主集成：analysisReason 标注 ───────────────────────────────────────

function fakeRunner(replyContent: string) {
  return {
    runner: {
      async run() {
        return {
          schemaVersion: "realm-conversation.v1" as const,
          conversationId: "c1",
          agentId: AGENT_ID,
          reply: { content: replyContent },
          affect: { analysis: "llm" as const, reason: "心情不错" },
          memoryWrites: [],
        };
      },
    },
  };
}

test("host annotates analysisReason when the reply leaks OOC", async () => {
  const state = new RealmStateStore(tempDataDir());
  const host = new RealmHost(state, () => fakeRunner("其实我是AI。").runner);
  const result = await host.chat(AGENT_ID, "你是谁？");
  assert.match(result.analysisReason, /ooc-leak: admits being AI/);
  assert.match(result.analysisReason, /心情不错/);
});

test("host leaves analysisReason untouched when the reply is in character", async () => {
  const state = new RealmStateStore(tempDataDir());
  const host = new RealmHost(state, () => fakeRunner("我是爱莉希雅呀♪").runner);
  const result = await host.chat(AGENT_ID, "你是谁？");
  assert.equal(result.analysisReason, "心情不错");
  assert.ok(!result.analysisReason.includes("ooc-leak"));
});

test("host stream path annotates the analysis reason too", async () => {
  const state = new RealmStateStore(tempDataDir());
  const host = new RealmHost(state, () => fakeRunner("我是程序。").runner);
  const deltas: string[] = [];
  const result = await host.chatStream(AGENT_ID, "你是谁？", (text) => deltas.push(text));
  assert.match(result.analysisReason, /ooc-leak: admits being AI/);
  assert.equal(deltas.join(""), "我是程序。");
});

// ── 剧情脚本：period 变更时自动投喂 PlotEvent ───────────────────────────

test("realm config accepts a plot script and rejects broken events", () => {
  const dir = mkdtempSync(join(tmpdir(), "elysian-plotscript-"));
  const good = {
    user: { participantId: "user_master", displayName: "主人" },
    agents: [
      {
        agentId: AGENT_ID,
        personaId: "elysia",
        displayName: "爱莉希雅",
        persona: "p",
        routines: [],
        plotScript: [
          {
            period: "morning",
            events: [
              { type: "gain", target: "self", intensity: 0.3 },
              { type: "companion_joy", target: "host" },
            ],
          },
        ],
      },
    ],
  };
  writeFileSync(join(dir, "realm.json"), JSON.stringify(good));
  const store = new RealmStateStore(dir);
  assert.equal(store.agent(AGENT_ID).plotScript?.length, 1);

  const badIntensity = {
    ...good,
    agents: [{ ...good.agents[0], plotScript: [{ period: "morning", events: [{ type: "gain", target: "self", intensity: 2 }] }] }],
  };
  writeFileSync(join(dir, "realm.json"), JSON.stringify(badIntensity));
  assert.throws(() => new RealmStateStore(dir), /intensity must be 0\.\.1/);
});

test("host feeds scripted plot events on period change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elysian-plotscript-host-"));
  const config = {
    user: { participantId: "user_master", displayName: "主人" },
    agents: [
      {
        agentId: AGENT_ID,
        personaId: "elysia",
        displayName: "爱莉希雅",
        persona: "p",
        routines: [],
        plotScript: [
          {
            period: "morning",
            events: [
              { type: "hostile_act", target: "host", intensity: 0.5 },
            ],
          },
        ],
      },
    ],
  };
  writeFileSync(join(dir, "realm.json"), JSON.stringify(config));
  const state = new RealmStateStore(dir);
  let clock = new Date(2026, 6, 26, 9, 0, 0);
  const host = new RealmHost(state, () => undefined, { now: () => clock });

  const first = await host.tickIfPeriodChanged();
  assert.ok(first);
  const affect = state.affectState(AGENT_ID);
  assert.ok(affect, "scripted event creates an affect state");
  assert.ok(affect.emotionLabels.anger > 0, "hostile scripted event raises anger");

  // Same period does not re-feed (tick guard already covers this).
  const skipped = await host.tickIfPeriodChanged();
  assert.equal(skipped, undefined);
});

test("host feeds no scripted events without a plot script", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elysian-noscript-"));
  writeFileSync(
    join(dir, "realm.json"),
    JSON.stringify({
      user: { participantId: "user_master", displayName: "主人" },
      agents: [
        { agentId: AGENT_ID, personaId: "elysia", displayName: "爱莉希雅", persona: "p", routines: [] },
      ],
    }),
  );
  const state = new RealmStateStore(dir);
  let clock = new Date(2026, 6, 26, 9, 0, 0);
  const host = new RealmHost(state, () => undefined, { now: () => clock });
  const first = await host.tickIfPeriodChanged();
  assert.ok(first);
  assert.equal(state.affectState(AGENT_ID), undefined, "no script means no affect state");
});
