import test from "node:test";
import assert from "node:assert/strict";

import { detectOocLeak } from "../src/conversation/oocGuard.js";
import { CHAT_PAGE_HTML } from "../src/host/chatPage.js";
import { blendConversationEmotion } from "../src/affect/plotRules.js";
import { createInitialAffectState } from "../src/affect/plotRules.js";
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

function fakeRunner(replyContent: string, affinityDelta?: number) {
  return {
    runner: {
      async run() {
        return {
          schemaVersion: "realm-conversation.v1" as const,
          conversationId: "c1",
          agentId: AGENT_ID,
          reply: { content: replyContent },
          affect: {
            analysis: "llm" as const,
            reason: "心情不错",
            ...(affinityDelta !== undefined ? { affinityDelta } : {}),
          },
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
  const affect = state.affectState(AGENT_ID);
  assert.ok(affect, "tick initializes an affect state");
  assert.equal(affect.valence, 0.2, "no baseline means the engine default");
  assert.equal(affect.arousal, 0.3);
  assert.equal(affect.emotionLabels.anger, 0, "no script means no event labels");
});

test("tick initializes affect at the character's temperament baseline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elysian-baseline-"));
  writeFileSync(
    join(dir, "realm.json"),
    JSON.stringify({
      user: { participantId: "user_master", displayName: "主人" },
      agents: [
        {
          agentId: AGENT_ID,
          personaId: "elysia",
          displayName: "爱莉希雅",
          persona: {
            identity: "爱莉希雅",
            personality: "开朗",
            values: "美好",
            speechStyle: "轻快",
            baseline: { valence: 0.5, arousal: 0.6 },
          },
          routines: [
            { period: "morning", locationId: "garden", intent: "照料花" },
            { period: "day", locationId: "library", intent: "看书" },
          ],
        },
      ],
    }),
  );
  const state = new RealmStateStore(dir);
  let clock = new Date(2026, 6, 26, 9, 0, 0);
  const host = new RealmHost(state, () => undefined, { now: () => clock });
  await host.tickIfPeriodChanged();
  const affect = state.affectState(AGENT_ID);
  assert.ok(affect);
  assert.equal(affect.valence, 0.5, "initial state anchors at the character baseline");
  assert.equal(affect.arousal, 0.6);
  assert.deepEqual(affect.baseline, { valence: 0.5, arousal: 0.6 });

  // A plot shock moves away, then a later tick decays toward the character's
  // own baseline — not the shared engine default.
  let clock2 = new Date(2026, 6, 26, 10, 0, 0);
  const host2 = new RealmHost(state, () => undefined, { now: () => clock2 });
  host2.plotEvent(AGENT_ID, { type: "hostile_act", target: "host" });
  const shocked = state.affectState(AGENT_ID);
  assert.ok(shocked && shocked.valence < 0.5);

  clock2 = new Date(2026, 6, 26, 14, 0, 0);
  await host2.tickIfPeriodChanged();
  const settled = state.affectState(AGENT_ID);
  assert.ok(settled && settled.valence > shocked.valence, "valence regresses toward the character baseline");
  assert.deepEqual(settled.baseline, { valence: 0.5, arousal: 0.6 });
});

test("persona baseline validation rejects out-of-range values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elysian-badbaseline-"));
  writeFileSync(
    join(dir, "realm.json"),
    JSON.stringify({
      user: { participantId: "user_master", displayName: "主人" },
      agents: [
        {
          agentId: AGENT_ID,
          personaId: "elysia",
          displayName: "爱莉希雅",
          persona: {
            identity: "爱莉希雅",
            personality: "开朗",
            values: "美好",
            speechStyle: "轻快",
            baseline: { valence: 2, arousal: 0.5 },
          },
          routines: [],
        },
      ],
    }),
  );
  assert.throws(() => new RealmStateStore(dir), /baseline needs valence -1\.\.1 and arousal 0\.\.1/);
});

// ── 对话情感闭环：宿主低权重逼近 AffectState ────────────────────────────

test("blendConversationEmotion nudges valence and arousal at a small weight", () => {
  const base = createInitialAffectState(AGENT_ID, "2026-07-26T10:00:00.000Z", { valence: 0, arousal: 0.3 });
  const blended = blendConversationEmotion(base, { valence: 0.8, arousal: 0.9 }, "2026-07-26T10:01:00.000Z");
  assert.ok(Math.abs(blended.valence - 0.08) < 1e-9, "0.1 weight toward the signature");
  assert.ok(Math.abs(blended.arousal - (0.3 + 0.06)) < 1e-9);
  assert.equal(blended.baseline.valence, 0, "baseline untouched");
  assert.equal(blended.emotionLabels.anger, 0, "labels untouched");
});

