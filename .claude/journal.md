# Elysian Realm Agent — 项目记忆（倒序）

## 2026-08-10 二十二轮补：OOC 泄露检测 + tick 轨情感签名（autoresearch 战役二三）

- 战役二 OOC 泄露检测：`src/conversation/oocGuard.ts` 纯函数 detectOocLeak（中英泄露形态：我是AI/作为语言模型/as an AI/I am an AI/游戏角色/说实话我是AI）；宿主 chat+chatStream 双路径在 analysisReason 追加 `ooc-leak:` 标注（不拦截回复，只让泄露可见）。+6 测试。
- 战役三 tick 轨情感签名（affect.md 候选）：`runLifeNarrative` 接受 emotion 参数写入 observation 记忆；宿主 runNarratives 把当前 affectState 快照 valence/arousal 打进每条 narrative 记忆。tick 与对话两轨记忆现在都带情感签名，反思情感弧线证据更完整。+2 测试。
- 193 tests 全绿 + verify:e2e 12 项；fidelity 100 保持。
- 坑：OOC 检测模式需覆盖「作为语言模型」「I am an AI」形态（最初只有「我是」与 "as an" 形态，测试抓出缺口）。

## 2026-08-10 二十二轮：角色生动性战役一——结构化角色契约（autoresearch character-liveliness）

- 用户需求：从 GitHub 开源项目学习「人物性格、行为」塑造，把崩坏三往世乐土角色变成活生生的人，不 OOC。planner 子代理（gpt-5.6-sol）+ 双 scout 调研，方案落盘 `.pi/plans/character-liveliness.md`（已批准执行）。
- 借鉴：SillyTavern character-card-spec 字段化、CharacterGLM 分层 prompt、Letta persona blocks、ChatHaruhi few-shot、Reflexion、GOAP/Big Five（仅描述注入，不引入数值权重）→ 全部映射在 `.claude/specs/character-contract.md`。
- 落地 P1-P4：`RealmStructuredPersonaV1`（identity/personality/values/speechStyle/boundaries/behaviorTraits/exampleLines）；`personaSections()` 纯函数分块注入（对话 prompt + lifeNarrative + 反思三处复用）；双校验器（realmState.validatePersona + conversationExecutor）；旧字符串 persona 兼容（逐字节不变）；默认配置新增第二位英桀梅比乌斯（差异化：冷静科学家 vs 爱莉希雅开朗）。
- 验证：185 tests 全绿（+8 characterContract.test.ts）；verify:e2e 12 项 PASS（新增多 agent 断言：state 列出梅比乌斯 + 独立聊天 + 历史持久化）；浏览器验证 chat 页多角色选择器切换+聊天+徽标全 PASS。
- 指标：character_fidelity 36→100（measure 修正：needle 须匹配 prompt 实际输出文本而非内部字段名）。
- 坑：校验器重建对象非引用相等（deepEqual）；可选数组渲染须 ?? [] 容错；多 agent 默认配置破坏两个依赖单 agent 的测试（改健壮断言）；fuser 清理端口；favicon 404 无害。
- 候选延后：P5 自我认知记忆、行为数值权重、示例场景化检索、OOC 事后校验、性格调制衰减——见 `.auto/ideas.md`。

## 2026-08-09 二十一轮：剧情投喂 UI 验证（autoresearch exp54）

- 剧情投喂浏览器级全流程（夸赞→pride 0.50/joy 0.40 气泡+徽标更新）。chat 页全部交互与 admin 页浏览器级验证完毕，UI 覆盖闭合。

## 2026-08-09 二十一轮：E2E 覆盖审计（autoresearch exp50）

- harness（流式链路 4 端点）+ 单元 + 浏览器 + 双进程 smoke：验证矩阵完整，无值得补的洞。

## 2026-08-09 二十一轮：admin 页浏览器验证（autoresearch exp48）

- admin 页全流程浏览器级验证：渲染、保存→热加载（来源翻转 admin）+ stats 即时刷新（exp32 特性确认）、测试连接清晰错误。chat+admin 双页面产品面覆盖闭合。

## 2026-08-09 二十一轮：回归测试双守卫（autoresearch exp46）

- 页面脚本测试强化：渲染后状态分类正则必须存活（String.raw 精确断言）+ 退格控制符守卫。模板转义语义破坏（\n、\b）双守卫。

## 2026-08-09 二十一轮：错误气泡友好化（autoresearch exp45）

- 聊天错误气泡按状态码分类文案（5xx/429/4xx/通用）+ 暗色细节行；UI 不挂。浏览器验证再抓模板转义 bug（正则 \b→退格控制符）→ 双重转义 + 回归测试。教训：chatPage 内联 JS 正则必须 \\ 转义。

