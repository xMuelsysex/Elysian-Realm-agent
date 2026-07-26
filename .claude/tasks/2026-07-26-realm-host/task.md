# realm host：宿主进程 + 聊天页 + tick 调度

> 追加（次日）：见 2026-07-27-liveliness/task.md —— 鲜活度第一批（生活叙事/时间感/记忆分级/LLM 反思）。

## 目标与决策

- 目标：让 agent"活"起来——宿主进程持有并持久化记忆/情感/会话状态，自动应用对话建议，提供聊天入口，tick 让她在无人对话时也生活。
- 形态：`npm run host` 单进程 = 聊天页(/chat) + admin LLM 配置(/admin) + 持久化 + tick 调度。服务包的无状态端点与不变量不动；host 是另一个进程入口。
- 持久化：`./realm-data/`（`ELYSIAN_REALM_DATA` 可覆盖，gitignore）——realm.json（角色/用户配置，可手编）、memories.json、affect.json、conversations.json；全量快照 + 临时文件 rename 原子写（个人规模足够）。
- 状态容器：内部复用 InMemoryMemoryStore / InMemoryAffectStore（load 构造、save 序列化），单一事实来源在宿主。
- 对话：嵌入调用 conversationRunner（不走 HTTP 自环）；每 agent 一个连续会话，请求带最近 20 轮，完整历史落盘；host 层生成 now（宿主拥有时间，合规）。
- tick：现实时钟映射 period（6-11 morning / 11-17 day / 17-22 evening / 22-6 night），每分钟检查、**时段切换才跑 step**（记忆增长可控，一天 4 条量级）；routine 来自 realm.json。
- 服务扩展点：把 admin 的路由机制泛化复用——AgentServiceOptions 加同构的 `chat` 扩展（page + handler），第三个扩展出现再抽象。
- pi 隔离：host/main.ts（进程入口）可 import bootstrap；realmState/realmHost/chatPage 零 pi。
- 默认角色：无配置时写入默认爱莉希雅（persona + 四时段 routine），开箱即用。

## 计划

1. `src/host/realmState.ts`：配置+状态 load/save、默认角色
2. `src/host/realmHost.ts`：chat 编排（组请求→runner→应用→落盘）、tick 编排
3. `agentService.ts`：admin 路由泛化出 chat 扩展点
4. `src/host/chatPage.ts`：聊天页（气泡 + 好感/心情实时显示 + agent 切换）
5. `src/host/main.ts` + package.json "host" script + .gitignore realm-data
6. 测试：realmState 持久化往返、realmHost chat 应用与 tick、host API
7. smoke：真实进程 + 浏览器聊天 + 数据落盘检查 + 重启状态恢复

## 验证记录

- `npm test`：117 pass / 0 fail（新增 7：realmState 播种/坏配置、chat 状态注入与应用累积、无 runner 显式失败、periodOf 映射、tick 时段切换与重启安全、host API 路由）
- `npm run typecheck`：通过
- smoke（demo 中转分角色回答 + 真实 host 进程 + Playwright 浏览器）：
  - 首启：默认爱莉希雅播种、首 tick（night，2 条记忆）、四个状态文件落盘
  - 浏览器 /chat：气泡对话两轮，好感徽标实时 0→2→4、心情"雀跃"，历史加载
  - 重启：affinity/mood/历史/记忆完整恢复
  - **发现并修复真实 bug**：同小时重启后启动 tick 崩溃（stepId 按小时生成撞 plan 记忆 id）+ lastTickPeriod 内存态丢失 → tick 状态落盘 tick.json（date+period 判重）、stepId 加毫秒时间戳、startup tick 包 try/catch 不拖垮 chat/admin
  - 修复后二连重启：同 period 零重复 tick，状态完整（affinity=4、8 条记忆）

## 结论

- 完成。`npm run host` 单进程 = 聊天页 + admin 配置 + 持久化 + tick 调度，爱莉希雅"活"了：记忆跨对话累积、好感真实增长、时段 routine 自动产生生活记忆。
- 修改文件：`src/host/`（realmState/realmHost/hostApi/chatPage/main，新增）、`agentService.ts`（admin 路由泛化为扩展点，chat 扩展同构复用）、`package.json`（host script）、`.gitignore`（realm-data）、README、`tests/realmHost.test.ts`（新增）。
- 剩余风险：periodOf 用宿主本地时钟（设计如此，测试须用本地时间构造）；night 跨午夜时 0 点会补一次 tick（可接受）；全量快照落盘在个人规模够用，记忆上万条再考虑增量格式。
- 后续：QQ/Telegram 适配器、反思 LLM 化、对话轨记忆检索 tool、好感衰减。
