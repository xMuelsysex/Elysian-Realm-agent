# Autoresearch: 角色生动性战役（把崩坏三角色变成活生生的人）

## Objective

从开源项目学习「人物性格、行为」塑造做法（SillyTavern 角色卡字段化 / CharacterGLM 分层 prompt / ChatHaruhi few-shot / Letta memory blocks / Big Five 行为偏置 / GOAP 代价思想），把 Elysian Realm Agent 的角色从「单段 persona 字符串」升级为「结构化角色契约 + 分块 prompt 注入 + OOC 红线」，让爱莉希雅等崩坏三往世乐土角色在对话与 tick 叙事中更鲜活、一致、不 OOC。

方案全文：`.pi/plans/character-liveliness.md`（已批准）。

## Metrics

- **Primary**: `character_fidelity`（0-100，higher is better）——5 个代表性场景下 system prompt 注入要素完整度（身份/性格/价值观/说话风格/红线/示例/情感/关系/记忆）。
- **Secondary**: `tests`（npm test 通过数，基线 177，只增不减）、`prompt_bytes`（注入信息密度，防无脑膨胀）。

## How to Run

`./.auto/measure.sh` — 输出 `METRIC name=value` 行。

## Files in Scope

- `src/service/realmConversationV1.ts` — RealmConversationAgentV1.persona 类型扩展（字符串 | 结构化角色卡）
- `src/host/realmState.ts` — RealmPersonaConfig 扩展 + validateAgent 校验
- `src/conversation/conversationPrompt.ts` — buildConversationSystemPrompt 分块注入（identity/personality/values/speechStyle/boundaries/exampleLines）
- `src/service/realmStepExecutor.ts` — tick 叙事 prompt 注入性格节
- `realm-data/realm.json` — 爱莉希雅结构化角色卡（游戏设定：往世乐土逐火十三英桀「粉色妖精小姐」、♪ 口癖、开朗俏皮、喜欢花与美好事物、真诚）
- `tests/` — conversationPrompt 结构化注入测试、realm.json 校验测试、叙事性格节测试
- `.auto/` — 会话文件

## Off Limits

- `src/llm/`、`src/conversation/piConversationReplyPort.ts`、`src/service/conversationBootstrap.ts`（pi 接缝）
- 四条核心不变量（包根零 pi / 宿主权威 / 快照-记忆分工 / 确定性）；hostAuthorityBoundary 守卫文件
- 不新增 npm 依赖；不引入 EPA/OCEAN 数值模型、行为树、GOAP 引擎（YAGNI，方案已注明）
- realm-data/realm.sqlite（宿主持久化数据）

## Constraints

- 纯函数拼装、时间调用方传入、LLM 只在两个接缝 fake
- persona 兼容旧字符串（迁移：旧字符串作为 identity）
- 每个新增行为必须有离线确定性测试；npm test 全绿才 keep
- 角色设定必须忠于崩坏三往世乐土（爱莉希雅：粉色妖精小姐、♪ 口癖、开朗俏皮、真诚喜欢眼前的人、喜欢花和美好事物）——不可 OOC

## What's Been Tried

（2026-08-10 战役一：P1-P4 完成）

- **P1 结构化角色契约** ✅：`RealmStructuredPersonaV1`（identity/personality/values/speechStyle/boundaries/behaviorTraits/exampleLines），realm.json + DEFAULT_REALM_CONFIG 升级爱莉希雅角色卡（往世乐土设定+♪+OOC 红线），字符串 persona 兼容（旧路径逐字节不变）。
- **P2 说话风格注入** ✅：personaSections 纯函数分块渲染，对话 prompt 注入 Speech style + Speech examples（few-shot 口吻锚）。
- **P3 OOC 红线** ✅：boundaries 注入「Character boundaries (never break these)」节，正向表述。
- **P4 叙事/反思复用** ✅：lifeNarrative + llmReflectionPlanner 共用 personaSections（tick 轨也吃角色契约）。
- **双校验器**：realmState.validatePersona + conversationExecutor.validatePersona（同规则，可选数组默认 []，渲染必须 ?? [] 容错）。
- **测试**：characterContract.test.ts 8 条（分块/兼容/缺字段/校验拒绝/叙事反思注入）。185 tests 全绿；verify:e2e 10 项 PASS（宿主全链路零破坏）。
- **指标**：fidelity 36→100（measure 缺陷修正：needle 匹配 prompt 节标题与内容，非内部字段名）；prompt_bytes 3102→5217（信息密度合理增加）。
- 死路/教训：measure 场景 persona 缺必填字段会崩渲染函数（可选数组 ?? []）；校验器重建对象非引用相等（deepEqual）。

待探索（ideas.md）：P5 角色自我认知记忆（延后，YAGNI）；行为倾向数值化权重（不引入，保持描述注入）。