## 2026-08-09 二十一轮：503 故障路径验证（autoresearch exp44）

- 浏览器级验证用户当前真实场景（上游 503）：聊天错误气泡清晰显示、UI 不挂、输入恢复；tick 叙事失败优雅降级。事故：env var 笔误（ELYSIAN_REALM_DATA_DIR→ELYSIAN_REALM_DATA）致 host 跑在真实 realm-data，影响仅一次按日期 tick+叙事 note，无数据丢失；正确变量名已存记忆 #4。

## 2026-08-09 二十一轮：完整故障诊断（autoresearch exp42）

- 中转 /models 200（13 模型）+ 逐一探测 chat 全 503 → 上游 LLM 后端整体离线。等中转方修复或主人另配中转；代理侧就绪。

## 2026-08-09 二十一轮：探测升级（autoresearch exp41）

- 中转 /models 200 + /chat/completions 503：基础设施在线，上游 LLM 后端故障。可操作：向中转方反馈或切换其上游/模型。

## 2026-08-09 二十一轮：检索性能基准（autoresearch exp39）

- 记忆检索线性 ~7µs/条：100→5.6ms、1k→6.5ms、5k→31ms、10k→85ms、20k→144ms。10k+ 肉眼可见。数据入 governance spec：清理到 <5k 保 <35ms，方案 A 获量化依据。

## 2026-08-09 二十一轮：自重建认证与收尾（autoresearch exp37）

- npm ci 冷装 + 全量 verify 通过：仓库从干净检出完全自重建，发布就绪最终认证。ideas.md 清理归档，仅剩治理执行（待批准）与真实 LLM 验证（待中转）。

## 2026-08-09 二十一轮：记忆治理设计提案（autoresearch exp36）

- .claude/specs/memory-governance.md 落盘（设计不执行）：方案 A（90 天未用+importance<=3 清理，SQL/dry-run/单事务）、方案 B（500 turns 上限）、POST /v1/host/govern 端点形态；spec 挂索引。决策材料齐备。

## 2026-08-09 二十一轮：发布安全核对（autoresearch exp35）

- npm pack dry-run 确认：166 文件零泄漏（无 tests/.auto/realm-data/src）、5 导出子路径含 .js+.d.ts+.map、private:true。发布结构完全干净，随时可发布。

## 2026-08-09 二十一轮：service 进程 smoke（autoresearch exp34）

- 独立 service（npm run start）真实启动验证：healthz/readyz、错误信封逐字段校验、确定性 tick 全管线（四阶段 ran+例行回退）、优雅退出。两个进程入口（host+service）全部真实启动验证完毕。

## 2026-08-09 二十一轮：实验门禁强化（autoresearch exp33）

- .auto/checks.sh 织入 verify:e2e：自动回滚门升级为单元+typecheck+帧级 E2E（本战役 4 个真 bug 所在层，此前不在门内）。全门 9.1s 全绿。

## 2026-08-09 二十一轮：最终打磨（autoresearch exp32）

- admin 保存后 stats 行即时刷新；README 增 Known limitations（node:sqlite 状态/历史无界增长/stats 治理数据/SSE 徽标延迟/浏览器验证手动）。177 tests 全绿。

## 2026-08-09 二十一轮：战役知识持久化与收尾（autoresearch exp31）

- 持久知识写入 ctx_memory（架构总览/验证命令与陷阱/悬置事项）；隐私确认 realm-data 从未入库；177 tests + verify:e2e 全绿。可自主推进项彻底穷尽，剩余均需用户决策或外部恢复。

## 2026-08-09 二十一轮：admin 存储统计展示（autoresearch exp30）

- admin 页新增 refreshStoreStats：best-effort 拉 /v1/host/stats 渲染「存储：N 记忆/M 对话（每 agent 明细，90 天未用数）」；端点缺失静默忽略。浏览器实测渲染正确。30 个实验里程碑达成。

## 2026-08-09 二十一轮：pi 升级后最终验收（autoresearch exp29）

- 浏览器三路径复测（chat SSE 流式、admin 测试连接、历史刷新）全 PASS——pi 0.84.1 升级后全链路无回归。配合 177 tests + verify:e2e 10 项，验收闭环完成。

## 2026-08-09 二十一轮：依赖卫生与 pi 升级（autoresearch exp28）

- npm audit 0 漏洞、npm ls 树干净。按项目约定对照 changelog 审查后升级 pi 系 0.82.1→0.84.1（breaking 仅涉未使用的 provider 内部 API；0.84.1 含 request-buffer-limit 重试修复）。适配器零改动，177 tests + verify:e2e 10 项全 PASS。@types/node 22 与 TS 7 有意不追。

## 2026-08-09 二十一轮：带历史刷新验证（autoresearch exp27）

