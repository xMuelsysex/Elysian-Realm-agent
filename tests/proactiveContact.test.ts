// Proactive contact: the agent may open the conversation herself. The guards
// are deterministic and must hold without any model involvement, so most of
// these tests exercise the pure policy; the rest drive a full tick with a fake
// LLM to prove the message reaches the transcript and the unread flag.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmPort } from "../src/ports/ports.js";
import {
  buildProactiveMessages,
  decideProactiveMessage,
  runProactiveMessage,
  PROACTIVE_MAX_UNANSWERED,
  PROACTIVE_QUIET_HOURS,
  PROACTIVE_SKIP_TOKEN,
  PROACTIVE_TIER_INTERVALS_MS,
  type ProactiveMessageInput,
} from "../src/host/proactive.js";
import { createHostApiHandler } from "../src/host/hostApi.js";
import { RealmHost } from "../src/host/realmHost.js";
import { DEFAULT_REALM_CONFIG, RealmStateError, RealmStateStore } from "../src/host/realmState.js";

const AGENT_ID = "agent_elysia";
const PROFILE_ID = "user_master";
const HOUR = 3_600_000;

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "elysian-proactive-"));
}

/** Local wall-clock time: the quiet-hours guard works on local hours. */
function localTime(hour: number, minute = 0, day = 26): Date {
  return new Date(2026, 6, day, hour, minute, 0, 0);
}

function textLlm(content: string): LlmPort {
  return { name: "fake", model: "fake", completeChat: () => Promise.resolve({ content }) };
}

function messageInput(overrides: Partial<ProactiveMessageInput> = {}): ProactiveMessageInput {
  return {
    agentId: AGENT_ID,
    displayName: "爱莉希雅",
    persona: "粉色妖精小姐，语气轻盈亲昵。",
    participantName: "玄月",
    now: localTime(12).toISOString(),
    period: "day",
    locationId: "library",
    material: ["午餐后的图书馆很安静，我把喜欢的诗集又翻了一遍。"],
    ...overrides,
  };
}

// ── 确定性护栏 ──────────────────────────────────────────────────────────

test("proactive guard treats quiet hours as a hard constraint", () => {
  const base = { enabled: true, tier: "normal", unanswered: 0, hasMaterial: true } as const;

  const lateNight = decideProactiveMessage({ ...base, now: localTime(23) });
  assert.equal(lateNight.send, false);
  assert.equal(lateNight.reason, "quiet-hours");
  const resumes = new Date(lateNight.nextAllowedAt ?? "");
  assert.equal(resumes.getHours(), PROACTIVE_QUIET_HOURS[1], "quiet hours end at the configured hour");
  assert.ok(resumes.getTime() > localTime(23).getTime(), "the resume time is in the future");

  assert.equal(decideProactiveMessage({ ...base, now: localTime(7, 59) }).reason, "quiet-hours");
  assert.equal(decideProactiveMessage({ ...base, now: localTime(8) }).send, true);
});

test("proactive guard backs off exponentially while her message stays unanswered", () => {
  const now = localTime(12);
  const answered = { enabled: true, tier: "normal", hasMaterial: true } as const;

  const longAgo = new Date(now.getTime() - 25 * HOUR).toISOString();
  assert.equal(decideProactiveMessage({ ...answered, now, lastProactiveAt: longAgo, unanswered: 0 }).send, true);

  const recent = new Date(now.getTime() - 5 * HOUR).toISOString();
  const early = decideProactiveMessage({ ...answered, now, lastProactiveAt: recent, unanswered: 0 });
  assert.equal(early.reason, "backoff");
  assert.ok(
    Date.parse(early.nextAllowedAt ?? "") > now.getTime(),
    "a backoff verdict reports when the next check may speak",
  );

  // One unanswered message doubles the required gap, so the same 25h wait is
  // no longer enough.
  const doubled = decideProactiveMessage({ ...answered, now, lastProactiveAt: longAgo, unanswered: 1 });
  assert.equal(doubled.reason, "backoff");
  assert.equal(
    Date.parse(doubled.nextAllowedAt ?? ""),
    Date.parse(longAgo) + 2 * PROACTIVE_TIER_INTERVALS_MS.normal,
  );
});

