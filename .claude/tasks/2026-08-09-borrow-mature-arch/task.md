# 2026-08-09 借鉴成熟开源项目替换自研实现（autoresearch）

## 目标与决策

- 目标：从 GitHub 成熟项目借架构，替换自研实现，仅在有真实优势时替换；不破坏四个核心不变量（包根零 pi、宿主权威、快照/记忆流分工、确定性）。
- 主指标：src_loc（lower better），但判定以"真实优势 + 契约不变 + 测试全绿"为准——src_loc 对"借成熟架构"是弱代理（领域逻辑占 src 大头），三项替换里两项指标微涨但优势真实，均判定 keep。
- 三项替换：①agentService.ts 手写 node:http → Hono 4.13.1 + @hono/node-server 2.1.0；②realmState.ts JSON 全量快照 → node:sqlite 增量事务写；③LLM JSON 解析 → jsonrepair 3.15.0。
- 明确不替换：retrieval/loop/runtime（确定性不变量）、agentServiceClient（契约完整）、llmConfigStore（原子写已实现）、HTML 页面、zod（无优势）。

## 计划

1. 侦察（3 探子并行）：HTTP 层 / 持久化 / 检索循环 → 定候选。
2. Exp1：Hono 替换 HTTP 层（10 项行为契约 smoke + 154 tests）。
3. Exp2：node:sqlite 替换持久化（含旧 JSON 无损迁移 + @types/node 20→22）。
4. Exp3：jsonrepair 替换手写 LLM JSON 解析（门控设计保契约）。
5. 扫尾探子 + 端到端 host smoke + 文档/journal 更新。

## 验证记录

- `npm test`：154 → 155 tests 全绿（新增截断 JSON 修复测试）。
- `npm run typecheck`：全绿。
- 行为契约 smoke（Hono）：HEAD 剥离 body、/v1/admin 前缀边缘、413 content-length/chunked、405+Allow、空 body 容忍、INVALID_JSON 双消息——与旧实现逐项一致（含旧版对照运行）。
- 迁移 smoke：真实 realm-data 副本 → 4 记忆/关系/心情/tick/历史无损导入 SQLite，JSON 原样保留，重载一致。
- 端到端 host smoke：临时目录真实启动，healthz/readyz/chat/admin/host-state 全 200；realm-data 只生成 realm.json + realm.sqlite。
- git log：baseline fd45b92 → exp1 210c4ca → exp2 a376b50 → exp3 f0b91ce，全部 keep 自动提交。

## 结论

- 自研基础设施层三处替换完成，均保持行为契约不变、测试全绿、零功能回归。
- 关键坑：①Hono bodyLimit content-length 快路径导致进行中上传 SocketError → 自持流式带帽读取；②Hono 通配符匹配裸前缀 → c.notFound() 恢复语义；③syncAffect 漏 mood upsert；④旧 affect.json 缺 affectStates 键；⑤jsonrepair 会把散文修复成字符串 → 必须门控。
- 遗留：realm-data 旧 JSON 文件原样保留（非破坏迁移）；node:sqlite 在 <25.7 为 experimental（22.13+ 免标志）；宿主下次 `npm run host` 自动迁移。

## 补充（exp5 + 扫尾）

- Exp5（3294b72）：chatPage 前端 PLOT_TYPES/topEmotions 第二事实来源 → 后端 PLOT_EVENT_LABELS + PROMINENT_EMOTION_MIN_STRENGTH 注入页面（单一事实来源）。
- 扫尾探子：12 模块全读，全部判定不值得换库（领域逻辑/薄适配层/换库净收益为负），结论"不再新增依赖"。
- 最终状态：155 tests 全绿，src_loc 8,038（+6.1%，SQL schema 与契约样板为固有成本），deps 5（hono/@hono-node-server/jsonrepair 均零传递依赖 + pi 两件套）。

## 补充（exp6 + exp7）

- Exp6（412a412）：检索 tokenize 加 CJK 重叠二元组分词（Lucene CJKAnalyzer 技术）——修复中文查询 relevance 通道静默为 0 的真实缺陷；英文路径零变化；新增中文检索测试。
- Exp7（6e638c8）：SSE 流式对话（ideas 头号候选）——runner.runStream?（可选+单 delta 回退）→ piConversationReplyPort.generateReplyStream（agent.subscribe 收 text_delta）→ RealmHost.chatStream → hostApi stream:true 分支 → agentService AdminStreamResult（hono streamSSE）→ chatPage 逐帧解析（JSON 回退）。160 tests 全绿（新增 4 个流式测试）。
- 最终状态：160 tests 全绿，src_loc 8,305。