- chat 页聊一次后刷新：历史气泡从 /v1/host/history 渲染、徽标从持久化恢复、空状态提示消失——全 PASS。页面双场景（空目录/带数据）浏览器验证完毕。

## 2026-08-09 二十一轮：宿主权威守卫（autoresearch exp26）

- 核心不变量 #2 机械化：hostAuthorityBoundary.test.ts 断言两个执行器禁导入 node:fs/node:sqlite/../host——服务层保持纯函数。四不变量 3/4 机械化（#1/#2/#4）；#3 语义约束难静态化。177 tests 全绿。

## 2026-08-09 二十轮：确定性守卫（autoresearch exp25）

- 核心不变量 #4 机械化：determinismBoundary.test.ts 扫描 src，无参 Date.now()/new Date() 仅允许在时钟权威边界（realmHost 注入时钟默认 + 两个 pi 适配器的 SDK 消息时间戳——设计内例外显式 allowlist）；new Date(expr) 纯派生始终允许。负向对照（注入违规→守卫抓到）验证非空转。176 tests 全绿。

## 2026-08-09 十九轮：包边界守卫（autoresearch exp24）

- 核心不变量 #1「包根入口零 pi 依赖」机械化：tests/packageBoundary.test.ts 从 dist/index.js BFS 遍历 re-export 图断言无 pi 运行时导入（负向走编译产物——type-only 会被擦除），正向对照三个 pi 子路径源码必须导入 pi。此前仅靠约定，现在改坏会被测试拦下。175 tests 全绿。

## 2026-08-09 十八轮：发布就绪收尾（autoresearch exp23）

- `npm run verify`（npm test + verify:e2e 一键全量）；.env.example 补 ELYSIAN_REALM_DATA；README/spec 同步留存字段与验证命令。engines 已与 node:sqlite 要求一致。全绿。

## 2026-08-09 十七轮：留存诊断（autoresearch exp22）

- stats 增每 agent oldestMemoryAt + staleMemories（90 天未用 = 治理候选）与 totals 汇总；stats(now) 时钟注入保持确定性。治理决策的只读数据齐备（追溯深度 + 候选规模）。

## 2026-08-09 十六轮：admin 目录模式浏览器验证（autoresearch exp21）

- 官方目录 radio 切换：自定义字段隐藏、Provider 下拉 35+ 厂商、Model 随 provider 联动（离线 pi-ai 内置目录，无需中转）——全 PASS。
- 至此两个页面全部路径浏览器验证完毕（chat 四条 SSE 路径+投喂；admin 自定义模式/测试连接/保存/目录切换）。

## 2026-08-09 十五轮：浏览器 SSE 错误路径验证（autoresearch exp20）

- 无 LLM 宿主 + stream:true 聊天 → error 帧 → 页面显示错误气泡 + 输入重新启用，全 PASS。页面四条 SSE 路径（delta/done/applied/error）至此全部浏览器验证。

## 2026-08-09 十四轮：URI 健壮性修复（autoresearch exp19）

- GET /v1/host/history/%zz（畸形百分号编码）此前让 decodeURIComponent 抛 URIError → handler 未捕获 → 500 AGENT_SERVICE_ERROR；修复为 400 INVALID_HOST_REQUEST（客户端错误显式化）。+1 回归测试，172 tests 全绿。

## 2026-08-09 十三轮：反思接缝确定性验证（autoresearch exp18）

- verify-sse 新增 stub 直接探测：构造反思 prompt + id=e_abc 证据，断言返回 JSON 数组且引用该 id——反思路由验证不再依赖本地夜间时段。verify:e2e 10 项全 PASS。

## 2026-08-09 十二轮：e2e harness 覆盖夜间循环（autoresearch exp17）

- stub 新增反思路由（"inner voice of" → 从 user 消息解析首个证据 id、返回可校验的 insights JSON）；verify-sse 新增夜间循环断言（轮询 /v1/host/stats 验证 tick 例程+叙事+反思+聊天全部落库）。
- 发现：反思只在 night 时段运行（period==='night'）——day 启动 5 条记忆是正确行为；断言改时段感知（day 5 / night 6）。夜间跑 harness 即覆盖反思 E2E。

## 2026-08-09 十一轮：架构文档同步（autoresearch exp16）

- README 端点清单补齐（/v1/host/stats、SSE 协议）；新增 `.claude/specs/host-runtime.md`（SQLite 布局/迁移、Hono 契约锚点、SSE 事件语义、admin key 合并、CJK/情感检索、验证 harness 与进程经验）；CLAUDE.md spec 索引加一行。
- 未来 session 改这些区域前先读 spec，防已知陷阱回归。

## 2026-08-09 十轮：反思注入情感弧线（autoresearch exp15）

