#!/usr/bin/env node
// 记忆系统核对：命中率、排序不变量、治理退役率、写入边界拒收率。
//
// 全部离线确定性；治理与写入边界走真实 RealmHost / RealmStateStore（不复制规则）。
// 先 `npm run build`，再 `node scripts/bench-memory.mjs`。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const { retrieveMemoryRecords } = await import(`${ROOT}/dist/memory/retrieval.js`);
const { InMemoryMemoryStore } = await import(`${ROOT}/dist/memory/inMemoryMemoryStore.js`);
const { RealmStateStore, MEMORY_STALE_DAYS, MEMORY_RETIRE_MIN_IMPORTANCE } = await import(
  `${ROOT}/dist/host/realmState.js`
);
const { RealmHost } = await import(`${ROOT}/dist/host/realmHost.js`);

const NOW = "2026-09-15T12:00:00.000Z";
const DAY = 86_400_000;
const AGENTS = ["agent_elysia", "agent_mobius"];
const metric = (key, fields) =>
  console.log(`METRIC ${key} ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")}`);
const pct = (part, whole) => (whole === 0 ? "n/a" : ((part / whole) * 100).toFixed(1));
const iso = (offsetDays) => new Date(Date.parse(NOW) - offsetDays * DAY).toISOString();

// --- 标注语料 ---------------------------------------------------------------
//
// 每条查询有唯一正确答案：只有目标记录含有该话题词（CJK 二元组），其余记录只共享
// 主题词。easy 子集里目标与干扰项同年龄同重要性；hard 子集里目标最旧、最不重要，
// 干扰项最新、最重要——用来暴露「相关性只占 50% 权重」的真实后果。

const THEME = ["花园", "晚霞", "约定", "实验室", "日志"];
const TOPIC_A = ["向日葵", "风铃草", "白桦林", "琉璃灯", "纸鸢", "银莲花", "旧怀表", "薄荷叶", "灰喜鹊", "琥珀石",
  "藤蔓架", "雨燕群", "陶土杯", "松脂香", "苔藓墙", "铜铃铛", "蓝雪花", "干花束", "竹编篮", "砂纸画"];
const TOPIC_B = ["花田", "小径", "书签", "夜灯", "纸鹤", "标本", "图谱", "笔记", "信箱", "橱柜"];
const topicOf = (index) => `${TOPIC_A[index % TOPIC_A.length]}${TOPIC_B[Math.floor(index / TOPIC_A.length)]}`;

const QUERY_COUNT = 200;
const DISTRACTORS_PER_QUERY = 3;

function record(id, agentId, content, { createdDaysAgo, importance, emotion, invalidAt, tags = [] }) {
  return {
    id,
    agentId,
    kind: "observation",
    content,
    createdAt: iso(createdDaysAgo),
    lastAccessedAt: iso(createdDaysAgo),
    importance,
    sourceIds: ["bench_seed"],
    relatedMemoryIds: [],
    visibility: "private",
    tags,
    ...(emotion !== undefined ? { emotion } : {}),
    ...(invalidAt !== undefined ? { invalidAt } : {}),
    metadata: {},
  };
}

function buildCorpus() {
  const records = [];
  const cases = [];
  for (let query = 0; query < QUERY_COUNT; query += 1) {
    const hard = query >= QUERY_COUNT / 2;
    const agentId = AGENTS[query % AGENTS.length];
    const theme = THEME[query % THEME.length];
    const topic = topicOf(query);
    const targetId = `target_${String(query).padStart(3, "0")}`;
    records.push(
      record(targetId, agentId, `${theme}里的${topic}，和主人一起看过了。`, {
        createdDaysAgo: hard ? 300 : 10,
        importance: hard ? 1 : 5,
        tags: [theme],
      }),
    );
    for (let d = 0; d < DISTRACTORS_PER_QUERY; d += 1) {
      records.push(
        record(`distractor_${query}_${d}`, agentId, `${theme}的记录，第 ${query}-${d} 次写下。`, {
          createdDaysAgo: hard ? 1 : 10,
          importance: hard ? 9 : 5,
          tags: [theme],
        }),
      );
    }
    // 另一个角色的同话题记录：绝不能被召回（档案/角色隔离）。
    const crossAgentId = AGENTS[(query + 1) % AGENTS.length];
    const crossId = `cross_${String(query).padStart(3, "0")}`;
    records.push(
      record(crossId, crossAgentId, `${theme}里的${topic}，是别人的记忆。`, {
        createdDaysAgo: 5,
        importance: 9,
      }),
    );
    cases.push({ query, hard, agentId, targetId, crossId, crossAgentId, text: `${theme} ${topic} 约定` });
  }
  return { records, cases };
}

