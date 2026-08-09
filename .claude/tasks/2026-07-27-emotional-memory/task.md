# 情感记忆：记忆的情感签名与回忆注入

## 目标与决策

- 目标：记忆写入时带情感签名（valence/arousal），回忆时注入"当时的感觉"，让 agent 拥有情感史。
- 决策（主人拍板，2026-07-27）：情感记忆是下一步方向；tick 轨记忆暂不强制打签。
- 设计要点：
  - 情感签名进核心合约 `MemoryRecord`（可选字段 `emotion`），是一等公民而非 metadata 塞值。
  - 情感来源：对话轨情感分析输出扩展；tick 轨记忆留空（最小改动）。
  - prompt 回忆注入：检索命中带 emotion 的记忆时，渲染"当时的感觉"描述。

## 计划

1. 读核心文件：affectAnalysis / conversationPrompt / conversationRunner / memory validation。
2. 合约演进：`EmotionSignature`（valence [-1,1]、arousal [0,1]）+ MemoryRecord/MemoryWrite 可选字段 + 校验。
3. 情感分析输出扩展：分析结果带 emotion。
4. 对话记忆写入时快照 emotion。
5. conversationPrompt 回忆注入：emotion → 中文感受描述。
6. 测试更新与新增，`npm test` 验证。

## 验证记录

- `npm test`：136 pass / 0 fail（新增 7 个测试：emotion 解析+clamp、非法 emotion 宽容、describeEmotion 象限、prompt 注入/省略、runner stamp/省略、store 透传+校验 reject、双轨闭环回忆注入）。
- `npm run typecheck`：通过。
- 闭环测试抓到 importRecord 漏透传 emotion 的 bug（host 重启载入记忆会丢签名），已修复。

## 结论

- 情感签名进核心合约：`EmotionSignature { valence: [-1,1], arousal: [0,1] }`，MemoryRecord/MemoryWrite 可选字段，validation reject 风格（越界拒绝写入）。
- 对话轨全链路：分析 prompt 要求 emotion → parseAffectAnalysis 宽容 clamp → runner stamp 到 memoryWrites → store 透传 → 下一轮检索注入 "at the time you felt …"。
- 兼容性：emotion 全程可选，旧 fake/旧数据无感通过（136 测试含全部旧测试）。
- 后续：tick 轨记忆打签（确定性映射或 LLM 快照）、反思/叙事引用情感弧线、情感史检索加权。