- journal 自列候选「反思/叙事引用情感弧线」落地：describeEvidenceEmotionalArc 把证据期首尾情感签名经 describeEmotion 描述注入反思 prompt（"started strongly joyful and energized, ended heavy and low"），<2 条签名记忆不注入。数据复用现成 EmotionSignature，零新存储。171 tests 全绿（+1）。
- 「情感的载体」候选三件套至此全部落地：情感签名入记忆 → 情感一致性检索（exp14）→ 反思引用情感弧线（exp15）。

## 2026-08-09 九轮：情感签名回忆检索加权（autoresearch exp14）

- journal 2026-07-27 自列候选「按情感签名的回忆检索加权」落地：MemoryRetrievalQuery 增可选 emotionBias{valence,arousal}、weights.emotion（默认 0=完全无偏，现有行为零变化）；无签名记忆 0.5 中性分；valence+arousal 双通道一致性。conversationRunner 有 affect 时传 bias+emotion:0.1——情绪一致记忆微幅上浮（mood-congruent recall，借鉴 Mimir's Memory Hub）。
- 坑：测试运行时 import 解析到 dist（包自引用），手动重编译 .test-dist 后必须 rebuild dist，否则跑旧代码。
- 170 tests 全绿（+3）。

## 2026-08-09 八轮：验证 harness 收进 repo（autoresearch exp13）

- tests/e2e/（llm-stub.mjs 流式 stub、verify-sse.mjs 全链路验证、stub-credentials.json 夹具）+ scripts/run-e2e.sh（stub 生命周期 + trap 清理）+ `npm run verify:e2e`（先 build）。
- verify-sse 断言更新为当前事件契约（done=仅 reply、applied=最终状态 affinity/mood/analysis），旧断言会漏检契约回归；`ELYSIAN_CREDENTIALS_PATH=<real> bash scripts/run-e2e.sh` 一键切真实中转。
- 三轮验证抓到 4 个真 bug 的工具链从 /tmp 永久化，三层验证闭环（单元 + 帧级 E2E + 浏览器 UI）可复现。

## 2026-08-09 七轮：SSE done 延迟打磨（autoresearch exp12）

- 事件流改版：`done{agentId,reply}` 回复完成即刻发出（页面解锁输入、气泡定稿），`applied{reply,affinity,mood,analysis}` 分析+持久化完成后发出（更新徽标）。`ConversationRunner.runStream` 增 `onReply` 可选回调，非流式回退路径同样触发。
- 浏览器验证抓到并修复两个流程 bug：①done 后 pending 气泡未转 agent 样式（回复消失）②流结束后无条件 `pending.remove()` 删掉已转换气泡。
- 167 tests 全绿（+2 断言）；浏览器全流程 PASS。

## 2026-08-09 六轮：记忆增长只读诊断端点（autoresearch exp11）

- 新增 `GET /v1/host/stats`（RealmStateStore.stats → realmHost.stats → hostApi 路由）：每 agent 记忆/对话 turns 数、关系/心情/情绪状态 total、SQLite 文件字节数。纯计数零变异，为记忆治理决策提供真实数据，也是通用运维端点。167 tests 全绿（+2），E2E smoke：一次聊天后 5 memories/2 turns/1 relationship/1 mood/48KB。
- 外部中转连续三轮 503——真实 LLM 验证持续受阻；记忆治理的删除类操作仍需主人确认后执行。

## 2026-08-09 五轮：admin 页浏览器验证 → 修两个既有 key 丢失 bug（autoresearch exp10）

- 浏览器验证 admin 配置页暴露两个既有真实 bug：①「测试连接」候选配置缺 apiKey（存储 key 按设计不回显）→ 探测报 "No API key for provider: custom-relay"；②「保存并启用」无 key 候选 → saveLlmConfig 落盘无 key 配置，存储 key 被悄悄清掉。
- 修复：conversationBootstrap 新增 `withStoredApiKey` 合并助手（候选缺 key 且活动配置有 key 时合并，保存+探测两路应用），165 tests 全绿（+2 测试），浏览器复验：测试连接成功、保存热加载成功且 key 保留。
- 坑：本 session 未动过 admin JS/handler，bug 是既有问题——浏览器验证路径连续两轮抓到真 bug（模板转义、key 丢失），价值实证。

## 2026-08-09 四轮：浏览器 UI 验证闭合（autoresearch exp9）

- Playwright 真实浏览器全流程验证 PASS：SSE 聊天（4 delta 拼成完整气泡、done 更新徽标 好感 3/心情 开心）、剧情投喂（注入常量 + topEmotions 正常）、无 JS 错误。上一轮模板转义修复在真实浏览器确认有效。
- 三层验证闭环完成：163 单元测试 + 帧级 E2E（本地流式 stub）+ 真实浏览器 UI。
- 进程生命周期经验：setsid+nohup+disown 可跨工具调用存活；fuser -k PORT 清理；pkill -f 会匹配自身 shell 命令行导致自杀（用 [.] 或 fuser）。

