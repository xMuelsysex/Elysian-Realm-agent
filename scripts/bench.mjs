#!/usr/bin/env node
// 离线基准：当前代码的真实延迟、吞吐、保真度与 OOC 误报率。
//
// 只读 dist/ 与固定场景数据（.auto/fidelity-scenarios.json、tests/oocGuard.test.ts
// 的标注样本、正史语料）；不启动进程、不访问网络、不写任何状态。
// 先 `npm run build` 保证 dist 新鲜，再 `node scripts/bench.mjs`。
//
// 输出 METRIC 行，便于 grep 与存档。

import { readFileSync, existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { cpus, platform, arch, release } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
if (!existsSync(`${ROOT}/dist/index.js`)) {
  console.error("dist/ 不存在，先运行 npm run build");
  process.exit(1);
}

const NOW = "2026-09-15T12:00:00.000Z";

const { InMemoryMemoryStore } = await import(`${ROOT}/dist/memory/inMemoryMemoryStore.js`);
const { retrieveMemoryRecords } = await import(`${ROOT}/dist/memory/retrieval.js`);
const { isCharacterVisibleMemory } = await import(`${ROOT}/dist/conversation/oocGuard.js`);
const { detectOocLeak } = await import(`${ROOT}/dist/conversation/oocGuard.js`);
const { buildConversationSystemPrompt } = await import(`${ROOT}/dist/conversation/conversationPrompt.js`);
const { buildLifeNarrativeMessages } = await import(`${ROOT}/dist/host/lifeNarrative.js`);
const { buildReflectionMessages } = await import(`${ROOT}/dist/reflection/llmReflectionPlanner.js`);
const { retrieveLoreDialogue } = await import(`${ROOT}/dist/lore/loreDialogueRetrieval.js`);
const { retrieveLoreEntries } = await import(`${ROOT}/dist/lore/loreRetrieval.js`);
const { ELYSIAN_REALM_CANON } = await import(`${ROOT}/dist/lore/elysianRealmCanon.js`);
const { ELYSIAN_REALM_DIALOGUE } = await import(`${ROOT}/dist/lore/elysianRealmDialogue.js`);
const { dialogueSpeakerAliases } = await import(`${ROOT}/dist/lore/loreDialogueRecords.js`);
const { runCognitiveTickSync } = await import(`${ROOT}/dist/loop/cognitiveLoop.js`);

// --- 计时工具 ---------------------------------------------------------------

function measure(fn, { warmup = 3, iters = 30 } = {}) {
  for (let i = 0; i < warmup; i += 1) fn(i);
  const samples = [];
  for (let i = 0; i < iters; i += 1) {
    const start = performance.now();
    fn(i);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const pick = (q) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
  return {
    p50: pick(0.5),
    p95: pick(0.95),
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    iters,
  };
}

const ms = (value) => value.toFixed(3);
const metric = (key, fields) =>
  console.log(`METRIC ${key} ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")}`);

// --- 环境 -------------------------------------------------------------------

console.log(`# Elysian Realm Agent 基准 @ ${NOW}`);
metric("env", {
  node: process.version,
  platform: platform(),
  arch: arch(),
  kernel: release(),
  cpu: cpus()[0]?.model?.trim().replace(/\s+/g, "_") ?? "unknown",
  cores: cpus().length,
});
console.log("");

// --- 1. 记忆检索：延迟 vs 规模 ----------------------------------------------

const MEMORY_TEXTS = [
  "今天在花园里看晚霞，和主人约定明天再一起来",
  "梅比乌斯在实验室核对逐火之蛾的日志，语气比平时软",
  "主人说最近工作很累，我给他倒了一杯温水",
  "日记：把今天的事写下来，免得以后忘了",
  "主人第一次叫我的名字，声音很轻",
];

function makeRecords(size) {
  return Array.from({ length: size }, (_, i) => ({
    id: `memory_${String(i).padStart(6, "0")}`,
    agentId: "agent_elysia",
    kind: "observation",
    content: `${MEMORY_TEXTS[i % MEMORY_TEXTS.length]}（第 ${i} 次记录）`,
    createdAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 3600_000).toISOString(),
    lastAccessedAt: NOW,
    importance: (i % 9) + 1,
    sourceIds: [],
    relatedMemoryIds: [],
    visibility: "private",
    tags: ["tick", `day-${i % 30}`],
    metadata: {},
  }));
}

console.log("## 1. 记忆检索延迟 vs 规模（retrieveMemoryRecords，纯排序评分核心）");
const memoryQuery = { text: "花园 晚霞 约定 主人", now: NOW, topK: 5 };
for (const size of [100, 1_000, 5_000, 10_000, 20_000]) {
  const records = makeRecords(size);
  const iters = size >= 10_000 ? 20 : 30;
  const stats = measure(() => retrieveMemoryRecords(records, "agent_elysia", memoryQuery), { iters });
  metric("memory_retrieval", {
    n: size,
    p50_ms: ms(stats.p50),
    p95_ms: ms(stats.p95),
    us_per_record: (stats.p50 * 1000 / size).toFixed(2),
    iters: stats.iters,
  });
}
console.log("");

// --- 2. 角色可见投影：延迟 vs 规模 ------------------------------------------

console.log("## 2. 角色可见记忆投影延迟 vs 规模（isCharacterVisibleMemory 全量线性扫描）");
for (const size of [1_000, 5_000, 10_000, 20_000]) {
  const records = makeRecords(size);
  const stats = measure(() => records.filter(isCharacterVisibleMemory), {
    warmup: 2,
    iters: size >= 10_000 ? 20 : 30,
  });
  metric("visibility_projection", {
    n: size,
    p50_ms: ms(stats.p50),
    p95_ms: ms(stats.p95),
    us_per_record: (stats.p50 * 1000 / size).toFixed(2),
  });
}
console.log("");

// --- 3. 正史语料规模与台词检索延迟 ------------------------------------------

const scenes = ELYSIAN_REALM_DIALOGUE.scenes;
const allLines = scenes.flatMap((scene) => scene.stages.flatMap((stage) => stage.lines));
const dialogueLines = allLines.filter((line) => line.kind === "dialogue");
const maxOrder = Math.max(...scenes.map((scene) => scene.order));

console.log("## 3. 正史语料规模");
metric("lore_corpus", {
  arcs: ELYSIAN_REALM_DIALOGUE.arcs.length,
  chapters: ELYSIAN_REALM_DIALOGUE.chapters.length,
  scenes: scenes.length,
  available_scenes: scenes.filter((scene) => scene.available).length,
  stages: scenes.reduce((sum, scene) => sum + scene.stages.length, 0),
  lines: allLines.length,
  dialogue_lines: dialogueLines.length,
  canon_entries: ELYSIAN_REALM_CANON.length,
});

const aliases = dialogueSpeakerAliases("爱莉希雅", "elysia");
const dialogueInput = {
  cursor: maxOrder + 1,
  speakerAliases: aliases,
  text: "晚霞 花园 约定 逐火之蛾",
  topK: 3,
};
const dialogueStats = measure(() => retrieveLoreDialogue(ELYSIAN_REALM_DIALOGUE, dialogueInput), {
  warmup: 2,
  iters: 20,
});
const dialogueHits = retrieveLoreDialogue(ELYSIAN_REALM_DIALOGUE, dialogueInput);
metric("dialogue_retrieval", {
  scenes_scanned: scenes.filter((scene) => scene.available && scene.order < dialogueInput.cursor).length,
  p50_ms: ms(dialogueStats.p50),
  p95_ms: ms(dialogueStats.p95),
  hits: dialogueHits.hits.length,
  hit_lines: dialogueHits.hits.reduce((sum, hit) => sum + hit.lines.length, 0),
});

const canonQuery = { agentId: "agent_elysia", text: "爱莉希雅 往世乐土 逐火十三英桀", topK: 4 };
const canonStats = measure(() => retrieveLoreEntries(ELYSIAN_REALM_CANON, canonQuery), { iters: 200 });
metric("canon_retrieval", {
  entries: ELYSIAN_REALM_CANON.length,
  p50_ms: ms(canonStats.p50),
  p95_ms: ms(canonStats.p95),
  hits: retrieveLoreEntries(ELYSIAN_REALM_CANON, canonQuery).hits.length,
});
console.log("");

// --- 4. Prompt 组装：延迟与体积（成本代理） ---------------------------------

const scenarios = JSON.parse(readFileSync(`${ROOT}/.auto/fidelity-scenarios.json`, "utf8"));

function renderPrompt(scenario) {
  switch (scenario.kind ?? "conversation") {
    case "narrative": {
      const { system, user } = buildLifeNarrativeMessages(scenario.input);
      return `${system}\n${user}`;
    }
    case "reflection": {
      const { system, user } = buildReflectionMessages(scenario.input, scenario.maxInsights ?? 3, scenario.options ?? {});
      return `${system}\n${user}`;
    }
    default:
      return buildConversationSystemPrompt(scenario.input);
  }
}

console.log("## 4. Prompt 组装延迟与体积（10 个固定场景：对话 8 / 叙事 1 / 反思 1）");
const promptStats = measure((i) => renderPrompt(scenarios[i % scenarios.length]), {
  warmup: 2,
  iters: 100,
});
let promptBytes = 0;
let promptChars = 0;
let elementTotal = 0;
let elementEarned = 0;
for (const scenario of scenarios) {
  const prompt = renderPrompt(scenario);
  promptBytes += Buffer.byteLength(prompt, "utf8");
  promptChars += prompt.length;
  for (const element of scenario.elements) {
    elementTotal += element.weight;
    if (prompt.includes(element.needle)) elementEarned += element.weight;
  }
}
// 中英混排的粗略估算：1 token ≈ 1.7 字符（CJK 偏 1.5，ASCII 偏 4）。仅作量级参考。
metric("prompt_assembly", {
  scenarios: scenarios.length,
  p50_ms: ms(promptStats.p50),
  p95_ms: ms(promptStats.p95),
  total_bytes: promptBytes,
  avg_bytes: Math.round(promptBytes / scenarios.length),
  avg_chars: Math.round(promptChars / scenarios.length),
  avg_tokens_est: Math.round(promptChars / scenarios.length / 1.7),
});
const fidelity = elementTotal === 0 ? 0 : Math.round((elementEarned / elementTotal) * 100);
metric("character_fidelity", {
  score: fidelity,
  elements: elementTotal,
  earned: elementEarned,
});
console.log("");

// --- 5. OOC 检测：召回（标注正例）+ 误报（正史台词，未参与调参） ------------

console.log("## 5. OOC 检测准确率与吞吐");
const oocTestSource = readFileSync(`${ROOT}/tests/oocGuard.test.ts`, "utf8");
const casePattern = /detectOocLeak\(\s*("(?:[^"\\]|\\.)*")\s*\)\s*,\s*(undefined|"(?:[^"\\]|\\.)*")\s*\)/g;
const labeled = [];
for (const match of oocTestSource.matchAll(casePattern)) {
  const reply = JSON.parse(match[1]);
  const expected = match[2] === "undefined" ? undefined : JSON.parse(match[2]);
  labeled.push({ reply, expected });
}
const positives = labeled.filter((entry) => entry.expected !== undefined);
const tunedNegatives = labeled.filter((entry) => entry.expected === undefined);

const truePositive = positives.filter((entry) => detectOocLeak(entry.reply) !== undefined).length;
const tunedFalsePositive = tunedNegatives.filter((entry) => detectOocLeak(entry.reply) !== undefined).length;

// 正史台词是检测器从未见过、且必然是角色本人的话——用它测误报率。
const corpusFalsePositives = dialogueLines.filter((line) => detectOocLeak(line.text) !== undefined);
const sampleFalsePositives = corpusFalsePositives
  .slice(0, 5)
  .map((line) => `${detectOocLeak(line.text)} :: ${line.text.slice(0, 36)}`);

metric("ooc_recall", {
  labeled_positives: positives.length,
  detected: truePositive,
  recall_pct: positives.length === 0 ? "n/a" : ((truePositive / positives.length) * 100).toFixed(1),
});
metric("ooc_false_positive", {
  tuned_negatives: tunedNegatives.length,
  tuned_fp: tunedFalsePositive,
  heldout_corpus_lines: dialogueLines.length,
  heldout_fp: corpusFalsePositives.length,
  heldout_fp_pct: ((corpusFalsePositives.length / dialogueLines.length) * 100).toFixed(3),
});
if (sampleFalsePositives.length > 0) {
  console.log(`METRIC ooc_false_positive_samples ${JSON.stringify(sampleFalsePositives)}`);
}

const oocThroughput = measure(() => {
  for (const line of dialogueLines.slice(0, 500)) detectOocLeak(line.text);
}, { warmup: 1, iters: 10 });
metric("ooc_throughput", {
  lines_per_sec: Math.round(500 / (oocThroughput.p50 / 1000)),
  us_per_line: ((oocThroughput.p50 * 1000) / 500).toFixed(2),
});
console.log("");

// --- 6. 确定性 tick：吞吐与可复现性 ----------------------------------------

console.log("## 6. 确定性 tick 吞吐与可复现性（runCognitiveTickSync，无 LLM）");
const TICK_AGENTS = 2;
const TICK_ROUNDS = 200;

function buildTickDeps() {
  const store = new InMemoryMemoryStore();
  for (let i = 0; i < 200; i += 1) {
    store.remember("agent_elysia", {
      kind: "observation",
      content: MEMORY_TEXTS[i % MEMORY_TEXTS.length],
      createdAt: new Date(Date.parse("2026-08-01T00:00:00.000Z") + i * 3600_000).toISOString(),
      importance: 5,
      sourceIds: ["bench_seed"],
      relatedMemoryIds: [],
      visibility: "private",
      tags: ["tick"],
      metadata: {},
    });
  }
  const proposals = [];
  return {
    deps: {
      perception: { perceive: (agentId, now) => ({ agentId, now, mood: agentId === "agent_elysia" ? "cheerful" : "focused" }) },
      memory: store.toPort(),
      planning: {
        plan: ({ agentId, perception }) => ({
          source: "deterministic",
          reason: `routine for ${perception.mood}`,
          proposal: { agentId, action: "tend_garden" },
        }),
      },
      actionSink: { submit: (_agentId, proposal) => proposals.push(proposal) },
      buildMemoryQuery: () => ({ text: "花园 晚霞 约定", now: NOW, topK: 5 }),
      buildMemoryWrite: (perception) => ({
        kind: "observation",
        content: `tick at ${perception.now}`,
        createdAt: perception.now,
        importance: 4,
        sourceIds: ["bench_tick"],
        relatedMemoryIds: [],
        visibility: "private",
        tags: ["tick"],
        metadata: {},
      }),
    },
    proposals,
  };
}

const tickA = buildTickDeps();
const tickStats = measure((round) => {
  for (let agent = 0; agent < TICK_AGENTS; agent += 1) {
    runCognitiveTickSync(`agent_${agent}`, new Date(Date.parse(NOW) + round * 60_000).toISOString(), tickA.deps);
  }
}, { warmup: 3, iters: TICK_ROUNDS });

// 同一输入跑两遍，比较完整结果的字节序列。
function runBatch() {
  const { deps, proposals } = buildTickDeps();
  const results = [];
  for (let round = 0; round < 20; round += 1) {
    for (let agent = 0; agent < TICK_AGENTS; agent += 1) {
      results.push(runCognitiveTickSync(`agent_${agent}`, new Date(Date.parse(NOW) + round * 60_000).toISOString(), deps));
    }
  }
  return JSON.stringify({ results, proposals });
}
const firstRun = runBatch();
const secondRun = runBatch();

metric("tick", {
  agents: TICK_AGENTS,
  rounds: TICK_ROUNDS,
  ticks: TICK_AGENTS * TICK_ROUNDS,
  p50_ms: ms(tickStats.p50),
  p95_ms: ms(tickStats.p95),
  ms_per_tick: (tickStats.p50 / TICK_AGENTS).toFixed(3),
  ticks_per_sec: Math.round((TICK_AGENTS * 1000) / tickStats.p50),
  llm_calls_per_tick: 0,
  deterministic: firstRun === secondRun,
  bytes_per_batch: Buffer.byteLength(firstRun, "utf8"),
});
console.log("");
console.log("# 完成");
