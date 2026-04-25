# NL2SQL 真实数据批次 D1：审计摘要基建 + legacy 对齐

## 来源
- **主计划文件**：`C:/Users/hanhui/.claude/plans/sql-vivid-lemon.md` · 批次 D1
- **总览文档**：[NL2SQL-真实数据批次总览.md](NL2SQL-真实数据批次总览.md)
- **上游设计文档**：[NL2SQL-目标偏离评估说明.md](NL2SQL-目标偏离评估说明.md) · 5.1 P0 "数据最小化要求"
- **生成日期**：2026-04-24
- **批次位置**：5 批次中的第 1 批（无前置依赖）

---

## 目标
交付纯函数 `summarizeResultForAudit`，并把 legacy 的审计写入切换到摘要形态，消除"`query_history` 存业务行"的数据最小化偏离。

## 前置依赖
无。本批次不触碰 agentic 引擎、不触碰 SSE、不触碰前端。

---

## 读取范围（严格）
| 文件 | 行范围 | 用途 |
|---|---|---|
| [backend/src/core/nl2sqlEngine.js](../backend/src/core/nl2sqlEngine.js) | L540-L600 | 定位审计写入位点 |
| [backend/src/core/sqlExecutor.js](../backend/src/core/sqlExecutor.js) | L72-L170 | 确认 `executeQuery` 返回 `data` 的 shape（只读） |
| [backend/src/core/database.js](../backend/src/core/database.js) | L1041-L1135 | 确认 `markQueryHistorySuccess` 签名 |

**不读** agenticEngine、sseHandler、前端代码。

## 写入范围（严格）
### 1. 新增 `backend/src/core/auditHelper.js`
```
summarizeResultForAudit({columns, rows, rowCount, truncated})
  => { columns, rowCount, truncated, sampleHash }
```
- `sampleHash = sha256(JSON.stringify(rows.slice(0,5))).slice(0,16)`
- 纯函数、无 I/O
- 空 rows → `sampleHash = ''`

### 2. 修改 `backend/src/core/nl2sqlEngine.js`（约 L561-L574）
- 审计写入的 `result` 字段，由"`rows.slice(0,20)` + `columns`"替换为 `summarizeResultForAudit(queryResult.data)`。
- **关键约束**：返回给前端的 `data` 不变（仍然是完整 rows/columns），只是落库形态变摘要。

### 3. 新增 `backend/test/phase-data/test-audit-helper.js`
5 个断言：
1. 空结果集（`rows: []`）→ 摘要含空 `sampleHash`
2. 普通行集（10 行）→ `sampleHash.length === 16`
3. `truncated: true` → 摘要 `truncated` 透传
4. 超大列数（100 列）→ columns 原样返回
5. 相同 `rows.slice(0,5)` 产生相同 `sampleHash`（幂等验证）

---

## 本批次验证
```bash
cd backend
node test/phase-data/test-audit-helper.js
npm run test:smoke          # 31 case 全过
```
手查 `data/sessions.db`：legacy 新产生的 `query_history.result` 为 `{columns, rowCount, truncated, sampleHash}` 摘要形态，**不含业务 rows**。

---

## 交接摘要（批次完成后产出）
输出 `docs/NL2SQL-真实数据批次D1-交接摘要.md`，包含：
- `summarizeResultForAudit` 签名与 `sampleHash` 算法
- legacy 审计写入被替换的精确行号
- 提示 D2/D3 的引入方式：`const { summarizeResultForAudit } = require('./auditHelper')`
- 已消除的 P0 偏离项记录

---

## 风险
| 风险 | 缓解 |
|---|---|
| 下游如有脚本直接读 `query_history.result.rows` 会失效 | D1 交接摘要中需列出影响面；必要时保留旧字段 1-2 周过渡 |
| `sampleHash` 冲突 | 16 字符前缀冲突概率极低（~2^-64），且此字段仅用于事后抽样比对 |
