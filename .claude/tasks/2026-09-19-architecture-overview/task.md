# 整体架构图（archify）

## 目标与决策

**目标**：用 archify 产出一张可交付的 Elysian Realm Agent 整体架构图（自包含 HTML），覆盖双轨（确定性 tick / 对话）、宿主权威、状态与档案、pi 依赖边界。

**产出文件**：

- `docs/architecture/architecture-overview.architecture.json` — archify 规格（架构图源）
- `docs/architecture/architecture-overview.html` — 交付产物（自包含 viewer）

**关键决策**：

1. 图类型选 `architecture`；`meta.locale` 用 `zh-CN`（正文中文，标识符保留英文）。
2. 用 12 个组件表达整体：浏览器参与者 / HTTP 入口 / RealmHost / 档案管理 / RealmStateStore / tick 轨 / 对话轨 / 认知循环 / 认知领域模块 / 正史 Canon / pi 接缝 / LLM 供应商。
3. 边界用两个嵌套 boundary 表达核心不变量：`region` = 宿主进程整体，`security-group` = pi 依赖边界（仅 3 个导出子路径）。
4. 组件 `sources` 指向真实代码位置（21 处引用），并配 `meta.repository` 固定到 revision `9850d5e`，让证据可核对。
5. 图内不重复 cards 已承载的说明；cards 只写三条不变量（双轨职责 / 宿主权威 / 边界与依赖）。

**布局约束（由 validate 诊断反推）**：

- showcase profile 要求 9 项 artifact checks 全过且 0 warning。
- 桌面可读性按 `availableDiagramWidth = 930`（960 最小阅读宽度减 30 chrome）折算：`sourceFontPx × 930 / viewBoxWidth ≥ 6`。sublabel 的 preferred 字号是 9、tag 是 7，因此 **tag 会把 viewBox 宽度上限压到 1085**，故本次不写 tag，viewBox 定 1280×700。
- 连接标签需显式 `labelAt` 才能避开端点节点内部；垂直连接的默认标签落点会在 from 节点内。
- boundary 标题过长会导致 title rail 不收敛（`composition/desktop-readability`），标签必须短。

## 计划

1. 读架构契约（CLAUDE.md / CONTEXT.md / src 结构 / 关键符号行号）。
2. 写候选规格 → validate 迭代修复 → deliver → visual-check。
3. 感知性视觉复核 1440×900 与 2048×1320 截图。

## 验证记录

```bash
node <archify>/bin/archify.mjs validate architecture docs/architecture/architecture-overview.architecture.json --quality showcase --repo-root .
# ok (9 artifact checks; composition showcase: 0 errors, 0 warnings)

node <archify>/bin/archify.mjs deliver architecture docs/architecture/architecture-overview.architecture.json docs/architecture/architecture-overview.html --quality showcase --repo-root .
# ok: true；spec sha256 0d8ed872…c5e1 (7334 B)；artifact sha256 ac2cca4d…b7a2 (819284 B)
# validation: checksPassed 9/9, compositionStatus pass, errors 0, warnings 0
# evidence: verified true, revision 9850d5e…, references 21

node <archify>/bin/archify.mjs visual-check docs/architecture/architecture-overview.html --json
# ok: true, status pass, visualReview pending
# 1440×900 / 1600×1000 / 1920×1080 / 2048×1320 全部 overflowX=false overflowY=false
# 最小投影字号 7.43 / 7.74 / 9 / 9 px（阈值 6）
```

感知性复核：人工查看 `architecture-overview.visual-check.1440x900.light.png` 与 `…2048x1320.light.png`，12 个节点、两个边界、12 条连接标签均无遮挡，卡片区在下方完整显示，大屏无异常空带。

**证据来源行号说明**：`sources` 行号取自 repository revision `9850d5e`（非 dirty 工作区），`src/host/realmHost.ts`、`src/host/realmState.ts` 在工作区有未提交改动，行号以 pinned revision 为准。

## 结论

交付完成。规格与产物同目录，产物为自包含 HTML（含主题切换 / 搜索 / 聚焦 / 导出），无外部依赖。未做：未把图接入 README 或文档索引（用户未要求）；未提交 git。
