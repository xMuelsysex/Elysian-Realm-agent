# env 驱动模型选择（pi-ai 目录装配）

## 目标与决策

- 主人问"pi 的模型选择器能否直接用"→ 结论：pi-ai 的 Models 目录（`builtinModels()` + `getModel` + auth 环境变量解析 + 构建期打包的静态模型数据）就是服务形态的模型选择器，直接接入服务进程；TUI 交互选择器属 pi-coding-agent，不适用。
- 装配决策：`ELYSIAN_LLM_PROVIDER` + `ELYSIAN_LLM_MODEL` 成对配置；都缺 → 端点保持 501；半配置或目录查无 → 启动时显式 throw（fail fast，拒绝到首次对话才暴露）。
- 隔离决策：`conversationBootstrap.ts` 走独立子路径 `./service/bootstrap`，不进 `./service` barrel——纯 tick 嵌入方零 pi/provider 注册加载。
- 凭据边界不变：API key 留在各 provider 标准环境变量，pi-ai 请求时解析，代码零密钥。

## 计划

1. `src/service/conversationBootstrap.ts`：parse + build 两函数
2. `main.ts` 接线 + 能力状态日志
3. exports/tsconfig 子路径、`.env.example`、README
4. 离线测试 + 双分支 smoke

## 验证记录

- `npm test`：90 pass / 0 fail（新增 bootstrap 4 测：全缺→undefined、半配置→throw、目录查无→throw、目录真实模型→runner 构造成功且离线）
- `npm run typecheck`：通过
- smoke（真实服务进程，端口 43199）：
  - 无 env：日志 "conversation endpoint disabled"，readyz capabilities 无 `realm-conversation.v1`
  - `ELYSIAN_LLM_PROVIDER=anthropic ELYSIAN_LLM_MODEL=claude-fable-5`：日志 "enabled via anthropic/claude-fable-5"，readyz 含 `realm-conversation.v1`；SIGTERM 优雅停机正常

## 结论

- 完成，已提交 `426790c`。
- 修改文件：`src/service/conversationBootstrap.ts`（新增）、`src/service/main.ts`、`package.json`/`tsconfig.json`（子路径）、`.env.example`、`README.md`、`tests/conversationBootstrap.test.ts`（新增）。
- 剩余事项：真实 API key 的端到端对话 smoke（延迟/回复质量）待主人提供环境后执行。
