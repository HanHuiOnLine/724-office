# 批次 B：澄清断链修复（主战场）

> 总览：[NL2SQL-澄清断链修复计划.md](./NL2SQL-澄清断链修复计划.md)
> 预估工时：1-1.5 天
> 覆盖根因：R1（澄清断链）、R5（applyClarificationResult 分支贫弱）
> 前置依赖：批次 A（Prompt 注入），若未做 A 也可独立上线，只是无法自动补 2026 年份

---

## 1. 目标

- **G1**：澄清后第二轮 query 必须带全第一轮 `originalQuery + decomposition`。
- **G4**：`applyClarificationResult` 覆盖 `uncovered_data_unit` 场景，能把用户回答回写到 `dataUnits.filters` 或 `dataUnits.description`。
- 案例复跑：澄清后 SQL 必须包含 `typeid = 1743` + `int_key5`。

---

## 2. 端到端链路设计

```
第一轮
  前端 POST /sse/query (query=完整需求)
  └─ handleQuery → agenticEngine.processQuery
     └─ 命中 clarification
        ├─ persistAgenticMessages: assistant 消息 metadata 增写
        │    { clarification, decomposition, originalQuery, tableCandidates:slice(0,8) }
        │    addMessage 返回 insertedId
        └─ SSE: type=clarification（附 message_id 供前端记住）

第二轮(用户点选项)
  前端 ChatView.answerClarification(message, option)
  └─ POST /sse/clarify-answer   ← 新端点
       body: { session_id, parent_message_id, option }
  └─ sseHandler.handleClarifyAnswer
     ├─ database.getMessage(parent_message_id) → 取回 metadata.decomposition/...
     ├─ agenticEngine.resumeFromClarification({
     │     originalQuery, decomposition, clarification, userAnswer:option, context
     │   })
     │   ├─ clarificationEngine.applyClarificationResult(...) ← 含新增 uncovered_data_unit 分支
     │   ├─ queryDecomposer.retrieveTablesByDataUnits(updatedDecomposition)
     │   └─ generationPhase → verificationPhase → recoveryPhase
     └─ persistAgenticMessages(写入最终 sql_result)
```

---

## 3. 详细设计

### 3.1 `agenticEngine.resumeFromClarification`（新增）

```js
async resumeFromClarification({ originalQuery, decomposition, clarification, userAnswer, context }) {
  // 1. 应用澄清回答
  const updatedDecomposition = clarificationEngine.applyClarificationResult(
    decomposition, clarification, userAnswer
  );
  updatedDecomposition.originalQuery = originalQuery; // 锁回原文
  updatedDecomposition.clarificationHistory = updatedDecomposition.clarificationHistory || [];

  // 2. 基于更新后的 decomposition 重新检索表
  const tableResult = await queryDecomposer.retrieveTablesByDataUnits(updatedDecomposition);

  // 3. Schema 详情
  const selectedTables = tableResult.recommendedTables || [];
  // 沿用 generationPhase 已有兜底
  let sqlResult = await this.generationPhase(
    updatedDecomposition, tableResult,
    { level1Index: schemaTools.getLevel1Index(), toolExploration: null },
    context
  );

  // 4. 验证 + 恢复
  const verification = await this.verificationPhase(sqlResult);
  if (!verification.success) {
    sqlResult = await this.recoveryPhase(verification.error, updatedDecomposition, null, context);
  }

  return {
    success: sqlResult.success,
    type: 'sql_result',
    sql: sqlResult.sql,
    explanation: sqlResult.explanation,
    selectedTables: sqlResult.selectedTables,
    decomposition: updatedDecomposition,
    verification
  };
}
```

### 3.2 `sseHandler.persistAgenticMessages` 改造

```js
// 澄清分支
if (tagged.type === 'clarification' && tagged.clarification) {
  const insertedId = await database.addMessage(
    sessionId, 'assistant',
    tagged.clarification.question || '需要更多信息才能继续',
    'clarification',
    {
      clarification: tagged.clarification,
      originalQuery: query,
      decomposition: tagged.decomposition,
      tableCandidates: (tagged.tableCandidates || []).slice(0, 8).map(c => ({
        name: c.table?.name || c.tableName,
        score: c.score
      }))
    }
  );
  tagged.message_id = insertedId;
}
```

