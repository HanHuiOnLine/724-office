# NL2SQL 真实数据批次 D1 · 交接摘要

## 来源
- **批次任务计划**：[NL2SQL-真实数据批次D1-任务计划.md](NL2SQL-真实数据批次D1-任务计划.md)
- **总览文档**：[NL2SQL-真实数据批次总览.md](NL2SQL-真实数据批次总览.md)
- **执行日期**：2026-04-25
- **执行结果**：✅ 通过（`test-audit-helper` 全过 + `test:smoke` 31 pass / 0 fail / 2 skip 与基线一致）

---

## 1. 已修改的核心接口和逻辑

### 1.1 新增模块 [backend/src/core/auditHelper.js](../../backend/src/core/auditHelper.js)
- 47 行纯函数模块，仅依赖 Node 内置 `crypto`
- 导出唯一函数：

  ```js
  summarizeResultForAudit(data)
    => { columns: string[], rowCount: number, truncated: boolean, sampleHash: string }
  ```

- 入参契约：`data` 即 `sqlExecutor.executeQuery(sql).data`，形如 `{columns, rows, rowCount, truncated}`
- `sampleHash` 算法：`sha256(JSON.stringify(rows.slice(0,5))).slice(0,16)`，空 rows → `''`
- 兜底：`null` / `{}` / 缺字段输入返回 `{columns:[], rowCount:0, truncated:false, sampleHash:''}`
- 设计目标：把审计落库形态从"业务行样本"压缩为"结构 + 抽样指纹"，满足数据最小化要求且不丢失事后比对能力

### 1.2 [backend/src/core/nl2sqlEngine.js](../../backend/src/core/nl2sqlEngine.js) · 审计写入
| 位置 | 改动 |
|---|---|
| L37 | 新增 `const { summarizeResultForAudit } = require('./auditHelper');` |
| L562-L571 | `markQueryHistorySuccess` 的 `result` 字段：从 `{ columns, sampleRows: rows.slice(0, 20) }` 替换为 `summarizeResultForAudit(queryResult.data)` |

**未改动**：
- 返回给前端的 `data`（仍由 `resultFormatter.formatResult(queryResult, ...)` 携带完整 rows/columns）
- `markQueryHistoryFailure` 调用（无业务行问题）
- `executeQuery`、RLS、脱敏、LIMIT 等任何执行链路

### 1.3 新增测试 [backend/test/phase-data/test-audit-helper.js](../../backend/test/phase-data/test-audit-helper.js)
- 6 个断言用例（计划要求 5 个 + 1 个兜底增量，详见 §3）
- 运行：`node backend/test/phase-data/test-audit-helper.js`
- 不依赖外部 SR DB / LLM，可加入 smoke

### 1.4 落库形态对比（直观差异）
**改动前**（旧）：
```json
{ "columns": ["id","name"], "sampleRows": [{"id":1,"name":"张三"}, ... 19 more] }
```
**改动后**（新）：
```json
{ "columns": ["id","name"], "rowCount": 1234, "truncated": false, "sampleHash": "a3f2..." }
```

---

## 2. 遗留到下一阶段的临时代码（TODOs）

