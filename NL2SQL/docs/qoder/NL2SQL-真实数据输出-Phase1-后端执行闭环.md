# Phase 1 — 后端执行闭环

## 文档信息
- 版本：v1.0
- 日期：2026-04-24
- 优先级：P0（核心链路，所有后续阶段的前置依赖）
- 预计工时：3d

---

## 1. 目标

将系统从「生成 SQL 后即返回」升级为「生成 SQL → 执行 → 返回真实数据」，打通数据输出的最后一公里。

**核心交付**：任意自然语言查询 → 后端返回 `data.rows` 非空数组

---

## 2. 当前问题详解

### 2.1 DRY_RUN=true 阻断执行

**文件**：`backend/.env:69`
```
DRY_RUN=true
```

**影响**：`sqlExecutor.executeQuery()` 检测到 `config.security.dryRun=true` 后直接返回 `{success:true, data:{rows:[], dryRun:true}}`，不执行真实查询。

**代码路径**：`sqlExecutor.js` 中：
```javascript
if (config.security.dryRun) {
  return { success: true, data: { rows: [], dryRun: true }, executionTime: 0, sql };
}
```

### 2.2 agenticEngine 不执行 SQL

**文件**：`backend/src/core/agenticEngine.js:159-169`

agentic 引擎的 `processQuery` 在生成 SQL 后直接返回 `type:'sql_result'`，**没有调用 `sqlExecutor.executeQuery()`**：

```javascript
const finalResult = {
  success: sqlResult.success,
  type: 'sql_result',    // ← 不是 'result'
  sql: sqlResult.sql,
  explanation: sqlResult.explanation,
  selectedTables: sqlResult.selectedTables,
  // ← 没有 data 字段！
};
```

同样，`resumeFromClarification` 也返回 `type:'sql_result'` 且无数据。

### 2.3 返回类型不统一

| 引擎 | 返回 type | 包含 data | 包含 message |
|------|-----------|-----------|-------------|
| nl2sqlEngine (legacy) | `'result'` | ✅ 有 | ✅ 有 |
| agenticEngine | `'sql_result'` | ❌ 无 | ❌ 无 |

前端 `session.js:268-283` 需要双分支处理，且 agentic 路径拿不到数据。

### 2.4 SSE 持久化不识别 result 类型

**文件**：`backend/src/core/sseHandler.js:461`

`persistAgenticMessages` 只识别 `type:'sql_result'`，改为 `type:'result'` 后该分支无法命中：

```javascript
} else if (tagged.type === 'sql_result') {  // ← 只认 sql_result
  await database.addMessage(...);
}
```

---

## 3. 任务分解

### P1-T1: DRY_RUN 开关切换（0.5d）

**目标**：将 `DRY_RUN` 设为 `false`，验证 srDatabase 真实执行

**修改文件**：
- `backend/.env:69` — `DRY_RUN=true` → `DRY_RUN=false`

**验证步骤**：
1. 启动后端 `npm run dev`
2. 通过前端发送简单查询，如「查一下有多少条订单」
3. 检查 SSE result 事件中 `data.rows` 非空
4. 检查 `logs/app.log` 确认 SQL 执行成功

**回滚方案**：将 `DRY_RUN` 改回 `true` 即可

**注意事项**：
- 确保 `SR_DATABASE_URL` 已正确配置（当前已配置 StarRocks）
- 确保 `maskResult` 脱敏开关开启（默认已开）
- 确认 `SR_MAX_ROWS=1000` 生效，防止大数据集

---

### P1-T2: agenticEngine 增加 SQL 执行步骤（1d）

**目标**：agentic 引擎在 SQL 生成后，调用 `sqlExecutor.executeQuery()` 执行查询并返回真实数据

**修改文件**：
- `backend/src/core/agenticEngine.js`

**详细设计**：

#### 3.2.1 processQuery 增加执行步骤

在 `agenticEngine.js` 的 `processQuery` 方法中，SQL 生成+验证通过后，增加执行步骤：

```javascript
// 当前流程（约 line 140-169）：
// 1. 规划 → 2. Schema发现 → 3. 意图拆解 → 4. 澄清 → 5. 生成 → 6. 验证 → 返回

// 新增步骤：
// 5. 生成 → 6. 验证 → 7. [新增] SQL执行 → 8. [新增] 结果格式化 → 返回
```

具体改动：

