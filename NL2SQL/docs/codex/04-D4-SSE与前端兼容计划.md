# D4 批次计划：SSE 下发与前端兼容收口

## 1. 批次目标
在不增加新协议事件的前提下，把 SSE 与前端展示切换为 data-first，确保“默认看数据，不是只看 SQL”。

## 2. 前置依赖
1. D2 已让主路径返回 `type='result'`。
2. D3 已让澄清恢复返回 `type='result'`。

## 3. 范围边界
### 3.1 允许修改
1. `backend/src/core/sseHandler.js`
2. `frontend/src/stores/session.js`
3. `frontend/src/views/ChatView.vue`（仅展示层轻改）

### 3.2 禁止修改
1. 引擎内部生成/执行逻辑（D2/D3 已定）
2. API 路由契约（保持现有）

## 4. 任务分解（WBS）
| 任务ID | 任务内容 | 产出 | 预计工时 |
|---|---|---|---|
| D4-T1 | SSE 持久化元数据切换到 result/data 语义 | `persistAgenticMessages` 对齐 | 0.5d |
| D4-T2 | 澄清返回 `engineUsed='agentic-resume'` 打标统一 | 广播层一致 | 0.5d |
| D4-T3 | 前端 `session` store 兼容 `result` 与旧 `sql_result` | 消息解析稳定 | 0.5d |
| D4-T4 | ChatView 空结果占位和表格优先展示 | 体验收口 | 0.5d |

## 5. 详细执行步骤
1. `sseHandler.persistAgenticMessages`：
   - 对 `type='result'` 写入 metadata `{sql,data,selectedTables,executionTime,engineUsed}`
   - 保留 `sql_result` 读取兼容（历史消息）
2. `handleClarifyAnswer`：
   - 广播 `result` 时统一附 `engineUsed='agentic-resume'`
3. `session.js`：
   - 优先渲染 `data.rows`
   - `rows.length===0` 标记 `emptyResult=true`
   - 保留 `sql_result` 老消息分支
4. `ChatView.vue`：
   - 空结果占位文案
   - SQL 折叠维持原交互

## 6. 验收标准（DoD）
1. 普通查询、澄清恢复均展示数据表（或空结果提示）。
2. 历史会话（含 `sql_result`）不崩溃。
3. SSE 仍仅使用现有事件类型：`processing/progress/result/error`。

## 7. 风险与回滚
| 风险 | 回滚/缓解 |
|---|---|
| 老 metadata 字段缺失导致前端异常 | 可选链 + 默认值 + 旧分支保留 |
| 大结果集前端卡顿 | 依赖后端 `maxRows` + `truncated`；前端提示截断 |
| 打标不一致影响统计 | 固定在 SSE 广播层统一打标 |

## 8. 批次交接要求
完成后新增：`docs/NL2SQL-真实数据批次D4-交接摘要.md`，附三类手测记录（普通、澄清、历史会话）。

