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
| rexgoap / GOAP 系、Big Five 实现集合 | MIT/各自 | 稳定特质做行为偏置；mood 做短期波动；本包采用显式六维 0–100 配置，不复制其实现 |

规则：Apache/MIT 可参考实现；AGPL/研究用途只借鉴设计不复制代码。

## 契约

- `RealmStructuredPersonaV1`：`{identity, personality, values, speechStyle, boundaries[], behaviorTraits[], exampleLines[], baseline?, affectModifiers?, emotionResponsiveness?, personalityDimensions?（六个可选维度 sociability/empathy/rationality/courage/curiosity/independence，均为 0–100，缺失按 50）}`；必填四字段（identity/personality/values/speechStyle）为非空字符串，三个数组可选（校验器对 undefined 默认 `[]`），`baseline {valence, arousal}` 可选（valence -1..1、arousal 0..1，越界拒写），`affectModifiers` 可选（事件类型→非负响应倍率，未知类型/负值拒写），`emotionResponsiveness` 可选（0..1，对话情感闭环权重，默认 0.1）。
- `persona` 字段类型统一为 `string | RealmStructuredPersonaV1`（realm.json 配置、RealmConversationAgentV1、LifeNarrativeInput、LlmReflectionPlannerOptions）。
- 渲染单一事实来源：`personaSections()`（src/conversation/conversationPrompt.ts 导出）——字符串 → 旧式单节 `Persona:\n...`；结构化 → Identity/Personality/Values/Speech style 四节 + 可选内部 Personality dimensions（数值与 5 段语义，不向参与者暴露）/Character boundaries（红线）/Behavior tendencies/Speech examples 三节。**三个数组必须 `?? []` 容错**（校验器允许缺省，渲染函数要匹配该语义，勿假设数组必在）。
- 消费点：对话 system prompt、life narrative（tick 日记）、夜间反思——三处共用 personaSections，不各自拼装。
- 参与者画像：`RealmUserConfig` / `RealmConversationParticipantV1` 可选 `profile`（非空字符串校验）；对话 prompt 注入「About 主人: ...」节（缺省不注入）；宿主 config.user 自动透传。
- 参与者情绪：`message.emotion {valence -1..1, arousal 0..1}` 可选（校验器拒绝越界）；buildReplyInput 透传 participantEmotion，piConversationReplyPort 在 user 消息追加共情提示（down/in good spirits/composed）。
- 叙事情感注入：lifeNarrative 接受 `affect`，把 `describeAffectState` 描述注入日记 prompt 的 user 消息；同一快照同时作为记忆 emotion 签名。
- **OOC 三轨防线**：`detectOocLeak` 覆盖全部 LLM 输出面——对话回复（analysisReason 标注 + 聊天页 ⚠️ 气泡；泄露回复不进入 agent 历史、生成记忆或情绪关系闭环）、叙事日记与夜间反思（写入前检测，泄露文本进入 tick notes 并隔离出记忆流；self-concept proposal 同样拒绝身份泄露）。`isCharacterVisibleMemory` 是角色可见 memory 的单一投影，统一排除旧 OOC、`visibility=system` 计划、`reflectionSource=deterministic` 反思和参与者 OOC 元对话，供对话召回、叙事连续性、nightly evidence 与 self-concept provenance 复用；原始记录只供 Host / Admin 诊断。affect analysis 的自由文本 mood 必须为短且无 OOC / 内部机制的描述，污染 mood 不写入、不回注。
- 叙事关系弧线：lifeNarrative 接受 `relationshipArc`，日记注入「Relationship today: ... moved from X to Y」（当日≥2 条且首末不同）；宿主 runNarratives 计算传入——日记与夜间反思都引用关系演变。
- 性格调制：`applyPlotEvents` / `computeAffinityDelta` 接受可选 `modifiers`（事件类型→倍率，缺省 1）；宿主 plotEvent 将显式 `persona.affectModifiers` 与六维固定事件倍率合成（全维 50 为 1，倍率范围 0.5..1.5），手动投喂与剧情脚本共用该路径；服务契约（tick 轨）不动。
- 情绪外露度：`blendConversationEmotion` 接受可选 `rate`（缺省 0.1）；宿主按 `persona.emotionResponsiveness` 调制对话情感闭环权重。

## 校验规则

- realm.json：`validatePersona`（realmState.ts）——字符串非空；对象四必填非空 + 数组为字符串数组；`personalityDimensions` 仅接受已知维度，值为 0..100 的有限数值。
- 对话请求：`validatePersona`（realmConversationExecutor.ts）同规则，`personalityDimensions` 仅接受已知维度，错误前缀 `agent.persona.*`。
- 校验器重建对象（非引用相等），测试断言用 `deepEqual`。

## 不变量

- 保持旧字符串兼容：字符串 persona 渲染结果与升级前逐字节一致（`Persona:\n` 单节），旧 realm.json 无需迁移。
- persona 是静态配置（realm.json 权威），不写入记忆流（P5「自我认知记忆」延后，YAGNI）。
- 不引入 OCEAN/EPA 兼容层、行为树、GOAP 引擎；六维数值由统一规则映射到 prompt、routine 和 Host 事件响应，LLM 只负责文本表现。

## 已知坑

- measure（.auto/fidelity-scenarios.json）的 needle 必须匹配 prompt 实际输出文本（节标题如 `Identity:`、内容如「粉色妖精小姐」），匹配内部字段名会永远 MISS（历史事故）。
- realm.json 默认爱莉希雅已是结构化角色卡（往世乐土设定 + ♪ 口癖 + OOC 红线），改它前确认不脱离游戏设定。
