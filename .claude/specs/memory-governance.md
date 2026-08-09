# 记忆治理设计提案（待主人批准后执行）

> 状态：**设计中，未执行**。本文件是决策材料——批准后按此实施，任何删除操作需主人明确确认。

## 问题

- 记忆与对话 turns 无界增长（SQLite 增量写，不崩溃但持续膨胀；检索全量线性扫描随规模变慢）。
- 现状数据源：`GET /v1/host/stats`（每 agent 记忆/turns、oldestMemoryAt、90 天未用 staleMemories、dbBytes）。

## 方案（两级，均需确认）

### A. 记忆清理（90 天未用）

- 规则：`lastAccessedAt < now - 90d` 且 `importance <= 3` 的记忆（低重要 + 长期未用 → 可删；重要记忆永不自动删）。
- 阈值常量：`MEMORY_STALE_DAYS = 90`（已存在）、`MEMORY_PRUNE_MIN_IMPORTANCE = 4`（新增，低于此才可删）。
- SQL（node:sqlite）：
  ```sql
  DELETE FROM memories
  WHERE agent_id = ? AND importance <= ? AND last_accessed_at < ?;
  ```
- **dry-run 模式**：`DELETE` 前先 `SELECT COUNT(*)` 报告将删条数（stats 已有候选数）；批准后执行。
- 触发：新增 `POST /v1/host/govern`（body `{dryRun: true|false}`）→ 返回 `{dryRun, candidates, deleted}`；或手动 SQL。**默认 dryRun=true，显式 false 才真删。**

### B. 对话历史保留上限（可选）

- 规则：每 agent 保留最近 N=500 turns，超出裁剪最旧（`DELETE FROM conversations WHERE agent_id = ? AND seq < (SELECT MAX(seq) - 499 FROM conversations WHERE agent_id = ?)`）。
- 与 A 同端点，`{pruneConversations: true}` 显式开启。

## 不变量

- 删除只在宿主（权威）侧执行；service 层不触碰（hostAuthorityBoundary 守卫已机械强制）。
- 全部操作走 `inTransaction`（单事务，崩溃安全）。
- dry-run 报告先行，真删永远显式。

## 待批准项

1. A 方案（90 天未用 + importance<=3 清理）——执行需确认。
2. B 方案（500 turns 上限）——可选，执行需确认。
3. `POST /v1/host/govern` 端点形态。

## 实测数据（2026-08-09 bench，线性扫描）

| 记忆数 | 单次检索 ms |
|---|---|
| 100 | 5.6 |
| 1,000 | 6.5 |
| 5,000 | 31 |
| 10,000 | 85 |
| 20,000 | 144 |

- 曲线：约 7µs/条，线性。**10k+ 开始肉眼可见**（每轮对话 1-2 次检索 → 20k 时每轮 +150-300ms）。
- 结论：清理到 <5k 记忆可保持单次检索 <35ms——方案 A 的量化收益依据。