## 补充（exp8 真实端到端验证）

- 外部中转 503 宕机 → 本地 OpenAI 兼容流式 stub 全链路验证 PASS（first_delta 13-15ms、done 带分析、持久化、JSON 回退）。
- 浏览器验证抓到真实 bug：chatPage 模板字符串内 \n 被求值成真实换行 → 页面 JS 语法损坏；修复（\\n）+ 页面脚本编译回归测试。
- 验证工具留存：/tmp/llm-stub.mjs、/tmp/sse-real-verify.mjs、/tmp/stub-creds.json、/tmp/run-verify.sh。

## 补充（exp9 浏览器 UI 验证）

- Playwright 真实浏览器：SSE 聊天全流程 PASS（delta 拼气泡、done 更新徽标 好感3/心情开心）、剧情投喂正常、无 JS 错误。
- 三层验证闭环完成：163 单元测试 + 帧级 E2E（stub）+ 真实浏览器 UI。
- 进程生命周期经验：setsid+nohup+disown 可跨调用存活；pkill -f 会自匹配 shell 命令行，用 [.] 或 fuser。

## 补充（exp10 admin 页浏览器验证）

- 浏览器验证暴露两个既有 bug：测试连接候选缺 key → "No API key"；保存无 key 候选 → 存储 key 被清掉。
- 修复：withStoredApiKey 合并助手（保存+探测两路），165 tests 全绿，浏览器复验通过。

## 补充（exp11 只读诊断端点）

- GET /v1/host/stats：每 agent 记忆/turns 数、关系/心情/情绪状态 total、dbBytes。非破坏，为记忆治理决策提供数据。
- 中转连续三轮 503，真实 LLM 验证持续受阻。

## 补充（exp12 SSE done 延迟打磨）

- 事件流改版：done{agentId,reply} 回复完成即刻发（解锁输入+气泡定稿），applied{reply,affinity,mood,analysis} 分析+持久化后发（更新徽标）。
- 浏览器验证抓到并修复两个流程 bug（气泡未转 agent 样式、无条件 remove 删已转换气泡）。

## 补充（exp13 harness 收进 repo）

- tests/e2e/（llm-stub.mjs + verify-sse.mjs + stub-credentials.json）+ scripts/run-e2e.sh + npm run verify:e2e。
- verify-sse 断言更新为新契约（done=仅 reply、applied=最终状态）；真实中转一键切换。

## 补充（exp14 情感签名检索加权）

- MemoryRetrievalQuery 增 emotionBias + weights.emotion（默认 0 无偏）；runner 有 affect 时传 bias + emotion 0.1；无签名记忆 0.5 中性。
- 坑：测试运行时 import 解析到 dist（包自引用），手动编译后须 rebuild dist。

## 补充（exp15 情感弧线）

- 反思 prompt 注入 describeEvidenceEmotionalArc（签名记忆按时间排序取首尾）；<2 条不注入。171 tests 全绿。

## 补充（exp16 文档同步）

- README 端点补齐（stats + SSE 协议）；.claude/specs/host-runtime.md 沉淀（SQLite/HTTP/SSE/admin/验证经验）；CLAUDE.md 索引。

## 补充（exp17 harness 扩展）

- stub 增反思路由；verify-sse 增夜间循环断言（时段感知 day5/night6）。反思只在 night 时段运行。

## 补充（exp18 反思接缝确定性验证）

- verify-sse 增 stub 直接探测断言（inner voice of prompt + id=e_abc），任何时段验证反思路由与证据 id 解析。

## 补充（exp19 URI 健壮性修复）

- /v1/host/history/%zz → decodeURIComponent 抛 URIError → 曾返回 500；现 try/catch → 400。+1 测试。

## 补充（exp20 浏览器 SSE 错误路径验证）

- 无 LLM 宿主 + stream:true → 页面错误气泡 + 输入解锁，PASS。页面四条 SSE 路径全部浏览器验证完毕。

## 补充（exp21 admin 目录模式验证）

- 官方目录 radio → provider/model 下拉联动渲染 PASS。两个页面全部路径浏览器验证完毕。

## 补充（exp22 留存诊断）

- stats 增 oldestMemoryAt + staleMemories（90 天未用）；时钟注入保持确定性。治理决策数据齐备。

## 补充（exp23 发布就绪）

- npm run verify 聚合命令；.env.example 补 ELYSIAN_REALM_DATA；README/spec 同步。全绿。

## 补充（exp24 包边界守卫）