```javascript
// 在 verification 之后、返回 finalResult 之前，新增：

// 步骤7: 执行SQL（仅在验证通过时）
let queryResult = null;
if (sqlResult.success && sqlResult.sql) {
  sendProgress(onProgress, 'executing', '执行查询...');
  try {
    queryResult = await sqlExecutor.executeQuery(sqlResult.sql);
    traceLog.push({ phase: 'execution', result: { success: queryResult.success, rowCount: queryResult.data?.rowCount } });
  } catch (execErr) {
    logger.warn('[AgenticEngine] SQL执行失败:', execErr.message);
    queryResult = { success: false, error: execErr.message, errorCode: 'AGENTIC_EXEC_ERROR' };
    traceLog.push({ phase: 'execution', result: { success: false, error: execErr.message } });
  }
}

// 步骤8: 结果格式化
let formattedMessage = '';
if (queryResult && queryResult.success) {
  formattedMessage = await resultFormatter.formatResult(queryResult, userQuery);
}
```

#### 3.2.2 修改 finalResult 结构

```javascript
// 之前：
const finalResult = {
  success: sqlResult.success,
  type: 'sql_result',
  sql: sqlResult.sql,
  explanation: sqlResult.explanation,
  selectedTables: sqlResult.selectedTables,
  decomposition,
  verification,
  traceLog,
  duration: Date.now() - startTime
};

// 之后：
const finalResult = {
  success: sqlResult.success && (!queryResult || queryResult.success),
  type: 'result',                                    // ← 统一为 'result'
  message: formattedMessage || sqlResult.explanation, // ← 自然语言总结
  sql: sqlResult.sql,
  explanation: sqlResult.explanation,
  data: queryResult?.data || null,                    // ← 真实数据
  executionTime: queryResult?.executionTime || 0,
  selectedTables: sqlResult.selectedTables,
  decomposition,
  verification,
  verificationWarning: sqlResult.verificationWarning,
  traceLog,
  duration: Date.now() - startTime
};
```

#### 3.2.3 resumeFromClarification 同步修改

同样的逻辑应用到 `resumeFromClarification` 方法（约 line 880-917），增加执行步骤和统一返回结构。

#### 3.2.4 新增依赖导入

```javascript
// agenticEngine.js 顶部新增导入
const sqlExecutor = require('./sqlExecutor');
const resultFormatter = require('./resultFormatter');
```

**验证步骤**：
1. 设置 `FF_AGENTIC_ENGINE=true`
2. 发送查询，确认 agentic 路径返回 `type:'result'` + `data.rows`
3. 检查 trace 日志确认执行步骤被记录
4. 验证 DRY_RUN=false 时 agentic 执行成功
5. 验证 DRY_RUN=true 时 agentic 降级返回空数据（不报错）

---

### P1-T3: 返回类型统一为 type:'result'（0.5d）

**目标**：所有引擎路径统一返回 `type:'result'`

**修改文件**：
- `backend/src/core/agenticEngine.js` — `type:'sql_result'` → `type:'result'`（P1-T2 已包含）
- `backend/src/core/sseHandler.js` — 持久化分支兼容

**详细设计**：

#### 3.3.1 sseHandler.js persistAgenticMessages 修改

```javascript
// 之前（line 461）：
} else if (tagged.type === 'sql_result') {

// 之后：
} else if (tagged.type === 'sql_result' || tagged.type === 'result') {
```

同时在 `result` 类型分支中持久化 `data` 和 `executionTime`：

```javascript
} else if (tagged.type === 'sql_result' || tagged.type === 'result') {
  await database.addMessage(
    sessionId,
    'assistant',
    tagged.message || tagged.explanation || '查询完成',
    'result',
    {
      sql: tagged.sql,
      selectedTables: tagged.selectedTables,
      data: tagged.data,                     // ← 持久化数据
      executionTime: tagged.executionTime    // ← 持久化耗时
    }
  );
}
```

#### 3.3.2 前端 session.js 兼容处理

前端 `handleSSEMessage` 已有对 `data.data` 的处理，但需确认兼容：

```javascript
// session.js line 278 — 已有：
metadata: {
  sql: data.data.sql,
  data: data.data.data,  // ← 已能接收 data
  verificationWarning: data.data.verificationWarning
}
```

需额外增加 `executionTime` 的透传：

```javascript
metadata: {
  sql: data.data.sql,
  data: data.data.data,
  executionTime: data.data.executionTime,
  verificationWarning: data.data.verificationWarning
}
```

**验证步骤**：
1. 发送查询，确认前端 SSE 接收 `type:'result'` 正常
2. 刷新页面，确认历史消息从数据库正确加载
3. 验证旧 `sql_result` 类型消息仍可正常展示（向后兼容）

---

### P1-T4: SSE 持久化完整兼容（0.5d）

**目标**：确保 agentic 路径的查询结果完整落库，含 data/executionTime

