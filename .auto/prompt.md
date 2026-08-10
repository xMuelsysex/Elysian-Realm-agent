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

（2026-08-10 战役一~十九全部完成，fidelity 36→100，tests 177→229，verify:e2e 10→13 项，浏览器验证多轮）

- **P1 结构化角色契约** ✅：`RealmStructuredPersonaV1`（identity/personality/values/speechStyle/boundaries/behaviorTraits/exampleLines），realm.json + DEFAULT_REALM_CONFIG 升级爱莉希雅角色卡（往世乐土设定+♪+OOC 红线），字符串 persona 兼容（旧路径逐字节不变）。
- **P2 说话风格注入** ✅：personaSections 纯函数分块渲染，对话 prompt 注入 Speech style + Speech examples（few-shot 口吻锚）。
- **P3 OOC 红线** ✅：boundaries 注入「Character boundaries (never break these)」节，正向表述。
- **P4 叙事/反思复用** ✅：lifeNarrative + llmReflectionPlanner 共用 personaSections（tick 轨也吃角色契约）。
- **多英桀** ✅：默认配置新增梅比乌斯（差异化角色卡），chat 页选择器激活，e2e 多 agent 断言。
- **OOC 泄露检测** ✅：oocGuard 纯函数 9 模式 4 标签（我是AI/作为语言模型/as an AI/I am an AI/游戏角色/虚拟存在/否认情感/I'm just a bot/说实话我是AI），宿主 chat/chatStream 双路径 analysisReason 追加 ooc-leak 标注；聊天页 SSE+JSON 双路径显示 ⚠️ 气泡（浏览器验证）。
- **tick 轨情感签名** ✅：runLifeNarrative 接受 emotion，narrative 记忆带当前 affect 快照。
- **剧情脚本** ✅：realm.json plotScript 按 period 自动投喂；修复 affinity 小数×INTEGER 列崩溃（storeAffinity round）。
- **角色化性情基线** ✅：persona.baseline（ACT 人因而异），tick 首轮初始化 affect，衰减回归目标因人而异。
- **叙事情感注入** ✅：lifeNarrative prompt 注入 describeAffectState 当前情感描述。
- **对话情感闭环** ✅：宿主以权重把对话 emotion 签名逼近 AffectState（blendConversationEmotion，plot 仍主导）。
- **性格调制** ✅：persona.affectModifiers 按事件类型缩放情感/亲和响应（爱莉希雅珍惜夸奖/梅比乌斯记仇）。
- **关系弧线叙事** ✅：relationship_history 表 + 夜间反思注入当日关系轨迹。
- **对话关系感知** ✅：prompt 注入 Relationship trajectory 行（≥2 条且首末不同）。
- **情绪驱动行为** ✅：routine 可选 mood 偏好，宿主按 affect 象限选例程（低落时待家里/独处实验室）。
- **反思可见化** ✅：state 摘要 latestReflection + 聊天页「🌙 她最近在想」（浏览器验证）。
- **情绪外露度** ✅：persona.emotionResponsiveness 调制对话情感闭环权重（爱莉希雅 0.15/梅比乌斯 0.05）。
- **参与者画像** ✅：user/participant 可选 profile 注入「About 主人」节。
- **度量覆盖** ✅：measure 8 场景（日常问候/结构化全要素/情感注入/关系与记忆/OOC 红线/梅比乌斯差异化/关系轨迹/参与者画像）内容级 needle 全 HIT；checks.sh 全量测试门禁。
- **e2e** ✅：verify-sse 13 项（含多 agent 断言、relationship_history 落库断言）。
- 死路/教训（勿重复）：measure needle 须匹配 prompt 实际输出文本（节标题/内容），匹配内部字段名永远 MISS；校验器重建对象非引用相等（deepEqual）；默认配置形态变化会破坏依赖默认配置的测试（改与 config 一致的健壮断言）；ESM 测试不能用 require；async 方法 void 调用竞态（须 await）；edit 大块替换残留闭括号 TS1128；destructure 漏新字段 ReferenceError；浮点断言需容差；同 day 同 period 不重复 tick；hostile_act 一次只到 -0.15 边界需两次；fakeRunner 需带 affinityDelta 才移动关系。
