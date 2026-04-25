# NL2SQL 真实数据批次 D5：端到端测试 + 回归

## 来源
- **主计划文件**：`C:/Users/hanhui/.claude/plans/sql-vivid-lemon.md` · 批次 D5
- **总览文档**：[NL2SQL-真实数据批次总览.md](NL2SQL-真实数据批次总览.md)
- **上游设计文档**：
  - [NL2SQL-真实数据输出实施计划.md](NL2SQL-真实数据输出实施计划.md) · 第 6 节 测试计划
  - [NL2SQL-目标偏离评估说明.md](NL2SQL-目标偏离评估说明.md) · 5.1 P0 "真实环境验收闭环不足"
- **生成日期**：2026-04-24
- **批次位置**：5 批次中的最后 1 批

---

## 目标
补齐 `phase-data` 专项测试，跑通 `smoke` / `phase1` / `phase2` 全套回归，形成真实数据输出的验收证据。

## 前置依赖
D1-D4 全部完成，阅读对应交接摘要：
- [NL2SQL-真实数据批次D1-交接摘要.md](NL2SQL-真实数据批次D1-交接摘要.md)
- [NL2SQL-真实数据批次D2-交接摘要.md](NL2SQL-真实数据批次D2-交接摘要.md)
- [NL2SQL-真实数据批次D3-交接摘要.md](NL2SQL-真实数据批次D3-交接摘要.md)
- [NL2SQL-真实数据批次D4-交接摘要.md](NL2SQL-真实数据批次D4-交接摘要.md)

---

## 读取范围（严格）
| 文件 | 用途 |
|---|---|
| [backend/test/phase1](../backend/test/phase1) 任一既有脚本 | 参考测试脚本组织方式（setup/teardown/断言风格） |
| [backend/test/phase2](../backend/test/phase2) 任一既有脚本 | 参考 LLM 依赖测试的 skip 兜底方式 |
| D1-D4 交接摘要中列出的接口签名 | 构造测试桩时使用 |

**不重读**引擎源码；如发现接口与摘要描述不符，停下来更新摘要而不是继续读代码。

## 写入范围（严格）
### 1. 新增 `backend/test/phase-data/test-agentic-execution.js`
覆盖断言：
1. `agenticEngine.processQuery` 成功 → `type === 'result'`、`data.rowCount > 0`
2. `query_history.row_count` 与 `data.rowCount` 一致
3. `query_history.result` 为摘要形态（含 `sampleHash`，**无业务 rows**）
4. `query_history.execution_time` 为 SQL 实际耗时（与返回的 `executionTime` 一致，±100ms 容差）
5. `DRY_RUN=true` → 成功返回空 rows，不报错（既有行为不回退）

### 2. 新增 `backend/test/phase-data/test-resume-execution.js`
覆盖断言：
1. 构造澄清场景 → 回答 → `resumeFromClarification` 返回 `type === 'result'` + `data`
2. `resumed === true`
3. `engineUsed === 'agentic-resume'`（由 SSE 层打标，通过模拟 sseHandler 流程验证）

### 3. 修改 `backend/package.json`
- 新增脚本：`"test:phase-data": "node test/phase-data/test-audit-helper.js && node test/phase-data/test-agentic-execution.js && node test/phase-data/test-resume-execution.js"`
- 将 `test:phase-data` 纳入 `test:all` 聚合

### 4. 依赖依赖缺失的兜底
`phase1` / `phase2` 沿用既有"缺 `SR_DATABASE_URL_TEST` 或 `LLM_API_KEY` 则 skip"的约定；新增的 `test-agentic-execution.js` 依赖 `SR_DATABASE_URL_TEST`，`test-resume-execution.js` 依赖 `LLM_API_KEY` + `SR_DATABASE_URL_TEST`，缺失时 skip 并打印原因。

---

## 本批次验证
```bash
cd backend

# 阶梯式回归
npm run test:smoke                                       # 31 pass
npm run test:phase-data                                  # 新增测试全过（或 skip 给出原因）

# 真实依赖
SR_DATABASE_URL_TEST=<只读库> npm run test:phase1        # 原有 phase1 通过
SR_DATABASE_URL_TEST=<只读库> npm run test:phase-data    # 真实执行断言通过
LLM_API_KEY=<key> SR_DATABASE_URL_TEST=<只读库> npm run test:phase2
LLM_API_KEY=<key> SR_DATABASE_URL_TEST=<只读库> npm run test:phase-data
```

### 验收清单
- [ ] `test:smoke` 31 pass / 0 fail
- [ ] `test:phase-data` 全过（真实依赖下全部断言生效）
- [ ] `test:phase1` / `test:phase2` 真实依赖下 0 fail
- [ ] `query_history` 抽查 10 条：`result` 为摘要、`row_count` 非零、`execution_time` 合理
- [ ] 手测截图 2 张：普通路径、澄清恢复路径均显示数据表

---

## 交接摘要（批次完成后产出）
输出 `docs/NL2SQL-真实数据输出完工摘要.md`，作为整个 5 批次的汇总交付：
- 改动点清单（按 D1-D4 归档）
- 测试结果：smoke / phase-data / phase1 / phase2 各自通过数
- 审计摘要样例（脱敏后）
- 手测截图 2 张（普通 / 澄清恢复）
- 已消除的目标偏离项：P0 "数据最小化" + "真实环境验收闭环不足"
- Follow-up：Phase A 基线观测与 Phase F 灰度发布（本轮未做）

---

## 风险
| 风险 | 缓解 |
|---|---|
| 真实 LLM 不稳定导致 `test-resume-execution.js` 偶发失败 | 加重试（最多 2 次）+ 超时保护；失败时打印完整 trace |
| CI 环境无 `SR_DATABASE_URL_TEST` | skip 而非 fail，保持 `test:smoke` 为必过门禁 |
| 测试污染生产数据库 | 严格使用 `SR_DATABASE_URL_TEST`（只读库）；禁止配置成 `SR_DATABASE_URL` |
