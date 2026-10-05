# BM25 检索打分：补齐 IDF 与长度归一化

## 目标与决策

**目标**：把三处检索的匹配打分从朴素词元命中率升级为 BM25 加权，补齐 IDF（稀有词权重）与长度归一化（抑制长文档的天然优势）。

**影响文件**：

- `src/text/tokenize.ts` — 新增词频分词
- `src/text/bm25.ts` — 新增，共享打分实现
- `src/lore/loreRetrieval.ts` — `scoreLoreEntry`
- `src/memory/retrieval.ts` — text 通道
- `src/lore/loreDialogueRetrieval.ts` — `scoreScene`

**修复类型**：结构性问题。同一套「query token 对文档 token 的覆盖打分」在三处各自实现，提取为单一实现并升级算法。

**关键决策**：

1. 归一化基准取 `Σ_{t∈Q} IDF(t)`，语义是「文档长度等于语料平均长度、每个 query term 恰好出现一次」的理想分数。该点精确得 `1.0`；文档短于平均长度时长度因子大于 1（可能超过 1，clamp 到 1）；长于平均长度时小于 1。长度归一化因此对所有 term 生效，而非只在词频大于 1 时生效。
2. IDF 用 `ln(1 + (N - n + 0.5) / (n + 0.5))`，恒正，避免小语料（N=1 或 term 全覆盖）出现负 IDF。
3. `k1 = 1.2`、`b = 0.75`，BM25 标准默认值。作为算法常量导出，跟随 `DEFAULT_LORE_RETRIEVAL_TOP_K` 等既有模块常量约定，不引入新的参数文件机制。
4. 语料统计基于过滤后的可见集合（lore 的 `visible`、memory 的 `candidates`），因为排序只在该集合内进行。
5. memory 的 `tags` / `sourceIds` 通道保持集合重叠打分——离散标识符不是自然语言文本，BM25 的 IDF 与长度归一化不适用。
6. 保持 `scoreMemoryRecord(record, query)` 单文档签名不变，不破坏已导出 API。

**不可破坏的契约**（现有测试断言，改动后必须仍然成立）：

- `tests/lore.test.ts:101` — 无匹配条目的 score 精确等于 `0`
- `tests/lore.test.ts:203` — 文本完全相同的条目同分，按 code-unit 顺序 tie-break
- `tests/simulationAgentMemory.test.ts:317` — 完全相关记录的 `score.relevance` 精确等于 `1`
- `tests/simulationAgentMemory.test.ts:300` — 相同输入产出完全相同的 `candidateScores`（determinism）

## 计划

1. `src/text/tokenize.ts` 新增 `tokenizeFrequencies(): Map<string, number>`；`tokenizeText` 改为基于它返回 key 集合，对外行为不变。
2. 新增 `src/text/bm25.ts`：`buildCorpusStats`（N / avgdl / df）+ `scoreBm25`（归一化到 `[0,1]`）。
3. 三处检索接入，替换 `matches / queryTokens.size` 形式的覆盖打分。
4. 跑 `npm test`（含 build）与 `npm run typecheck`。

## 验证记录

补记于 2026-10-06（本次收尾验收在 HEAD `55465c4` 上重跑；工作区含并发任务 `2026-09-18-memory-bm25-stemming` 的加法）。

```bash
npm run typecheck   # tsc -p tsconfig.json --noEmit → 退出码 0（无输出）
npm test            # build + 测试编译 + node --test → ℹ tests 305 / ℹ pass 305 / ℹ fail 0
npm run bench       # bench.mjs + bench-memory.mjs → 排序不变量 6/6 PASS
npm run bench:locomo  # 10 对话 / 5,882 轮 / 1,982 问题 / 2,815 证据轮，0 次 LLM 调用
```

- LoCoMo 证据召回（当前代码实测；default / lexical-only 权重）：@1 17.9% / 24.9%、@5 29.5% / 40.9%、@10 34.6% / 47.5%、@20 41.8% / 56.0%；p50 6.3 ms / 6.7 ms。
- 合成语料（bench-memory，1,000 条记忆 / 200 查询）：easy recall@1 100%、hard recall@1 100%、MRR 1.000、排序不变量 6/6 PASS。
- 计划列出的四条契约断言仍成立（`tests/lore.test.ts` 无匹配零分、code-unit tie-break；`tests/simulationAgentMemory.test.ts` relevance 精确 1、determinism），随 305 全量测试通过。

## 结论

- 已落地：`src/text/tokenize.ts` 的 `tokenizeFrequencies`、`src/text/bm25.ts`（`buildCorpusStats` / `scoreBm25`，k1=1.2、b=0.75）、`src/lore/loreRetrieval.ts`（BM25 替换覆盖打分，零分过滤保留）、`src/memory/retrieval.ts`（文本通道接入共享 BM25；长度归一化实测关闭 b=0，该选项由并发任务 `2026-09-18-memory-bm25-stemming` 追加）。
- 遗留（计划中未实现）：`src/lore/loreDialogueRetrieval.ts` 的 `scoreScene` 未接入 BM25，仍是朴素覆盖率打分 `matched / queryTokens.size`——「三处检索接入」只完成两处。
