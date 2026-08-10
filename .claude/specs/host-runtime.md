# Host runtime 规范（2026-08-09 沉淀）

低频领域知识：改宿主持久化、HTTP 路由、聊天协议、admin 配置语义前先读本文件。

## 持久化（realm-state v2）

- `realm-data/realm.sqlite`（node:sqlite，`DatabaseSync`）存记忆/对话/情感/心情/tick 状态；`realm.json` 保持可手编 JSON（仅配置）。
- **剧情脚本**：每 agent 可选 `plotScript: [{period, days?, events: [{type, target, intensity?}]}]`（`days` 为 0=周日..6=周六 星期过滤，缺省每天）；宿主 `tickIfPeriodChanged` 在 runTick 后按 period+星期自动投喂（与 tick 同闸门，重启安全）；缺省无脚本零行为变化。affinity 存储已取整（INTEGER 列），`clamped` 语义仅反映越界裁剪。**投喂的 plot 事件同时写经历记忆**（observation，PLOT_EVENT_LABELS 中文标签 + target 三模板，tags plot-event，metadata plotType/plotTarget）——角色可提及经历。
- **情绪驱动例程**：routine 可选 `mood: low|neutral|high`（valence <-0.15 低 / >0.15 高）；`selectRoutineForPeriod(routines, period, affect)` 纯函数选择（mood 匹配 → 无偏好兜底 → 首条）；runTick 与 runNarratives 统一使用，行为随情绪变化。
- 每次 mutation 单事务（`inTransaction`，BEGIN IMMEDIATE）；行级增量写，无全量快照。
- **迁移**：旧 JSON（memories/affect/conversations/tick.json）在 DB 为空时一次性导入，文件原样保留（可手删）。
- 旧 `persist()` 已删除；宿主 shutdown 不再全量写。
- 表：`memories`(PK agent_id,id)、`conversations`(PK agent_id,seq)、`relationships`、`relationship_history`（affinity 变化时经 syncAffect 追加，无 PK 按 at 排序）、`moods`、`affect_states`、`tick_state`。JSON 列（source_ids/tags/metadata/emotion/emotion_labels）用 STRICT 表 + JS 校验器。 relationship_history 有 `at` 索引（idx_relationship_history_at），stats.totals 暴露 `relationshipHistoryRows`；裁剪（删除类）未做，留待治理决策。
- 测试陷阱：测试运行时 import 解析到 **dist**（包自引用）——手动重编译 .test-dist 后必须 `npm run build` 重建 dist。

## HTTP 层（Hono）

- `agentService.ts` 用 Hono 4.x + @hono/node-server；扩展接口 `AdminRequestHandler(method,path,body)` 返回 `{status,body}` 或 `{status,stream(emit)}`（SSE）。
- 契约锚点（测试黑盒覆盖，勿改）：`{error:{code,message}}` 错误形状、405+Allow、413 1MiB（流式带帽读取，勿用 Hono bodyLimit 的 content-length 快路径——会让客户端 SocketError）、空 body 容忍、`/v1/admin` 裸前缀走 notFound。

## 聊天 SSE 协议

`POST /v1/host/chat` + `{"stream": true}` → `text/event-stream`：

1. `delta {text}` — 逐字回复
2. `done {agentId, reply}` — 回复完成：页面解锁输入、气泡定稿（不携带最终状态！）
3. `applied {reply, affinity, mood, analysis, analysisReason}` — 分析+持久化完成后：更新徽标
4. `error {message}` — 流中失败

- 实现链：`ConversationRunner.runStream?(request, onDelta, onReply?)`（可选，无流式能力时单 delta + onReply 回退）→ `piConversationReplyPort.generateReplyStream`（`agent.subscribe` 收 `text_delta`）→ `RealmHost.chatStream` → hostApi。
- 非 stream 请求返回 JSON 兼容契约（页面自动回退）。

## admin 配置语义

- 存储 key 按设计不回显；候选配置缺 apiKey 时**合并存储 key**（`withStoredApiKey`，保存+测试两路）——勿改成直接落盘无 key 配置。
- env 固定（ELYSIAN_LLM_PROVIDER/MODEL）时保存返回 409 LLM_CONFIG_PINNED。

## 检索与情感

- 检索 `tokenize` 用 CJK 重叠二元组（Lucene 风格）+ ASCII 词；中文查询 relevance 通道正常工作。
- `emotionBias`/`weights.emotion`（默认 0 无偏）实现情绪一致性召回；`describeEvidenceEmotionalArc` 给反思 prompt 注入证据期情感轨迹（<2 条签名记忆不注入）。
- **关系弧线**：`relationshipHistory(agentId, since?)` 查询亲和度轨迹；夜间反思注入当日关系弧线行（当天≥2 条且首末不同才注入，`Relationship arc today: ... moved from X to Y`）；对话请求带 `relationshipHistory`（近 20 条），prompt 注入 `Relationship trajectory` 行（≥2 条且首末不同）——角色在对话中感知关系演变。
- **反思可见化**：`/v1/host/state` 摘要含 `latestReflection`（最新 kind=reflection 记忆）；聊天页空历史展示「🌙 她最近在想：「...」」（80 字符截断）。

## 验证

- `npm run verify`：npm test + verify:e2e 聚合全量验证（单元 + 帧级 E2E）；`ELYSIAN_CREDENTIALS_PATH=<real> bash scripts/run-e2e.sh` 切真实中转。
- 浏览器验证（Playwright）：进程需跨工具调用存活——`setsid nohup ... & disown`；清理用 `fuser -k PORT`；`pkill -f` 模式会匹配自身 shell 命令行（自杀），用 `[.]` 或 fuser。

- **记忆治理**：设计提案见 `.claude/specs/memory-governance.md`（未执行，删除类操作需主人确认）。
