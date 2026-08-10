import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildConversationSystemPrompt,
  createConversationRunner,
  createLlmReflectionPlanner,
  describeRelativeTime,
  parseAffectAnalysis,
  runReflection,
  type ConversationReplyInput,
  type LlmPort,
  type MemoryRecord,
} from "@elysian/simulation-agent";
import { buildReflectionMessages } from "../src/reflection/llmReflectionPlanner.js";
import {
  REALM_CONVERSATION_SCHEMA_VERSION,
  type RealmConversationRequestV1,
} from "@elysian/simulation-agent/service";
import { buildLifeNarrativeMessages, runLifeNarrative } from "../src/host/lifeNarrative.js";
import { RealmHost } from "../src/host/realmHost.js";
import { RealmStateStore } from "../src/host/realmState.js";

const NOW = "2026-07-26T20:30:00.000Z";
const AGENT_ID = "agent_elysia";

function textLlm(content: string): LlmPort {
  return { name: "fake", model: "fake", completeChat: () => Promise.resolve({ content }) };
}

// ── 时间感 ──────────────────────────────────────────────────────────────

test("describeRelativeTime maps deltas onto human-shaped buckets", () => {
  assert.equal(describeRelativeTime(NOW, NOW), "just now");
  assert.equal(describeRelativeTime("2026-07-26T20:00:00.000Z", NOW), "30 minutes ago");
  assert.equal(describeRelativeTime("2026-07-26T17:30:00.000Z", NOW), "3 hours ago");
  assert.equal(describeRelativeTime("2026-07-23T20:30:00.000Z", NOW), "3 days ago");
  assert.equal(describeRelativeTime("2026-05-20T20:30:00.000Z", NOW), "2 months ago");
  assert.equal(describeRelativeTime("garbage", NOW), "just now");
});

test("system prompt carries current time, last-chat gap, and memory ages", () => {
  const record: MemoryRecord = {
    id: "m1",
    agentId: AGENT_ID,
    kind: "conversation",
    content: "约好去湖边看晚霞。",
    createdAt: "2026-07-23T20:30:00.000Z",
    lastAccessedAt: NOW,
    importance: 7,
    sourceIds: ["user_master"],
    relatedMemoryIds: [],
    visibility: "private",
    tags: [],
    metadata: {},
  };
  const prompt = buildConversationSystemPrompt({
    agent: { agentId: AGENT_ID, personaId: "elysia", displayName: "Elysia", persona: "p" },
    participant: { participantId: "user_master", displayName: "主人" },
    memoryHits: [{ record, score: { relevance: 1, recency: 1, importance: 1, finalScore: 1 } }],
    now: NOW,
    lastTurnAt: "2026-07-24T20:30:00.000Z",
  });

  assert.match(prompt, /Current time: \w+ \d{2}:\d{2}\./);
  assert.match(prompt, /previous exchange with 主人 was 2 days ago/);
  assert.match(prompt, /- \(3 days ago\) \[conversation\] 约好去湖边看晚霞。/);
  assert.match(prompt, /let the time of day, mood, relationship/);
});

// ── 记忆重要度打分 ───────────────────────────────────────────────────────

test("affect analysis parses and normalizes memoryImportance", () => {
  const scored = parseAffectAnalysis(
    '{"affinityDelta": 2, "mood": "warm", "moodIntensity": 0.5, "memoryImportance": 7, "reason": "约定"}',
  );
  assert.equal(scored.memoryImportance, 7);

  const clamped = parseAffectAnalysis(
    '{"affinityDelta": 1, "mood": "calm", "moodIntensity": 0.5, "memoryImportance": 42.6}',
  );
  assert.equal(clamped.memoryImportance, 9);
  assert.match(clamped.reason, /memoryImportance normalized/);

  const absent = parseAffectAnalysis('{"affinityDelta": 1, "mood": "calm", "moodIntensity": 0.5}');
  assert.equal(absent.memoryImportance, undefined);
});