test("proactive guard stops once she is waiting for an answer", () => {
  const now = localTime(12);
  const waiting = decideProactiveMessage({
    enabled: true,
    now,
    tier: "talkative",
    lastProactiveAt: new Date(now.getTime() - 400 * HOUR).toISOString(),
    unanswered: PROACTIVE_MAX_UNANSWERED,
    hasMaterial: true,
  });
  assert.equal(waiting.send, false);
  assert.equal(waiting.reason, "awaiting-reply");
  assert.equal(waiting.nextAllowedAt, undefined, "only an answer lifts this guard");
});

test("proactive guard needs material and an enabled agent", () => {
  const common = {
    now: localTime(12),
    tier: "normal",
    lastProactiveAt: new Date(localTime(12).getTime() - 400 * HOUR).toISOString(),
    unanswered: 0,
  } as const;
  assert.equal(decideProactiveMessage({ ...common, enabled: true, hasMaterial: false }).reason, "no-material");
  assert.equal(decideProactiveMessage({ ...common, enabled: false, hasMaterial: true }).reason, "disabled");
});

// ── 内容生成 ────────────────────────────────────────────────────────────

test("proactive prompt asks for first contact grounded in her own material", () => {
  const messages = buildProactiveMessages(
    messageInput({ recentMessages: ["上次说想给你读一首诗。"], relationship: "Bond: close." }),
  );
  assert.match(messages.system, /on her own initiative/);
  assert.match(messages.system, /first contact, not a reply/);
  assert.ok(messages.system.includes(PROACTIVE_SKIP_TOKEN), "the writer may decline");
  assert.match(messages.user, /- 午餐后的图书馆很安静/);
  assert.match(messages.user, /do not repeat/);
});

test("proactive writer rejects leaks, empty and overlong output", async () => {
  const input = messageInput();
  const ok = await runProactiveMessage(textLlm("主人，图书馆的诗集里有一句我想读给你听♪"), input);
  assert.ok("content" in ok);

  const declined = await runProactiveMessage(textLlm(PROACTIVE_SKIP_TOKEN), input);
  assert.ok("skipped" in declined);

  const leaked = await runProactiveMessage(textLlm("作为一个 AI 语言模型，我很高兴见到你。"), input);
  assert.ok("error" in leaked);
  assert.match(leaked.error, /ooc-leak/);

  const empty = await runProactiveMessage(textLlm("   "), input);
  assert.ok("error" in empty);

  const overlong = await runProactiveMessage(textLlm("好".repeat(400)), input);
  assert.ok("error" in overlong);
  assert.match(overlong.error, /exceeded/);
});

// ── tick 与宿主 ────────────────────────────────────────────────────────

function tickLlm(): LlmPort {
  return {
    name: "fake",
    model: "fake",
    completeChat(request) {
      const system = String(request.messages[0]?.content ?? "");
      if (system.includes("on her own initiative")) {
        return Promise.resolve({ content: "主人，图书馆的诗集里有一句我想读给你听♪" });
      }
      if (system.includes("JSON array")) {
        return Promise.resolve({ content: "[]" });
      }
      return Promise.resolve({ content: "花园里的风带着玫瑰香，我偷偷许了个愿♪" });
    },
  };
}

test("a tick lets her open the conversation, and answering clears it", async () => {
  const dir = tempDataDir();
  let clock = localTime(9);
  const state = new RealmStateStore(dir);
  const host = new RealmHost(state, () => undefined, { now: () => clock, llm: () => tickLlm() });

  const morning = await host.tickIfPeriodChanged();
  assert.ok(morning);
  assert.ok(morning.proactive >= 1, "she speaks up once the tick gave her something to say");

  const unread = state.unreadProactiveMessages(AGENT_ID);
  assert.equal(unread.length, 1);
  assert.match(unread[0].content, /诗集/);
  assert.equal(unread[0].trigger, "send");
  assert.equal(host.listAgents()[0]?.proactiveUnread, 1);

  // The message is also a transcript turn, so her next reply knows she said it.
  const turns = state.historyFor(AGENT_ID);
  assert.equal(turns.at(-1)?.role, "agent");
  assert.equal(turns.at(-1)?.content, unread[0].content);
  assert.equal(turns.at(-1)?.at, unread[0].createdAt);

  // Night: quiet hours keep her silent even with material and an LLM at hand.
  clock = localTime(23);
  const night = await host.tickIfPeriodChanged();
  assert.equal(night?.period, "night");
  assert.equal(night?.proactive, 0);

  // Answering clears the pending flag.
  assert.equal(host.markProactiveRead(AGENT_ID), 1);
  assert.equal(state.unreadProactiveMessages(AGENT_ID).length, 0);
  assert.equal(host.markProactiveRead(AGENT_ID), 0, "marking read twice changes nothing");
});

