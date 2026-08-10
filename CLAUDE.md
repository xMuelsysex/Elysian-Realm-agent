# Elysian Realm Agent

Elysian Realm 模拟智能体认知核心：双轨架构——确定性 tick（`realm-agent-step.v1`）+ pi 驱动对话（`realm-conversation.v1`），共享宿主持有的记忆流与情感快照。最终形态是"情感的载体"。

## 验证命令

```bash
npm test            # build + 测试编译 + node --test（全离线确定性）
npm run typecheck   # tsc strict
```

## 核心不变量

1. **包根入口零 pi 依赖**：pi 代码只经 `./llm/pi-ai`、`./conversation/pi`、`./service/bootstrap` 子路径进入；`./service` barrel 也保持零 pi。
2. **宿主权威**：服务只返回建议（proposal / memoryWrites / affinityDelta / mood），宿主决定应用；本包永不直接改世界状态。
3. **快照与记忆流分工**：affect 快照管"现在怎样"，记忆流管"发生过什么"，各自单一事实来源；变化是否写入记忆流由调用方决定。
4. **确定性**：时间一律由调用方传入（`at`/`now` 参数），核心不生成时间；测试离线，LLM 只在两个接缝 fake（StreamFn / LlmPort）。

## Spec 索引

- 改 pi 相关代码（依赖升级、适配器、bootstrap）前先读 `.claude/specs/pi-integration.md`。
- 改情感/剧情相关代码（affect 模块、PlotEvent、tick/对话的 affect 字段、宿主情感应用）前先读 `.claude/specs/affect.md`。
- 改宿主持久化/HTTP 路由/聊天协议/admin 配置语义前先读 `.claude/specs/host-runtime.md`。
- 改 persona 相关代码（realm.json 角色卡、persona 类型、prompt 注入、校验器）前先读 `.claude/specs/character-contract.md`。

## 记忆约定

- session 开始先读 `.claude/journal.md` 顶部最近条目；非平凡任务建 `.claude/tasks/YYYY-MM-DD-<slug>/task.md`。
