# pi 集成约定

## 版本策略

- `@earendil-works/pi-ai` 与 `@earendil-works/pi-agent-core` **精确锁定同一版本**（当前 0.82.1，两包 lockstep 发版），`.npmrc` 已设 `save-exact=true`。
- 升级流程：手动、在 minor 边界集中升，先读上游 `packages/{ai,agent}/CHANGELOG.md` 的 **Breaking Changes** 节（记录规范）。breaking 高发区在 harness/session 层；`Agent` 类、agent-loop、钩子（`transformContext`/`prepareNextTurn`）、事件订阅相对稳定。
- Node engines ≥22.19.0（pi 硬要求）；官方另有 `legacy-node20` dist-tag（0.74.x），无需理会。
- 上游源码参考：`git clone --depth 1 https://github.com/earendil-works/pi /tmp/pi-repo`（MIT）。

## 子路径隔离规则

- pi import 只允许出现在三个模块，且各自独立子路径导出：
  - `src/llm/piAiLlmPort.ts` → `./llm/pi-ai`
  - `src/conversation/piConversationReplyPort.ts` → `./conversation/pi`
  - `src/service/conversationBootstrap.ts` → `./service/bootstrap`（禁止进 `./service` barrel——纯 tick 嵌入方不加载 provider 注册）
- 新增 pi 适配一律沿用此模式：领域逻辑无 pi（可离线纯函数测试），pi 只做端口 adapter；同一端口不做第二实现。
- 新子路径需同步三处：`package.json#exports`、`tsconfig.json#paths`、测试用包别名 import。

## 已知坑

- pi-ai 根入口的 `AssistantMessageEventStream` 是 type-only 导出（与 types.ts 的 star export 歧义），值请用 `createAssistantMessageEventStream()` 工厂。
- pi `Agent.prompt(string)` 会把文本规范化为 content 块数组 `[{type:"text",text}]`，断言 streamFn 收到的 context 时按块数组比较。
- pi-ai 失败契约：不 throw，错误编码在最终 `AssistantMessage`（`stopReason: "error"|"aborted"` + `errorMessage`）——适配器必须检查并显式 re-throw，禁止吞掉。
- 历史 assistant 消息进 pi Context 需合成完整 `AssistantMessage`（api/provider/model/零 usage/stopReason:"stop"/timestamp）；pi 官方支持跨 provider context 转移，此为受支持形状。
- 模型目录是构建期打包的静态数据：`builtinModels().getModel(provider, id)` 离线可查、找不到返回 undefined（调用方显式 throw）；auth 在请求时才解析，构造阶段零网络。
- npm install 时 `@google/genai`（no-op preinstall）与 `protobufjs`（postinstall）的 install scripts 被 allowScripts 拦截，不影响构建与测试。

## LLM 输出边界防御（对话轨）

- 情感分析 JSON 解析失败 → `analysis: "failed"` + reason 可见，回复仍可用；回复失败则整个请求失败。
- 数值 clamp 且可观察：affinityDelta ±10、moodIntensity [0,1]，clamp 记入 reason。