const { records, cases } = buildCorpus();
console.log(`# 记忆系统核对 @ ${NOW}`);
metric("corpus", {
  records: records.length,
  queries: cases.length,
  agents: AGENTS.length,
  distractors_per_query: DISTRACTORS_PER_QUERY,
  easy_queries: cases.filter((entry) => !entry.hard).length,
  hard_queries: cases.filter((entry) => entry.hard).length,
});
console.log("");

// --- 1. 检索命中率 ----------------------------------------------------------

console.log("## 1. 检索命中率（唯一答案标注语料）");
for (const subset of ["easy", "hard"]) {
  const subsetCases = cases.filter((entry) => entry.hard === (subset === "hard"));
  const topK = 5;
  let hit1 = 0;
  let hit3 = 0;
  let hit5 = 0;
  let reciprocalRank = 0;
  let isolationViolations = 0;
  const latencies = [];
  for (const entry of subsetCases) {
    const start = performance.now();
    const result = retrieveMemoryRecords(records, entry.agentId, {
      text: entry.text,
      now: NOW,
      topK,
    });
    latencies.push(performance.now() - start);
    const ids = result.hits.map((hit) => hit.record.id);
    for (const hit of result.hits) {
      if (hit.record.agentId !== entry.agentId) isolationViolations += 1;
    }
    const rank = ids.indexOf(entry.targetId);
    if (rank === 0) hit1 += 1;
    if (rank >= 0 && rank < 3) hit3 += 1;
    if (rank >= 0) hit5 += 1;
    if (rank >= 0) reciprocalRank += 1 / (rank + 1);
  }
  latencies.sort((a, b) => a - b);
  const n = subsetCases.length;
  metric("memory_recall", {
    subset,
    queries: n,
    recall_at_1_pct: pct(hit1, n),
    recall_at_3_pct: pct(hit3, n),
    recall_at_5_pct: pct(hit5, n),
    mrr: (reciprocalRank / n).toFixed(3),
    agent_isolation_violations: isolationViolations,
    p50_ms: latencies[Math.floor(latencies.length / 2)].toFixed(3),
  });
}
console.log("");

// --- 1b. 命中率随目标记忆年龄 / 重要性衰减 -----------------------------------

console.log("## 1b. 唯一相关记忆的命中率衰减（干扰项始终为 1 天前、重要性 9）");
function recallAt1For({ targetAgeDays, targetImportance, queryCount = 60 }) {
  let hit = 0;
  for (let query = 0; query < queryCount; query += 1) {
    const topic = topicOf(query);
    const theme = THEME[query % THEME.length];
    const probe = [
      record("target", AGENTS[0], `${theme}里的${topic}，和主人一起看过了。`, {
        createdDaysAgo: targetAgeDays,
        importance: targetImportance,
      }),
      ...Array.from({ length: 3 }, (_, d) =>
        record(`distractor_${d}`, AGENTS[0], `${theme}的记录，第 ${d} 次写下。`, {
          createdDaysAgo: 1,
          importance: 9,
        }),
      ),
    ];
    const hits = retrieveMemoryRecords(probe, AGENTS[0], { text: `${theme} ${topic} 约定`, now: NOW, topK: 5 }).hits;
    if (hits[0]?.record.id === "target") hit += 1;
  }
  return (hit / queryCount) * 100;
}
for (const age of [1, 30, 90, 180, 365, 730]) {
  metric("recall_decay_by_age", {
    target_age_days: age,
    target_importance: 1,
    recall_at_1_pct: recallAt1For({ targetAgeDays: age, targetImportance: 1 }).toFixed(1),
  });
}
for (const importance of [1, 3, 5, 7, 9]) {
  metric("recall_decay_by_importance", {
    target_age_days: 300,
    target_importance: importance,
    recall_at_1_pct: recallAt1For({ targetAgeDays: 300, targetImportance: importance }).toFixed(1),
  });
}
console.log("");

