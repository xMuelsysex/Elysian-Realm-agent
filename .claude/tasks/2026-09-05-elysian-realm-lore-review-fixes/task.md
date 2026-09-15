# Lore Review Findings 修复

## 目标与决策
- 修复独立审查确认的 RV-001～RV-005，不接受只修复首条 finding 的部分覆盖。
- RV-001：Lore 检索查询合并当前消息与最近两条 participant 历史，支持“她/然后呢”等有界指代追问，同时不把模型生成的 agent 历史当作 grounding 依据。
- RV-002：Lore 排序与共享 tokenizer 使用 locale-independent 的 code-unit/大小写规则，保持跨宿主环境确定性。
- RV-003：生活叙事和夜间反思只使用活动/证据文本检索，角色名不再单独触发 Canon。
- RV-004：为 Lore 条目、数组、topK 和渲染上下文建立命名边界；拒绝控制字符和超限输入，避免外部 lore 制造超大或结构注入 prompt。
- RV-005：渲染精确 sourceUrl/canonVersion，要求来源追问只引用受信 provenance。

## 计划
- 修复 conversationRunner、loreRetrieval、lorePrompt、tokenize、realmHost、loreRecords 与 conversation validator。
- 为历史指代、locale tie-break、角色名误命中、边界拒绝、来源输出补回归测试。
- 运行 typecheck、build、完整离线单测和核心边界检查；不改动已有 self-concept 或 workflow 产物。

## 验证记录
- `npm run build`：通过。
- `npm run typecheck`：通过。
- `./node_modules/.bin/tsc -p tsconfig.test.json --ignoreDeprecations 5.0 && node --test .test-dist/tests/*.test.js`：通过，275 项测试全绿（含 12 项 Lore 回归/边界测试）；历史 participant 窗口修正后最终重跑仍全绿。
- `git diff --check`：通过。
- 标准 `npm test` 的测试编译仍受仓库既有 TypeScript 5.9.3 与 `tsconfig.test.json` 的 TS5090/TS5102 配置兼容问题阻断；本次复用已确认的 `--ignoreDeprecations 5.0` 等价离线验证路径，未修改无关配置。

## 结论
- RV-001～RV-005 全部按 confirmed finding 修复，新增回归测试覆盖历史指代、跨环境排序、Host 按需检索、输入/Prompt 资源边界和 provenance 语义。
- 未改动 self-concept 等既有工作树改动；未执行提交、推送或真实 LLM E2E。
