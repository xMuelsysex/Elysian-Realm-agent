# 调研驱动三条改造：主动联系 / 记忆流边界 / 记忆失效

## 目标与决策

主人批准按调研报告「如果只抄三条」依次落地，三条都必须端到端可用：

1. **不打扰护栏 + 未回复指数退避**（对应「让她先开口」）。护栏全部是确定性规则，符合 Nomi / Kindroid / EchoText 三家收敛出的形态：
   - 开关注入 → 静默时段（本地 22–8，硬约束，不是靠用户写 directive）→ 未回上限 2 条 → 指数退避（tier 基础间隔 × min(2^未回, 4)）→ 素材检查（上次发言后必须有角色可见的 observation/reflection，避免没话找话）。
   - LLM 只写文字，且在全部护栏通过后才调用；SKIP 逃生阀照抄 EchoText（`[saynothing]` 的等价物）。失败/空回/OOC/超长一律不发、进 notes。
   - 主动消息同时写一条 agent conversation turn（她的下一次回复知道她说过）+ 一条未读记录（退避度量 + 页面徽标）；participant 回复即整批已读。
2. **模板兜底不写记忆流 + 兜底即退化检查**。Smallville 的 `daily_req = daily_req` 冻结日程、失败兜底反复写 "I am hungry" 是同一类退化，主人的真实库里 46 条记忆里 25 条是 `realmStepExecutor` 的模板句：确定性的 plan / 确定性 reflection 现在标记 `metadata.engineDiagnostic`，宿主记忆流边界拒收（单一执法点），并保留诊断出口（tick 报告 `withheld` / `diagnostics`，宿主日志逐行打印）；每个 tick 再检查一次「这个角色今天有没有真的活的记忆」，没有就写 note。
3. **失效优于删除 + 反思强制引用证据**。Zep 双时态 / Mem0 V3 只增不删都指向同一结论：`MemoryRecord.invalidAt`（+ `supersededBy`）而不是 DELETE；检索与投影同时跳过；治理入口 `POST /v1/host/govern`（默认 dryRun）把 90 天未用的低重要记忆与历史模板记录正式退役。反思证据校验原本已实现（非空 + 必须来自本次证据），补了一条宿主边界的端到端测试。

## 计划

1. 读通现状：step 模板写入路径、MemoryRecord/检索、reflectionValidation、tick 叙事缝、realm.json 校验。
2. 三条 1：`src/host/proactive.ts`（纯策略 + LLM 写手）→ realmState（`proactive_messages` 表 + stats）→ realmHost（tick 钩子、`proactiveInspection`、`markProactiveRead`）→ hostApi 两条路由 → chatPage 徽标与「她先开口」标记。
3. 三条 2：`RealmMemoryMetadataV1.engineDiagnostic` → step executor 两个写入点打标 → 记忆流边界拒收 + 计数 → tick 报告与退化 note。
4. 三条 3：`invalidAt/supersededBy`（含老库 ALTER TABLE 迁移）→ 检索与 `isCharacterVisibleMemory` 跳过 → `invalidateMemories` + `govern` + 路由 → 证据校验的端到端测试。
5. 验证：单测 + typecheck + `npm run verify`（含 e2e 新断言）+ 浏览器实测 + 文档/journal/spec。

## 验证记录

- `npm run typecheck`：通过。
- `npm test`：304 / 304（新增 `tests/proactiveContact.test.ts` 9 例、`tests/memoryInvalidation.test.ts` 6 例；改写 2 例把「模板即记忆」的旧契约换成新契约）。
- `npm run verify`：单测全通过 + 离线 e2e 全 PASS，新增断言：
  - `PASS deterministic templates stayed out of the memory stream (4 withheld)`
  - `PASS proactive guards answered (reason=quiet-hours, unread=0)`（e2e 跑在本地 02:29，静默时段正确生效）
  - `PASS govern defaults to a dry run and applies on request (candidates={"stale":0,"engineTemplates":0})`
  - `PASS nightly loop persisted 6 memories (narrative + reflection + chat, templates withheld)`
- 宿主日志实测：`tick diagnostic: agent_mobius: 我把今天的安排记下了：...` 与 `... 留在今天的记忆里 ...` 逐行可见，但 `stats.totals.memories` 不含它们。
- 浏览器（`fish scripts/start-demo.fish`，1600×950）：徽标显示「🌙 她先说 · 1 条未回」，历史里她的消息上方显示「🌙 她先开口 · 还没回」+ 头像；回复后徽标消失、标记变为「🌙 她先开口」、`GET /v1/host/proactive/...` 的 `unread` 归零（截图 `.playwright-mcp/chat-proactive.png`）。
- 真实数据旁证：主人 `realm-data/realm.sqlite` 里 46 条记忆中 10 条 plan + 15 条 reflection 均为模板句——新边界生效后不再新增；历史那批可用 `POST /v1/host/govern {"dryRun":false}` 退役（未擅自对真实数据执行）。

## 结论

- 三条全部落地并可复现：她可以在护栏内先开口（可解释、可关闭、不会被无视后越追越紧）；引擎模板不再污染记忆流且退化会自己喊出来；记忆用失效代替删除，反思必须引用真实证据。
- 已知边界：主动消息的 LLM 内容质量取决于模型（离线 stub 只回固定句）；`supersededBy` 目前只有治理路径会写，冲突消解式替换未接入；失效记录的物理清理仍属删除类，留待主人决定。