### TODO-D1.1 · agentic 引擎仍走旧 result 形态 → 由 D2 收敛
[backend/src/core/agenticEngine.js:185-195](../../backend/src/core/agenticEngine.js#L185-L195) 当前仍写：
```js
await database.markQueryHistorySuccess(historyId, {
  ...
  rowCount: 0,                                                    // ← D2 改为真实值
  result: { selectedTables, explanation: explanation.slice(0,500) }, // ← D2 改为 summarizeResultForAudit
  ...
});
```
不属于 D1 范围（D1 严格不动 agentic）。无业务行落库（不违反数据最小化），但与 legacy 不一致，由 **D2** 在接入 `executionPhase` 时一并切换到摘要。

### TODO-D1.2 · `phase-data/` 未纳入 `run-all.js` 发现路径 → 由 D5 收敛
[backend/test/run-all.js:54](../../backend/test/run-all.js#L54) 默认只扫描 `phase1..phase4`：
```js
const phases = PHASE ? [`phase${PHASE}`] : ['phase1', 'phase2', 'phase3', 'phase4'];
```
当前 D1 的测试需手动 `node backend/test/phase-data/test-audit-helper.js` 执行；`npm run test:smoke` 不会自动跑。**D5** 会新增 `test:phase-data` 脚本并把目录加入聚合发现路径。

### TODO-D1.3 · 下游消费 `query_history.result.sampleRows` 的脚本待告知
代码库内引用仅限测试，已确认不破坏 smoke：
- [backend/test/phase1/test-query-history.js:38](../../backend/test/phase1/test-query-history.js#L38) — 测试 database 层 result 透传，不依赖具体 shape
- [backend/test/phase3/test-auditMigration.js:166](../../backend/test/phase3/test-auditMigration.js#L166) — 同上

外部脚本（监控 / 报表 / BI）若有读 `result.sampleRows` 的，需切到 `result.rowCount` + `result.sampleHash`。**非 D2-D5 范围**，由文档化告知运维。

### TODO-D1.4 · 历史 query_history 行未做数据迁移
旧记录的 `result` 列仍是 `{columns, sampleRows}` 形态。本次只切换"新写入"，不回填历史。如有合规要求清空历史业务行，需单独迁移脚本，**非本计划范围**。

---

## 3. 偏离初始计划的变更及其原因

### 偏离 3.1 · 测试用例由"5 个断言"扩为"5 个 + 1 个兜底"
- **计划**（[NL2SQL-真实数据批次D1-任务计划.md](NL2SQL-真实数据批次D1-任务计划.md) §写入范围 3）：5 个断言
- **实际**：5 个断言 + 1 个兜底用例（`null` / `{}` / 缺字段）
- **原因**：实现 `summarizeResultForAudit` 时为防御性加入了非法入参兜底（`safe = data && typeof data === 'object' ? data : {}`），既然实现里有兜底分支，测试就要覆盖以防回归。计划未禁止增加用例，仅新增不删减，无副作用。

### 偏离 3.2 · `auditHelper` 没有放进 `sqlExecutor.js`
- **计划**（任务计划 §写入范围 1）："新增 [auditHelper.js](../../backend/src/core/auditHelper.js) **或** 放进 sqlExecutor.js"
- **实际**：选择新建独立文件
- **原因**：sqlExecutor 已有 200 行偏长且职责单一（验证 + 执行 + 脱敏），混入审计摘要会污染职责边界。独立 `auditHelper.js` 让 D2/D3 直接 `require('./auditHelper')` 也更直观，且不会让 sqlExecutor 因引入 `crypto` 增加依赖面。

### 偏离 3.3 · 文档目录由 `docs/` 移到 `docs/claude/`
- **计划**：批次任务计划与交接摘要原计划写入 `docs/`
- **实际**：用户在执行前把 6 份批次文档统一移入 `docs/claude/`；本交接摘要也写入 `docs/claude/`
- **原因**：用户行为，本计划顺应。对代码无影响，仅文档相对路径调整。

### 偏离 3.4 · `sampleHash` 输出长度明确为 16 hex 字符
- **计划**：`sampleHash = sha256(JSON.stringify(rows.slice(0,5)))`（未明确取多少字符）
- **实际**：`.slice(0, 16)`（前 16 字符 hex，64-bit 信息量）
- **原因**：完整 sha256 hex 是 64 字符，纯审计抽样比对场景不需要；16 字符冲突概率 ~2⁻⁶⁴，足够；同时减少 `query_history.result` 列的存储压力。计划文档（总览 §关键决策）已声明摘要包含 `sampleHash`，本偏离仅是把"未指定长度"细化为"16 字符"。

### 无偏离的事项（备查）
- 摘要字段 `{columns, rowCount, truncated, sampleHash}` 与计划完全一致
- legacy 审计写入位点（L562-L571）与计划预估的 L561-L574 一致
- 返回前端 `data` 不变，与计划"关键约束"一致
- 不触碰 agentic / sseHandler / 前端，与计划严格读写范围一致

---

## 4. 验证结果存档

```
$ node backend/test/phase-data/test-audit-helper.js
✅ test-audit-helper: 5 个断言 + 兜底全部通过

$ cd backend && npm run test:smoke
[runner] 发现 33 个测试脚本 | smoke=true | phase=all
[runner] 汇总:
  ✓ pass:    31
  ✗ fail:    0
  ✗ timeout: 0
  ⊘ skip:    2          # phase1/test-executeQuery.js (no SR_DB)
                        # phase2/test-regression-complex.js (no LLM key)
  总计:     33
```
与 [NL2SQL-目标偏离评估说明.md](NL2SQL-目标偏离评估说明.md) 第 18-22 行的基线一致。

---

## 5. D2 启动条件确认
- [x] `backend/src/core/auditHelper.js` 已交付，`summarizeResultForAudit` 可 `require`
- [x] legacy 审计写入已切换到摘要形态
- [x] smoke 31 pass / 0 fail，与基线一致
- [x] D2/D3 接入路径已固化（详见本文档 §1.1）
- [x] agentic 现行 result 形态与待替换位点已标注（详见 TODO-D1.1）

D2 可以开工：在 `agenticEngine.processQuery` 接入 `executionPhase`，并把 [agenticEngine.js:189-192](../../backend/src/core/agenticEngine.js#L189-L192) 的 `result` 字段一并切换到 `summarizeResultForAudit(...)`。

---

## 6. 回滚方式
1. 还原 [backend/src/core/nl2sqlEngine.js:567-568](../../backend/src/core/nl2sqlEngine.js#L567-L568) 的 result 字段为：
   ```js
   result: {
     columns: queryResult.data?.columns,
     sampleRows: Array.isArray(queryResult.data?.rows)
       ? queryResult.data.rows.slice(0, 20) : []
   }
   ```
2. 移除 L37 的 `require('./auditHelper')`
3. `auditHelper.js` 与 `test-audit-helper.js` 可保留备用，无副作用

回滚后立刻恢复到批次 D1 改动前的状态。
