# 鲜活度第一批：生活叙事 + 时间感 + 记忆分级 + LLM 反思

## 目标与决策

- 诉求：让她更鲜活、更有人味。调研 AstrBot 生态后确认："bot 自己过日子"无现成插件（双轨架构独有优势，自研）；scriptor（AGPL，零代码搬运）的 sleep-consolidation 任务分解与记忆压缩分级理念被借鉴进反思 prompt 与打分标准。
- ① 生活叙事：tick 后每 agent 由 LLM 写一条第一人称日记时刻（kind observation、importance 4、tag life-narrative、带近 3 条叙事保证连续性、temperature 0.9）；失败进 notes 不阻塞 tick。
- ② 时间感：prompt 注入当前时间（星期+时刻）、距上次交谈（`RealmConversationTurnV1.at?` 合约演进，向后兼容）、每条记忆相对时间前缀（describeRelativeTime 分档：minutes/hours/days/months）。
- ③ 记忆分级：情感分析 JSON 增 `memoryImportance`（打分标准借鉴 scriptor：约定/告白 7-9、情感时刻 5-6、日常 3-4、寒暄 1-2），normalize 到 0-9 整数，对话记忆写入使用之（缺省回退 3）。
- ④ LLM 反思：`createLlmReflectionPlanner`（主入口导出，零 pi）——内心独白视角、模式/情感/心愿三类任务、JSON 数组输出、无效 evidence 引用逐条过滤可见；host 夜间 tick 跑每日反思（当天记忆按 importance top12 为证据），复用现有 runReflection 验证链。
- hub 暴露 `getLlm()`（runtime.probeLlm 复用）；`tickIfPeriodChanged` async 化并返回 RealmTickReport（added/narratives/reflections/notes）。

## 验证记录

- `npm test`：126 pass / 0 fail（新增 9：相对时间分档、prompt 时间行、importance 解析与传导、反思 planner 正/反路径、叙事 prompt 与失败、host 集成叙事+夜间反思）
- `npm run typecheck`：通过
- smoke（分角色 demo 中转 + 真实 host）：夜间首 tick 日志 `2 memories, 1 narrative(s), 1 reflection(s)`；记忆库对比——模板 plan 记忆旁出现叙事「夜风把窗台的风铃吹响了一声…♪」（imp4）与反思「原来被人惦记是这种感觉呀」（imp7）；对话记忆按分析打 7 分（原固定 3）。

## 结论

- 完成。她的记忆从日程表变成了生活：有日记、有内心、重要的事记得更牢、知道现在几点和多久没见。
- 修改文件：`lifeNarrative.ts`/`llmReflectionPlanner.ts`/`livelinessEnhancements.test.ts`（新增）、conversationPrompt/affectAnalysis/conversationRunner/realmConversationV1（时间感+分级）、realmHost/realmState/conversationBootstrap/main（集成）。
- 第二批待做：主动消息（参考 proactive_chat 的免打扰时段/触发设计）、情绪惯性与好感衰减。