test("blendConversationEmotion clamps at the affect bounds", () => {
  const high = createInitialAffectState(AGENT_ID, "2026-07-26T10:00:00.000Z", { valence: 0.9, arousal: 1 });
  const blended = blendConversationEmotion(high, { valence: -1, arousal: 0 }, "2026-07-26T10:01:00.000Z");
  assert.equal(blended.valence, 0.9 - 0.19, "moves 10% toward -1");
  assert.equal(blended.arousal, 0.9, "moves 10% toward 0 from 1");
});

test("host chat applies conversation emotion to the affect state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elysian-chatemotion-"));
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
  // Pre-seed an affect state so the blend has a base.
  let clock = new Date(2026, 6, 26, 9, 0, 0);
  const host = new RealmHost(state, () => undefined, { now: () => clock });
  await host.tickIfPeriodChanged();
  const before = state.affectState(AGENT_ID);
  assert.ok(before);
  assert.equal(before.valence, 0.2, "default baseline");

  const emotionRunner = {
    runner: {
      async run() {
        return {
          schemaVersion: "realm-conversation.v1" as const,
          conversationId: "c1",
          agentId: AGENT_ID,
          reply: { content: "好开心呀♪" },
          affect: {
            analysis: "llm" as const,
            reason: "开心的交流",
            emotion: { valence: 0.9, arousal: 0.8 },
          },
          memoryWrites: [],
        };
      },
    },
  };
  const host2 = new RealmHost(state, () => emotionRunner.runner, { now: () => clock });
  await host2.chat(AGENT_ID, "给你讲个笑话");
  const after = state.affectState(AGENT_ID);
  assert.ok(after);
  assert.ok(after.valence > before.valence, "happy chat nudges valence up");
  assert.ok(after.valence < 0.9, "but only by the small blend weight");
});

test("host chat without an emotion signature leaves affect untouched", async () => {
  const state = new RealmStateStore(tempDataDir());
  let clock = new Date(2026, 6, 26, 9, 0, 0);
  const host = new RealmHost(state, () => fakeRunner("你好呀").runner, { now: () => clock });
  await host.tickIfPeriodChanged();
  const before = state.affectState(AGENT_ID);
  assert.ok(before);
  await host.chat(AGENT_ID, "你好");
  const after = state.affectState(AGENT_ID);
  assert.deepEqual(after, before, "fake runner carries no emotion signature");
});

// ── 性格调制：角色对剧情事件的情感响应差异化 ─────────────────────────────

test("applyPlotEvents scales responses by per-type modifiers", async () => {
  const { applyPlotEvents } = await import("../src/affect/plotRules.js");
  const { createInitialAffectState } = await import("../src/affect/plotRules.js");
  const base = createInitialAffectState(AGENT_ID, "2026-07-26T10:00:00.000Z", { valence: 0, arousal: 0.3 });
  const praise = { id: "p1", type: "praise" as const, target: "host" as const, intensity: 1, at: "2026-07-26T10:00:00.000Z" };

  const plain = applyPlotEvents(base, [praise], "2026-07-26T10:01:00.000Z");
  const doubled = applyPlotEvents(base, [praise], "2026-07-26T10:01:00.000Z", { praise: 2 });
  assert.ok(doubled.valence - base.valence > plain.valence - base.valence, "2x modifier amplifies the response");
  assert.ok(Math.abs((doubled.valence - base.valence) - 2 * (plain.valence - base.valence)) < 1e-9);
});

test("host plot events apply the character's affect modifiers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elysian-modifiers-"));
  writeFileSync(
    join(dir, "realm.json"),
    JSON.stringify({
      user: { participantId: "user_master", displayName: "主人" },
      agents: [
        {
          agentId: AGENT_ID,
          personaId: "elysia",
          displayName: "爱莉希雅",
          persona: {
            identity: "爱莉希雅",
            personality: "开朗",
            values: "美好",
            speechStyle: "轻快",
            baseline: { valence: 0, arousal: 0.3 },
            affectModifiers: { praise: 0 }, // completely indifferent to praise
          },
          routines: [],
        },
      ],
    }),
  );
  const state = new RealmStateStore(dir);
  const host = new RealmHost(state, () => undefined, {
    now: () => new Date(2026, 6, 26, 9, 0, 0),
  });
  host.plotEvent(AGENT_ID, { type: "praise", target: "host" });
  const affect = state.affectState(AGENT_ID);
  assert.ok(affect);
  assert.equal(affect.valence, 0, "praise modifier 0 means no emotional response");
  assert.equal(state.relationship(AGENT_ID)?.affinity, undefined, "no affinity change either");
});

