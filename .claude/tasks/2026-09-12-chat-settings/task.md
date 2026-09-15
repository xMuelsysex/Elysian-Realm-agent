# 聊天画面设置入口

## 目标与决策
- 在当前 `/chat` 画面提供 LLM 设置入口，第一版沿用既有 `/admin` 配置页完成 Base URL 与 API Key 配置。
- 复用 `/v1/admin/llm-config`、`llmConfigStore` 和既有 key 不回显/保留语义；不重复实现表单、存储或配置 API。
- 设置入口使用 header 中的可访问链接“⚙ 设置”，跳转到同端口 `/admin`。

## 计划
- 审计 chatPage、adminPage、conversationBootstrap 与 Host 路由，确认配置链路和安全边界。
- 在聊天页增加最小设置入口样式与链接。
- 运行页面脚本、配置 API 和实际浏览器链路验证，记录已有 dirty worktree。

## 验证记录
- `npm run typecheck`：通过。
- `npm run build` + 本地测试编译：通过。
- 受影响测试：`realmHost.test.js`、`adminService.test.js`、`conversationBootstrap.test.js` 共 34/34 通过。
- 浏览器实际检查：`/chat` 显示“⚙ 设置”，点击进入 `/admin`；真实页面显示 Base URL、Model、API Key、保存和测试控件；当前存储 key 为空白不回显。
- 浏览器唯一控制台错误为 `/favicon.ico` 404，不影响页面或设置功能。
- 未修改配置 API、凭据存储和 key 合并逻辑；未清理工作树中原有 lore/self-concept 等改动。

## 结论
- 已完成聊天画面的设置入口；用户可从 `/chat` 进入 `/admin` 配置自定义中转 Base URL 和 API Key，并使用既有测试连接、保存热加载能力。
- 本次未新增独立设置状态或第二套配置事实来源。