> `addMessage` 需返回 `lastID`（SQLite `this.lastID`），见代码清单 B-4。

### 3.3 `sseHandler.handleClarifyAnswer`（新增）

```js
async function handleClarifyAnswer(sessionId, parentMessageId, userAnswer, context = {}) {
  const connList = connections.get(sessionId);
  if (!connList || connList.length === 0) {
    logger.warn('handleClarifyAnswer: SSE 未连接', { sessionId });
    return null;
  }
  if (!userAnswer || !userAnswer.trim()) {
    pushError(sessionId, '澄清回答不能为空');
    return null;
  }

  // 取父消息
  const parent = await database.getMessage(parentMessageId);
  if (!parent || parent.message_type !== 'clarification') {
    logger.warn('父消息不是澄清消息,降级走 handleQuery', { parentMessageId });
    return handleQuery(sessionId, userAnswer, context);
  }

  const meta = typeof parent.metadata === 'string'
    ? JSON.parse(parent.metadata) : (parent.metadata || {});

  if (!meta.decomposition || !meta.originalQuery) {
    logger.warn('父消息 metadata 不完整,降级走 handleQuery', { parentMessageId });
    return handleQuery(sessionId, userAnswer, context);
  }

  connList.forEach(c => c.isProcessing = true);
  try {
    broadcastToSession(sessionId, { type: 'processing', data: { message: '应用澄清回答...' } });

    const result = await agenticEngine.resumeFromClarification({
      originalQuery: meta.originalQuery,
      decomposition: meta.decomposition,
      clarification: meta.clarification,
      userAnswer,
      context: { sessionId, ...context }
    });

    const tagged = { ...(result || {}), engineUsed: 'agentic-resume', fallbackUsed: false };
    await database.addMessage(sessionId, 'user', userAnswer, 'text');
    await persistAgenticMessages(sessionId, userAnswer, tagged);
    broadcastToSession(sessionId, { type: 'result', data: tagged });
    return tagged;
  } catch (err) {
    logger.error('handleClarifyAnswer 失败:', err);
    pushError(sessionId, 'SQL 生成失败: ' + err.message);
    throw err;
  } finally {
    connList.forEach(c => c.isProcessing = false);
  }
}
```

### 3.4 `POST /api/sse/clarify-answer`

```js
router.post('/sse/clarify-answer', async (req, res) => {
  const { session_id, parent_message_id, option } = req.body;
  if (!session_id || !parent_message_id || !option) {
    return res.status(400).json({ error: '缺少必填参数' });
  }
  if (!sseHandler.hasActiveConnection(session_id)) {
    return res.status(409).json({ error: 'SSE 未建立' });
  }
  const context = requestContext.extractContext(req);
  sseHandler.handleClarifyAnswer(session_id, parent_message_id, option, context)
    .catch(err => {
      logger.error('[SSE-Clarify] 后台异常:', err);
      sseHandler.pushError(session_id, err.message || '处理澄清回答失败');
    });
  res.json({ success: true });
});
```

### 3.5 `clarificationEngine.applyClarificationResult` 增强

```js
switch (clarification?.clarificationType) {
  case 'table_selection': applyTableSelection(...); break;
  case 'metric_source':   applyMetricSource(...);   break;
  case 'time_granularity':applyTimeGranularity(...); break;
  case 'general':
  default:
    applyUncoveredDataUnit(updatedDecomposition, clarification, userAnswer);
    updatedDecomposition.clarificationNote = userAnswer;
}
```

