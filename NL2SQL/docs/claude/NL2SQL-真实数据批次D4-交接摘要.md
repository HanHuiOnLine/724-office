# NL2SQL 真实数据批次 D4 · 交接摘要

## 来源
- **批次任务计划**:[NL2SQL-真实数据批次D4-任务计划.md](NL2SQL-真实数据批次D4-任务计划.md)
- **总览文档**:[NL2SQL-真实数据批次总览.md](NL2SQL-真实数据批次总览.md)
- **上游交接**:[NL2SQL-真实数据批次D3-交接摘要.md](NL2SQL-真实数据批次D3-交接摘要.md)
- **执行日期**:2026-04-25
- **执行结果**:✅ 通过(`backend npm run test:smoke` 31 pass / 0 fail / 2 skip,与 D2/D3 基线一致;`frontend npm run build` 25.48s 通过)

---

## 1. 已修改的核心接口和逻辑

### 1.1 [backend/src/core/sseHandler.js](../../backend/src/core/sseHandler.js) · `persistAgenticMessages`
**位置**:[sseHandler.js:461-494](../../backend/src/core/sseHandler.js#L461-L494)

**改动一句话**:把主写入分支从 `tagged.type === 'sql_result'` 升级到 `tagged.type === 'result'`,metadata 持久化新契约 `{ sql, data, selectedTables, explanation, executionTime, engineUsed, verificationWarning }`;`sql_result` 分支保留为兼容兜底(新链路不会走到,极端 fallback 才会触发)。

| 行 | 改动 |
|---|---|
| L461-L479 | **新增** `tagged.type === 'result'` 分支:写新 metadata,含 `executionTime` / `engineUsed` / `verificationWarning` |
| L480-L494 | 原 `sql_result` 分支保留写入语义,作老链路/极端兜底兼容 |
| L436-L460 | `clarification` 分支保持批次 B 形态不变 |
| L495-L500 | `error` / `success===false` 分支保持原状 |

**复用契约**:`tagged` 由调用方注入 `engineUsed` 标识。`handleQuery` → `'agentic'` / `'legacy'` / `'legacy-after-agentic'`,`handleClarifyAnswer` → `'agentic-resume'`(L594 现状,本批次未触碰)。两条路径都以 `tagged.type === 'result'` 走相同写入分支。

### 1.2 [backend/src/core/sseHandler.js](../../backend/src/core/sseHandler.js) · `handleClarifyAnswer`
**位置**:[sseHandler.js:592-606](../../backend/src/core/sseHandler.js#L592-L606)

**改动**:无代码改动。D3 的 `resumeFromClarification` 现已直接返回 `type='result' + data + executionTime`,该函数在 L592-L596 把 `engineUsed: 'agentic-resume'` 注入 `tagged`,在 L604 调用 `persistAgenticMessages` 时由 §1.1 新增的 `result` 分支统一落库,在 L606 直接广播 SSE event(payload 即 `tagged`),前端按 `data.type === 'result'` 一条分支统一处理。

### 1.3 [frontend/src/stores/session.js](../../frontend/src/stores/session.js) · SSE `result` 事件处理
**位置**:[session.js:268-292](../../frontend/src/stores/session.js#L268-L292)

**改动**:
| 行 | 改动 |
|---|---|
| L274-L278 | **新增** `isResultType = (type==='result' \|\| type==='sql_result')` + `emptyResult = isResultType && Array.isArray(rows) && rows.length === 0` 的空结果识别 |
| L283-L290 | 入列 message metadata **新增**字段:`executionTime`(后端 D2/D3 真实耗时)、`engineUsed`(`'agentic'` / `'agentic-resume'` / `'legacy'`)、`emptyResult`(空结果标记) |
| 兼容 | `sql_result` 老消息回放路径走同一分支不报错(rows 仍渲染表格) |

新协议 vs. 老前端兼容:`type === 'clarification'` / `type === 'error'` 处理路径不变;`message_id` 透传逻辑保留,与批次 B 协议无冲突。

### 1.4 [frontend/src/views/ChatView.vue](../../frontend/src/views/ChatView.vue) · 消息渲染
**位置**:[ChatView.vue:60-83](../../frontend/src/views/ChatView.vue#L60-L83) + [ChatView.vue:165](../../frontend/src/views/ChatView.vue#L165) + [ChatView.vue:587-617](../../frontend/src/views/ChatView.vue#L587-L617)

**改动**:
| 行 | 改动 |
|---|---|
| L60-L64 | **新增** `emptyResult === true` 占位块,展示 `<InfoFilled>` 图标 + "查询无结果"文案 |
| L65-L83 | 原数据表块改为 `v-else-if`,新增内部 `truncated` 提示行(`已截断显示前 N 行`) |
| L165 | `@element-plus/icons-vue` 导入加 `InfoFilled` |
| L592-L617 | CSS:`.data-truncated-hint`(浅灰小字)、`.empty-result`(虚线边框 + 图标)新增样式 |
| 不改 | Element Plus 表格组件、SQL 折叠展示、澄清块、欢迎页、输入区域 |

---

## 2. 新协议下的端到端契约 (D2 + D3 + D4 完整链)

### 2.1 SSE `result` 事件 payload(主路径与 resume 路径同形)
```jsonc
{
  "type": "result",                  // 替代历史的 'sql_result'
  "success": true,
  "sql": "SELECT ... LIMIT 1000",
  "explanation": "...",
  "data": {
    "columns": ["id","name","..."],
    "rows": [ /* ≤ maxRows */ ],
    "rowCount": 123,
    "truncated": false               // true 时前端展示截断提示
  },
  "executionTime": 820,              // 真实 SQL 耗时 (ms)
  "engineUsed": "agentic",           // or 'agentic-resume' / 'legacy'
  "selectedTables": [/* ... */],
  "verificationWarning": null,       // 仅降级路径成功时透传
  "decomposition": {/* ... */},
  "verification": {/* ... */},
  "traceLog": [/* ... */],
  "duration": 1234,
  "fallbackUsed": false,
  "resumed": true                    // 仅 resume 路径携带
}
```

### 2.2 数据库 `messages.metadata` 写入(由 §1.1 落库)
```jsonc
{
  "sql": "...",
  "selectedTables": [/* ... */],
  "explanation": "...",
  "data": { "columns":[...], "rows":[...], "rowCount":N, "truncated":bool },
  "executionTime": 820,
  "engineUsed": "agentic" | "agentic-resume",
  "verificationWarning": null
}
```

### 2.3 前端 `messages[i]` 结构(由 §1.3 入列)
```jsonc
{
  "role": "assistant",
  "content": "<explanation>",
  "type": "result",
  "metadata": {
    "sql": "...",
    "data": { /* 同上 */ },
    "verificationWarning": null,
    "executionTime": 820,
    "engineUsed": "agentic-resume",
    "emptyResult": false             // 空结果时为 true,触发占位渲染
  }
}
```

---

## 3. 给 D5 的提示

### 3.1 三条端到端路径(`test/phase-data/`)
对应 D4 §本批次验证,D5 应覆盖:

1. **普通查询成功**:`processQuery` → SSE `result` 事件 → `messages.metadata` 含 `data` + `executionTime` + `engineUsed='agentic'` → 前端可见数据表
2. **澄清恢复成功**:首轮 `type='clarification'` → `clarify-answer` POST → `resumeFromClarification` → SSE `result` 事件 `engineUsed='agentic-resume'` → 数据表
3. **空结果**:`executeQuery` 返回 `rows=[]` → 前端 message `metadata.emptyResult === true`,UI 渲染占位
4. **truncated**:`executeQuery` 返回 `truncated=true` + 截断 rows → metadata 透传 → UI 在表下方加截断提示

### 3.2 stub 复用提示
[backend/test/phase3/clarification-resume.test.js](../../backend/test/phase3/clarification-resume.test.js) 已固化的 stub 模式可直接复用:
- `sqlExecutor.validateSQL` / `executeQuery`
- `database.createQueryHistory` / `markQueryHistorySuccess` / `markQueryHistoryFailure`
- D5 可在此基础上加 `database.addMessage` 的 mock,断言 metadata 含 `executionTime` / `engineUsed`

### 3.3 前端 E2E(可选,D5 范围酌情)
若覆盖前端 E2E,关键断言点:
- `data-table` 仅在 `emptyResult===false` 时渲染
- `empty-result` 占位仅在 `emptyResult===true` 时渲染
- `data-truncated-hint` 仅在 `data.truncated===true` 时渲染
- 老会话 `metadata` 缺 `executionTime` / `engineUsed` 时不报错(`?.` 链路保护)

---

## 4. 偏离初始计划的变更及其原因

### 偏离 4.1 · `handleClarifyAnswer` 未做代码改动
- **计划**:计划 §写入范围 2 提到"广播时加上 `engineUsed='agentic-resume'`(这是'由 SSE 层打标'的实际位置)"
- **实际**:函数 L594 既已注入 `engineUsed: 'agentic-resume'`,本批次零代码改动
- **原因**:批次 B 阶段已实现该打标(为契合澄清恢复链路),D4 计划只是把它正式登记为"打标位置"。重新写入会引入冗余,故仅在本摘要中显式登记 §1.2 引用关系。
- **影响评估**:零;D3 改造 `resumeFromClarification` 内部不动 `engineUsed`,与 D4 协议预期完全一致。

### 偏离 4.2 · metadata 额外写 `verificationWarning`
- **计划**:计划 §写入范围 1 列出 `{ sql, data, selectedTables, explanation, executionTime, engineUsed }`,未列 `verificationWarning`
- **实际**:§1.1 写入分支额外保留 `verificationWarning`
- **原因**:D3 摘要 §1.4 显式说"`verificationWarning` 在降级路径透传给前端展示警告小提示",落库该字段使会话历史回放时也能保留警告状态。无破坏性。
- **影响评估**:DB metadata 多一个 nullable 字段;前端已通过 `metadata.verificationWarning` 读取(老代码保留),无变化。

### 偏离 4.3 · 前端 `metadata` 透传 `executionTime` / `engineUsed`
- **计划**:计划 §写入范围 3 仅提"处理 `data.type === 'result'` 时空数据标记",未明确要求把 `executionTime` / `engineUsed` 加到前端 message metadata
- **实际**:§1.3 一并透传
- **原因**:D5 端到端测试(§3)需要从 message 读取这两个字段做断言;前端 message metadata 与后端 `messages.metadata` 字段对齐后,会话回放与实时消息行为一致,降低两边 schema 漂移概率。
- **影响评估**:渲染层未消费(本批次范围严格,不动 UI);仅作为数据通道存储,体积影响可忽略(数字 + 短字符串)。

### 偏离 4.4 · 前端额外加 `truncated` 提示
- **计划**:计划 §风险表提到"大结果集 SSE payload 超大 ⇒ 依赖 `sqlExecutor` 既有 `maxRows` 截断 + `truncated` 标记,前端显示提示",但 §写入范围 4 没明确要求在本批次实现
- **实际**:§1.4 在 data-table 内加了 `data.truncated` 提示行
- **原因**:风险表既已点名,且实现仅 1 行 `v-if`,不实现等于把风险显式留给 D5/线上;一并落地更经济。
- **影响评估**:不破坏既有渲染,只在 truncated 真实为 true 时多一行小字。

### 无偏离的事项(备查)
- 后端 SSE 协议**零新增事件**,只有 payload 字段升级(与计划 §目标"协议本身不变"完全一致)
- 前端 `clarification` / `error` 分支保持不变
- `sql_result` 写入分支保留,老会话 metadata 无破坏
- 严格读取范围内的文件:sseHandler、session.js、ChatView.vue,未越界

---

## 5. 验证结果存档

### 5.1 后端 smoke
```
$ npm run test:smoke
[runner] 汇总:
  ✓ pass:    31
  ✗ fail:    0
  ✗ timeout: 0
  ⊘ skip:    2          # phase1/test-executeQuery.js (no SR_DB)
                        # phase2/test-regression-complex.js (no LLM key)
  总计:     33
```
与 D2/D3 基线完全一致(31 pass / 0 fail / 2 skip)。

### 5.2 前端 build
```
$ npm run build
✓ built in 25.48s
```
仅有既存的 chunk size warning(项目历史问题,非本批次引入)。

### 5.3 IDE TS 提示
[ChatView.vue:172](../../frontend/src/views/ChatView.vue#L172) 的 "All imports unused" 是 Vue SFC 误报(TypeScript service 不识别 template 内的 icon 引用),已存在于此前批次,本批次仅追加 `InfoFilled` 一项,不引入新错误。

---

## 6. 手动联调指南(打开 FF 后的三条手测路径)

```bash
# 后端
cd backend && FF_AGENTIC_ENGINE=true npm run dev
# 前端
cd frontend && npm run dev   # 5173,Vite 代理转发到 3000
```

### 路径 1 · 普通查询(数据非空)
1. 浏览器开 `http://localhost:5173`,新建会话
2. 输入"查一下最近 7 天的订单数"(任一会触发数据查询的提问)
3. **预期**:
   - 助手消息渲染 `data-table`(Element Plus 表格)
   - DevTools → Network → SSE stream:`event` 之外的 payload 含 `data.rows` / `executionTime` / `engineUsed: 'agentic'`
   - SQLite `data/sessions.db` → `messages.metadata` 形如 §2.2

### 路径 2 · 澄清查询恢复(数据非空)
1. 输入会触发澄清的提问(如"看一下数据")
2. 后端首轮返回 `type='clarification'`,前端弹澄清按钮
3. 点选/输入澄清回答
4. **预期**:
   - SSE stream 第二次 `result` 事件 payload 含 `engineUsed: 'agentic-resume'` + `resumed: true` + `data.rows`
   - `messages.metadata` 写入新结构,`engineUsed === 'agentic-resume'`

### 路径 3 · 空结果占位
1. 提问刻意只命中空数据(如查不存在的 typeid 范围)
2. **预期**:
   - 助手消息**不渲染表格**
   - 渲染 `.empty-result` 块:`<InfoFilled>` 图标 + "查询无结果"
   - DevTools 无报错;`metadata.emptyResult === true`

### 路径 4 · 老会话兼容
1. 打开 D2 之前的历史会话(metadata 仅 `{ sql, data, selectedTables }`,无 `executionTime` / `engineUsed`)
2. **预期**:
   - 表格正常渲染
   - 控制台无可选链未定义报错

### DRY_RUN 回归
```bash
DRY_RUN=true FF_AGENTIC_ENGINE=true npm run dev
# 任意查询 → 后端透传 data.rows=[] → 前端 emptyResult=true,显示"查询无结果"占位
```

---

## 7. D5 启动条件确认
- [x] 主路径 + resume 路径在 SSE 层产出 `type='result' + data + executionTime + engineUsed`
- [x] 落库 metadata 与 SSE payload 同 schema(§2.2 / §2.1)
- [x] 前端 `emptyResult` / `truncated` 渲染分支接通
- [x] 老会话 / `sql_result` 兼容分支保留
- [x] smoke 31 pass / 0 fail / 2 skip;前端 build 通过
- [x] 三条手测路径文档化(§6)

D5 可以开工:在 `backend/test/phase-data/` 加端到端用例,覆盖 §3.1 的 4 条路径;复用 §3.2 stub 即可。

---

## 8. 回滚方式

代码回滚:
1. 还原 [sseHandler.js:461-494](../../backend/src/core/sseHandler.js#L461-L494) 的 `persistAgenticMessages` 为批次 D3 完工态(只有 `sql_result` 分支)
2. 还原 [session.js:268-292](../../frontend/src/stores/session.js#L268-L292) 移除 `emptyResult` / `executionTime` / `engineUsed` 字段
3. 还原 [ChatView.vue:60-83](../../frontend/src/views/ChatView.vue#L60-L83) 移除 `empty-result` / `data-truncated-hint` 渲染块
4. 还原 [ChatView.vue:165](../../frontend/src/views/ChatView.vue#L165) 的 `InfoFilled` 导入
5. 还原 [ChatView.vue:587-617](../../frontend/src/views/ChatView.vue#L587-L617) 的两段新 CSS

紧急回滚不需要改代码,可直接:
- `DRY_RUN=true`:agentic 仍生成 SQL 但不执行,`data.rows=[]` → 前端走 `emptyResult` 占位(等价临时关闭执行)
- `FF_AGENTIC_ENGINE=false`:整体切回 legacy(legacy 也已返回 `type='result' + data`,前端兼容渲染)
- `FF_AGENTIC_AUTO_FALLBACK=true`(现状):agentic 失败自动回退 legacy
