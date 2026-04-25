# NL2SQL 真实数据批次 D4：SSE 下发与前端兼容

## 来源
- **主计划文件**：`C:/Users/hanhui/.claude/plans/sql-vivid-lemon.md` · 批次 D4
- **总览文档**：[NL2SQL-真实数据批次总览.md](NL2SQL-真实数据批次总览.md)
- **上游设计文档**：[NL2SQL-真实数据输出实施计划.md](NL2SQL-真实数据输出实施计划.md) · Phase B、E
- **生成日期**：2026-04-24
- **批次位置**：5 批次中的第 4 批

---

## 目标
SSE 侧按新契约下发 + 落库 metadata，前端把"无数据"与"有数据"区分渲染。**协议本身不变**（无新 SSE 事件、无新 API）。

## 前置依赖
- D2 已完成 agentic 主路径执行闭环
- D3 已完成澄清恢复路径执行闭环
- 阅读 [NL2SQL-真实数据批次D2-交接摘要.md](NL2SQL-真实数据批次D2-交接摘要.md) 和 [NL2SQL-真实数据批次D3-交接摘要.md](NL2SQL-真实数据批次D3-交接摘要.md)（引擎现在稳定返回 `type='result'` + `data`）

---

## 读取范围（严格）
| 文件 | 行范围 | 用途 |
|---|---|---|
| [backend/src/core/sseHandler.js](../backend/src/core/sseHandler.js) | L320-L500 | `handleQuery` / `persistAgenticMessages` / `handleClarifyAnswer` |
| [frontend/src/stores/session.js](../frontend/src/stores/session.js) | L240-L310 | SSE 消息分发、消息入列 |
| [frontend/src/views/ChatView.vue](../frontend/src/views/ChatView.vue) | L40-L90 | 数据表渲染、SQL 折叠展示 |

**不读** engine、database、auditHelper、测试（依赖 D2/D3 摘要中列出的接口）。

## 写入范围（严格）
### 1. `backend/src/core/sseHandler.js` · `persistAgenticMessages`
| 分支 | 新行为 |
|---|---|
| `result.type === 'result'` | 写 metadata `{ sql, data, selectedTables, explanation, executionTime, engineUsed }` |
| `result.type === 'clarification'` | 保持原有 clarification metadata 写入不变（批次 B 已固化） |
| `result.type === 'sql_result'`（遗留） | 降级为兼容读取；不再作为主写入路径，但保留解析以不破坏老会话 |

### 2. `backend/src/core/sseHandler.js` · `handleClarifyAnswer`
- 收到 D3 返回的 `type='result'` + `data` 时，直接广播，无需转换
- 广播时加上 `engineUsed='agentic-resume'`（这是"由 SSE 层打标"的实际位置）

### 3. `frontend/src/stores/session.js`（L255-L294）
- 处理 `data.type === 'result'` 时：
  - 若 `data.data?.rows?.length === 0` → 消息附加 `emptyResult: true` 标记，UI 展示"查询无结果"占位
  - 有 rows → 正常入列并渲染数据表
- `sql_result` 分支保留（老消息兼容），但不再从新 SSE 流接收

### 4. `frontend/src/views/ChatView.vue`（L60-L75）
- 空数据文案：`emptyResult === true` 时显示占位
- SQL 折叠展示保持原样
- **不改** Element Plus 表格组件、不加新视图

---

## 本批次验证
前后端 dev 起服务：
```bash
cd backend && FF_AGENTIC_ENGINE=true npm run dev
cd frontend && npm run dev
```

### 三条路径手测
1. **普通查询**：UI 显示数据表；空数据时显示占位文案
2. **澄清查询**：回答后 UI 显示数据表；消息 metadata 含 `engineUsed === 'agentic-resume'`
3. **老会话兼容**：打开历史会话（含 `sql_result` 老消息）不崩溃，SQL 与解释正常显示

### 断言
- 浏览器 DevTools → Network → SSE stream：`result` 事件 payload 含 `data.rows`
- `data/sessions.db` → `messages.metadata` 新消息为 `{sql, data, ...}` 形态
- 前端控制台无报错

---

## 交接摘要（批次完成后产出）
输出 `docs/NL2SQL-真实数据批次D4-交接摘要.md`：
- 前后端改动精确行号
- 三条手测路径的结果截图（普通 / 澄清 / 老会话）
- 提示 D5：E2E 测试需覆盖"空结果"、"truncated"、"澄清恢复"三条路径

---

## 风险
| 风险 | 缓解 |
|---|---|
| 老会话消息 metadata 缺字段导致渲染崩 | 前端读取时用可选链 + 默认值，保留 `sql_result` 兼容分支 |
| 大结果集 SSE payload 超大 | 依赖 `sqlExecutor` 既有 `maxRows` 截断 + `truncated` 标记，前端显示提示 |
| `engineUsed` 打标位置从引擎改到 SSE 层 | D3 显式不设置该字段；SSE 层统一在广播点打标，集中处理一次 |
