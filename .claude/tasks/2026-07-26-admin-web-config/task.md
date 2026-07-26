# 网页 admin 入口：LLM key 配置与热装配

## 目标与决策

- 诉求：网页交互配置 provider/model/key，免改 `.env`；重启保留（主人确认落盘 0600）。
- 存储：`~/.elysian-realm/credentials.json`（0600，临时文件+rename 原子写；`ELYSIAN_CREDENTIALS_PATH` 可覆盖，测试用）。坏文件 → main 启动时 console.error 并以无对话能力启动（tick 不受影响，admin 页可重新保存修复）。
- 配置优先级：env（ELYSIAN_LLM_PROVIDER/MODEL + provider 标准 key env）> credentials 文件。单一 hub 管理运行时状态。
- key 注入走 pi 正规接口：reply 侧 `Agent.getApiKey`，analysis 侧 `StreamOptions.apiKey`——零环境变量污染。
- 热装配单一来源：`AgentServiceOptions.conversationRunner` 放宽为 `ConversationRunner | (() => ConversationRunner | undefined)`，readyz/对话路由统一经 resolve；静态注入方不受影响。
- 安全边界（显式、范围受控）：admin 仅在装配点判定——bind loopback → 开放；非 loopback → 必须 `ELYSIAN_ADMIN_TOKEN`（无 token 则不装 admin 并启动警告）；HTTP 层校验 Bearer token。key 永不回显（状态端点只报 keySource）。
- pi 隔离不变量：agentService barrel 零 pi；admin handler/page 作为纯数据接口（`AdminRequestHandler`）由 bootstrap 子路径装配注入。
- 测试连接端点：用当前/试探配置发最小 completeChat，即时验证 key；hub 支持注入 buildRunner（测试 fake，避免真网络）。

## 计划

1. `src/service/llmConfigStore.ts`：load/save（0600、原子写、校验）
2. `src/conversation/piConversationReplyPort.ts` + `src/llm/piAiLlmPort.ts`：可选 apiKey 注入透传
3. `src/service/conversationBootstrap.ts` 重构：`createConversationHub`（env>file 装配、热更新、admin handler 工厂）
4. `src/service/agentService.ts`：runner 联合类型 resolve、/admin 页面路由、/v1/admin/* 路由 + token gate
5. `src/service/adminPage.ts`：内嵌 HTML 单页
6. `main.ts` 装配；`.env.example`/README
7. 测试：configStore、hub（env/file/热更）、admin HTTP（gate/save/状态/页面）、适配器 apiKey 透传

## 验证记录

- `npm test`：105 pass / 0 fail（新增 19：configStore 6、hub/admin handler 9、admin HTTP gate 4）
- `npm run typecheck`：通过
- smoke（真实服务进程 + Playwright 浏览器）：
  - 未配置启动 → `/v1/admin/llm-config` 报 unconfigured，readyz 无对话能力
  - 网页 API 保存 anthropic/claude-fable-5 + key → 200，readyz **热加载**出现 `realm-conversation.v1`，落盘文件权限 **600**
  - 重启服务 → 配置自动恢复（configSource: file，启动日志正确）
  - 浏览器打开 `/admin`：37 provider 下拉、模型联动、当前配置自动选中；"测试连接"真实调用 LLM，403 错误清晰显示在红色结果框（假 key 预期失败路径）

## 结论

- 完成。网页配置全流程可用：选择 → 测试 → 保存 → 热加载 → 重启恢复。
- 修改文件：`llmConfigStore.ts`/`adminPage.ts`（新增）、`conversationBootstrap.ts`（重构为 hub）、`agentService.ts`（admin 路由 + token gate + runner 联合类型）、`main.ts`（装配）、两个 pi 适配器（apiKey 透传）、`service/index.ts`、`.env.example`、README、测试 ×3。
- 安全边界：loopback 默认开放 / 非 loopback 必须 token（timingSafeEqual 比较）；key 永不回显；0600 落盘原子写；env 配置 pin 住 admin 修改（409）。
- 剩余风险：admin 页面无 CSRF token——loopback + 无 cookie 认证场景下风险低（token 模式下 Bearer header 天然免疫 CSRF）；如未来公网部署建议加反代认证层。
