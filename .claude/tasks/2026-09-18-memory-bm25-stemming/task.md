# 记忆检索升级：BM25 多信号 + 英文词干归一化

## 目标与决策

**目标**：把记忆检索的文本通道从朴素词元覆盖率升级为 BM25（IDF + TF 饱和），并补上英文形态归一化，然后用公开 LoCoMo 与自有合成语料量出提升率。

**影响文件**：

- `src/text/tokenize.ts` — 新增 `tokenizeSearchFrequencies`（在既有词频分词上叠加英文词干）
- `src/text/bm25.ts` — `scoreBm25` 增加可选 `Bm25Options`（`k1` / `b`）
- `src/memory/retrieval.ts` — 文本通道接入共享 BM25；`MEMORY_BM25_OPTIONS = { b: 0 }`

**关键决策**：

1. **收敛到共享模块**：工作区里已有一个并发会话在做 `2026-09-18-bm25-retrieval`（新建 `src/text/bm25.ts`、`tokenizeFrequencies`，并已接入 `loreRetrieval`）。第一版我手写了内联 IDF 加权，属重复实现，已删除并改用该共享模块，保证 BM25 只有一处实现。
2. **记忆流的长度归一化关掉（b=0）**——这是测出来的，不是假设。扫描结果（LoCoMo 证据召回 @10，default / lexical-only 权重）：b=0 → 34.6 / 47.5；b=0.25 → 33.1 / 47.7；b=0.5 → 31.6 / 47.3；b=0.75 → 29.1 / 46.7。合成语料「唯一相关但既旧又不重要」的 recall@1：b=0 → 95%，b≥0.25 → 20%。原因：记忆流里最长的记录恰好是最具体的记录，长度惩罚压掉的正是值得召回的那些。TF 饱和与 IDF 保留。
3. **词干归一化**：`tokenizeSearchFrequencies` 在词频上叠加剥后缀形式（`researching` ↔ `research`），原文形式保留，所以字面命中永不掉分。这是纯词法检索里替代语义通道的最低成本手段——部署环境不连外网，Mem0 的 embedding 通道不可用。
4. **保持契约**：`score.relevance` 仍是 `[0,1]`，完全匹配仍精确等于 1（BM25 的归一化基准取「平均长度、每个 query term 恰好一次」的理想分，b=0 时该点恰为 1）；`tags` / `sourceIds` 通道仍用集合重叠——离散标识符不是自然语言，BM25 的 IDF 与长度归一化不适用；`scoreMemoryRecord(record, query)` 单文档签名不变。

## 计划

1. `src/text/tokenize.ts`：新增 `tokenizeSearchFrequencies`。
2. `src/text/bm25.ts`：`scoreBm25` 加可选 `k1` / `b`（默认值不变，lore 行为不受影响）。
3. `src/memory/retrieval.ts`：文本通道用 `tokenizeSearchFrequencies` + `buildCorpusStats` + `scoreBm25`，`b=0`。
4. 扫 b 取最优，再跑 typecheck / npm test / 三个基准。

## 验证记录

```bash
npm run typecheck   # ok
npm test            # 305/305 pass
node scripts/bench-locomo.mjs
node scripts/bench-memory.mjs   # 不变量 6/6 PASS
node scripts/bench.mjs
```

### LoCoMo 证据召回（公开数据集，10 对话 / 5,882 轮 / 1,982 问题 / 2,815 证据轮，0 次 LLM 调用）

| 配置 | recall@1 | @5 | @10 | @20 |
|---|---|---|---|---|
| 改造前 · default 权重 | 7.5% | 18.2% | 24.2% | 32.3% |
| **改造后 · default 权重** | **17.9%** | **29.5%** | **34.6%** | **41.8%** |
| 改造前 · 纯词法 | 15.5% | 28.3% | 34.2% | 41.0% |
| **改造后 · 纯词法** | **24.9%** | **40.9%** | **47.5%** | **56.0%** |

分类 recall@10（default / 纯词法，前 → 后）：multi-hop 9.4→15.3 / 14.6→26.1；temporal 34.7→49.9 / 48.0→60.5；open-domain 6.5→9.0 / 13.5→17.0；single-hop 35.9→47.0 / 49.0→61.6；adversarial 28.7→46.3 / 41.1→63.9。

### 合成唯一答案语料（1,000 条记忆 / 200 查询）

| 项 | 改造前 | 改造后 |
|---|---|---|
| recall@1 easy | 100% | 100% |
| recall@1 hard（目标最旧 + 重要性 1，干扰项 1 天 + 重要性 9） | 75% | **100%** |
| MRR hard | 0.750 | **1.000** |
| 命中率 vs 目标年龄（重要性固定 1） | 1 天 100%，30–730 天 75% | 1 天 100%，30–730 天 **95%** |
| 命中率 vs 目标重要性（年龄固定 300 天） | importance 1 → 75% | importance 1 → **95%**，≥3 → 100% |
| 排序不变量 | 6/6 PASS | 6/6 PASS |

### 性能与其它基准（无回归）

| 项 | 改造前 | 改造后 |
|---|---|---|
| 记忆检索 5k / 20k 条 | 43–47 / 191–209 ms | 46.1 / 200.9 ms（9.2–10.0 µs/条） |
| 角色可见投影 20k | 26.5–30.0 ms | 27.0 ms |
| 确定性 tick | 0.554–0.660 ms/tick、0 LLM、字节一致 | 0.510 ms/tick、1,962 tick/s、0 LLM、字节一致 |
| 角色保真度 | 100/100 | 100/100 |
| OOC 召回 / 正史留出集误报 | 14/14 / 2（0.011%） | 14/14 / 2（0.011%） |

## 结论

- 用「BM25（IDF + TF 饱和，长度归一化关闭）+ 英文词干归一化」替换朴素词元覆盖率，记忆检索的证据召回在公开 LoCoMo 上 **@1 提升 139%（7.5% → 17.9%）、@10 提升 43%（24.2% → 34.6%）**；自有语料上「唯一相关但旧且不重要」的记忆 recall@1 **从 75% 提到 100%**。
- 代价：无（延迟在噪声内，依赖数不变，305 测试与 6 条排序不变量全绿）。
- 未做：Mem0 的 embedding 语义通道（部署环境不连外网）；实体链接与图共现（multi-hop 仍是最弱分类，26.1%）。
- **并发写入风险**：本任务与另一会话的 `2026-09-18-bm25-retrieval` 在同一批文件上重叠，本任务已收敛到对方新建的 `src/text/bm25.ts` 并只做加法（可选参数 + 新导出函数），但对方任务仍未填写验证记录，后续若其继续改 `src/memory/retrieval.ts` 需要人工合并。
- 已沉淀为架构决策文档：`docs/adr/0002-memory-retrieval-bm25.md`（Status/Context/Decision/Consequences + 全部实测表）。