```js
function applyUncoveredDataUnit(decomposition, clarification, userAnswer) {
  const uncovered = clarification?.details?.uncoveredUnits || [];
  // 抽 field=value 形式的物理 filter
  const filterMatches = [...userAnswer.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*[=＝]\s*([0-9]+)/g)];
  const extractedFilters = filterMatches.map(m => ({
    field: m[1], operator: '=', value: Number(m[2])
  }));

  // 抽字段名(如 int_key5, int_key1)
  const fieldMatches = [...userAnswer.matchAll(/\b(int_key\d+|str_key\d+|typeid|game_id|channel_id)\b/g)];
  const mentionedFields = [...new Set(fieldMatches.map(m => m[1]))];

  for (const unit of decomposition.dataUnits || []) {
    const isTarget = uncovered.length === 0 || uncovered.some(u => u.id === unit.id);
    if (!isTarget) continue;

    if (extractedFilters.length) {
      unit.filters = unit.filters || [];
      for (const f of extractedFilters) {
        if (!unit.filters.find(x => x.field === f.field)) unit.filters.push(f);
      }
    }
    if (mentionedFields.length) {
      unit.outputFields = [...new Set([...(unit.outputFields || []), ...mentionedFields])];
      unit.description = `${unit.description || ''}; 用户澄清: ${userAnswer}`.trim();
    }
    unit.keywords = [...new Set([...(unit.keywords || []), ...mentionedFields,
      ...extractedFilters.map(f => `${f.field}=${f.value}`)])];
  }
}
```

### 3.6 前端改造

`frontend/src/views/ChatView.vue`：

```js
function answerClarification(message, option) {
  if (!option || isProcessing.value) return;
  answeredClarifications.value.add(message.id);
  sessionStore.sendClarifyAnswer(message.id, option);
  scrollToBottom();
}
```

`frontend/src/stores/session.js`：

```js
async function sendClarifyAnswer(parentMessageId, option) {
  addMessage({ role: 'user', content: option, type: 'text' });
  isProcessing.value = true;
  try {
    await api.sendClarifyAnswer(currentSessionId.value, parentMessageId, option);
  } catch (e) {
    isProcessing.value = false;
    addMessage({ role: 'assistant', content: '发送澄清回答失败', type: 'error' });
  }
}

// handleSSEMessage 的 clarification 分支
if (data.data?.type === 'clarification' && data.data?.clarification) {
  addMessage({
    id: data.data.message_id,   // 新增:记住 message_id 供 answerClarification 使用
    role: 'assistant',
    content: data.data.clarification.question || '需要更多信息才能继续',
    type: 'clarification',
    metadata: {
      clarification: data.data.clarification,
      explanation: data.data.clarification.explanation
    }
  });
}
```

`frontend/src/utils/api.js`：

```js
export async function sendClarifyAnswer(sessionId, parentMessageId, option) {
  return fetch('/api/sse/clarify-answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, parent_message_id: parentMessageId, option })
  }).then(r => r.json());
}
```

---

## 4. 代码清单

| # | 文件 | 改动类型 | 改动说明 | 工作量 |
|---|------|---------|----------|--------|
| B-1 | `backend/src/core/agenticEngine.js` | 新增 | `resumeFromClarification` 方法，复用 `generationPhase/verificationPhase/recoveryPhase` | 2h |
| B-2 | `backend/src/core/sseHandler.js` | 修改 | `persistAgenticMessages` 澄清分支落 `decomposition/originalQuery/tableCandidates`；返回 `message_id` 回写 `tagged` | 1h |
| B-3 | `backend/src/core/sseHandler.js` | 新增 | `handleClarifyAnswer(sessionId, parentMessageId, userAnswer, context)` | 2h |
| B-4 | `backend/src/core/database.js` | 修改 | `addMessage` 返回 `lastID`；新增 `getMessage(id)` | 1h |
| B-5 | `backend/src/core/routes.js` | 新增 | `POST /api/sse/clarify-answer` 路由 | 30min |
| B-6 | `backend/src/core/clarificationEngine.js` | 修改 | 新增 `applyUncoveredDataUnit`；switch default 分支调用 | 1.5h |
| B-7 | `frontend/src/views/ChatView.vue` | 修改 | `answerClarification` 改调 `sendClarifyAnswer(message.id, option)` | 15min |
| B-8 | `frontend/src/stores/session.js` | 修改/新增 | `sendClarifyAnswer`；`handleSSEMessage.clarification` 分支写 `message_id` | 1h |
| B-9 | `frontend/src/utils/api.js` | 新增 | `sendClarifyAnswer` 包装 | 15min |
| B-10 | `backend/test/phase3/clarification-resume.test.js` | 新增 | 见 §5.1 | 2h |
| B-11 | `backend/test/phase3/clarification-apply.test.js` | 新增 | 见 §5.2 | 1h |
| B-12 | `backend/test/phase3/sse-clarify-answer-route.test.js` | 新增 | 集成测试，mock LLM 响应 | 2h |
| B-13 | `docs/NL2SQL-Phase3-交接摘要.md` | 修改 | 末尾追加"澄清断链修复"子章节 | 20min |
| B-14 | `CLAUDE.md` | 修改 | "关键数据流"章节补澄清分支流程 | 20min |

