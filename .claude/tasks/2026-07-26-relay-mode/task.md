# admin 中转接入：baseURL + key 模式

## 目标与决策

- 诉求：admin 页面改成输入 baseURL 和 key，方便中转（OpenAI/Anthropic 兼容代理、one-api 类聚合站）接入。
- 配置双模式共用一个 `StoredLlmConfig`：`provider`（目录模式）与 `baseUrl`（中转模式）二选一必填；中转模式 `model` 自由填写、`api` 选 `openai-completions`（默认）或 `anthropic-messages`。
- 校验单一权威：`validateLlmConfig` 同时服务文件读写与 admin body 解析，删除了 handler 里的重复校验实现。
- 中转 runtime：`createProvider` + 合成 Model（contextWindow 128k / maxTokens 8k 默认）+ lazy api 实现；provider auth 显式置空——key 走每请求显式传递（pi-ai 规则：explicit apiKey wins）。
- 页面：接入方式单选，默认「自定义中转」；目录模式保留为第二选项；状态行显示 baseUrl。
- env 通道保持现状（provider/model），中转仅走网页/文件配置（YAGNI）。

## 验证记录

- `npm test`：110 pass / 0 fail（新增 5：configStore 双模式校验 3、buildConversationRuntime 中转离线构造与目录拒绝 2）
- `npm run typecheck`：通过
- 端到端 smoke（本地假中转 SSE 端点 + 真服务 + Playwright 浏览器）：
  - 页面默认中转模式，填 `http://127.0.0.1:43230/v1` + 模型名 + key → 「测试连接」真实走中转返回 **连接成功 (gpt-4o-mini)：pong**
  - 保存 → 热加载（readyz 出现 conversation 能力），落盘结构 `{baseUrl, model, api, apiKey}` 权限 600
  - `POST /v1/realm/conversations` 完整对话经中转返回回复；情感分析收到非 JSON（假中转只会 pong）→ `analysis:"failed"` + 清晰 reason（失败可见性正确）
  - 重启 → 配置自动恢复（日志 `custom/gpt-4o-mini (config: file)`）

## 结论

- 完成。中转接入全流程可用：填 baseURL/key → 测试 → 保存热加载 → 重启恢复。
- 修改文件：`llmConfigStore.ts`（双模式 + validateLlmConfig 统一）、`conversationBootstrap.ts`（customRelayModels + buildConversationRuntime 导出）、`adminPage.ts`（模式切换 UI）、README、测试 ×2。
- 剩余风险：中转模式的 contextWindow/maxTokens 是固定默认值（128k/8k），超长上下文的中转模型不受影响（仅影响 pi 内部预算估计）；真实中转站的兼容性差异（如非标准 SSE）遇到时按 pi-ai 的 OpenAICompletionsCompat 选项扩展。