- packageBoundary.test.ts：dist 根图 BFS 无 pi 运行时导入 + 三 pi 子路径正向对照。不变量 #1 机械化。

## 补充（exp25 确定性守卫）

- determinismBoundary.test.ts：无参 Date.now()/new Date() 仅限时钟权威 allowlist（realmHost 默认时钟 + 两个 pi 适配器）；负向对照验证非空转。

## 补充（exp26 宿主权威守卫）

- hostAuthorityBoundary.test.ts：执行器禁 node:fs/node:sqlite/../host 导入。四不变量 3/4 机械化。

## 补充（exp27 带历史刷新验证）

- 聊一次→刷新→历史气泡+徽标恢复 PASS。页面双场景（空/带数据）验证完毕。

## 补充（exp28 依赖卫生与 pi 升级）

- audit 0 漏洞、树干净；pi 系 0.84.1 按约定升级（breaking 不涉本项目，适配器零改动，全量验证通过）。

## 补充（exp29 最终验收）

- pi 升级后浏览器三路径验收（chat 流式/测试连接/历史刷新）全 PASS。全链路无回归。

## 补充（exp30 admin stats 展示）

- refreshStoreStats best-effort 拉 /v1/host/stats 渲染存储行（失败静默）。浏览器实测正确。

## 补充（exp31 知识持久化与收尾）

- ctx_memory 3 条（架构/验证陷阱/悬置事项）；隐私确认（realm-data 已 gitignore）；最终状态全绿。

## 补充（exp32 最终打磨）

- admin 保存后 stats 即时刷新；README Known limitations 章节。177 tests 全绿。

## 补充（exp33 门禁强化）

- checks.sh 织入 verify:e2e——每轮实验自动回滚门含帧级 E2E（SSE/持久化层回归不再静默入库）。

## 补充（exp34 service 进程 smoke）

- dist/service/main.js 真实启动：healthz/readyz、逐字段校验信封、确定性 tick 全管线、优雅退出。双进程入口验证完毕。

## 补充（exp35 发布安全核对）

- npm pack dry-run：零泄漏、5 子路径声明齐备、private:true。发布结构干净。

## 补充（exp36 治理设计提案）

- memory-governance.md 落盘（方案 A/B、SQL、dry-run、端点形态）；spec 挂索引。批准即执行。

## 补充（exp37 自重建认证 + 收尾）

- npm ci 冷装 + 全量 verify 通过——仓库自愈重建认证完成；ideas.md 清理归档。

## 补充（exp39 检索基准）

- 检索性能曲线量化（100→5.6ms / 1k→6.5ms / 5k→31ms / 10k→85ms / 20k→144ms），写入 governance spec——清理到 <5k 保 <35ms，方案 A 获量化依据。

## 补充（exp41 探测升级）

- /models 200 + /chat/completions 503：中转在线、上游 LLM 后端挂。可向中转方反馈/切换上游。

## 补充（exp42 完整诊断）

- /models 200（13 模型）+ 代表模型 chat 全 503 → 上游整体离线，非单模型问题。等上游修复或另配中转。

## 补充（exp44 503 路径验证 + 事故）

- 503 故障路径浏览器级验证通过（错误气泡清晰、UI 不挂、输入恢复；tick 优雅降级）。
- 事故：env var 笔误（DATA_DIR→正确 DATA）导致 3 次 host 跑在真实 realm-data；影响仅一次按日期 tick+叙事 note，无数据丢失；正确变量名已存记忆 #4。

## 补充（exp45 错误气泡友好化）

- bubbleError 状态码分类文案 + 细节行；捕获模板转义正则 bug（\b→退格符）→ 双重转义 + 回归测试（页面脚本禁含 \u0008）。教训：chatPage 内联 JS 正则必须 \\ 转义。

## 补充（exp46 回归双守卫）

- 页面脚本测试：退格控制符守卫 + 渲染后状态分类正则精确断言（String.raw 形态）。模板转义语义破坏双守卫。

## 补充（exp48 admin 页浏览器验证）

- admin 页全流程浏览器级验证（渲染/保存热加载/stats 刷新/测试连接错误）。产品面覆盖闭合。

## 补充（exp50 覆盖审计）

- E2E harness 覆盖核对：流式链路全盖，其余端点单元+浏览器+smoke 覆盖，验证矩阵完整。

## 补充（exp54 剧情投喂验证）

- 剧情投喂 UI 浏览器级验证（气泡+徽标+按钮恢复）；chat 页全部交互 + admin 页浏览器级验证完毕。