---

## 5. 测试用例要点

### 5.1 `clarification-resume.test.js`

```js
it('resumeFromClarification 最终 SQL 必含原 decomposition 中的 typeid / int_key5', async () => {
  const decomposition = {
    originalQuery: '取 typeid=1743 的数据, int_key5 为战场等级, 时间 2026-3-28~4-12',
    primaryEntity: '玩家',
    dataUnits: [
      { id:'u1', type:'基础属性筛选', description:'类型筛选',
        filters:[{field:'typeid',operator:'=',value:1743}] },
      { id:'u2', type:'输出字段需求', description:'战场等级',
        outputFields:['int_key5'] }
    ]
  };
  const clarification = { clarificationType:'general',
    details:{ uncoveredUnits:[{id:'u1'}] }, question:'x' };
  const result = await engine.resumeFromClarification({
    originalQuery: decomposition.originalQuery,
    decomposition, clarification, userAnswer:'通过 int_key5 字段, typeid=1743', context:{}
  });
  expect(result.sql).toMatch(/typeid\s*=\s*1743/i);
  expect(result.sql).toMatch(/int_key5/i);
});
```

### 5.2 `clarification-apply.test.js`

```js
it('applyUncoveredDataUnit 能从回答抽出 typeid=1743 并写入 filters', () => {
  const d = { dataUnits:[{ id:'u1', filters:[], keywords:[] }] };
  const c = { clarificationType:'general', details:{ uncoveredUnits:[{id:'u1'}] } };
  const r = clarificationEngine.applyClarificationResult(d, c, 'typeid=1743 int_key5');
  const f = r.dataUnits[0].filters;
  expect(f.find(x => x.field === 'typeid' && x.value === 1743)).toBeTruthy();
  expect(r.dataUnits[0].outputFields).toContain('int_key5');
});
```

### 5.3 `sse-clarify-answer-route.test.js`

- mock LLM 首轮返回触发 `uncovered_data_unit`
- mock `database.addMessage` 返回递增 id
- mock LLM 第二轮返回合规 SQL
- POST `/api/sse/clarify-answer` 后，SSE 广播的 `result` 中 sql 非空且包含澄清补充的字段

---

## 6. 验收标准

1. 所有新增 + 原有 177 条测试全绿。
2. 手工复跑本文案例：
   - 第一轮完整需求 → 命中澄清
   - 点选项或输入"通过 int_key5"
   - 最终 SQL 同时包含 `typeid = 1743`、`int_key5`、时间区间年份正确（需配合批次 A）。
3. 老前端（未升级）在本批次下仍正常工作（依赖批次 C 的 `handleQuery` 兜底才保证，本批次可选择性校验）。

---

## 7. 回滚

- 直接移除 `POST /api/sse/clarify-answer` 路由注册。
- 前端保留旧 `sendQuery` 逻辑做降级（批次 C 兜底生效时不影响）。
- `persistAgenticMessages` 的 metadata 扩展为纯字段叠加，旧客户端自动忽略。

---

## 8. 风险

- **metadata JSON 大小**：已限制 `tableCandidates.slice(0,8)` 且仅存 `{name, score}`。实测 <2KB。
- **老会话兼容**：`handleClarifyAnswer` 取不到父消息 metadata 时降级到 `handleQuery`，不 throw。
- **`addMessage` 返回 id 兼容**：若旧代码有 `await database.addMessage(...)` 忽略返回值，改动向后兼容。
