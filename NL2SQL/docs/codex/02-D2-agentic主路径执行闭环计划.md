# D2 批次计划：agentic 主路径执行闭环

## 1. 批次目标
让 `agenticEngine.processQuery` 从“只产 SQL”升级为“执行 SQL 并返回真实数据”，成功态改为 `type='result'`。

## 2. 前置依赖
1. D1 已完成（审计摘要工具可复用）。

## 3. 范围边界
### 3.1 允许修改
1. `backend/src/core/agenticEngine.js`
2. `backend/src/core/sqlExecutor.js`（仅必要的接口复用或小修）

### 3.2 禁止修改
1. `resumeFromClarification`（留给 D3）
2. SSE 层与前端（留给 D4）

## 4. 任务分解（WBS）
| 任务ID | 任务内容 | 产出 | 预计工时 |
|---|---|---|---|
| D2-T1 | 在 agentic 内新增可复用执行阶段函数 | `executionPhase` | 0.5d |
| D2-T2 | `processQuery` 接入执行阶段（含恢复后重试） | 主路径 `type='result'` | 1.0d |
| D2-T3 | 审计写入改真实执行语义 | `row_count`/`execution_time` 对齐 | 0.5d |
| D2-T4 | 主路径手测 + 冒烟回归 | 运行记录 | 0.5d |

## 5. 详细执行步骤
1. 新增 `executionPhase(finalSql, context)`：
   - 调 `sqlExecutor.validateSQL`
   - 调 `sqlExecutor.executeQuery`
   - 返回统一结构 `{ success, data, executionTime, errorCode, error }`
2. `processQuery` 在 `verificationPhase` 通过后进入 `executionPhase`：
   - 成功：返回 `type='result'`，附带 `data` 与 `executionTime`
   - 失败：走 `recoveryPhase` 重新生成，再执行一次
   - 仍失败：`type='error'`
3. 审计改造：
   - `markQueryHistorySuccess` 写真实 `rowCount` 与执行耗时
   - `result` 用 D1 摘要函数
4. 回归：
   - `npm run test:smoke`
   - 手测 `FF_AGENTIC_ENGINE=true` 场景
   - 手测 `DRY_RUN=true` 场景

## 6. 验收标准（DoD）
1. agentic 主路径成功返回 `type='result'` + `data.rows`。
2. `query_history.row_count` 与返回结果一致，不再固定 0。
3. 失败路径不静默，仍能落审计失败记录。

## 7. 风险与回滚
| 风险 | 回滚/缓解 |
|---|---|
| 执行阶段引入时延 | 保留 `FF_AGENTIC_ENGINE=false` 回 legacy |
| 生成可过、执行失败 | recovery 后二次执行；仍失败则 error |
| 审计语义错位 | 对比 `executionTime` 与数据库记录一致性 |

## 8. 批次交接要求
完成后新增：`docs/NL2SQL-真实数据批次D2-交接摘要.md`，包含新返回契约字段与 `executionPhase` 签名。

