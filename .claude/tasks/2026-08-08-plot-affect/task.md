# 剧情驱动情感系统（Plot-Driven Affect）

日期：2026-08-08

## 目标与决策

用户需求：人物有情感、人物根据剧情来决定情感、能够正常对话；优先借鉴 GitHub 成熟项目，不自创。

已锁决策（Plan Mode 主人确认）：
1. 情感模型 = 维度+标签混合（valence/arousal 连续维度 + 离散情绪标签 + affinity + baseline）
2. 情感判定 = tick 内确定性规则引擎（PlotEvent → 情感增量表 + 向基线回归）
3. 情感表达 = 对话时快照注入 prompt

借鉴映射（2026-08-08 网络核验）：
| 项目 | 许可证 | 借鉴点 |
|---|---|---|
| google-research/goemotions（google-research 仓库内） | Apache-2.0 | 28 类情绪标签（27 细类+neutral），ekman_mapping.json 粗分 |
| joonspk-research/generative_agents | Apache-2.0 | 记忆流（recency/relevance/importance）架构已镜像；agent 状态管理 |
| ACT（inteRact: ekmaloney/inteRact、actdata: ahcombs/actdata、ACTING: nikozoe/ACTING） | 各自 | deflection 思想：事件改暂态印象，向基础情感（fundamental sentiments）回归 → 我们的增量表+baseline 衰减 |
| facebookresearch/EmpatheticDialogues | CC BY-NC 4.0（仅格式） | "Emotion: X / Situation: Y + utterance" 对话格式 → prompt 注入格式 |
| SillyTavern character-card-spec-v2 | 规范非 AGPL（SillyTavern 本体 AGPL） | 角色卡字段：name/description/personality/scenario/first_mes/mes_example → 情感描述块组织 |
| huankuios/SoulChat、THUDM/CharacterGLM-6B | 各自（研究用途） | 中文角色扮演 system prompt 风格（仅借鉴措辞思路） |

规则：Apache-2.0 可参考代码；CC BY-NC / AGPL / 研究用途项目只借鉴设计与数据格式，不复制代码。

现状核对（step-0b）结论：
- 双轨契约已存在：`realm-agent-step.v1`（tick，无 affect 输出）、`realm-conversation.v1`（对话，affect 提议：affinityDelta/mood/emotion 签名）
- `src/affect/` 已有：RelationshipAffect（affinity -100..100）+ AgentMood（自由文本标签+intensity 0..1）
- 未提交的"情感记忆"工作：EmotionSignature{valence,arousal} 已进 MemoryRecord，对话记忆打签，prompt 注入 "— at the time you felt …"
- 缺口：tick 轨无情感；无 valence/arousal 维度状态、无情绪标签体系、无剧情事件协议、无 baseline 衰减；对话 prompt 只注入 mood 标签+强度

本任务（最小有效改动）：
- 新增 `AffectState`（valence/arousal/emotionLabels 28 类/baseline）+ `PlotEvent` 协议 + 确定性规则引擎（plotRules.ts）
- tick 契约接受 affectState/plotEvents 输入，输出 affectProposal（完整新状态 + affinityDelta）
- 对话契约接受 affect 快照，prompt 注入情感描述 + 表达约束（EmpatheticDialogues 式）
- 宿主：affect 状态持久化、tick/plot 应用路径统一、POST /v1/host/plot API、聊天页剧情投喂 + 情绪徽标
- 不改四条核心不变式；情感记忆未提交工作在旁不动

## 计划

1. affectRecords.ts：EmotionLabel（GoEmotions 28）+ AffectState + PlotEvent 类型与常量
2. affectValidation.ts：validateAffectState / validatePlotEvent（collect-then-throw 风格）
3. plotRules.ts（新）：PLOT_EVENT_RULES 增量表、applyPlotEvents（先衰减后叠加）、decay、createInitialAffectState、computeAffinityDelta
4. inMemoryAffectStore.ts：affectStates 存储 + set/get + init 导入校验
5. realmStepV1.ts / realmStepExecutor.ts：输入 affectState/plotEvents、输出 affectProposal
6. realmConversationV1.ts / executor：请求 affect 字段
7. conversationPrompt.ts：describeAffectState + 表达约束注入；affectAnalysis.ts：分析输入含 affect；conversationRunner.ts：透传
8. realmState.ts：affectStates 持久化 + applyAffectProposal；realmHost.ts：runTick 传入 affectState+应用提议、plotEvent()、summary 含 affect；hostApi.ts：POST /v1/host/plot；chatPage.ts：情绪徽标 + 剧情投喂行
9. index.ts 导出 plotRules
10. 测试：affectPlotEngine.test.ts（规则/衰减/裁剪/不可变）、simulationAgentAffect.test.ts 扩展 store 层、plotAffectIntegration.test.ts（tick 序列→proposal、对话 prompt 注入、宿主应用+API）
11. 收尾：npm test + typecheck 全绿；specs/affect.md + CLAUDE.md 索引；journal 追加

## 验证记录

- `npm run typecheck`：绿。
- `npm test`：154 pass / 0 fail（含未提交的情感记忆测试；新增 affectPlotEngine.test.ts 12 条 + plotAffectIntegration.test.ts 7 条）。
- 关键断言：hostile×3+threat → valence 触底、anger=1/fear=0.6、affinityDelta=-10（裁剪生效）；kind 序列正向；intensity 0.5 线性缩放；decay 回归基线；不可变性；宿主投喂→affect.json 持久化→重启读回；tick 衰减应用；对话 prompt 含 "prominent feelings: fear (0.60)" 与 stirred/uneasy 约束；/v1/host/plot 200/400。
- 修正记录：两处测试算式错误（arousal 裁剪、decay 基数）。

## 结论

完成。剧情驱动情感全链路落地：PlotEvent（宿主喂）→ tick/引擎（确定性）→ affectProposal → 宿主应用持久化 → 对话快照注入表达。设计全部映射已核验的成熟项目（GoEmotions/ACT/generative_agents/EmpatheticDialogues/角色卡），spec 沉淀于 `.claude/specs/affect.md`。四条核心不变式未触碰。待主人确认后提交（含先前未提交的情感记忆与鲜活度工作，建议同批提交）。