test("realm.json can switch self-initiated contact off per agent", async () => {
  const dir = tempDataDir();
  const config = {
    ...DEFAULT_REALM_CONFIG,
    agents: DEFAULT_REALM_CONFIG.agents.map((agent) => ({
      ...agent,
      proactive: { enabled: false, tier: "normal" as const },
    })),
  };
  const state = new RealmStateStore(dir, config);
  const host = new RealmHost(state, () => undefined, { now: () => localTime(9), llm: () => tickLlm() });

  const tick = await host.tickIfPeriodChanged();
  assert.equal(tick?.proactive, 0);
  assert.equal(state.proactiveMessages(AGENT_ID).length, 0);
  assert.equal(host.listAgents()[0]?.proactiveUnread, 0);
});

test("realm config rejects an unknown proactive tier", () => {
  const dir = tempDataDir();
  const broken = {
    ...DEFAULT_REALM_CONFIG,
    agents: [{ ...DEFAULT_REALM_CONFIG.agents[0], proactive: { enabled: true, tier: "loud" } }],
  };
  writeFileSync(join(dir, "realm.json"), JSON.stringify(broken));
  assert.throws(() => new RealmStateStore(dir), RealmStateError);

  const dir2 = tempDataDir();
  const nonBoolean = {
    ...DEFAULT_REALM_CONFIG,
    agents: [{ ...DEFAULT_REALM_CONFIG.agents[0], proactive: { enabled: "yes", tier: "normal" } }],
  };
  writeFileSync(join(dir2, "realm.json"), JSON.stringify(nonBoolean));
  assert.throws(() => new RealmStateStore(dir2), RealmStateError);
});

test("host api exposes the proactive channel, its guards and the read marker", async () => {
  const dir = tempDataDir();
  const state = new RealmStateStore(dir);
  const host = new RealmHost(state, () => undefined, { now: () => localTime(9), llm: () => tickLlm() });
  const handler = createHostApiHandler(host);

  await host.tickIfPeriodChanged();

  const view = await handler("GET", `/v1/host/proactive/${PROFILE_ID}/${AGENT_ID}`, undefined);
  assert.equal(view?.status, 200);
  const body = view !== undefined && "body" in view
    ? (view.body as {
        unread: Array<{ content: string }>;
        recent: Array<{ content: string }>;
        decision: { send: boolean; reason: string };
        profileId: string;
      })
    : undefined;
  assert.equal(body?.profileId, PROFILE_ID);
  assert.equal(body?.unread.length, 1);
  assert.equal(body?.recent.length, 1);
  assert.equal(body?.decision.send, false, "she just spoke, so the guard holds her back");
  assert.equal(body?.decision.reason, "backoff");

  const read = await handler("POST", "/v1/host/proactive/read", { agentId: AGENT_ID });
  assert.equal(read?.status, 200);
  assert.equal(
    read !== undefined && "body" in read ? (read.body as { cleared: number }).cleared : undefined,
    1,
  );

  assert.equal((await handler("POST", "/v1/host/proactive/read", {}))?.status, 400);
  assert.equal((await handler("GET", "/v1/host/proactive/profile-only", undefined))?.status, 400);
  assert.equal(
    (await handler("POST", "/v1/host/proactive/read", { agentId: "nope" }))?.status,
    400,
    "unknown agents are a client error",
  );
});

test("the proactive channel survives a restart", async () => {
  const dir = tempDataDir();
  const state = new RealmStateStore(dir);
  const host = new RealmHost(state, () => undefined, { now: () => localTime(9), llm: () => tickLlm() });
  await host.tickIfPeriodChanged();

  const reopened = new RealmStateStore(dir);
  const pending = reopened.unreadProactiveMessages(AGENT_ID);
  assert.equal(pending.length, 1);
  assert.match(pending[0].content, /诗集/);
  const stats = reopened.stats(localTime(9).toISOString());
  assert.equal(stats.agents.find((agent) => agent.agentId === AGENT_ID)?.unreadProactive, 1);
  assert.ok(stats.totals.unreadProactive >= 1);
});
