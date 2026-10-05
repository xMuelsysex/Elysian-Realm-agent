# Chat 页面加宽 + 人物头像 + 开始新的对话

## 目标与决策
- 目标：`/chat` 页面左右加宽；对话双方显示头像以便区分角色；新增「开始新的对话」按钮。
- 加宽：`body` 最大宽度 `72rem → 88rem`、左右内边距 `1rem → .75rem`，只放大页面容器，聊天区与右侧剧情面板的现有栅格比例不变。
- 头像：使用官方游戏角色缩略图（爱莉希雅 = Miss Pink Elf♪、梅比乌斯 = Infinite Ouroboros）裁成头肩方图，降采样为 160×160 WebP 后以 data URI 内嵌在 `src/host/avatarAssets.ts`，键为稳定的 `personaId`（不是可变显示名）。
  - 不用静态资源路由、不额外加依赖、不在运行时读文件：页面单次响应即自带全部头像，dist / .test-dist 解析路径一致。
  - realm.json 可手编，自定义角色可能没有头像：无图角色与用户侧回退为「首字 + 按 key 确定性取色的圆牌」，保证两侧仍可区分。
  - 用户侧头像用档案 `displayName` 首字，与 `profileId` 取色。
- 新对话：新增 `POST /v1/host/new-conversation {profileId, agentId}`，清空该档案该角色的对话记录（`conversations` 表 + 内存），**保留**记忆、好感度、心情、自我认知与剧情进度——对话记录只是活动上下文窗口，不是角色记得的事。
  - 前端点击后先 `confirm` 再调用，成功后重载历史（回到空历史态），并追加一条「—— 与X的新对话 ——」分隔提示。
  - 按钮在 header 中，与其他控件同组；`setViewLoading` 期间禁用，避免与流式回复竞争。
- 顶部 header 在 ≤760px 时允许换行（标题独占一行），避免新按钮把标题挤成竖排。

## 计划
1. 生成头像资源模块 `src/host/avatarAssets.ts`（官方缩略图 → 裁剪 → WebP → base64）。
2. chatPage：容器加宽、气泡行 + 头像渲染、新对话按钮与调用、header 窄屏换行。
3. Host：`RealmStateStore.clearConversation` → `RealmHost.newConversation` → `POST /v1/host/new-conversation`。
4. 单测补页面断言与新对话行为；浏览器实测宽屏 / 390px 窄屏、双角色头像与新对话落库。

## 验证记录
- `npm run typecheck`：通过。
- `npm test`：286 / 286 通过（新增 1 例：新对话清空记录、记忆与好感度保留、重开库后记录不复现、缺 body / 空 agentId 400）。
- `npm run verify`：286 / 286 单测 + 离线 SSE / 双角色 / nightly E2E 全部 PASS。
- 浏览器（`fish scripts/start-demo.fish`，离线 stub，1600×950）：页面内容宽度 1408px（原 1152px）；对爱莉希雅与梅比乌斯发言后各自气泡左侧显示各自头像（粉 / 绿，明显不同），用户气泡右侧显示「主」圆牌。
- 浏览器点「＋ 新对话」→ 确认框 → `/v1/host/history/agent_elysia` 从 2 条变 0 条，`state` 中好感度仍为 3、记忆仍为 5；刷新页面后历史仍为空（删除已落库）。
- 浏览器 390×844：header 换行成三行（标题 / 按钮组 / 角色选择器 + 徽标），无溢出，头像与气泡布局正常。
- 截图：`.playwright-mcp/chat-wide-1600.png`、`chat-avatars-1600-b.png`、`chat-mobius.png`、`chat-newconversation.png`、`chat-final-elysia.png`、`chat-mobile-390.png`。

## 结论
- 三项需求均已完成并可复现；头像与 personaId 绑定，新增角色只需在 avatarAssets 增一条或在 realm.json 配置角色（自动回退首字圆牌）。
- 清空的是对话记录，`applyConversation` 的 seq 归零后继续追加，不影响记忆流与情感闭环。

## 第二轮：头像完整显示 + 可见表面（主人反馈）

- 反馈：「这两个的背景和背景融为一体了，修改一下让他更明显」（附确认对话框 + admin 页截图）与「头像也只显示了左上部分，没有显示完全」。
- 头像：原 160×160 头肩裁图是原图左上区域，看不到完整角色；改为**完整官方缩图**（144×144 艺术图居中内缩到 176×176 透明方图），头像容器 2.35rem → 2.75rem 加 `object-fit: contain` + 底色 + 内描边环，浅色 / 深色下都是可见的圆形表面。
- 按钮 / 输入框：`background: transparent` 让按钮与页面底色（以及原生对话框底色）融为一体；三个页面统一为 `currentColor 8%` 填充 + 35% 描边，hover 18%。
- 确认框：`window.confirm` 的原生对话框只画按钮文字、不画按钮表面，在主人的深色主题下 OK / 取消 几乎不可见；换成页面内确认卡片（`Canvas`/`CanvasText` + 遮罩 + 红色「清空并开始」+ Esc / 取消），并加了一条测试不准再用 `window.confirm`。
- 验证：`npm run typecheck`、`npm test`（286/286）、`npm run verify`（单测 + E2E 全 PASS）；浏览器浅色 / 深色两种 `prefers-color-scheme` 下实测 chat 确认卡片、头像圆环、admin 与 test 页控件均有可见底色；取消与 Esc 不删历史（仍 2 轮），确认后 0 轮且好感度保留；截图 `.playwright-mcp/chat-surfaces-light.png`、`chat-confirm-light.png`、`chat-confirm-dark.png`、`admin-dark.png`、`admin-light.png`、`test-light.png`。

## 第三轮：`color-scheme` 白底白字（主人反馈）

- 反馈：「解锁到场景这边还是白底白字」。
- 根因：三页只声明 `color-scheme: light dark` 而**不自绘页面底色**；宿主的 webview 底是白色，而 `prefers-color-scheme: dark` 时 UA 文字色是白色 → 整页白底白字；`<select>` 原生下拉弹层的 `option` 继承 `select` 的白色文字，弹层表面又跟平台亮色主题 → 「解锁到场景」白底白字。这也解释了上一轮 admin 截图整页发灰。
- 修复：三页 `:root { color-scheme: light dark }` → `html { color-scheme: only light; background: #fff; color: #1a1a1a; }`；上一轮的控件 8% 填色 / 35% 描边保留（在自绘底色上就是可见的浅灰控件）。
- 验证：`npm test` 286/286；浏览器在 `prefers-color-scheme: dark` 下实测三页：`html` 计算底色 `rgb(255,255,255)`、字色 `#1a1a1a`、`color-scheme: light only`；`#storyCursor` 与其 609 个 option 计算字色均为 `rgb(26,26,26)`；截图 `.playwright-mcp/admin-darkpinned.png`、`chat-darkpinned.png`。
- 代价：三个页面不再跟随系统深色主题（始终浅色）——换取任何宿主主题下字色与底色都一致。