test("two personas respond differently to the same event", async () => {
  // Elysia treasures praise; Mobius shrugs it off — same event, same engine.
  const { applyPlotEvents, createInitialAffectState } = await import("../src/affect/plotRules.js");
  const at = "2026-07-26T10:00:00.000Z";
  const praise = { id: "p1", type: "praise" as const, target: "host" as const, intensity: 1, at };
  const elysia = applyPlotEvents(
    createInitialAffectState("a", at, { valence: 0, arousal: 0.3 }),
    [praise], at, { praise: 1.3 },
  );
  const mobius = applyPlotEvents(
    createInitialAffectState("a", at, { valence: 0, arousal: 0.3 }),
    [praise], at, { praise: 0.4 },
  );
  assert.ok(elysia.valence > mobius.valence, "Elysia is more moved by praise than Mobius");
});

test("affectModifiers validation rejects unknown event types and negatives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elysian-badmods-"));
  const base = {
    user: { participantId: "user_master", displayName: "主人" },
    agents: [
      {
        agentId: AGENT_ID,
        personaId: "elysia",
        displayName: "爱莉希雅",
        persona: { identity: "i", personality: "p", values: "v", speechStyle: "s" },
        routines: [],
      },
    ],
  };
  writeFileSync(
    join(dir, "realm.json"),
    JSON.stringify({
      ...base,
      agents: [{ ...base.agents[0], persona: { ...base.agents[0].persona, affectModifiers: { notAnEvent: 1 } } }],
    }),
  );
  assert.throws(() => new RealmStateStore(dir), /not a plot event type/);

  writeFileSync(
    join(dir, "realm.json"),
    JSON.stringify({
      ...base,
      agents: [{ ...base.agents[0], persona: { ...base.agents[0].persona, affectModifiers: { praise: -1 } } }],
    }),
  );
  assert.throws(() => new RealmStateStore(dir), /non-negative finite number/);
});

// ── 关系历史与情感弧线叙事 ──────────────────────────────────────────────

test("affinity changes append to relationship history", async () => {
  const state = new RealmStateStore(tempDataDir());
  let clock = new Date(2026, 6, 26, 9, 0, 0);
  const host = new RealmHost(state, () => fakeRunner("你好", 3).runner, { now: () => clock });

  assert.equal(state.relationshipHistory(AGENT_ID).length, 0, "no history before any change");

  // Fake runner carries an affinityDelta so the relationship moves.
  await host.chat(AGENT_ID, "你好呀");
  const afterChat = state.relationshipHistory(AGENT_ID);
  assert.equal(afterChat.length, 1, "one history row after the first affinity move");
  assert.equal(afterChat[0].affinity, 3);

  // A second chat with the same delta appends another row.
  await host.chat(AGENT_ID, "再说一句");
  const afterSecond = state.relationshipHistory(AGENT_ID);
  assert.equal(afterSecond.length, 2);
  assert.equal(afterSecond[1].affinity, 6);
  assert.ok(afterSecond[1].at >= afterSecond[0].at, "rows are ordered by time");
});

test("relationship history survives a store reopen", async () => {
  const dir = tempDataDir();
  const state = new RealmStateStore(dir);
  let clock = new Date(2026, 6, 26, 9, 0, 0);
  const host = new RealmHost(state, () => fakeRunner("你好", 3).runner, { now: () => clock });
  await host.chat(AGENT_ID, "你好");

  const reopened = new RealmStateStore(dir);
  assert.equal(reopened.relationshipHistory(AGENT_ID).length, 1, "history persisted in sqlite");
});

test("reflection prompt quotes the relationship arc when it moved", async () => {
  const { buildReflectionMessages } = await import("../src/reflection/llmReflectionPlanner.js");
  const evidence = [
    {
      id: "e1",
      agentId: AGENT_ID,
      kind: "conversation" as const,
      content: "和主人一起赏花。",
      createdAt: "2026-07-26T10:00:00.000Z",
      importance: 6,
      lastAccessedAt: "2026-07-26T10:00:00.000Z",
      sourceIds: [],
      relatedMemoryIds: [],
      visibility: "private" as const,
      tags: [],
      metadata: {},
    },
  ];
  const { system, user } = buildReflectionMessages(
    {
      agentId: AGENT_ID,
      trigger: { kind: "scheduled", reason: "night", now: "2026-07-26T22:00:00.000Z", sourceIds: [] },
      evidence,
    },
    3,
    { personaName: "爱莉希雅", persona: "p", relationshipArc: "Relationship arc today: your bond with 主人 moved from 3 to 9 (scale -100..100)." },
  );
  assert.ok(system.includes("inner voice"));
  assert.match(user, /Relationship arc today: your bond with 主人 moved from 3 to 9/);
});

