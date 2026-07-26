# 阶段②：情感状态与好感度模块（affect）

## 目标与决策

- 目标：为双轨架构补上共享情感层——per 关系好感度（RelationshipAffect）与 agent 自身情绪（AgentMood），tick 轨确定性规则与阶段③对话后 LLM 分析都归结为对本模块的 apply/set 调用。
- 形态决策：情感快照与记忆流分开——快照管"现在怎样"（唯一事实来源），记忆流管"发生过什么"；apply/set 返回 before/after Change，是否把变化写进记忆流由调用方决定，无隐藏副作用。
- 边界决策：好感度 [-100,100]，delta 累积越界属正常路径 → clamp 且 `clamped` 标志可观察；mood intensity [0,1] 为显式设定值，越界属调用方错误 → 校验拒绝。
- 时间由调用方传入（at 参数），核心不生成时间，保持确定性。
- 范围：核心模块 + 测试；realmStep 服务合约扩展留到阶段③（届时才知道对话服务的使用形状）。
- 结构：records/validation/store 三件套，对齐 memory 模块风格；校验原语（非空串/ISO 日期）在 affect 内私有实现，与 memory 同构，出现第三个域再提升共享。

## 计划

1. `src/affect/affectRecords.ts`：类型 + 常量（AFFINITY_MIN/MAX/INITIAL、MOOD_INTENSITY_MIN/MAX、Change 形状）
2. `src/affect/affectValidation.ts`：AffectValidationError + 校验
3. `src/affect/inMemoryAffectStore.ts`：InMemoryAffectStore（get/list/apply/set，构造导入，clone 返回，list 排序确定）
4. `src/index.ts` 导出
5. `tests/simulationAgentAffect.test.ts` 离线测试
6. 验证：npm test → typecheck

## 验证记录

- `npm test`：affect 9 个测试全过（首建/累积/双向 clamp 可观察、set 覆盖、定向关系与排序、mood 往返、快照拷贝、导入校验、错误收集、NUL key 防碰撞）
- `npm run typecheck`：通过

## 结论

- 新增 `src/affect/`（records/validation/store 三件套）：`RelationshipAffect`（定向好感 [-100,100]）、`AgentMood`（intensity [0,1]）、`InMemoryAffectStore`（apply/set 返回 before/after Change，clamped 可观察，时间由调用方传入保持确定性）。
- 快照与记忆流分离：快照是"现在怎样"的唯一事实来源，变化是否写记忆流由调用方决定，无隐藏副作用。
- 主入口导出；服务合约在阶段③④中确认无需扩展 realmStep（见 2026-07-26-dual-track）。
