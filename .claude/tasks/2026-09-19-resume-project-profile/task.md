# 简历项目经历：Elysian Realm 模拟智能体认知核心

## 目标与决策

- 目标：产出可直接粘贴进简历的「项目背景 + 技术栈 + 技术亮点 + 成果」，每条亮点附 `file:line` 证据。
- 决策：按 `repo2resume` skill 流程执行；四路并行只读深扫（架构 / 工程实践 / 性能算法 / 业务难点）后汇总。
- 决策：所有量化数字只用本仓库可复现命令产出的值；口径冲突的数字不取最好值，标注机器与命令。
- 决策：规模一律剔除生成语料 `src/lore/elysianRealmDialogue.ts`（169,167 行），手写源码口径为 16,179 行。

## 影响文件

- 无源码改动。产出为简历文本（交付在会话中），本文件记录证据与验证。

## 关键事实（实测）

- 手写 src 16,179 行 / 61 个 `.ts`（剔除 169,167 行生成语料后）；tests 8,691 行 / 35 个 `.test.ts`。
- 76 次提交，单一作者；`src/` 17 个模块；`package.json#exports` 5 个子路径，pi 只出现在 3 个文件。
- 剧情语料：608 个场景（605 available）、17,665 条台词、6 个章节、2 个篇章。
- 索引：`src/host/realmState.ts` 13 张 `CREATE TABLE`（全 STRICT）。

## 验证记录

命令与结果（2026-09-19，i7-13700H / Node v26.7.0）：

```bash
npm run typecheck   # tsc -p tsconfig.json --noEmit → 通过
npm test            # tests 305 / pass 305 / fail 0 / duration 1.04s（先 build，再编 .test-dist）
```

量化数据来源：

- LoCoMo 证据召回（`npm run bench:locomo`，10 对话 / 5,882 轮 / 1,982 带证据问题）：默认权重 recall@1/5/10/20 = 17.9 / 29.5 / 34.6 / 41.8%；纯词法 = 24.9 / 40.9 / 47.5 / 56.0%；p50 6.3–6.7 ms。经并行深扫独立重跑，与 `docs/adr/0002-memory-retrieval-bm25.md` 记录逐点一致。
- 检索标度（`npm run bench`）：9.65 / 10.64 / 13.25 / 12.76 µs per record（1k / 5k / 10k / 20k）；确定性 tick 0.592 ms/tick、1,689 tick/s、`llm_calls_per_tick=0`、`deterministic=true`。
- `b` 扫描结论（b=0 → LoCoMo@10 34.6%、合成语料 recall@1 95%；b=0.75 → 29.1% / 20%）由 `docs/adr/0002` 与 `src/memory/retrieval.ts:21-31` 双处记录；**仅 b=0 一点可由已提交脚本复现**，其余三点无复现入口。

## 证据来源（深扫发布物，可随时回读）

- 架构与设计：`agent://6830d010-6d34-44ed-bca0-698df5151f0a`
- 工程实践：`agent://36e1bf7c-d42e-4c91-8820-368df6f89217`
- 性能与优化：`agent://0d435928-96bd-4e9b-9db9-1c52ba59854c`
- 业务与难点：`agent://ffcfd09d-c8fe-44a9-b8e7-802127b40e54`

## 结论

- 交付：简历项目经历文本（见会话回复）。
- 遗留待确认：第三方 IP 与剧情文本来源是否可写入材料；目标岗位（决定亮点排序）；「定位到 per-turn O(n²) 热点」是否作为问题定位能力写入（该热点已定位未修复：每轮对话重建 `InMemoryMemoryStore`，其 ID 唯一性校验每次全量重建 Set，8,000 条实测构造 1,510 ms vs 同语料检索 55.9 ms）。
- 未做：对话历史 500 turns 裁剪与失效记录物理清理仍未执行，因此「记忆治理」只能表述为失效退役机制，不可写成已解决无界增长。