// ── 对话关系感知：prompt 注入关系轨迹 ───────────────────────────────────

test("host chat carries relationship history into the conversation request", async () => {
  const { buildConversationSystemPrompt } = await import("../src/conversation/conversationPrompt.js");
  const prompt = buildConversationSystemPrompt({
    agent: { agentId: AGENT_ID, personaId: "elysia", displayName: "爱莉希雅", persona: "p" },
    participant: { participantId: "user_master", displayName: "主人" },
    relationship: { agentId: AGENT_ID, targetId: "user_master", affinity: 40, updatedAt: "2026-07-26T12:00:00.000Z" },
    relationshipHistory: [
      { affinity: 10, at: "2026-07-26T09:00:00.000Z" },
      { affinity: 25, at: "2026-07-26T10:00:00.000Z" },
      { affinity: 40, at: "2026-07-26T12:00:00.000Z" },
    ],
    memoryHits: [],
    now: "2026-07-26T13:00:00.000Z",
  });
  assert.match(prompt, /Relationship trajectory: your bond with 主人 has moved from 10 to 40 over your recent exchanges\./);
  assert.match(prompt, /close \(affinity 40/);
});

test("conversation prompt omits the trajectory when it never moved", async () => {
  const { buildConversationSystemPrompt } = await import("../src/conversation/conversationPrompt.js");
  const prompt = buildConversationSystemPrompt({
    agent: { agentId: AGENT_ID, personaId: "elysia", displayName: "爱莉希雅", persona: "p" },
    participant: { participantId: "user_master", displayName: "主人" },
    relationship: { agentId: AGENT_ID, targetId: "user_master", affinity: 40, updatedAt: "2026-07-26T12:00:00.000Z" },
    relationshipHistory: [
      { affinity: 40, at: "2026-07-26T09:00:00.000Z" },
      { affinity: 40, at: "2026-07-26T12:00:00.000Z" },
    ],
    memoryHits: [],
  });
  assert.ok(!prompt.includes("Relationship trajectory"));
});

test("host chat writes relationship history on affinity moves", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elysian-reltraj-"));
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
  const runner = {
    runner: {
      async run() {
        return {
          schemaVersion: "realm-conversation.v1" as const,
          conversationId: "c1",
          agentId: AGENT_ID,
          reply: { content: "好呀" },
          affect: { analysis: "llm" as const, reason: "x", affinityDelta: 5 },
          memoryWrites: [],
        };
      },
    },
  };
  const host = new RealmHost(state, () => runner.runner, {
    now: () => new Date(2026, 6, 26, 9, 0, 0),
  });
  await host.chat(AGENT_ID, "你好");
  const history = state.relationshipHistory(AGENT_ID);
  assert.equal(history.length, 1, "first chat writes one history row");
});

// ── 情绪驱动行为：mood 偏好例程选择 ─────────────────────────────────────

test("selectRoutineForPeriod picks the mood-matching candidate", async () => {
  const { selectRoutineForPeriod, moodBand } = await import("../src/host/realmHost.js");
  const { createInitialAffectState } = await import("../src/affect/plotRules.js");
  const routines = [
    { period: "morning" as const, locationId: "garden", intent: "照料花" },
    { period: "morning" as const, locationId: "home", intent: "整理干花", mood: "low" as const },
  ];
  const at = "2026-07-26T08:00:00.000Z";

  const lowAffect = createInitialAffectState(AGENT_ID, at, { valence: -0.4, arousal: 0.3 });
  const highAffect = createInitialAffectState(AGENT_ID, at, { valence: 0.5, arousal: 0.3 });
  const neutralAffect = createInitialAffectState(AGENT_ID, at, { valence: 0, arousal: 0.3 });

  assert.equal(moodBand(lowAffect), "low");
  assert.equal(moodBand(highAffect), "high");
  assert.equal(moodBand(neutralAffect), "neutral");
  assert.equal(moodBand(undefined), "neutral");

  const lowPick = selectRoutineForPeriod(routines, "morning", lowAffect);
  assert.equal(lowPick?.locationId, "home", "low mood picks the quiet routine");
  const highPick = selectRoutineForPeriod(routines, "morning", highAffect);
  assert.equal(highPick?.locationId, "garden", "high mood falls back to the default");
  const neutralPick = selectRoutineForPeriod(routines, "morning", neutralAffect);
  assert.equal(neutralPick?.locationId, "garden");
  const noAffectPick = selectRoutineForPeriod(routines, "morning", undefined);
  assert.equal(noAffectPick?.locationId, "garden");
});

