#!/usr/bin/env node
// LoCoMo 证据检索核对：在公开数据集上测「记忆检索能否把标注的证据轮捞出来」。
//
// 与 Mem0 / Zep 的 LoCoMo 分数不是同一个量：它们报的是 LLM-as-Judge 问答准确率
// （检索 + 模型推理 + 裁判），这里只测纯检索的证据召回，全程 0 次 LLM 调用，
// 所以数字可直接归因到检索器本身。
//
// 数据来自 https://github.com/snap-research/locomo（locomo10.json，约 2.7 MB），
// 缺省缓存在 .bench-data/ 下（不入库）；首次运行会下载一次。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DATA_DIR = `${ROOT}/.bench-data`;
const DATA_PATH = `${DATA_DIR}/locomo10.json`;
const SOURCE_URL = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";

const { retrieveMemoryRecords } = await import(`${ROOT}/dist/memory/retrieval.js`);

const metric = (key, fields) =>
  console.log(`METRIC ${key} ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")}`);
const pct = (part, whole) => (whole === 0 ? "n/a" : ((part / whole) * 100).toFixed(1));

if (!existsSync(DATA_PATH)) {
  mkdirSync(DATA_DIR, { recursive: true });
  console.log(`# 下载 LoCoMo 数据集 → ${DATA_PATH}`);
  const response = await fetch(SOURCE_URL);
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status} ${SOURCE_URL}`);
  writeFileSync(DATA_PATH, Buffer.from(await response.arrayBuffer()));
}
const dataset = JSON.parse(readFileSync(DATA_PATH, "utf8"));

const CATEGORY_NAMES = { 1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop", 5: "adversarial" };
const TOP_K = 20;
const K_SWEEP = [1, 5, 10, 20];

// 每种权重配置各跑一遍：默认权重（相关性 0.5 / 时间 0.3 / 重要性 0.2）与纯词法（相关性 1.0）。
const CONFIGS = [
  { name: "default", weights: undefined },
  { name: "lexical_only", weights: { relevance: 1, recency: 0, importance: 0 } },
];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** LoCoMo 的会话时间形如 "1:56 pm on 8 May, 2023"，Date 解析不了。 */
function parseSessionTime(value) {
  const match = /^(\d{1,2}):(\d{2}) (am|pm) on (\d{1,2}) ([A-Za-z]+), (\d{4})$/.exec(value);
  if (match === null) throw new Error(`无法解析会话时间：${value}`);
  const [, hour, minute, meridiem, day, monthName, year] = match;
  const hour24 = (Number(hour) % 12) + (meridiem === "pm" ? 12 : 0);
  return new Date(Date.UTC(Number(year), MONTHS.indexOf(monthName), Number(day), hour24, Number(minute))).toISOString();
}

function buildRecords(conversation, agentId) {
  const records = [];
  const turnsById = new Map();
  for (const [key, value] of Object.entries(conversation)) {
    const match = /^session_(\d+)$/.exec(key);
    if (match === null) continue;
    const sessionNumber = match[1];
    const at = parseSessionTime(conversation[`session_${sessionNumber}_date_time`]);
    for (const turn of Object.values(value)) {
      if (typeof turn !== "object" || turn === null || typeof turn.dia_id !== "string") continue;
      const record = {
        id: turn.dia_id,
        agentId,
        kind: "conversation",
        content: `${turn.speaker}: ${turn.text}`,
        createdAt: at,
        lastAccessedAt: at,
        importance: 5,
        sourceIds: ["locomo"],
        relatedMemoryIds: [],
        visibility: "private",
        tags: [],
        metadata: {},
      };
      records.push(record);
      turnsById.set(turn.dia_id, record);
    }
  }
  if (turnsById.size === 0) throw new Error("会话里没有任何带 dia_id 的轮次");
  return { records, turnsById };
}

console.log("# LoCoMo 证据检索核对（纯检索，0 次 LLM 调用）");
console.log(`# 数据：${DATA_PATH}`);

const perConfig = new Map(CONFIGS.map((config) => [config.name, { hits: new Map(), total: new Map(), latencies: [] }]));
let totalTurns = 0;
let totalQueries = 0;

for (const sample of dataset) {
  const agentId = `locomo_${sample.sample_id}`;
  const { records } = buildRecords(sample.conversation, agentId);
  totalTurns += records.length;
  const lastAt = records.reduce((max, record) => (record.createdAt > max ? record.createdAt : max), records[0].createdAt);
  const now = new Date(Date.parse(lastAt) + 86_400_000).toISOString();

  for (const qa of sample.qa) {
    if (!Array.isArray(qa.evidence) || qa.evidence.length === 0) continue;
    totalQueries += 1;
    for (const config of CONFIGS) {
      const bucket = perConfig.get(config.name);
      const start = performance.now();
      const result = retrieveMemoryRecords(records, agentId, {
        text: qa.question,
        now,
        topK: TOP_K,
        ...(config.weights !== undefined ? { weights: config.weights } : {}),
      });
      bucket.latencies.push(performance.now() - start);
      const returned = result.hits.map((hit) => hit.record.id);
      for (const k of K_SWEEP) {
        const top = new Set(returned.slice(0, k));
        const found = qa.evidence.filter((id) => top.has(id)).length;
        bucket.hits.set(`${qa.category}:${k}`, (bucket.hits.get(`${qa.category}:${k}`) ?? 0) + found);
      }
      for (const id of qa.evidence) {
        bucket.total.set(qa.category, (bucket.total.get(qa.category) ?? 0) + 1);
        bucket.total.set("all", (bucket.total.get("all") ?? 0) + 1);
      }
    }
  }
}

metric("locomo_corpus", {
  conversations: dataset.length,
  turns: totalTurns,
  queries_with_evidence: totalQueries,
  evidence_turns: perConfig.get("default").total.get("all"),
  max_top_k: TOP_K,
});

for (const config of CONFIGS) {
  const bucket = perConfig.get(config.name);
  bucket.latencies.sort((a, b) => a - b);
  const total = bucket.total.get("all");
  metric("locomo_latency", {
    config: config.name,
    p50_ms: bucket.latencies[Math.floor(bucket.latencies.length / 2)].toFixed(3),
  });
  for (const k of K_SWEEP) {
    const found = [...bucket.hits.entries()]
      .filter(([key]) => key.endsWith(`:${k}`))
      .reduce((sum, [, value]) => sum + value, 0);
    metric("locomo_evidence_recall", {
      config: config.name,
      weights: config.weights === undefined ? "0.5/0.3/0.2" : "1/0/0",
      k,
      evidence_found: found,
      evidence_total: total,
      recall_pct: pct(found, total),
    });
  }
  for (const category of Object.keys(CATEGORY_NAMES)) {
    const key = Number(category);
    if (!bucket.total.has(key)) continue;
    metric("locomo_recall_by_category", {
      config: config.name,
      category: key,
      name: CATEGORY_NAMES[category],
      recall_at_10_pct: pct(bucket.hits.get(`${key}:10`), bucket.total.get(key)),
      evidence_turns: bucket.total.get(key),
    });
  }
}
