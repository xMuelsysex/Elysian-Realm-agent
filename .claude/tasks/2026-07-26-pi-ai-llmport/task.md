# 阶段①：pi-ai 实现 LlmPort + 工程基线升级

## 目标与决策

- 目标：为双轨架构打通 LLM provider 层——用 `@earendil-works/pi-ai@0.82.1` 实现现有 `LlmPort`，核心包入口保持无 pi 依赖。
- 版本决策：锁 0.82.1 精确版本（latest，刚过 0.81/0.82 breaking 窗口；本地 Node v26.4.0 满足 ≥22.19）。
- 架构决策：适配器放 `src/llm/piAiLlmPort.ts`，以独立子路径 `./llm/pi-ai` 导出；`index.ts` 不 re-export，核心保持 host-independent + 离线确定性。
- 失败可见：`responseFormat`、消息中段 system、stopReason error/aborted 一律显式 throw,不静默降级。
- 上游参考源码：/tmp/pi-repo（main @ 0.82.1）。

## 计划

1. 基线 commit（完成：6971944）
2. `.npmrc` save-exact；package.json：engines ≥22.19.0、pi-ai@0.82.1 精确依赖、`./llm/pi-ai` 子路径导出
3. `src/llm/piAiLlmPort.ts`：`createPiAiLlmPort` —— 消息映射（前导 system 合并进 systemPrompt）、options 映射（signal + timeoutMs 用 AbortSignal.any 组合）、结果映射（text 块拼接、usage、responseId）
4. `tests/piAiLlmPort.test.ts`：注入 fake completeSimple，全离线断言映射与失败路径
5. 验证：npm test → typecheck → build

## 验证记录

- `npm test`：58 pass / 0 fail（原 49 + 新增 9 个适配器测试；内含 build 与测试编译）
- `npm run typecheck`：通过（strict, NodeNext）
- 环境：Node v26.4.0；install scripts 有 2 个被 allowScripts 拦截（@google/genai 的 no-op preinstall、protobufjs postinstall），未影响构建与测试

## 结论

- 新增 `src/llm/piAiLlmPort.ts`：`createPiAiLlmPort(client, model, options?)` 将 pi-ai `Models.completeSimple` 封装为 `LlmPort`；仅此模块 import pi-ai，经 `./llm/pi-ai` 子路径导出，主入口保持无 pi 依赖。
- 失败显式化：responseFormat、中段 system 消息、stopReason error/aborted 全部 throw。
- 工程基线：engines ≥22.19.0、pi-ai@0.82.1 精确锁定、.npmrc save-exact、tsconfig paths 与 package exports 增加子路径。
- 后续：阶段②记忆库扩展情感状态；阶段③ pi-agent-core 对话轨。
