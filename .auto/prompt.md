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

（实验循环开始后更新。基线：现有 177 tests 全绿，persona 为单段字符串注入。）
