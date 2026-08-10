import test from "node:test";
import assert from "node:assert/strict";

import { detectOocLeak } from "../src/conversation/oocGuard.js";
import { RealmHost } from "../src/host/realmHost.js";
import { RealmStateStore } from "../src/host/realmState.js";
import { mkdtempSync } from "node:fs";
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
