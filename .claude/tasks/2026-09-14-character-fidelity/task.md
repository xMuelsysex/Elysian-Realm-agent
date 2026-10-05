# 角色鲜活度与原作一致性修复

## 目标与决策
- 目标：让实际对话、生活叙事和夜间反思中的角色更鲜活，保持游戏角色身份、口吻与剧情可见边界，减少 OOC 内容进入后续记忆。
- 审计根因：`realm-data/realm.json` 的现用角色卡把爱莉希雅写成通过网络聊天的现代角色；源码 fallback 的爱莉希雅身份和梅比乌斯刻印也有正史偏差；剧情台词别名漏召回；台词上下文未明确区分角色台词、他人台词、旁白和分支；反思输出格式指令互相矛盾；OOC 输出会被标注但仍可能污染记忆。
- 决策：统一默认与现用角色卡为游戏内设定；按稳定 `personaId` 补齐原作说话人别名；三轨 prompt 明确资料只作参考并增强角色主动性/事实边界；修正 transcript 渲染与可用性过滤；OOC 回复保留可见诊断但隔离其生成记忆/状态，避免错误内容循环强化。

## 计划
1. 更新 `DEFAULT_REALM_CONFIG` 与当前 `realm-data/realm.json` 的爱莉希雅、梅比乌斯角色卡，使用本地剧情快照可核对的身份与短台词锚点。
2. 修复剧情检索/渲染的稳定别名、不可用场景过滤、台词归属/分支提示和预算行为，并接入三条 prompt 轨道。
3. 统一对话/叙事/反思的资料边界与角色表现约束，消除反思 JSON 契约冲突。
4. 让 OOC 输出保留显式 notes/analysisReason，同时不写入长期记忆、对话历史或情绪关系状态。
5. 运行 `npm run typecheck`、`npm test`、`npm run verify`、度量与静态检查；根据失败结果继续修复。

## 验证记录
- 审计完成：默认配置、运行配置、Prompt 三轨、剧情别名与 OOC 持久化链路均已定位，证据来自 `src/host/realmState.ts`、`realm-data/realm.json`、`src/lore/`、`src/conversation/`、`src/reflection/` 和现有测试。
- `npm run typecheck`：通过。
- `npm test`：285/285 通过。
- `npm run verify`：285/285 离线测试通过，E2E stub 启动、SSE、双角色聊天、夜间叙事/反思与 JSON fallback 全部 PASS。
- `bash .auto/measure.sh`：`character_fidelity=100`，`tests=285`，`prompt_bytes=16831`。
- `git diff --check`：通过；`realm-data/realm.json` 已解析并由 `RealmStateStore` 读取到更新后的两张角色卡。
- 复审后修复 5 项边界：移除「妖精爱莉」自我别名并补齐「无限的蛇主」；生活叙事按 `personaId` 解析台词；OOC 检测覆盖 AI/网络/模型身份并跳过引用和否定语境；泄露对话只重建原始参与者记忆（importance=3、无 emotion）且不应用 affect；分支 marker 在最终 transcript 中与首条阶段台词成块保留。
- 复审边界 smoke：四条精确 OOC 例句命中，两条引用/否定例句不命中；自定义显示名仍命中角色正史台词，妖精台词保持他人；合成 stage marker 保留并标注为未确认事件。
- `npm run verify`：通过（285/285 单测 + 离线 E2E）；`bash .auto/measure.sh`：`character_fidelity=100`；`git diff --check`：通过。
- 继续收敛角色上下文：对话召回排除 `visibility=system` 的计划记录和 `reflectionSource=deterministic` 的引擎反思记录；旧历史中的 OOC agent turn 只保留在宿主 / admin 诊断视图，不再回灌模型；确定性计划与反思文本改为第一人称、去除内部 agent id。
- 追加验证：`npm run typecheck`、`npm test`（285/285）、`npm run verify`（离线 E2E 全部通过）、`bash .auto/measure.sh`（`character_fidelity=100`，`prompt_bytes=21311`）、`git diff --check` 与真实 `realm-data` 上的模型上下文 smoke 均通过。
- 独立复审发现的 RV-001..RV-008 已处理：统一角色可见 memory projection 覆盖旧 OOC / system plan / deterministic reflection、历史、叙事连续性、nightly evidence 与 self-concept provenance；mood 单独校验并阻断直接状态写入；runner 在 affect 分析前隔离 OOC reply，并对直接 service 调用保持同等历史 / memory 防线。
- detector 回归修复引号绕过、`大型语言模型`、扮演 / 内部字段与参与者元对话，同时保留程序员、机器人偶、感情用事、普通 instructions 和第三方转述；self-concept prompt 去除 evidence / proposal 内部标识，仅保留 revision 与语义陈述。
- 最终验证：`npm run typecheck`、`npm run verify`（285/285 + SSE / 双角色 / nightly E2E 全 PASS）、`bash .auto/measure.sh`（`character_fidelity=100`，`prompt_bytes=23454`）、`git diff --check`、detector regression smoke、projection/state smoke、direct prompt projection smoke 均通过。
- 第三轮独立复审发现两项真实链路缺口并修复：`dialogueLinesForSpeaker` 从角色首次入场后的 transcript 中移除其他说话人的全括号私有内心独白，避免离场后的心声被注入；Lore prompt 明确该类内容不可推断。`detectOocLeak` 与参与者投影补齐“一款/一位/一台/一套”和“确实/当然/实际上/算是”等常见中文身份句式，同时保留“程序员/机器人偶”等正常语义排除。
- 针对性验证：真实 `bh3-mainline-29-032`（cursor 422、爱莉希雅）渲染不再包含芽衣离场后的两条内心独白；`我是一款人工智能助手`、`我确实是一个人工智能助手`、`我当然是一个人工智能助手` 均命中 OOC，程序员/机器人偶负例保持不命中；直接 runner 对泄露回复未调用 affect LLM，只返回 importance=3、无 emotion 的参与者记忆。
- 变更后全量验证：`npm run verify` 通过（285/285 + SSE / 双角色 / nightly E2E 全 PASS），`bash .auto/measure.sh` 通过（`character_fidelity=100`，`prompt_bytes=23454`），`git diff --check` 通过；`node --check tests/e2e/verify-sse.mjs` 通过。
- 真实中转验证：`ELYSIAN_CREDENTIALS_PATH="$HOME/.elysian-realm/credentials.json" bash scripts/run-e2e.sh` 通过（exit 0）；真实模型流式回复 97 帧 / 125 字符，applied 状态、历史/关系/情绪、nightly、reflection、JSON fallback 与梅比乌斯聊天全部 PASS。E2E 检查器保留 stub 的精确 mood/affinity 断言，真实模型改为验证协议字段与合法范围，避免把模型自然生成的心情文案误判为契约错误。

## 结论
- 完成：默认与当前运行角色卡统一为前文明 / 往世乐土设定；对话、日记、反思共用数据边界和角色主动性规则；剧情转录支持稳定别名、自身台词标记、元数据/分支边界和预算内片段；OOC 文本保留可见诊断，同时隔离记忆、历史、情绪关系、mood 和 self-concept 持久化影响。复审发现的 RV-001..RV-008 边界已全部修复并完成针对性核验。
- 剩余风险：真实中转在线验证已通过一次；模型回复受中转服务状态、延迟和采样影响，后续仍需在目标部署环境观察长期稳定性。当前验证使用本机默认凭据和临时 Realm 数据目录，不改写项目运行数据。