// --- 2. 排序不变量 ----------------------------------------------------------

console.log("## 2. 排序不变量（同内容对照，全部必须成立）");
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  metric("invariant", { name, ok: ok ? "PASS" : "FAIL", detail });
}

// 2a 重要性优先：同内容同时间，importance 高的必须排前。
{
  const pair = [
    record("low", AGENTS[0], "花园里的向日葵开了。", { createdDaysAgo: 10, importance: 3 }),
    record("high", AGENTS[0], "花园里的向日葵开了。", { createdDaysAgo: 10, importance: 9 }),
  ];
  const hits = retrieveMemoryRecords(pair, AGENTS[0], { text: "向日葵 花园", now: NOW, topK: 2 }).hits;
  check("importance_ranks_higher_first", hits[0]?.record.id === "high", hits.map((h) => h.record.id).join(">"));
}

// 2b 时间优先：同内容同重要性，新的必须排前。
{
  const pair = [
    record("old", AGENTS[0], "花园里的向日葵开了。", { createdDaysAgo: 300, importance: 5 }),
    record("new", AGENTS[0], "花园里的向日葵开了。", { createdDaysAgo: 1, importance: 5 }),
  ];
  const hits = retrieveMemoryRecords(pair, AGENTS[0], { text: "向日葵 花园", now: NOW, topK: 2 }).hits;
  check("recency_ranks_newer_first", hits[0]?.record.id === "new", hits.map((h) => h.record.id).join(">"));
}

// 2c 失效记忆绝不召回，且诊断里写明原因。
{
  const store = new InMemoryMemoryStore([
    record("retired", AGENTS[0], "花园里的向日葵开了。", { createdDaysAgo: 5, importance: 9 }),
  ]);
  store.invalidate(AGENTS[0], ["retired"], NOW);
  const result = store.retrieve(AGENTS[0], { text: "向日葵 花园", now: NOW, topK: 5 });
  const excluded = result.diagnostics.excluded.find((entry) => entry.memoryId === "retired");
  check(
    "invalidated_never_recalled",
    result.hits.length === 0 && excluded?.reason === "invalidated",
    `hits=${result.hits.length} reason=${excluded?.reason}`,
  );
}

// 2d 跨角色隔离：同话题但属于另一个角色的记录，只能在 excluded 里看到。
{
  const probe = cases[0];
  const result = retrieveMemoryRecords(records, probe.agentId, { text: probe.text, now: NOW, topK: 5 });
  const excluded = result.diagnostics.excluded.find((entry) => entry.memoryId === probe.crossId);
  const inHits = result.hits.some((hit) => hit.record.id === probe.crossId);
  check(
    "cross_agent_records_excluded",
    !inHits && excluded?.reason === "different agentId",
    `in_hits=${inHits} reason=${excluded?.reason}`,
  );
}

// 2e 情绪一致性召回：id 排序与期望相反，所以命中变化只能来自 emotionBias。
{
  const build = () => [
    record("aaa_neutral", AGENTS[0], "花园里的向日葵开了。", { createdDaysAgo: 10, importance: 5 }),
    record("bbb_sad", AGENTS[0], "花园里的向日葵开了。", {
      createdDaysAgo: 10,
      importance: 5,
      emotion: { valence: -1, arousal: 1 },
    }),
    record("ccc_happy", AGENTS[0], "花园里的向日葵开了。", {
      createdDaysAgo: 10,
      importance: 5,
      emotion: { valence: 1, arousal: 1 },
    }),
  ];
  const bias = { valence: 1, arousal: 1 };
  const off = retrieveMemoryRecords(build(), AGENTS[0], { text: "向日葵 花园", now: NOW, topK: 3 }).hits;
  const on = retrieveMemoryRecords(build(), AGENTS[0], {
    text: "向日葵 花园",
    now: NOW,
    topK: 3,
    emotionBias: bias,
    weights: { relevance: 0.5, recency: 0.3, importance: 0.2, emotion: 0.6 },
  }).hits;
  check(
    "emotion_bias_promotes_congruent",
    off[0]?.record.id !== "ccc_happy" && on[0]?.record.id === "ccc_happy",
    `off=${off.map((h) => h.record.id).join(">")} on=${on.map((h) => h.record.id).join(">")}`,
  );
}

