# 收尾战：累积提交 + 真治理 + O(n²) 修复

## 目标与决策

- 把工作区累积约两周的改动落库，并收尾三项已知缺口：O(n²) 热点、从未执行过的记忆治理、仓库卫生与文档漂移。
- 提交不包含 `realm-data/`（已在 `.gitignore`）。所有量化数字均取本次实测，不取记忆中的旧值。
- 本记录由收尾 agent 按简报汇总；以下实测结果为简报提供的观测，不冒充本次文档整理重新执行的验证。不确定的事实写「待补」。

## 计划

1. 按主题把累积改动切成 5 个提交。
2. 对活库执行一次真记忆治理：先备份、dry-run、再 apply。
3. 消除 `InMemoryMemoryStore` 构造/插入的 O(n²)。
4. 修正文档漂移与仓库卫生；补齐 README 依赖节漏网的版本号，将 `pinned exactly to ` 后的 `0.82.1` 改为 `0.84.1`，其余句式不变。
5. 对提交态跑帧级 e2e + 独立对抗验证。

### 实际提交

以下提交已落库，HEAD 链线性；前 5 个为累积工作提交，随后为性能修复与文档修正：

- `551d8c6` 记忆检索升级：共享 BM25 + 英文词干归一化，新增基准脚本与 ADR（12 文件 +1498/-30）。
- `3e92268` 主动联系 + 记忆失效治理：她先开口、失效优于删除、引擎诊断退出记忆流（17 文件 +1722/-49）。
- `764beaf` OOC 防线：基准暴露的指令覆盖误判修复 + 失效记忆纳入角色可见投影（2 文件 +28/-6）。
- `6346890` docs: 架构总览图（自包含 HTML + 视觉回归凭据）与任务留痕（11 文件 +15961）。
- `55465c4` chore: 忽略本地工具与实验产物（`.gitignore` +6）。
- `e222b24` 性能：InMemoryMemoryStore 插入改为常量时间 ID 集合，消除构造 O(n²)（1 文件 +6/-3）。
- `4ff7144` docs: 修正 pi 版本/自我认知/记忆治理/tick LLM 四处文档漂移，补 bm25-retrieval 验证记录（5 文件 +18/-6）。

## 验证记录

归档日期：2026-10-05。简报未逐项提供具体测量日期，待补；性能探针机器与运行时为 i7-13700H / Node v24.14.1，其余验证的机器信息待补，不由性能探针配置外推。

1. **类型检查与单测**：提交前后 `npm run typecheck` 均无错；`npm test` 提交前后均 **305 pass / fail 0**。
2. **帧级 e2e**：在独立 git worktree 中跑 `npm run verify:e2e`，使用本地 OpenAI 兼容 stub。指标为 `METRIC sse_first_delta_ms=15` / `sse_total_ms=637` / `sse_frames=4`。PASS 项包括：
   - SSE 帧序列与 content-type；`applied` 携带终态（affinity=3 mood=开心 analysis=llm）。
   - history 持久化 2 轮、relationship history 1 行；conversation emotion 把 affect 推到 0.39。
   - 夜间循环持久化 6 条记忆且 4 条模板被 withheld；proactive 守卫回答 quiet-hours。
   - `govern` 默认 dry-run 并在显式请求时落库；反思接缝返回证据引用；json 回退。
   - 第二个角色（梅比乌斯）可列且对话可持久化。
3. **真记忆治理**：活库 46 条中 **20 条引擎模板记录被失效**（`invalid_at` 打戳；`superseded_by` 全 NULL）。失效不是删除：行数 46 不变，与备份对比 id 集合 diff 为空，`id|content` 拼接哈希一致；备份路径为 `/tmp/realm-govern-backup-1791220907`。
   - 端点侧 `/v1/host/stats` 的 `totals.invalidatedMemories` 0→20（elysia 12 + mobius 8），`totals.memories` 不变。
   - 一次性探针使用只读库与 `dist/memory/retrieval.js` 公共路径：20/20 失效记录命中 `diagnostics.excluded` 且 `reason="invalidated"`，0 泄漏；26 条未失效记录 26/26 可召回。
   - 二次 dry-run 候选归零（幂等）。
4. **O(n²) 修复前后**：独立探针，warmup 2 + 7 次取 p50，i7-13700H / Node v24.14.1。
   - construct n=8000：**1472.1 ms → 6.8 ms**；insert n=8000：**1450.5 ms → 4.8 ms**。
   - 旧版 `us_per_record` 随 n 翻倍上升（18.5→38.2→78.4→184.0），新版恒定在 0.6–1.3。
   - 真实 per-turn 路径（重建 store + 一次完整 retrieve）n=8000：**1514.2 ms → 67.4 ms**；新旧完整返回结果 deepEqual（含分数、诊断与 touched 记录）。
5. **独立对抗验证**（作者≠Hacker）：**发现一个真反例**。`importRecord()` 对 `record.id` 多次读取（:142/:163/:166/:182），使 `knownIds` 可与实际记录错位：带副作用 getter 的构造输入下，旧实现拒绝重复 id，新实现接受（探针 `COUNTEREXAMPLE_CONFIRMED`，退出码 1）。该反例需要带副作用的 JS getter，**未证明可经 HTTP/JSON/SQLite 输入触发**。修复方向为把 id 取单次快照；修复提交与复审状态见结论。

## 结论

- 简报收尾时，5 个累积提交 + 性能修复 + 文档修正均已落库、未 push，工作区 clean；此为文档整理前的状态，不把并发修复状态混入该快照。
- README 依赖节第五处版本号漂移由 `0.82.1` 修正为 `0.84.1`；任务记录与 journal 同步留痕。
- 记忆治理已从「从未执行」变为「已执行一次」；方案 B（对话 500 turns 裁剪）与失效记录物理清理仍未执行（删除类，需主人确认）。
- `src/lore/loreDialogueRetrieval.ts#scoreScene` 仍未接入 BM25，已在 `2026-09-18-bm25-retrieval/task.md` 遗留中记录。
- 本任务记录由收尾 agent 汇总；反例修复的复审结果见下一行。
- 修复提交与复审结果待补。

<!-- PENDING: fix-id-snapshot re-verification -->