**修改文件**：
- `backend/src/core/sseHandler.js` — P1-T3 已部分覆盖
- `backend/src/core/database.js` — 确认 metadata 字段可存储大数据

**详细设计**：

#### 3.4.1 database.js metadata 存储检查

当前 `addMessage` 的 `metadata` 字段使用 `JSON.stringify` 存储，需确认：
- 大数据集（1000行 × 20列）的 JSON 是否超出 SQLite TEXT 限制（默认 1GB，足够）
- 读取时是否正确 `JSON.parse` 回来

#### 3.4.2 query_history 审计完善

agentic 路径的 `query_history` 审计写入（`agenticEngine.js:173-199`）当前 `rowCount: 0`，需改为真实行数：

```javascript
// 之前：
rowCount: 0,  // agentic 不执行 SQL,行数未知

// 之后：
rowCount: queryResult?.data?.rowCount || 0,
result: {
  columns: queryResult?.data?.columns,
  sampleRows: queryResult?.data?.rows?.slice(0, 20) || [],
  selectedTables: sqlResult.selectedTables || [],
  explanation: (sqlResult.explanation || '').slice(0, 500)
},
```

**验证步骤**：
1. 发送查询后检查 `query_history` 表的 `result_sample` 字段非空
2. 刷新页面确认消息从数据库正确恢复，含数据表格

---

### P1-T5: 端到端冒烟测试（0.5d）

**目标**：确认两条引擎路径（legacy + agentic）均能返回真实数据

**测试用例**：

| # | 场景 | 引擎 | 预期 |
|---|------|------|------|
| 1 | 简单聚合查询 | legacy | `data.rows` 非空，`type:'result'` |
| 2 | 简单聚合查询 | agentic | `data.rows` 非空，`type:'result'` |
| 3 | SQL 生成失败 | legacy | `success:false`，友好错误提示 |
| 4 | SQL 执行报错 | agentic | `success:false`，含错误信息 |
| 5 | DRY_RUN=true 回退 | 任意 | `data.rows=[]`，`dryRun:true` |
| 6 | 澄清→恢复→执行 | agentic | 恢复后返回真实数据 |
| 7 | 大结果集截断 | 任意 | `truncated:true`，行数 ≤ maxRows |
| 8 | 脱敏验证 | 任意 | phone/email 字段已脱敏 |

**测试脚本**：

创建 `backend/test/phase5/test-real-data-execution.js`：

```javascript
// 验证项：
// 1. DRY_RUN=false 时 sqlExecutor.executeQuery 返回真实数据
// 2. agenticEngine.processQuery 返回 type:'result' + data.rows
// 3. nl2sqlEngine.processQuery 返回 type:'result' + data.rows
// 4. sseHandler 持久化 agentic result 类型消息
// 5. 历史消息从数据库正确加载 data 字段
```

---

## 4. 文件变更清单

| 文件 | 变更类型 | 任务 |
|------|---------|------|
| `backend/.env` | 修改 DRY_RUN=false | P1-T1 |
| `backend/src/core/agenticEngine.js` | 增加执行步骤 + 统一类型 | P1-T2 |
| `backend/src/core/sseHandler.js` | 持久化兼容 result 类型 | P1-T3 |
| `frontend/src/stores/session.js` | 增加 executionTime 透传 | P1-T3 |
| `backend/src/core/database.js` | 确认 metadata 存储 | P1-T4 |
| `backend/test/phase5/test-real-data-execution.js` | 新增测试 | P1-T5 |

---

## 5. 风险与回滚

| 风险 | 缓解 |
|------|------|
| SR 数据库连接不稳定 | srDatabase 已有懒加载 + 错误返回机制 |
| SQL 执行超时 | `MAX_EXECUTION_TIME` + `queryTimeout` 双重保护 |
| 大结果集内存溢出 | `maxRows=1000` 截断 + `truncated` 标记 |
| agentic 执行步骤增加延迟 | 执行通常 <1s，影响可控 |
| DRY_RUN 切换影响范围大 | 可通过环境变量随时回退 |

**回滚方案**：将 `.env` 中 `DRY_RUN` 改回 `true`，agentic 路径增加 `if(!config.security.dryRun)` 守卫，跳过执行步骤。

---

## 6. 验收标准

1. ✅ `DRY_RUN=false` 下，legacy 引擎查询返回 `data.rows` 非空
2. ✅ agentic 引擎查询返回 `type:'result'` + `data.rows` 非空
3. ✅ 澄清恢复后返回真实数据
4. ✅ SSE 持久化正确存储 data 字段
5. ✅ 前端正确展示数据表格
6. ✅ 8 个冒烟测试用例全部通过