// 2f 记录被排除时诊断必须说明原因，不能默默丢。
{
  const result = retrieveMemoryRecords(records, AGENTS[0], { text: "向日葵花田 约定", now: NOW, topK: 5 });
  const reasons = new Set(result.diagnostics.excluded.map((entry) => entry.reason));
  check(
    "exclusions_are_diagnosed",
    result.diagnostics.excluded.length > 0 && [...reasons].every((reason) => reason === "different agentId"),
    `excluded=${result.diagnostics.excluded.length} reasons=${[...reasons].join("|")}`,
  );
}
console.log("");

// --- 2g 无重叠查询的返回行为（测量，非不变量） ------------------------------

console.log("## 2g 无重叠查询仍返回 topK（recency/importance 恒正，故无零分过滤）");
{
  const hits = retrieveMemoryRecords(records, AGENTS[0], { text: "完全无关的银河铁道", now: NOW, topK: 5 }).hits;
  metric("no_overlap_query", {
    top_k: 5,
    returned: hits.length,
    relevance_positive: hits.filter((hit) => hit.score.relevance > 0).length,
    final_score_p50: hits[Math.floor(hits.length / 2)]?.score.finalScore.toFixed(4) ?? "n/a",
    note: "lore 检索有零分过滤，记忆检索没有；分数分解已随命中返回，调用方可自行过滤",
  });
}
console.log("");

// --- 3. 治理退役率（真实 RealmHost.govern） ---------------------------------

