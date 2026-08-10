# 结构化角色契约（Character Contract）约定

改动 persona 相关代码（realm.json、persona 类型、prompt 注入、校验器）前先读本文。来源：`src/service/realmConversationV1.ts`（契约类型）、`src/conversation/conversationPrompt.ts`（渲染）、`src/host/realmState.ts`（配置校验）、`src/service/realmConversationExecutor.ts`（请求校验）。

## 设计来源（2026-08-10 网络核验，三个子代理调研）

| 项目 | 许可证 | 借鉴点 |
|---|---|---|
| SillyTavern character-card-spec-v2 | 规范公开（本体 AGPL） | 角色卡字段化组织（identity/personality/values/speech_style/boundaries/examples） |
| THUDM/CharacterGLM-6B | 研究用途（仅借鉴设计） | 中文角色扮演分层 prompt：身份/性格/表达风格/关系/禁区 |
| Letta (MemGPT) | Apache-2.0 | persona memory blocks 外化；宿主权威写入 |
| ChatHaruhi | 需核验（仅借鉴） | 对话示例（few-shot）注入保持口吻 |
| Reflexion | MIT | 反思受宿主批准；prompt 注入保持角色视角 |
| rexgoap / GOAP 系、Big Five 实现集合 | MIT/各自 | 稳定特质做行为偏置；mood 做短期波动（本包仅注入描述，不引入数值权重） |

规则：Apache/MIT 可参考实现；AGPL/研究用途只借鉴设计不复制代码。

## 契约

- `RealmStructuredPersonaV1`：`{identity, personality, values, speechStyle, boundaries[], behaviorTraits[], exampleLines[], baseline?, affectModifiers?}`；必填四字段（identity/personality/values/speechStyle）为非空字符串，三个数组可选（校验器对 undefined 默认 `[]`），`baseline {valence, arousal}` 可选（valence -1..1、arousal 0..1，越界拒写），`affectModifiers` 可选（事件类型→非负响应倍率，未知类型/负值拒写）。
- `persona` 字段类型统一为 `string | RealmStructuredPersonaV1`（realm.json 配置、RealmConversationAgentV1、LifeNarrativeInput、LlmReflectionPlannerOptions）。
- 渲染单一事实来源：`personaSections()`（src/conversation/conversationPrompt.ts 导出）——字符串 → 旧式单节 `Persona:\n...`；结构化 → Identity/Personality/Values/Speech style 四节 + 可选 Character boundaries（红线）/Behavior tendencies/Speech examples 三节。**三个数组必须 `?? []` 容错**（校验器允许缺省，渲染函数要匹配该语义，勿假设数组必在）。
- 消费点：对话 system prompt、life narrative（tick 日记）、夜间反思——三处共用 personaSections，不各自拼装。
- 叙事情感注入：lifeNarrative 接受 `affect`，把 `describeAffectState` 描述注入日记 prompt 的 user 消息；同一快照同时作为记忆 emotion 签名。
- 性格调制：`applyPlotEvents` / `computeAffinityDelta` 接受可选 `modifiers`（事件类型→倍率，缺省 1）；宿主 plotEvent 传 `persona.affectModifiers`（手动投喂 + 剧情脚本自动继承）；服务契约（tick 轨）不动。

## 校验规则

- realm.json：`validatePersona`（realmState.ts）——字符串非空；对象四必填非空 + 数组为字符串数组。
- 对话请求：`validatePersona`（realmConversationExecutor.ts）同规则，错误前缀 `agent.persona.*`。
- 校验器重建对象（非引用相等），测试断言用 `deepEqual`。

## 不变量

- 保持旧字符串兼容：字符串 persona 渲染结果与升级前逐字节一致（`Persona:\n` 单节），旧 realm.json 无需迁移。
- persona 是静态配置（realm.json 权威），不写入记忆流（P5「自我认知记忆」延后，YAGNI）。
- 不引入 OCEAN/EPA 数值权重、行为树、GOAP 引擎——行为倾向以描述注入 prompt，由 LLM 在接缝处执行。

## 已知坑

- measure（.auto/fidelity-scenarios.json）的 needle 必须匹配 prompt 实际输出文本（节标题如 `Identity:`、内容如「粉色妖精小姐」），匹配内部字段名会永远 MISS（历史事故）。
- realm.json 默认爱莉希雅已是结构化角色卡（往世乐土设定 + ♪ 口癖 + OOC 红线），改它前确认不脱离游戏设定。
