# 中转 403 排查：SDK 指纹修复与真 LLM 首通

## 目标与决策

- 现象：主人的中转站（baseUrl 已带 /v1，路径标准）测试连接仍 403 "Your request was blocked."。
- 诊断决策：无 key 也能定位——对同一端点做三组 UA 对比（curl / 浏览器 / openai SDK 指纹），看拦截发生在网关层还是认证层。
- 修复决策：中转模式默认抹除 SDK 指纹（中性 UA + 全套 `x-stainless-*: null`），注入点在 `customRelayParts` 包装的 streamFn/completionClient；目录模式不动。属显式、范围受控的合法配置（用户访问自己付费的中转服务）。
- 诊断透明化：测试连接失败时返回实际请求 URL（`target` 字段，永不含 key），页面显示；Base URL 字段加 /v1 路径说明。

## 验证记录

- 无 key UA 对比（主人的真实中转端点）：curl UA → **401**（到认证层）；浏览器 UA → **401**；openai SDK 指纹（`OpenAI/JS` UA + `x-stainless-*`）→ **403 blocked**（认证前被 WAF 拦）。根因实锤。
- `npm test`：110 pass / 0 fail（新增 target 字段断言）；`npm run typecheck` 通过。
- 假 WAF 中转端到端（复刻拦截规则：见 stainless/OpenAI UA 即 403）：修复后中转日志 `ua="Mozilla/5.0 (compatible; ElysianRealmAgent/0.1)" stainless=[]`，测试连接返回 `ok:true, content:"pong"`。
- 主人真实环境确认：页面测试连接「连接成功 (gpt-5.6-sol)：pong」（截图）。
- 真 LLM 首条完整对话（`POST /v1/realm/conversations`）：回复自然引用注入记忆（"昨天的约定你没有忘记"）、人设与好感语气到位；情感分析返回完整 JSON（affinityDelta +3、mood 欣喜而亲昵 0.82、含理由）；两条对话记忆建议正确。
- 收尾复跑：110 pass / typecheck OK（HEAD 3c437b8）。

## 结论

- 完成，已提交 `ece6447`（诊断透明化）+ `3c437b8`（指纹修复）。
- 修改文件：`conversationBootstrap.ts`（RELAY_HEADER_OVERRIDES + target 诊断 + getActiveConfig）、`adminPage.ts`（target 显示 + /v1 提示）、`tests/conversationBootstrap.test.ts`。
- 里程碑：真实 LLM 端到端首通，"情感载体"管线可投入实际使用。
- 剩余事项：宿主应用层（affinityDelta/memoryWrites 自动应用到权威存储）与前端/bot 框架接入，待主人规划。
