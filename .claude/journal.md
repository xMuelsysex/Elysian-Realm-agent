# Elysian Realm Agent — 项目记忆（倒序）

## 2026-07-26 网页 admin 入口：LLM key 配置与热装配

- 改动：`GET /admin` 内嵌单页（provider/model 下拉 + key + 测试连接）、`/v1/admin/llm-config`(+/test、catalog) API、key 落盘 `~/.elysian-realm/credentials.json`（0600 原子写，`ELYSIAN_CREDENTIALS_PATH` 可覆盖）、`createConversationHub` 热装配（env > file > admin，env 时 pin 住 admin 改动 409）、`AgentServiceOptions.conversationRunner` 放宽为函数联合类型（readyz 动态反映）。关键文件：`conversationBootstrap.ts`（hub）、`llmConfigStore.ts`、`adminPage.ts`、`agentService.ts`。
- 学到：admin handler 用纯数据接口（`AdminRequestHandler`）注入，service barrel 维持零 pi；保存顺序必须 build（验证）→ save（落盘）→ swap（热替换），运行态永不与磁盘分叉；token 校验用 `timingSafeEqual`。
- 坑：主人 pi CLI 的订阅 OAuth 凭据会被 pi-ai credential store 自动解析但 provider 返回 403 forbidden（订阅凭据只允许官方客户端）——需要 standalone API key；测试连接按钮把这个错误清晰显示了出来。

## 2026-07-26 模型选择走 pi-ai 目录（env 装配）

- 主人问"pi 的模型选择器能不能直接用"→ 能：pi-ai 的 Models 目录（`builtinModels()` + `getModel` + auth 环境变量解析 + 静态模型数据）就是服务形态的模型选择器；TUI 交互选择器属 pi-coding-agent，不适用 HTTP 服务。
- 新增 `src/service/conversationBootstrap.ts`（子路径 `./service/bootstrap`，独立于 `./service` barrel——纯 tick 嵌入方不加载 pi 与全量 provider 注册）：`ELYSIAN_LLM_PROVIDER`+`ELYSIAN_LLM_MODEL` 成对配置，未配置→undefined（端点 501），半配置/目录查无→启动时显式 throw。
- main.ts 接线并打印能力状态；`.env.example`、README 更新。目录查询离线可用（构建期打包的静态数据）。
- 验证：90 tests pass；smoke 双分支（无 env→无对话能力；有 env→readyz 含 realm-conversation.v1，模型 anthropic/claude-fable-5）。

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