test("runner uses analyzed importance for conversation memory writes", async () => {
  const replyInputs: ConversationReplyInput[] = [];
  const runner = createConversationRunner({
    reply: {
      generateReply(input) {
        replyInputs.push(input);
        return Promise.resolve({ content: "好呀！" });
      },
    },
    analysisLlm: textLlm(
      '{"affinityDelta": 3, "mood": "开心", "moodIntensity": 0.8, "memoryImportance": 7, "reason": "约定了"}',
    ),
  });

  const request: RealmConversationRequestV1 = {
    schemaVersion: REALM_CONVERSATION_SCHEMA_VERSION,
    conversationId: "c1",
    now: NOW,
    agent: { agentId: AGENT_ID, personaId: "elysia", displayName: "Elysia", persona: "p" },
    participant: { participantId: "user_master", displayName: "主人" },
    memories: [],
    history: [
      { role: "participant", content: "早", at: "2026-07-26T08:00:00.000Z" },
      { role: "agent", content: "早安♪", at: "2026-07-26T08:00:05.000Z" },
    ],
    message: { messageId: "m1", content: "晚上一起看星星吗？" },
  };
  const response = await runner.run(request);

  assert.equal(response.affect.memoryImportance, 7);
  assert.ok(response.memoryWrites.every((write) => write.importance === 7));
  assert.match(replyInputs[0].systemPrompt, /previous exchange with 主人 was 12 hours ago/);
});

// ── LLM 反思 ────────────────────────────────────────────────────────────

function evidenceRecord(id: string, content: string, importance = 5): MemoryRecord {
  return {
    id,
    agentId: AGENT_ID,
    kind: "conversation",
    content,
    createdAt: NOW,
    lastAccessedAt: NOW,
    importance,
    sourceIds: ["user_master"],
    relatedMemoryIds: [],
    visibility: "private",
    tags: [],
    metadata: {},
  };
}

test("reflection prompt grounds the evidence in the emotional arc", () => {
  const signed1 = { ...evidenceRecord("e1", "主人早上来看向日葵。"), createdAt: "2026-07-26T08:00:00.000Z", emotion: { valence: 0.8, arousal: 0.6 } };
  const signed2 = { ...evidenceRecord("e2", "下雨了，有点低落。"), createdAt: "2026-07-26T20:00:00.000Z", emotion: { valence: -0.6, arousal: 0.2 } };
  const trigger = { kind: "scheduled" as const, reason: "nightly", now: NOW, sourceIds: [AGENT_ID] };

  const withArc = buildReflectionMessages(
    { agentId: AGENT_ID, trigger, evidence: [signed2, signed1] }, // intentionally unsorted
    3,
    { personaName: "Elysia" },
  );
  assert.match(
    withArc.user,
    /Emotional arc across the evidence \(2 emotionally signed moments\): started strongly joyful and energized, ended heavy and low\./,
  );

  const withoutArc = buildReflectionMessages(
    { agentId: AGENT_ID, trigger, evidence: [evidenceRecord("e1", "x")] },
    3,
    { personaName: "Elysia" },
  );
  assert.doesNotMatch(withoutArc.user, /Emotional arc/);
});

test("llm reflection planner turns evidence into validated insight writes", async () => {
  const llm = textLlm(
    JSON.stringify([
      { content: "我好像越来越期待主人来花园了。", evidenceIds: ["e1", "e2"], importance: 7 },
      { content: "没有证据的幻想。", evidenceIds: ["nope"], importance: 5 },
      { content: "", evidenceIds: ["e1"] },
    ]),
  );
  const planner = createLlmReflectionPlanner(llm, { personaName: "Elysia" });
  const result = await runReflection(
    {
      agentId: AGENT_ID,
      trigger: { kind: "scheduled", reason: "nightly", now: NOW, sourceIds: [AGENT_ID] },
      evidence: [evidenceRecord("e1", "主人早上来看向日葵。"), evidenceRecord("e2", "约好一起浇水。")],
    },
    planner,
  );

  assert.equal(result.status, "completed");
  assert.equal(result.memoryWrites.length, 1);
  assert.equal(result.memoryWrites[0].kind, "reflection");
  assert.match(result.memoryWrites[0].content, /越来越期待/);
  assert.equal(result.memoryWrites[0].importance, 7);
});