## 2026-08-09 三轮：真实端到端验证 + 页面模板转义 bug 修复（autoresearch exp8）

- 外部中转 503 宕机（直连确认外部故障）→ 本地 OpenAI 兼容流式 stub（/tmp/llm-stub.mjs）全链路验证 PASS：first_delta 13-15ms、4 帧渐进、done 带完整分析（affinity/mood/analysis=llm）、2 turns 持久化、JSON 回退契约不变。
- 浏览器验证抓到真实 bug：chatPage 模板字符串内 `\n` 被求值成真实换行 → 页面 JS 语法损坏（console "Invalid or unexpected token"）；修复为 `\\n`，新增页面脚本编译回归测试。
- pi 集成事实：completeSimple 底层也走流式；openai 流式结束需 finish_reason chunk 再 [DONE]。

## 2026-08-09 二轮：CJK 中文检索修复 + SSE 流式对话（autoresearch exp6/7）

- Exp6：检索 `tokenize` 只认 ASCII 导致中文查询 relevance 静默为 0 → 加 CJK 重叠二元组分词（Lucene CJKAnalyzer 技术，确定性零依赖），英文路径零变化，新增中文检索测试。
- Exp7：SSE 流式对话全链路（Hono streamSSE）：`ConversationRunner.runStream?`（可选，无流式能力时单 delta 回退）→ `piConversationReplyPort.generateReplyStream`（`agent.subscribe` 收 `text_delta`）→ `RealmHost.chatStream` → hostApi `stream:true` 分支（delta/done/error 三事件）→ agentService `AdminStreamResult`（新增 SSE 结果类型，扩展接口）→ chatPage fetch+ReadableStream 逐帧解析（旧主机 JSON 自动回退）。160 tests 全绿。
- 坑：AdminRequestResult 变联合类型后多处测试 `.body` 访问需收窄（"body" in result）；chatPage 模板字符串内嵌 JS 的 `\`` 转义易错。
- 后续：记忆增长治理需删数据，属危险操作，待主人确认。

## 2026-08-09 借成熟架构三连：Hono HTTP / node:sqlite 持久化 / jsonrepair 解析（autoresearch）


