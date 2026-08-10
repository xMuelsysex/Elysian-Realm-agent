# 角色生动性战役：把崩坏三角色变成活生生的人

日期：2026-08-10
状态：**已批准执行**（用户指令：planner 方案 → 实现）
分支：`autoresearch/character-liveliness-2026-08-10`

## 目标

向开源项目学习「人物性格、行为」塑造做法，让崩坏三往世乐土角色（爱莉希雅等）在对话与 tick 行为中更鲜活、更一致、不 OOC（不脱离游戏设定）。最小有效改动，保持四条核心不变量、确定性、离线测试、零新运行时依赖。

## 调研摘要（三个子代理：planner + 2 scout）

| 来源 | 许可证 | 借鉴点 |
|---|---|---|
| SillyTavern character-card-spec-v2 | 规范公开（本体 AGPL） | 角色卡字段化组织：identity/personality/values/speech_style/boundaries/examples |
| THUDM/CharacterGLM-6B | 研究用途（仅借鉴设计） | 中文角色扮演分层 prompt：身份背景/性格原则/表达风格/关系/禁区 |
| Letta (MemGPT) | Apache-2.0 | persona memory blocks 外化；宿主权威写入 |
| ChatHaruhi | 需核验（仅借鉴） | 对话示例（few-shot）注入保持口吻 |
| Reflexion | MIT | 反思写入受宿主批准；短反思约束 OOC |
| rexgoap / GOAP | MIT | 行为选择用目标+代价；人格/情绪进代价函数 |
| Big Five 实现集合 | 各自 | 稳定特质做行为偏置权重；mood 做短期波动 |
| BehaviorTree.CPP / behavior-tree | MIT | tick 结果组织为先决条件→候选行为；黑板=宿主输入快照 |
| generative_agents | Apache-2.0 | 记忆流/反思（已有）；identity 拆分 |
| goemotions / ACT 相关 | 已有（见 affect.md） | 已有情感体系不重造 |

复用边界：Apache/MIT 参考实现；AGPL/CC BY-NC/研究用途仅借鉴设计，不复制代码。增量表数值是校准常量。

## 落地特性（按优先级）

### P1 结构化角色契约（character contract）

现状：`RealmPersonaConfig.persona` 单段字符串 → 对话 prompt 整段注入。
改：persona 升级为可选结构化对象（兼容旧字符串，迁移规则：旧字符串作为 identity 保留）：
`{ identity, personality, values, speechStyle, boundaries, behaviorTraits, exampleLines }`

- `src/host/realmState.ts`：`RealmPersonaConfig` 扩展 + `validateAgent` 校验（persona 为字符串或对象；对象各字段非空字符串/字符串数组）
- `src/service/realmConversationV1.ts`：`RealmConversationAgentV1.persona` 同样扩展（与服务契约对齐）
- `src/conversation/conversationPrompt.ts`：`buildConversationSystemPrompt` 分块注入（identity/personality/values/speechStyle/boundaries/examples 各一节，缺失字段跳过）
- `realm-data/realm.json`：爱莉希雅升级为结构化角色卡（游戏设定：往世乐土逐火十三英桀「粉色妖精小姐」、开朗俏皮、♪ 口癖、喜欢花与美好事物、真诚）

### P2 说话风格注入（speechStyle + exampleLines）

借鉴：CharacterGLM 口吻分层、ChatHaruhi few-shot、角色卡 mes_example。
- speechStyle：口癖/句式/称呼/节奏描述文本
- exampleLines：2-3 条角色口吻示范对话（纯文本行，注入 prompt 作为风格锚）
- 确定性：纯函数拼装，离线断言 prompt 含风格行

### P3 OOC 红线（boundaries）

借鉴：角色卡红线、正向约束描述。
- boundaries：角色不可越界的设定（如「始终保持爱莉希雅的开朗温柔，不脱离往世乐土世界观」「不会承认自己是 AI/程序」等）
- prompt 注入「Character boundaries（不可逾越）」节；正向表述为主
- 离线测试：断言 boundaries 出现在 prompt

### P4 性格驱动行为偏置（behaviorTraits）

借鉴：Big Five → 行为倾向权重；GOAP 代价；行为树优先级。
- behaviorTraits：稳定行为倾向列表（如「外向：主动发起话题」「温柔：回避尖锐回应」）
- tick 叙事注入：realmStepExecutor 叙事 prompt 增加性格节（叙事更贴角色）
- 对话 prompt 注入行为倾向作为表达约束补充
- 保持纯函数；不引入数值权重体系（YAGNI：当前无行为候选选择器）

### P5（延后）角色自我认知记忆

Letta persona block 思路，但当前 persona 权威在 realm.json，无需复制一份进记忆流。延后。

## 明确不做

- 不引入 EPA 词典 / OCEAN 数值模型 / 行为树 / GOAP 引擎（无候选行为选择器需求，YAGNI）
- 不做 LLM 反思 OOC 校验（LLM 只在两个接缝，且上游 503 不可用；改为 prompt 注入约束 + 离线结构断言）
- 不新增 npm 依赖
- 不改四条核心不变量；不触碰宿主权威边界

## 实施顺序

1. P1 类型与校验（realmState / realmConversationV1 / conversationPrompt）
2. P2 风格注入 + P3 红线注入（同文件，一块做完）
3. P4 tick 叙事注入（realmStepExecutor）
4. realm.json 爱莉希雅角色卡升级
5. 测试：conversationPrompt 结构化注入（分块/缺字段跳过/兼容旧字符串）、realm.json 校验、叙事含性格节；跑 npm test 全绿
6. 收尾：spec 沉淀 + journal

## 度量（autoresearch）

- **主指标**：`character_fidelity`（0-100 分）——对 5 个代表性对话场景构造 system prompt，检查注入要素完整度：身份/性格/价值观/风格/红线/示例/情感状态/关系/记忆（每要素加权）。反映「人设被工程化承载」的完整度，LLM 不可用时可离线诚实测量。
- **副指标**：`tests`（npm test 通过数，基线 177）、`prompt_bytes`（注入信息密度，防膨胀）。
- **防作弊**：fidelity 场景与要素清单固定写死在 measure 脚本外（.auto/fidelity-scenarios.json），实现只读场景不读评分逻辑；checks.sh 跑 npm test 全量，破坏测试即 discard。

## 验证命令

- `npm run typecheck`
- `npm test`（build + 测试编译 + node --test 全离线）
- `.auto/measure.sh`（fidelity 评分 + tests 计数）
