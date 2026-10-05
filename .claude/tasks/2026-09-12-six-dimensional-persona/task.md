# 六维人格属性

## 目标与决策
- 在现有结构化 persona 中加入 6 个稳定人格属性，让 agent 产生 Gal-like 的可区分表现。
- 六维采用：外向度、共情度、理性度、勇气、好奇度、独立度；每维独立取值 `0–100`。
- 使用统一固定映射；数值连续影响表现，并以 5 段语义区间辅助解释：`0–19` 极低、`20–39` 偏低、`40–59` 中性、`60–79` 偏高、`80–100` 极高。
- 首期属性固定且隐藏，不建立成长循环、运行态属性存储、编辑/查询/展示入口。
- 缺失维度按 `50` 处理；旧文本 persona 保持兼容。
- 保持人格属性、AffectState、AgentMood、affinity、self-concept 各自单一事实来源。

## 计划
- 扩展 persona 契约与 host / conversation 校验，增加边界和缺省兼容。
- 统一在 persona prompt 渲染器注入数值与语义，覆盖对话、生活叙事和夜间反思。
- 在 Host routine 选择与剧情情绪/关系响应中接入固定、无随机的六维映射，保持旧 routine 声明顺序兜底。
- 更新默认角色配置；遵循项目规则不新增测试文件，使用既有受影响测试与最小 smoke 检查验证行为。
- 按受影响边界运行 typecheck、build、目标测试及项目要求的验证命令，并记录结果。

## 验证记录
- `npm run typecheck`：通过。
- `npm test` 首次发现 1 个既有精确值回归：默认爱莉希雅的 hostile 事件被新人格倍率调制；调整默认配置的中性组合后，针对性重建并运行 `plotAffectIntegration.test.js`：7/7 通过。
- `node --test .test-dist/tests/oocGuard.test.js`：55/55 通过。
- `personality smoke`：验证 5 段边界、缺失值按 50、prompt 六维渲染、事件倍率和 routine 高低偏好，全部通过。
- 最终 `npm run verify`：`npm test` 275/275 通过，`verify:e2e` 全部 PASS；SSE、持久化、情绪、夜间反思、JSON fallback、第二角色链路均通过。
- `realm-data/realm.json` JSON 解析通过；`git diff --check` 通过。
- 直接执行全局 `tsc -p tsconfig.test.json` 曾触发 TS5090/TS5102；改用项目本地 `npm exec -- tsc` 后验证通过。该环境问题未修改项目配置。

## 结论
- 已完成六维人格属性第一期：结构化 persona 契约、双边界校验、三轨 prompt 注入、固定 affect/affinity 事件倍率、确定性 routine 偏好、默认角色配置和领域规格同步完成。
- 属性保持静态、隐藏、宿主持有；未新增 SQLite 状态、成长循环、编辑/查询 API 或 UI 展示。
- 工作树中原有 lore/self-concept 等未提交改动未被清理或覆盖。