console.log("## 3. 治理退役率（RealmHost.govern，dry run 先行）");
const dataDir = mkdtempSync(join(tmpdir(), "elysian-bench-govern-"));
try {
  const state = new RealmStateStore(dataDir);
  const agentId = state.config.agents[0].agentId;
  const staleBefore = iso(MEMORY_STALE_DAYS + 10);

  const writes = [
    // 期望退役：长期未用且重要性低。
    { kind: "observation", content: "很久以前的琐事。", createdAt: staleBefore, importance: MEMORY_RETIRE_MIN_IMPORTANCE - 1, sourceIds: [agentId], metadata: { source: "engine" } },
    { kind: "observation", content: "另一件旧琐事。", createdAt: staleBefore, importance: 1, sourceIds: [agentId], metadata: { source: "engine" } },
    // 期望保留：重要记忆永不退役。
    { kind: "observation", content: "很重要的事，一直记着。", createdAt: staleBefore, importance: MEMORY_RETIRE_MIN_IMPORTANCE, sourceIds: [agentId], metadata: { source: "engine" } },
    { kind: "observation", content: "最高重要性的约定。", createdAt: staleBefore, importance: 9, sourceIds: [agentId], metadata: { source: "engine" } },
    // 期望保留：虽然不重要，但最近用过。
    { kind: "observation", content: "今天刚想起的小事。", createdAt: NOW, importance: 1, sourceIds: [agentId], metadata: { source: "engine" } },
  ];
  const written = state.applyMemoryWrites(agentId, writes);

  // 期望退役：引擎模板（marker 形态与 legacy 形态）。
  const templateWrites = state.applyMemoryWrites(agentId, [
    { kind: "reflection", content: "引擎模板反思。", createdAt: NOW, importance: 5, sourceIds: [agentId], metadata: { reflectionSource: "deterministic" } },
    { kind: "plan", content: "引擎计划。", createdAt: NOW, importance: 5, sourceIds: [agentId], metadata: { source: "engine" } },
  ]);

  const host = new RealmHost(state, () => undefined, { now: () => new Date(NOW) });
  const before = state.memoriesFor(agentId).length;
  const dry = host.govern({ dryRun: true });
  const expectedStale = 2;
  const expectedTemplates = 2;

  metric("govern_dry_run", {
    candidates_stale: dry.candidates.stale,
    candidates_engine_templates: dry.candidates.engineTemplates,
    expected_stale: expectedStale,
    expected_engine_templates: expectedTemplates,
    changed_nothing: state.memoriesFor(agentId).length === before ? "yes" : "no",
  });

  const applied = host.govern({ dryRun: false });
  const retired = state.memoriesFor(agentId).filter((entry) => entry.invalidAt !== undefined);
  const keptImportant = state
    .memoriesFor(agentId)
    .filter((entry) => entry.invalidAt === undefined)
    .map((entry) => entry.content);

  metric("govern_applied", {
    invalidated_stale: applied.invalidated.stale,
    invalidated_engine_templates: applied.invalidated.engineTemplates,
    rows_deleted: state.memoriesFor(agentId).length === before ? 0 : before - state.memoriesFor(agentId).length,
    retire_rate_pct: pct(retired.length, before),
    important_kept: keptImportant.filter((content) => content.includes("很重要的事")).length,
    important_kept_expected: 1,
    template_records_retired: templateWrites.length,
  });

  const secondDry = host.govern({ dryRun: true });
  metric("govern_idempotent", {
    candidates_after_apply_stale: secondDry.candidates.stale,
    candidates_after_apply_templates: secondDry.candidates.engineTemplates,
  });
  metric("govern_retired_ids", {
    written_stale_retired: written.slice(0, 2).filter((entry) => state.memoriesFor(agentId).find((r) => r.id === entry.id)?.invalidAt !== undefined).length,
    written_kept_retired: written.slice(2).filter((entry) => state.memoriesFor(agentId).find((r) => r.id === entry.id)?.invalidAt !== undefined).length,
  });
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
console.log("");

// --- 4. 写入边界拒收率 ------------------------------------------------------

console.log("## 4. 记忆写入边界（RealmStateStore.applyMemoryWrites）");
const boundaryDir = mkdtempSync(join(tmpdir(), "elysian-bench-boundary-"));
try {
  const state = new RealmStateStore(boundaryDir);
  const agentId = state.config.agents[0].agentId;
  const marked = state.applyMemoryWrites(agentId, [
    { kind: "plan", content: "确定性计划的模板文本。", createdAt: NOW, importance: 5, sourceIds: [agentId], metadata: { engineDiagnostic: true } },
    { kind: "reflection", content: "另一条模板反思。", createdAt: NOW, importance: 5, sourceIds: [agentId], metadata: { engineDiagnostic: true } },
  ]);
  const unmarked = state.applyMemoryWrites(agentId, [
    { kind: "conversation", content: "主人今天说了很多话。", createdAt: NOW, importance: 5, sourceIds: [agentId], metadata: {} },
    { kind: "reflection", content: "引擎模板反思。", createdAt: NOW, importance: 5, sourceIds: [agentId], metadata: { reflectionSource: "deterministic" } },
    { kind: "plan", content: "引擎计划。", createdAt: NOW, importance: 5, sourceIds: [agentId], metadata: { source: "engine" } },
  ]);
  const stats = state.stats(NOW);
  metric("write_boundary", {
    marked_submitted: 2,
    marked_withheld: 2 - marked.length,
    marked_withheld_pct: pct(2 - marked.length, 2),
    unmarked_submitted: 3,
    unmarked_accepted: unmarked.length,
    stats_withheld_diagnostics: stats.totals.withheldDiagnostics,
    memories_after: state.memoriesFor(agentId).length,
    note: "engineDiagnostic 标记是写入边界的唯一执法点；reflectionSource/plan+engine 不在此拦截，由治理退役",
  });
} finally {
  rmSync(boundaryDir, { recursive: true, force: true });
}
console.log("");

const failed = checks.filter((entry) => !entry.ok);
console.log(`# 不变量：${checks.length - failed.length}/${checks.length} PASS${failed.length === 0 ? "" : ` — FAIL: ${failed.map((entry) => entry.name).join(", ")}`}`);
