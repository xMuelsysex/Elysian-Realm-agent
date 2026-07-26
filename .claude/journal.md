# Elysian Realm Agent — 项目记忆（倒序）

## 2026-07-26 双轨架构落地：pi 集成 + affect + 对话轨 + 闭环

- 方向决策（主人拍板）：双轨并存——tick 驱动日常 routine（确定性），对话事件走 pi 会话循环，共享同一记忆/情感库；项目最终形态是"情感的载体"（参考 astrbot_plugin_self_learning 的理念，AGPL 协议、只借鉴思路零代码搬运）。
- pi 版本：`@earendil-works/pi-ai` + `pi-agent-core` 精确锁定 **0.82.1**（latest，刚过 0.81/0.82 breaking 窗口）；`.npmrc save-exact`；Node engines ≥22.19。升级须对照上游 CHANGELOG 的 Breaking Changes 节。
- 架构不变量：
  - 包根入口零 pi 依赖；pi 只经 `./llm/pi-ai`、`./conversation/pi` 子路径进入。
  - 宿主权威：服务只返回建议（proposal / memoryWrites / affinityDelta / mood），宿主应用。
  - 记忆流管"发生过什么"，affect 快照管"现在怎样"，各自单一事实来源；变化是否写记忆流由调用方决定。
  - 时间一律由调用方传入，核心不生成时间；测试全离线（fake StreamFn / fake LlmPort 两个接缝）。
- 新模块：`src/affect/`（好感 [-100,100] clamp 可观察 + mood）、`src/conversation/`（prompt 组装 / affect 分析解析 / runner）、`src/llm/piAiLlmPort.ts`、`src/conversation/piConversationReplyPort.ts`、服务端点 `POST /v1/realm/conversations`（runner 注入制，未配置 501）。
- 合约演进：`RealmMemoryMetadataV1.stepId` 可选化 + `source` 增 `"conversation"`；realmStep 合约本体未扩展（routine planner 不消费情感，扩展属无消费者预留）。
- 验证：86 tests pass / typecheck 通过；`dualTrackIntegration.test.ts` 证明闭环（tick 记忆入对话 prompt → 对话产物入下一 step 检索 → affect 单店累积）。
- 踩坑备忘：pi-ai 根入口 `AssistantMessageEventStream` 是 type-only（用 `createAssistantMessageEventStream()`）；pi Agent 把 prompt 文本规范化成 content 块数组；pi 上游源码参考位于 /tmp/pi-repo（main @ 0.82.1）。