- 改动：①`agentService.ts` 手写 node:http（if/else 路由+自研 body/鉴权）→ Hono 4.13.1 + @hono/node-server 2.1.0（零传递依赖），行为契约逐项保留（10 项 smoke + 旧版对照）②`realmState.ts` JSON 全量快照 → node:sqlite 增量事务写（每次 mutation 单事务、消灭 O(N) 重写；旧 JSON 一次性无损迁移、文件原样留存；`persist()` 删除，宿主 shutdown 不再全量写）③LLM JSON 解析 → jsonrepair 3.15.0，新共享模块 `src/llm/llmJson.ts`（strict parse 失败且内容以 {/[ 开头才 repair），affectAnalysis/llmReflectionPlanner 去重接入。@types/node 20→22。155 tests 全绿。
- 取舍：**retrieval/loop/runtime 不换**（确定性不变量，ports 已隔离替换点）；agentServiceClient/llmConfigStore/HTML 页面/zod 均评估放弃（无优势）。src_loc 7,575→8,008（+5.7%，SQL schema 与 Hono 契约样板是固有成本，指标为弱代理，以契约为准）。
- 坑：①Hono bodyLimit 的 content-length 快路径会让进行中上传的客户端 SocketError → 弃用，自持流式带帽读取（旧语义）②Hono 通配符 `/v1/admin/*` 匹配裸前缀 → `c.notFound()` 恢复 404/405 ③syncAffect 漏 mood upsert（重载测试抓到）④旧 affect.json 可能缺 affectStates 键 → 迁移按键容忍 ⑤jsonrepair 会把散文修复成字符串 → 门控保 non-JSON 契约。
- 后续候选：SSE 流式对话（Hono 已解锁，见 .auto/ideas.md）；记忆增长治理（SQLite 就绪）；中文分词检索增强。

## 2026-07-27 情感记忆：记忆的情感签名与回忆注入

- 改动：①核心合约加 `EmotionSignature { valence: [-1,1], arousal: [0,1] }`，MemoryRecord/MemoryWrite 可选 `emotion`（validation reject 风格，越界拒写）②情感分析 prompt 要求输出 emotion，parseAffectAnalysis 宽容解析（缺失→无签名，非法→忽略+notes，越界→clamp+notes）③runner 把 affect.emotion stamp 到对话记忆写入 ④`describeEmotion` 四象限+强度修饰映射中文感受英文描述（strongly joyful and energized 等），prompt 回忆注入 "— at the time you felt …" ⑤双轨闭环测试验证：签名从分析→记忆→下一轮对话 prompt 全链路存活。
- 设计取舍：emotion 全程可选——tick 轨确定性记忆不带签名（最小改动，后续再做确定性映射或 LLM 快照）；旧 fake/旧数据无感兼容（136 tests 全绿）。
- 坑：`importRecord`（host 重启从 realm-data 载入记忆）最初漏透传 emotion——闭环测试抓到，修掉；cloneMemoryRecord 用 `...record` 展开天然透传无需改。
- 后续候选：tick 轨记忆打签、反思/叙事引用情感弧线（"这周好感从 X 涨到 Y"）、按情感签名的回忆检索加权。

## 2026-07-27 鲜活度第一批：生活叙事+时间感+记忆分级+LLM 反思

- 改动：①tick 后 LLM 写第一人称日记时刻（`host/lifeNarrative.ts`，失败进 notes 不阻塞）②prompt 注入当前时间/距上次交谈/记忆相对时间（`turn.at?` 合约演进）③情感分析增 memoryImportance 打分（约定 7-9、寒暄 1-2，缺省回退 3）④`reflection/llmReflectionPlanner.ts` 夜间每日反思（内心独白、evidence 过滤可见、复用 runReflection 验证链）。hub 暴露 getLlm()，tick async 化返回 RealmTickReport。
- 学到：调研先行有效——AstrBot 生态无"bot 过日子"插件（双轨独有优势自研）；scriptor（AGPL 仅借理念）的 sleep-consolidation 任务分解和记忆压缩分级直接成为反思与打分的 prompt 蓝本。
- 坑：LLM planner 泛型 metadata 为空对象，host 侧写入前须 stamp realm metadata（source: engine）；demo 中转按 system prompt 特征分流四种角色（对话/分析 JSON/叙事/反思数组）可离线验证全链路。

## 2026-07-27 realm host：宿主进程让 agent"活"了

- 改动：`npm run host` 单进程 = /chat 聊天页（好感/心情实时徽标）+ /admin 配置 + 状态持久化（./realm-data 全量快照原子写：realm.json 角色配置可手编、memories/affect/conversations/tick）+ tick 调度（本地时钟 period 切换才跑 step）。对话建议（memoryWrites/affinityDelta/mood）由 host 自动应用——闭环从组合测试变成常驻现实。关键文件：`src/host/`（realmState/realmHost/hostApi/chatPage/main）。
- 学到：agentService 的 admin 路由泛化成扩展点（AdminOptions 同构复用给 chat）；host 层生成时间合规（host 就是宿主）；扩展 handler 拿不到 query string，路径参数用 `/v1/host/history/{agentId}` 段式。
- 坑：①tick stepId 按小时生成 → 同小时重启撞 plan 记忆 id 崩启动，改毫秒时间戳；②lastTickPeriod 内存态重启即丢 → tick 状态落盘（date+period 判重）；③periodOf 用本地时钟，测试必须用本地时间构造 Date（UTC 构造踩过一次）；④startup tick 必须 try/catch，否则拖垮 chat/admin 面。

## 2026-07-26 里程碑：真实 LLM 端到端首通

- 主人的中转（OpenAI 兼容 + gpt-5.6-sol）经指纹修复后连通；首条真实对话验证全管线：人设/记忆/好感注入 → 回复自然引用注入记忆并反映好感语气 → 情感分析返回完整 JSON（delta +3、mood 欣喜而亲昵 0.82、含理由）→ 两条对话记忆建议正确生成。
- "情感载体"闭环自此可投入实际使用；后续接宿主应用层即可。

## 2026-07-26 中转 403 排查与 SDK 指纹修复

- 现象：中转站测试连接 403 "Your request was blocked."（baseUrl 已带 /v1，路径正确）。
- 诊断方法（无 key 定位）：同一端点三组 UA 对比——curl UA→401、浏览器 UA→401、openai SDK 特征（`OpenAI/JS` UA + `x-stainless-*`）→403。结论：中转 WAF 在认证前按 SDK 指纹拦截。
- 修复：中转模式请求默认注入 `RELAY_HEADER_OVERRIDES`（中性 UA + 全套 `x-stainless-*: null`）；pi-ai 链路 `StreamOptions.headers` → openai SDK `defaultHeaders`，null 值删除 SDK 自动头。注入点在 `customRelayParts` 包装的 streamFn/completionClient，目录模式不受影响。
- 验证：假 WAF 中转（拦 stainless/OpenAI UA）端到端——修复后 `stainless=[]`、返回 pong。
- 学到：403 文案"blocked"基本是网关层（401 才到认证层）；无 key 也能用 UA 对比法定位拦截层。

## 2026-07-26 admin 中转接入（baseURL + key）

- 改动：配置双模式（`provider` 目录 / `baseUrl` 中转，二选一），校验统一收敛 `validateLlmConfig`；中转 runtime 走 `createProvider` + 合成 Model + lazy api（openai-completions / anthropic-messages）；页面默认「自定义中转」模式。关键文件：`llmConfigStore.ts`、`conversationBootstrap.ts`（customRelayModels）、`adminPage.ts`。
- 学到：pi-ai 自定义 provider 的 auth 可显式置空（`resolve: async () => ({ auth: {} })`），key 走 `StreamOptions.apiKey`/`Agent.getApiKey` 每请求显式传——explicit key wins；lazy api 从 `@earendil-works/pi-ai/api/*.lazy` 子路径导入。
- 验证手法沉淀：本地 20 行假中转（SSE chunk 格式）即可端到端验证整条 LLM 管线，无需真实 key。

## 2026-07-26 网页 admin 入口：LLM key 配置与热装配

- 改动：`GET /admin` 内嵌单页（provider/model 下拉 + key + 测试连接）、`/v1/admin/llm-config`(+/test、catalog) API、key 落盘 `~/.elysian-realm/credentials.json`（0600 原子写，`ELYSIAN_CREDENTIALS_PATH` 可覆盖）、`createConversationHub` 热装配（env > file > admin，env 时 pin 住 admin 改动 409）、`AgentServiceOptions.conversationRunner` 放宽为函数联合类型（readyz 动态反映）。关键文件：`conversationBootstrap.ts`（hub）、`llmConfigStore.ts`、`adminPage.ts`、`agentService.ts`。
- 学到：admin handler 用纯数据接口（`AdminRequestHandler`）注入，service barrel 维持零 pi；保存顺序必须 build（验证）→ save（落盘）→ swap（热替换），运行态永不与磁盘分叉；token 校验用 `timingSafeEqual`。
- 坑：主人 pi CLI 的订阅 OAuth 凭据会被 pi-ai credential store 自动解析但 provider 返回 403 forbidden（订阅凭据只允许官方客户端）——需要 standalone API key；测试连接按钮把这个错误清晰显示了出来。

## 2026-07-26 模型选择走 pi-ai 目录（env 装配）

- 主人问"pi 的模型选择器能不能直接用"→ 能：pi-ai 的 Models 目录（`builtinModels()` + `getModel` + auth 环境变量解析 + 静态模型数据）就是服务形态的模型选择器；TUI 交互选择器属 pi-coding-agent，不适用 HTTP 服务。
- 新增 `src/service/conversationBootstrap.ts`（子路径 `./service/bootstrap`，独立于 `./service` barrel——纯 tick 嵌入方不加载 pi 与全量 provider 注册）：`ELYSIAN_LLM_PROVIDER`+`ELYSIAN_LLM_MODEL` 成对配置，未配置→undefined（端点 501），半配置/目录查无→启动时显式 throw。
- main.ts 接线并打印能力状态；`.env.example`、README 更新。目录查询离线可用（构建期打包的静态数据）。
- 验证：90 tests pass；smoke 双分支（无 env→无对话能力；有 env→readyz 含 realm-conversation.v1，模型 anthropic/claude-fable-5）。

## 2026-07-26 双轨架构落地：pi 集成 + affect + 对话轨 + 闭环

- 方向决策（主人拍板）：双轨并存——tick 驱动日常 routine（确定性），对话事件走 pi 会话循环，共享同一记忆/情感库；项目最终形态是"情感的载体"（参考 astrbot_plugin_self_learning 的理念，AGPL 协议、只借鉴思路零代码搬运）。
- pi 版本：`@earendil-works/pi-ai` + `pi-agent-core` 精确锁定 **0.82.1**（latest，刚过 0.81/0.82 breaking 窗口）；`.npmrc save-exact`；Node engines ≥22.19。升级须对照上游 CHANGELOG 的 Breaking Changes 节。
- 架构不变量：
  - 包根入口零 pi 依赖；pi 只经 `./llm/pi-ai`、`./conversation/pi` 子路径进入。
  - 宿主权威：服务只返回建议（proposal / memoryWrites / affinityDelta / mood），宿主应用。
  - 记忆流管"发生过什么"，affect 快照管"现在怎样"，各自单一事实来源；变化是否写记忆流由调用方决定。
  - 时间一律由调用方传入，核心不生成时间；测试全离线（fake StreamFn / fake LlmPort 两个接缝）。
- 新模块：`src/affect/`（好感 [-100,100] clamp 可观察 + mood）、`src/conversation/`（prompt 组装 / affect 分析解析 / runner）、`src/llm/piAiLlmPort.ts`、`src/conversation/piConversationReplyPort.ts`、服务端点 `POST /v1/realm/conversations`（runner 注入制，未配置 501）。
- 合约演进：`RealmMemoryMetadataV1.stepId` 可选化 + `source` 增 `"conversation"`；realmStep 合约本体未扩展（routine planner 不消费情感，扩展属无消费者预留）。
- 验证：86 tests pass / typecheck 通过；`dualTrackIntegration.test.ts` 证明闭环（tick 记忆入对话 prompt → 对话产物入下一 step 检索 → affect 单店累积）。
- 踩坑备忘：pi-ai 根入口 `AssistantMessageEventStream` 是 type-only（用 `createAssistantMessageEventStream()`）；pi Agent 把 prompt 文本规范化成 content 块数组；pi 上游源码参考位于 /tmp/pi-repo（main @ 0.82.1）。
## 2026-08-08 剧情驱动情感系统：PlotEvent 引擎 + AffectState + 对话注入 + 宿主投喂

- 改动：①affect 域新增 `AffectState`（valence/arousal 维度 + GoEmotions 28 类标签全量 + baseline 性情基线）与 `PlotEvent` 协议（11 类型，target self/host/other，intensity 0..1）②`plotRules.ts` 确定性引擎：PLOT_EVENT_RULES 增量表 → applyPlotEvents（先 0.15 指数衰减向基线回归再叠加事件，全程裁剪）+ computeAffinityDelta（仅 host 目标，±10/调用上限）③tick 契约（realm-agent-step.v1）输入 affectState/plotEvents、输出 affectProposal（完整新状态+affinityDelta，宿主决定应用）；对话契约（realm-conversation.v1）可带 affect，prompt 注入情感描述（象限+显著标签，EmpatheticDialogues 式）+ 表达约束（高唤起短促/低效价沉重/fear 回避/anger 带刺），情感分析也以 affect 为 mood 锚点 ④宿主：affect.json 持久化 affectStates、applyAffectProposal 单点应用、plotEvent() 即时投喂、POST /v1/host/plot（400 可见校验）、聊天页情绪徽标+剧情投喂行。

- 调研（应主人'优先借鉴成熟项目'要求，网络核验 2026-08-08）：GoEmotions（Apache-2.0）28 类标签+ekman 粗分；generative_agents 实为 Apache-2.0（非 MIT，探子纠错）；ACT deflection 语义（inteRact/actdata/ACTING 实现）→ 增量表+基线回归；EmpatheticDialogues（CC BY-NC 仅格式）Emotion+Situation 格式；character-card-spec-v2 角色卡字段。全部映射与核验记录在 .claude/specs/affect.md。

- 设计取舍：AffectState 与 AgentMood 并存不互覆盖（剧情引擎管'现在怎样'，对话分析管记忆签名与 mood 标签）；tick 无 affect 输入时不产 affectProposal（向后兼容）；衰减按调用计（每 tick/每次投喂一次），常量 0.15 可调；不引入 EPA 词典（成本超范围，spec 记为后续候选）。

- 验证：154 tests pass（新增 affectPlotEngine 12 + plotAffectIntegration 7）/ typecheck 绿；集成证明 hostile×3+threat → valence 触底/anger/fear 高/affinity -10，宿主投喂→持久化→重启读回，tick 衰减应用，对话 prompt 注入 fear 0.60 与约束句。

- 坑：两处测试算式错误（arousal 触顶裁剪未算、decay 基数算错）被断言抓出；periodOf 用本地时钟，宿主测试必须 new Date(y,m,d,h) 构造。

- 后续候选：tick 轨记忆打情感签名、realm.json 剧情脚本、情感弧线叙事、EPA 全量 ACT。

- 注：情感记忆（2026-07-27）与鲜活度工作仍未提交，本次改动与之共存 154 全绿。

## 2026-08-09 三轮：真实端到端验证 + 页面模板转义 bug 修复（autoresearch exp8）

- 外部中转 503 宕机（直连确认外部故障）→ 本地 OpenAI 兼容流式 stub（/tmp/llm-stub.mjs）全链路验证 PASS：first_delta 13-15ms、4 帧渐进、done 带完整分析（affinity/mood/analysis=llm）、2 turns 持久化、JSON 回退契约不变。
- 浏览器验证抓到真实 bug：chatPage 模板字符串内 `\n` 被求值成真实换行 → 页面 JS 语法损坏（console "Invalid or unexpected token"）；修复为 `\\n`，新增页面脚本编译回归测试。
- pi 集成事实：completeSimple 底层也走流式；openai 流式结束需 finish_reason chunk 再 [DONE]。
