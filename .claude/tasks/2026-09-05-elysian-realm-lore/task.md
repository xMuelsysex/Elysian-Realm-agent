# 往世乐土正史知识层

## 目标与决策
- 在新分支 `feature/elysian-realm-lore` 实现让 agent 按需了解往世乐土主线故事。
- 采用独立、只读、版本化的 Canon 故事条目 + 本地词法检索 + prompt 注入；不微调模型、不运行时联网、不把正史写入经历记忆。
- 保持 `MemoryRecord` 只表示 agent 的经历；正史上下文独立标注为 canonical story context，避免角色把世界观资料说成亲身经历。
- 首版覆盖：乐土与记忆模拟的设定、十三英桀与刻印、芽衣进入乐土、系统异常与深处、阿波尼亚记忆牢笼、侵蚀之律者真相、爱莉希雅与乐土的最终告别。
- 网络资料仅提炼为原创短摘要并保留来源 URL，不复制游戏脚本；主要参考：
  - https://honkaiimpact3.fandom.com/wiki/Elysian_Realm
  - https://honkaiimpact3.fandom.com/wiki/Flame-Chasers_(Elysian_Realm)
  - https://honkaiimpact3.fandom.com/wiki/Elysian_Realm/Episodes/Chapter_1
  - https://honkaiimpact3.fandom.com/wiki/Elysian_Realm/Episodes/Chapter_2
  - https://honkaiimpact3.fandom.com/wiki/Elysian_Realm/Episodes/Chapter_3
  - https://honkaiimpact3.fandom.com/wiki/Story
  - https://honkaiimpact3.fandom.com/wiki/Chapter_XXXI

## 计划
- SC-01：新增 lore 条目契约、校验、CJK 词法检索和 Canon 初始语料。
- SC-02：在对话请求/runner 及 RealmHost 中接入只读 lore，构建 canonical context。
- SC-03：把同一 lore context 接入生活叙事与夜间反思，保持三条 LLM 轨一致。
- SC-04：新增 focused tests，运行 typecheck 与受影响测试，检查与已有 self-concept 工作树改动的兼容性。

## 验证记录
- 分支已创建：`feature/elysian-realm-lore`。
- 当前工作树已有 self-concept 未提交改动，已保留，不做清理或覆盖。
- 已完成网络资料检索，获得上述主线设定和章节摘要来源。
- `npm run build` 通过；`npm run typecheck` 通过；`git diff --check` 通过。
- 受影响测试、边界测试和完整离线单测均通过：`tsc -p tsconfig.test.json --ignoreDeprecations 5.0 && node --test .test-dist/tests/*.test.js`，271 项全绿。
- 标准 `npm test` 的测试编译步骤被当前已锁定的 TypeScript 5.9.3 与 `tsconfig.test.json` 的 `baseUrl`/`rootDir` 兼容错误阻断（TS5090/TS5102）；使用上述 `--ignoreDeprecations 5.0` 等价验证后测试本身全绿，未修改无关配置。

## 结论
- 往世乐土首版正史 Canon 已完成：本地只读检索接入对话、生活叙事和夜间反思三条轨道；来源、权限过滤、因果顺序与正史/经历分区均有测试覆盖。
- 未运行真实 LLM E2E；本次改动仅使用离线 stub/确定性测试。
