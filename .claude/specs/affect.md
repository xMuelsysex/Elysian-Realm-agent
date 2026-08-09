# 剧情驱动情感系统（Affect）约定

改动情感/剧情相关代码前先读本文。状态机与来源：`src/affect/`（零 pi 依赖、纯函数）；契约：`src/service/realmStepV1.ts`（tick）、`src/service/realmConversationV1.ts`（对话）；宿主应用：`src/host/realmState.ts`、`src/host/realmHost.ts`。

## 设计来源（2026-08-08 网络核验）

| 项目 | 许可证 | 借鉴点 |
|---|---|---|
| google-research/goemotions（google-research 仓库内 goemotions/） | Apache-2.0 | 28 类情绪标签（27 细类 + neutral），仓库含 ekman_mapping.json 粗分 |
| joonspk-research/generative_agents（Stanford Smallville） | Apache-2.0 | 记忆流（recency/relevance/importance）架构；本包记忆流已镜像 |
| ACT 实现：ekmaloney/inteRact、ahcombs/actdata、nikozoe/ACTING | 各自 | deflection 语义：事件把暂态印象推离基础情感（fundamental sentiments），随后回归 → 本包增量表 + baseline 指数衰减；**不引入 EPA 词典** |
| facebookresearch/EmpatheticDialogues | CC BY-NC 4.0（仅格式） | "情绪标签 + 情境 + 回应" 对话格式 → prompt 注入写法 |
| character-card-spec-v2（SillyTavern 生态） | 规范公开（SillyTavern 本体 AGPL-3.0） | 角色卡字段组织（personality/scenario 等）→ 情感描述块组织 |
| huankuios/SoulChat、THUDM/CharacterGLM-6B | 研究用途 | 中文角色扮演 system prompt 措辞思路（仅借鉴，未复制） |

规则：Apache-2.0 可参考实现；CC BY-NC / AGPL / 研究用途只借鉴设计与格式，不复制代码。增量表数值是校准常量（非公式推导），保守默认，可调。

## 模型

- `AffectState`（"现在怎样"，宿主持有、不可变）：`valence [-1,1]` × `arousal [0,1]` 连续维度 + `emotionLabels: Record<EmotionLabel, number>`（GoEmotions 28 类全量、每类 0..1）+ `baseline {valence, arousal}`（性情基线，默认 0.2/0.3）+ `updatedAt`。
- `PlotEvent`：`{ id, type, target: self|host|other, intensity [0,1], at }`；类型 11 种（kind_act / hostile_act / praise / criticism / loss / gain / threat / surprise / companion_joy / companion_sad / neutral）。
- 规则引擎（`src/affect/plotRules.ts`，纯函数）：`PLOT_EVENT_RULES` 事件→增量表；`applyPlotEvents` = 先按 `AFFECT_DECAY_RATE`（0.15）指数回归基线/标签归零，再叠加事件增量（intensity 线性缩放），全程裁剪；`computeAffinityDelta` 只累计 target=host 的事件，每调用上限 `MAX_TICK_AFFINITY_DELTA`（10）。
- 分工：affect 快照管"现在怎样"，记忆流管"发生过什么"；`AgentMood`（自由文本+强度，对话分析产出）与 `AffectState`（剧情引擎产出）并存，互不覆盖；对话产生的 `EmotionSignature` 只打记忆，不写 AffectState。

## 契约流

- tick（realm-agent-step.v1）：输入 `affectState?`（宿主当前快照）+ `plotEvents?`；输出 `affectProposal { affect（完整新状态）, affinityDelta（向宿主）}`——只在携带二者之一时出现。宿主决定应用（`RealmStateStore.applyAffectProposal` 单点）。
- 对话（realm-conversation.v1）：请求可带 `affect?`；prompt 注入 `Current emotional state: <象限+显著标签>` + 表达约束（高唤起→短促急促；低效价→沉重克制；fear≥0.55→回避不安；anger≥0.55→言辞带刺）；情感分析 prompt 也携带 affect 作为 mood 提议的锚点。
- 宿主：`RealmHost.plotEvent()` 即时应用（同引擎）；tick 每周期应用衰减；`POST /v1/host/plot` API（400 可见校验）；聊天页徽标显示情绪、剧情投喂行。
- 时间一律调用方传入；引擎确定性（同输入同输出）；测试全离线。

## 校验规则

- `validateAffectState`：28 标签必须全量存在且 0..1；valence/arousal/baseline 越界拒写（AffectValidationError，collect-then-throw）。
- `validatePlotEvent`：type/target 枚举、intensity 0..1、id 非空、at 合法 ISO。
- tick/对话执行器把 AffectValidationError 包成各自的 ValidationError，路径带 `agents[i].affectState` / `affect` 前缀。

## 后续候选（未做）

- EPA 词典全量 ACT（引入 actdata 系数）替换增量表——需文化词典获取/翻译成本，超出当前范围。
- tick 轨记忆打情感签名（引擎已产出状态，接 `MemoryRecord.emotion` 即可）。
- realm.json 剧情脚本（按时间/周期投喂 PlotEvent 序列）。
- 情感弧线叙事（反思引用"本周好感从 X 涨到 Y"）。