test("legacy single-routine configs select the only candidate", async () => {
  const { selectRoutineForPeriod } = await import("../src/host/realmHost.js");
  const { createInitialAffectState } = await import("../src/affect/plotRules.js");
  const routines = [{ period: "day" as const, locationId: "library", intent: "看书" }];
  const pick = selectRoutineForPeriod(
    routines,
    "day",
    createInitialAffectState(AGENT_ID, "2026-07-26T12:00:00.000Z", { valence: -0.5, arousal: 0.3 }),
  );
  assert.equal(pick?.locationId, "library", "no mood variants means no behavior change");
});

test("host tick uses the mood-matched routine", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elysian-moodroutine-"));
  writeFileSync(
    join(dir, "realm.json"),
    JSON.stringify({
      user: { participantId: "user_master", displayName: "主人" },
      agents: [
        {
          agentId: AGENT_ID,
          personaId: "elysia",
          displayName: "爱莉希雅",
          persona: "p",
          routines: [
            { period: "morning", locationId: "garden", intent: "照料花" },
            { period: "morning", locationId: "home", intent: "整理干花", mood: "low" },
          ],
        },
      ],
    }),
  );
  const state = new RealmStateStore(dir);
  let clock = new Date(2026, 6, 26, 8, 0, 0);
  const host = new RealmHost(state, () => undefined, { now: () => clock });
  // Two hostile events push valence well below the low band (-0.5).
  host.plotEvent(AGENT_ID, { type: "hostile_act", target: "host" });
  host.plotEvent(AGENT_ID, { type: "hostile_act", target: "host" });
  const affect = state.affectState(AGENT_ID);
  assert.ok(affect && affect.valence < -0.15, "hostile events leave a low valence");

  await host.tickIfPeriodChanged(); // first morning tick with low mood
  const memories = state.memoriesFor(AGENT_ID);
  assert.ok(
    memories.some((record) => record.content.includes("整理干花")),
    "low mood tick runs the quiet home routine",
  );
});

test("routine mood validation rejects unknown bands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elysian-badmoodband-"));
  writeFileSync(
    join(dir, "realm.json"),
    JSON.stringify({
      user: { participantId: "user_master", displayName: "主人" },
      agents: [
        {
          agentId: AGENT_ID,
          personaId: "elysia",
          displayName: "爱莉希雅",
          persona: "p",
          routines: [{ period: "morning", locationId: "garden", intent: "x", mood: "ecstatic" }],
        },
      ],
    }),
  );
  assert.throws(() => new RealmStateStore(dir), /mood must be low, neutral, or high/);
});

// ── 反思可见化：摘要暴露最近心事 ────────────────────────────────────────

test("agent summary exposes the latest reflection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elysian-reflsummary-"));
  const state = new RealmStateStore(dir);
  state.applyMemoryWrites(AGENT_ID, [
    {
      id: "refl_1",
      kind: "reflection",
      content: "今天的一切都让我想多陪陪主人。",
      createdAt: "2026-07-26T23:00:00.000Z",
      importance: 7,
      sourceIds: [AGENT_ID],
      visibility: "private",
      tags: [AGENT_ID, "reflection"],
      metadata: { source: "engine", period: "night" },
    },
    {
      id: "obs_1",
      kind: "observation",
      content: "花园的风很舒服。",
      createdAt: "2026-07-26T10:00:00.000Z",
      importance: 4,
      sourceIds: [AGENT_ID],
      visibility: "private",
      tags: [AGENT_ID, "life-narrative"],
      metadata: { source: "engine", period: "morning" },
    },
  ]);
  const host = new RealmHost(state, () => undefined, {
    now: () => new Date(2026, 7, 8, 9, 0),
  });
  const summary = host.listAgents()[0];
  assert.equal(summary.latestReflection, "今天的一切都让我想多陪陪主人。");
  assert.equal(summary.memoryCount, 2, "summary counts all memories");
});

test("agent summary omits latestReflection when none exists", () => {
  const state = new RealmStateStore(tempDataDir());
  const host = new RealmHost(state, () => undefined, {
    now: () => new Date(2026, 7, 8, 9, 0),
  });
  const summary = host.listAgents()[0];
  assert.equal(summary.latestReflection, undefined);
});


test("chat page embeds the latest-reflection renderer", () => {
  assert.ok(CHAT_PAGE_HTML.includes("她最近在想"), "chat page must show the agent's recent reflection");
  assert.ok(CHAT_PAGE_HTML.includes("latestReflection"), "chat page must read latestReflection from the summary");
});
