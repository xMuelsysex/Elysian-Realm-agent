# 记忆治理规范

> 状态：**方案 A 已实现（2026-09-15），语义从「删除」改为「失效」**：`POST /v1/host/govern`，默认 `dryRun=true`。
> 删除类操作（方案 B 的 turns 裁剪）仍未执行，需主人明确确认。

## 问题

- 记忆与对话 turns 无界增长（SQLite 增量写，不崩溃但持续膨胀；检索全量线性扫描随规模变慢）。
- 现状数据源：`GET /v1/host/stats`（每 agent 记忆/turns、oldestMemoryAt、90 天未用 staleMemories、dbBytes）。

## 方案（两级，均需确认）

### A. 记忆失效（已实现，不删除）

- **失效优于删除**：记录加 `invalidAt`（+ 可选 `supersededBy`），行为 `memories.invalid_at` / `superseded_by`（老库在构造时 `ALTER TABLE` 补列）。失效记录保留为证据链，但检索与所有角色可见投影都不再返回它（`retrieveMemoryRecords` 记 `excluded: invalidated`；`isCharacterVisibleMemory` 直接 false）。
- 规则一「长期未用」：`lastAccessedAt < now - 90d` 且 `importance < MEMORY_RETIRE_MIN_IMPORTANCE`（=4）；重要记忆永不失效。
- 规则二「引擎模板」：`isEngineTemplateRecord` —— `metadata.engineDiagnostic`、`reflectionSource: deterministic`、或 `kind=plan + source=engine`；这些是引擎自己的文本（见 host-runtime 的记忆流边界），治理把它们正式退役。
- 触发：`POST /v1/host/govern`（body `{dryRun?, profileId?}`）→ `{profileId, dryRun, at, candidates:{stale, engineTemplates}, invalidated:{...}}`。**默认 `dryRun=true`，显式 `dryRun:false` 才真改。**

### B. 对话历史保留上限（可选）

- 规则：每 agent 保留最近 N=500 turns，超出裁剪最旧（`DELETE FROM conversations WHERE agent_id = ? AND seq < (SELECT MAX(seq) - 499 FROM conversations WHERE agent_id = ?)`）。
- 与 A 同端点，`{pruneConversations: true}` 显式开启。

## 不变量

- 失效/删除只在宿主（权威）侧执行；service 层不触碰（hostAuthorityBoundary 守卫已机械强制）。
- 全部操作走 `inTransaction`（单事务，崩溃安全）。
- dry-run 报告先行，真删永远显式。

## 待批准项

1. B 方案（500 turns 上限）——可选，执行需确认。
2. 已失效记录的物理清理（真空/归档）——仍属删除类，需确认。
3. `supersededBy` 的写入方（目前只有治理路径，冲突消解式替换尚未接入）。

## 实测数据（线性扫描）

> 最新可复现数据用 `npm run bench`（`scripts/bench.mjs`）现场测量，下表为 2026-08-09 的历史记录：
> 2026-09-18 在 i7-13700H 上重测为 5,000 → 46 ms、20,000 → 201 ms（9.2–10.0 µs/条，BM25 文本通道）。
> 方法与机器不同，不可与下表直接相比，但结论（线性、5k 是分水岭）不变。

| 记忆数 | 单次检索 ms |
|---|---|
| 100 | 5.6 |
| 1,000 | 6.5 |
| 5,000 | 31 |
| 10,000 | 85 |
| 20,000 | 144 |

- 曲线：约 7µs/条，线性。**10k+ 开始肉眼可见**（每轮对话 1-2 次检索 → 20k 时每轮 +150-300ms）。
- 结论：清理到 <5k 记忆可保持单次检索 <35ms——方案 A 的量化收益依据；失效后候选不再进入检索，故收益等价。
