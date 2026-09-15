# 自我认知成长

## 目标与决策
- 为角色增加独立、宿主持有、可版本化的 self-concept 状态；保持 realm.json persona 与普通经历记忆的单一事实来源。
- LLM/reflection 只产生带 provenance 的 proposal；宿主校验、CAS 应用并注入只读 snapshot。
- 首版 producer 限定 nightly reflection；非法 self-concept proposal 不阻断合法 reflection memory；CAS 冲突记录后等待下次 nightly；记录完整脱敏决策审计。

## 计划
- SC-01：纯契约与三轨 serializer。
- SC-02：SQLite snapshot、CAS、append-only audit、迁移和恢复。
- SC-03：nightly reflection proposal 合同及解析。
- SC-04：宿主 nightly 两阶段应用与审计。
- SC-05：对话/叙事/反思三轨注入。
- SC-06：回归测试、规范和全量验证。

## 验证记录
- SC-01：`npm run typecheck`、self-concept focused tests、`npm test` 通过。
- SC-02：完成 SQLite snapshot、首次写入 CAS、证据归属校验、append-only audit、迁移恢复、竞争测试；缺失证据不会写入 snapshot。
- SC-03/SC-04：nightly reflection 可携带 proposal；非法 proposal 记录脱敏 `parse_failure`，合法 reflection memory 继续落库；CAS 冲突记录并等待下一次 nightly。
- SC-05：批准 snapshot 只读注入 conversation、narrative、reflection 三轨；无 snapshot 时保持缺省行为。
- SC-06：新增 self-concept records/persistence/CAS/host/prompt/reflection 测试。
- `npm run typecheck`：通过。
- `npm test`：263/263 通过。
- `npm run verify`：通过；包含 263 项单测与 14 项离线 E2E。
- `git diff --check`：通过。
- 注意：`npm test` 不可并行执行，因为脚本会清理共享的 `dist` 与 `.test-dist`。

## 结论
- 已完成。self-concept 首版保持宿主权威、版本化 CAS、完整脱敏审计和三轨只读注入。
