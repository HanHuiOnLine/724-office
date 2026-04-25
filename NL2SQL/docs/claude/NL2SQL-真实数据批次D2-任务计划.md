# NL2SQL 真实数据批次 D2：agentic 主路径执行闭环

## 来源
- **主计划文件**：`C:/Users/hanhui/.claude/plans/sql-vivid-lemon.md` · 批次 D2
- **总览文档**：[NL2SQL-真实数据批次总览.md](NL2SQL-真实数据批次总览.md)
- **上游设计文档**：[NL2SQL-真实数据输出实施计划.md](NL2SQL-真实数据输出实施计划.md) · Phase C
- **生成日期**：2026-04-24
- **批次位置**：5 批次中的第 2 批

---

## 目标
让 `agenticEngine.processQuery` 在验证通过后执行 SQL，成功返回 `type='result'` + 真实 `data`，并把真实 `executionTime`/`rowCount` 写入审计。

## 前置依赖
- D1 已交付 `backend/src/core/auditHelper.js::summarizeResultForAudit`
- 阅读 [NL2SQL-真实数据批次D1-交接摘要.md](NL2SQL-真实数据批次D1-交接摘要.md)（D1 完成后产出）

---

## 读取范围（严格）
| 文件 | 行范围 | 用途 |
|---|---|---|
| [backend/src/core/agenticEngine.js](../backend/src/core/agenticEngine.js) | L1-L250 | `processQuery` 主流程 |
| [backend/src/core/agenticEngine.js](../backend/src/core/agenticEngine.js) | L600-L720 | `verificationPhase` / `recoveryPhase` 签名 |
| [backend/src/core/sqlExecutor.js](../backend/src/core/sqlExecutor.js) | L34-L170 | `validateSQL` / `executeQuery` 签名 |
| [backend/src/core/database.js](../backend/src/core/database.js) | L1041-L1135 | 审计写入 API |

**不读** `resumeFromClarification`（留给 D3）、**不读** SSE / 前端 / 测试。

## 写入范围（严格）
### 1. 在 `backend/src/core/agenticEngine.js` 新增私有函数 `executionPhase`
```
executionPhase(finalSql, ctx)
  1) validateSQL(finalSql)
  2) executeQuery(finalSql)
  => { success, data, executionTime, errorCode?, error? }
```
- 模块内可复用（D3 会复用）
- 统一经由 `sqlExecutor.executeQuery`，**禁止**绕过执行器直连 mysql 驱动

### 2. `processQuery` 接入 executionPhase
在 `verificationPhase.success === true` 后调用 `executionPhase`：
- **成功** → 返回
  ```
  { success: true, type: 'result', sql, explanation, selectedTables,
    decomposition, verification, data, executionTime, traceLog, duration }
  ```
- **失败 + 未走过 recoveryPhase** → 走一次 `recoveryPhase`，再试 `executionPhase`
- **仍失败** → `{ success: false, type: 'error', error }`

### 3. 审计写入对齐（原 L173-L200 位点）
- `markQueryHistorySuccess`：`executionTime`/`rowCount` 使用真实值；`result` 使用 `summarizeResultForAudit(queryResult.data)`
- `markQueryHistoryFailure`：传入真实 `executionTime` 与 `errorCode`

---

## 本批次验证
```bash
cd backend
npm run test:smoke

# 手测
FF_AGENTIC_ENGINE=true npm run dev
# 前端问一个简单查询，断言：
#   - SSE result 事件 type === 'result'（非 sql_result）
#   - data.rowCount > 0
#   - query_history.row_count === data.rowCount
#   - query_history.execution_time 为 SQL 实际耗时（非规划耗时）
```

### DRY_RUN 回归
```bash
DRY_RUN=true FF_AGENTIC_ENGINE=true npm run dev
# 问查询，断言 data.rows === []（既有行为不回退）
```

---

## 交接摘要（批次完成后产出）
输出 `docs/NL2SQL-真实数据批次D2-交接摘要.md`：
- `executionPhase` 签名、文件位置、行号（供 D3 复用）
- `processQuery` 成功返回新契约（字段清单）
- 提示 D4：SSE 侧需按 `type==='result'` 分支写 metadata
- 执行失败 → recovery → 重试链路的时序图

---

## 风险
| 风险 | 缓解 |
|---|---|
| 执行耗时叠加，P95 上升 | 保留 `DRY_RUN` 开关即时关闭执行 |
| `recoveryPhase` 后的第二次 `executionPhase` 再次失败 | 返回 `type='error'` 并写 `markQueryHistoryFailure`，不静默 |
| 复用 `executionPhase` 的参数语义不一致 | D3 直接调用时需保证传入的 `ctx`（含 sessionId、rls、脱敏开关）与 D2 完全一致，交接摘要中固化 |