test("llm reflection failures stay visible without fabricating insights", async () => {
  const planner = createLlmReflectionPlanner(textLlm("我今天感觉很好，但这不是 JSON。"));
  const output = await planner.reflect({
    agentId: AGENT_ID,
    trigger: { kind: "scheduled", reason: "nightly", now: NOW, sourceIds: [AGENT_ID] },
    evidence: [evidenceRecord("e1", "x")],
  });
  assert.equal(output.insights.length, 0);
  assert.match(output.reason, /non-JSON/);
});

// ── 生活叙事 ────────────────────────────────────────────────────────────

test("life narrative prompt grounds the diary moment and keeps continuity", () => {
  const messages = buildLifeNarrativeMessages({
    agentId: AGENT_ID,
    displayName: "爱莉希雅",
    persona: "粉色妖精小姐",
    period: "morning",
    locationId: "garden",
    intent: "照料向日葵",
    now: NOW,
    recentNarratives: ["昨天的向日葵朝我点了点头。"],
  });
  assert.match(messages.system, /voice of 爱莉希雅/);
  assert.match(messages.user, /Place: garden/);
  assert.match(messages.user, /- 昨天的向日葵朝我点了点头。/);
});

test("life narrative produces an observation write and reports failures", async () => {
  const ok = await runLifeNarrative(textLlm("向日葵上停了一只白蝴蝶，我屏住呼吸看了好久♪"), {
    agentId: AGENT_ID,
    displayName: "爱莉希雅",
    persona: "p",
    period: "morning",
    locationId: "garden",
    intent: "浇水",
    now: NOW,
  });
  assert.ok("write" in ok);
  assert.equal(ok.write.kind, "observation");
  assert.ok(ok.write.tags?.includes("life-narrative"));
  assert.equal(ok.write.metadata?.source, "engine");

  const failed = await runLifeNarrative(
    { name: "f", model: "f", completeChat: () => Promise.reject(new Error("down")) },
    {
      agentId: AGENT_ID,
      displayName: "爱莉希雅",
      persona: "p",
      period: "morning",
      locationId: "garden",
      intent: "浇水",
      now: NOW,
    },
  );
  assert.ok("error" in failed);
  assert.match(failed.error, /down/);
});

// ── host 集成：叙事 + 夜间反思 ───────────────────────────────────────────

test("host ticks write narratives, and night ticks add reflections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elysian-lively-"));
  let clock = new Date(2026, 6, 26, 9, 0, 0);
  const state = new RealmStateStore(dir);

  let llmCalls = 0;
  const llm: LlmPort = {
    name: "fake",
    model: "fake",
    completeChat(request) {
      llmCalls += 1;
      const system = String(request.messages[0]?.content ?? "");
      if (system.includes("JSON array")) {
        const idMatch = /id=(\S+)/.exec(String(request.messages[1]?.content ?? ""));
        return Promise.resolve({
          content: JSON.stringify([
            { content: "今天的一切都让我想多陪陪主人。", evidenceIds: [idMatch?.[1] ?? ""], importance: 7 },
          ]),
        });
      }
      return Promise.resolve({ content: "花园里的风带着玫瑰香，我偷偷许了个愿♪" });
    },
  };
  const host = new RealmHost(state, () => undefined, { now: () => clock, llm: () => llm });

  const morning = await host.tickIfPeriodChanged();
  assert.ok(morning);
  assert.ok(morning.narratives >= 1, "morning tick writes one narrative per agent");
  assert.equal(morning.reflections, 0);
  const narratives = state
    .memoriesFor(AGENT_ID)
    .filter((record) => record.tags.includes("life-narrative"));
  assert.equal(narratives.length, 1, "elysia gets her narrative");
  assert.match(narratives[0].content, /玫瑰香/);

  clock = new Date(2026, 6, 26, 23, 0, 0);
  const night = await host.tickIfPeriodChanged();
  assert.ok(night);
  assert.equal(night.period, "night");
  assert.ok(night.narratives >= 1);
  assert.ok(night.reflections >= 1, "night tick runs the daily reflection");
  const reflections = state
    .memoriesFor(AGENT_ID)
    .filter((record) => record.kind === "reflection" && record.content.includes("多陪陪主人"));
  assert.equal(reflections.length, 1);
  assert.ok(llmCalls >= 3);
});
