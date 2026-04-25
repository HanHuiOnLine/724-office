# NL2SQL 真实数据批次 D3：agentic 澄清恢复执行闭环

## 来源
- **主计划文件**：`C:/Users/hanhui/.claude/plans/sql-vivid-lemon.md` · 批次 D3
- **总览文档**：[NL2SQL-真实数据批次总览.md](NL2SQL-真实数据批次总览.md)
- **上游设计文档**：
  - [NL2SQL-真实数据输出实施计划.md](NL2SQL-真实数据输出实施计划.md) · Phase C
  - [NL2SQL-澄清断链修复-批次C-交接摘要.md](NL2SQL-澄清断链修复-批次C-交接摘要.md)（澄清恢复路径既有背景）
- **生成日期**：2026-04-24
- **批次位置**：5 批次中的第 3 批

---

## 目标
让 `resumeFromClarification` 也返回 `type='result'` + data，澄清分支与主分支体验一致。

## 前置依赖
- D1 已交付 `auditHelper.summarizeResultForAudit`
- D2 已在 `agenticEngine.js` 中交付可复用的 `executionPhase`
- 阅读 [NL2SQL-真实数据批次D2-交接摘要.md](NL2SQL-真实数据批次D2-交接摘要.md)：必须拿到 `executionPhase` 的签名与行号

---

## 读取范围（严格）
| 文件 | 行范围 | 用途 |
|---|---|---|
| [backend/src/core/agenticEngine.js](../backend/src/core/agenticEngine.js) | L780-L940 | `resumeFromClarification` 及其辅助函数 |
| [backend/src/core/agenticEngine.js](../backend/src/core/agenticEngine.js) | D2 摘要指向的 `executionPhase` 行号附近 | 确认函数签名 |

**不重读** `processQuery` 主路径；**不读** sqlExecutor、database（依赖 D2 摘要中固化的接口）；**不读** SSE / 前端 / 测试。

## 写入范围（严格）
### 1. 修改 `resumeFromClarification`（L803-L929）
在 `verificationPhase.success === true` 后插入 `executionPhase` 调用：
- 成功 → 返回
  ```
  { success: true, type: 'result', sql, explanation, selectedTables,
    decomposition, verification, data, executionTime, traceLog, duration,
    resumed: true }
  ```
- 失败 → 走 `recoveryPhase` → 重试 `executionPhase` → 仍失败返回 `type='error'`

### 2. 审计写入对齐 D2
- 成功路径：`markQueryHistorySuccess`，使用真实 `executionTime`/`rowCount`/摘要 `result`
- 失败路径：`markQueryHistoryFailure`，使用真实值
- **不在本文件设置** `engineUsed='agentic-resume'`，该字段由 `sseHandler` 层广播时打标（D4 处理）

---

## 本批次验证
```bash
cd backend && npm run test:smoke
```

### 手测（前后端 dev）
1. 构造一个触发澄清的查询
2. 回答澄清
3. 断言：
   - SSE result 事件 `type === 'result'`
   - `resumed === true`
   - `data.rowCount > 0`
   - `query_history` 新增记录的 `row_count` 与 `data.rowCount` 一致

### DRY_RUN 回归
```bash
DRY_RUN=true FF_AGENTIC_ENGINE=true npm run dev
# 澄清 → 回答 → data.rows === []，不崩溃
```

---

## 交接摘要（批次完成后产出）
输出 `docs/NL2SQL-真实数据批次D3-交接摘要.md`：
- `resumeFromClarification` 新返回契约
- 提示 D4：`handleClarifyAnswer` 下发时使用 `type='result'` 并携带 `data`，`engineUsed='agentic-resume'` 由 SSE 层打标
- D2 + D3 完成后 agentic 引擎两条成功路径的一致性确认表

---

## 风险
| 风险 | 缓解 |
|---|---|
| D2/D3 对 `executionPhase` 的参数语义漂移 | 严格沿用 D2 摘要中固化的调用方式，不自造参数 |
| 澄清后补充的 dataUnits 未进入 SQL 改写 | 既有 `applyClarificationResult` 负责回写 dataUnits，D3 不改该流程 |
| `resumed: true` 与老客户端兼容 | 该字段只增不改，老客户端忽略即可 |
