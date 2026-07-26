# 阶段③④：对话轨 + 双轨闭环

## 目标与决策

- 阶段③：对话轨落地——`realm-conversation.v1` 无状态单轮合约、conversation 领域层（无 pi 依赖）、pi-agent-core 回复适配器、服务端点。
- 阶段④：双轨闭环——评估后收窄为组合测试 + README；不扩展 realmStep 合约（deterministic routine planner 不消费情感，扩展属无消费者预留，违反 YAGNI）。
- 关键决策：
  - 回复生成用 pi-agent-core（`./conversation/pi` 子路径隔离，后续可挂工具）；情感分析用 `LlmPort`（单次结构化调用），各一个实现，无并行实现。
  - 服务返回建议（reply + affinityDelta + mood + memoryWrites），宿主权威应用——对齐 realmStep 的 proposal 模式。
  - 对话执行器经 `createAgentService({ conversationRunner })` 注入；未配置时端点 501 显式失败，`npm start` 保持零密钥可启动。
  - `RealmMemoryMetadataV1`：`stepId` 宽松为可选、`source` 增加 `"conversation"`（读取方仅反思过滤 `source==="engine" && stepId===step`，对话记忆自然不进 tick 反思证据，向后兼容）。
  - LLM 分析输出为系统边界：JSON 解析失败 → `analysis:"failed"` 可见；delta clamp ±10、intensity clamp [0,1]，clamp 记入 reason。
  - 分析失败时回复仍可用（分析是增强），回复失败则整个请求失败（回复是核心产出）。

## 计划

1. 合约 `realmConversationV1.ts` + metadata 演进
2. 领域层：conversationPrompt / affectAnalysis / conversationRunner
3. pi 适配 `piConversationReplyPort.ts`（子路径 `./conversation/pi`）
4. 执行器 + agentService 端点 + client `resolveConversation`（提取共用 postJson）
5. 测试：领域 10 个、pi 适配 3 个、服务 HTTP 5 个
6. 阶段④组合测试 `dualTrackIntegration.test.ts` + README 重写

## 验证记录

- `npm test`：86 pass / 0 fail（新增 19 个：conversation 域 10、pi 适配 3、服务 5、双轨闭环 1；含 build 与测试编译）
- `npm run typecheck`：通过
- 途中修正：pi-ai 根入口 `AssistantMessageEventStream` 是 type-only 导出 → 测试改用 `createAssistantMessageEventStream()` 工厂；pi Agent 将 prompt 文本规范化为 content 块数组 → 断言对齐；readyz capabilities 加 `affect` → 旧测试期望更新。

## 结论

- 双轨闭环成立：组合测试证明 tick 记忆+好感进对话 prompt、对话 memoryWrites/affinityDelta 经宿主应用后被下一 step 检索命中、affect 在单一权威 store 累积（20 → 24）。
- 全链路真实组件，仅两处 LLM 接缝 fake，全离线确定性。
- 遗留：`npm start` 的服务无对话能力（by design，嵌入方注入 runner）；pi 0.82.1 精确锁定，升级需对照上游 changelog。