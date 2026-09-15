# 后台角色属性与记忆面板

## 目标与决策
- 在现有 `/admin` 页面增加只读后台面板，查看每个角色的六维属性、当前好感度 / 心情和记忆。
- 新增受 admin 路由保护的 `GET /v1/admin/realm`，由 Host 生成快照；属性不加入聊天端已有 `/v1/host/state`，保持后台可见边界。
- 首版展示每个角色按 `createdAt` 倒序的最近 100 条记忆；不提供编辑、删除或新的持久化状态。
- 动态记忆内容使用 DOM `textContent` 渲染，避免把存储内容当作 HTML。

## 计划
- 审计现有 admin 页面、RealmHost 摘要、MemoryRecord 和 Host 路由。
- 增加 `RealmAgentAdminView` / `adminView`、admin 快照路由，并在 `main.ts` 合并 LLM admin handler 与 Host admin handler。
- 在 `/admin` 增加角色卡、六维进度条、状态和折叠记忆列表。
- 运行类型、构建、受影响测试和浏览器验证，更新 Host runtime 规格与项目 journal。

## 验证记录
- `npm run typecheck`：通过。
- `npm run build` + 测试编译：通过。
- 受影响测试：`realmHost.test.js`、`adminService.test.js`、`conversationBootstrap.test.js`、`oocGuard.test.js` 共 89/89 通过。
- 浏览器实测 `/admin`：两名角色显示六维数值 / 进度条，分别加载 10 和 4 条最近记忆；原有 Base URL、Model、API Key 设置控件仍可用。
- 浏览器实测 `/v1/admin/realm` 返回后台快照；`/v1/host/state` 不包含 `personalityDimensions`。
- 浏览器唯一控制台错误为 `/favicon.ico` 404，与后台面板无关。
- `git diff --check`：通过。
- Host 验证进程已停止；未清理工作树中原有 lore、self-concept、六维属性等改动。

## 结论
- 后台界面已能查看角色属性和最近记忆，配置页与只读监控面板共存。
- 后端数据只读、无新增编辑或删除能力；属性保持在 admin 快照边界内。
