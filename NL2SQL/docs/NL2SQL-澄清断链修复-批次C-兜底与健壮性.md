# 批次 C：兜底与健壮性

> 总览：[NL2SQL-澄清断链修复计划.md](./NL2SQL-澄清断链修复计划.md)
> 预估工时：0.5 天
> 覆盖根因：R3（Schema 发现入参过窄）+ R1 的兜底兼容
> 前置依赖：批次 B（依赖 `handleClarifyAnswer` 做兜底对比）

---

## 1. 目标

- **G3**：Phase 1 Schema 检索入参必须包含原始 query 的物理 token（`typeid`、`int_key*` 等编码），确保向量检索能命中对应表。
- **G1 兜底**：未升级前端仍走 `/sse/query` 回答澄清时，后端能自动识别并路由到 `handleClarifyAnswer` 路径，避免回归。
- 规划阶段 LLM 主动提取物理字段名 / 数字编码，避免丢信号。

---

## 2. 设计

### 2.1 `schemaDiscoveryPhase` 入参扩展

原实现（`agenticEngine.js:237-238`）：

```js
const entities = plan.entities || [];
const searchQuery = entities.join(' ');
```

改造：

```js
const flagOn = process.env.SCHEMA_SEARCH_INCLUDE_RAW !== 'false';
const parts = flagOn ? [
  userQuery,                                        // 原文
  ...(plan.entities || []),
  ...(plan.filters || []).map(f => `${f.field}=${f.value}`),
  ...(plan.aggregations || [])
] : (plan.entities || []);
const searchQuery = parts.filter(Boolean).join(' ');
```

> 注意：`schemaDiscoveryPhase(plan, context)` 当前签名没接收 `userQuery`。需要改为 `schemaDiscoveryPhase(userQuery, plan, context)`，对应调用点 `processQuery` 第 87 行 `await this.schemaDiscoveryPhase(plan, context)` 改为 `await this.schemaDiscoveryPhase(userQuery, plan, context)`。

### 2.2 `planningPhase` Prompt 扩展

原 `agenticEngine.js:190-207` 的 planningPrompt 追加一条：

```
5. **物理字段/编码**：列出查询中出现的物理字段名或数字编码
   (如 typeid=1743、int_key1、int_key5、game_id=30)

返回 JSON 中新增 physicalHints 数组:
{
  ...
  "physicalHints": ["typeid=1743", "int_key5=战场等级", "game_id=30"]
}
```

`plan.physicalHints` 也拼入 `searchQuery`：

```js
const parts = [
  userQuery,
  ...(plan.entities || []),
  ...(plan.filters || []).map(f => `${f.field}=${f.value}`),
  ...(plan.aggregations || []),
  ...(plan.physicalHints || [])   // 新增
];
```

### 2.3 `handleQuery` 澄清自动路由兜底（老前端兼容）

```js
async function handleQuery(sessionId, query, context = {}) {
  // ...既有校验...

  // 兜底:若老前端直接把澄清回答发到 /sse/query
  // 条件:当前 query 较短,且会话最新 assistant 消息是未回答的 clarification
  if (query.length < 30) {
    const latest = await database.getLatestAssistantMessage(sessionId);
    if (latest && latest.message_type === 'clarification') {
      const meta = typeof latest.metadata === 'string'
        ? JSON.parse(latest.metadata) : latest.metadata;
      if (meta?.decomposition && meta?.originalQuery) {
        logger.info('[handleQuery] 检测到短 query + 未回答的澄清,自动路由 handleClarifyAnswer', { sessionId });
        return handleClarifyAnswer(sessionId, latest.id, query, context);
      }
    }
  }

  // 既有逻辑...
}
```

数据库需新增 `getLatestAssistantMessage(sessionId)`。

---

## 3. 代码清单

| # | 文件 | 改动类型 | 改动说明 | 工作量 |
|---|------|---------|----------|--------|
| C-1 | `backend/src/core/agenticEngine.js` | 修改 | `schemaDiscoveryPhase(userQuery, plan, context)` 签名调整，调用点同步；入参合入 `userQuery / filters / aggregations / physicalHints` | 1h |
| C-2 | `backend/src/core/agenticEngine.js` | 修改 | `planningPhase` prompt 追加 `physicalHints` 要求；返回结果验证与兜底 | 45min |
| C-3 | `backend/src/core/sseHandler.js` | 修改 | `handleQuery` 开头追加澄清自动路由兜底 | 1h |
| C-4 | `backend/src/core/database.js` | 新增 | `getLatestAssistantMessage(sessionId)` | 30min |
| C-5 | `backend/.env.example` | 修改 | 追加 `SCHEMA_SEARCH_INCLUDE_RAW=true` 及注释 | 15min |
| C-6 | `backend/test/phase3/schema-discovery-searchquery.test.js` | 新增 | 见 §4.1 | 1.5h |
| C-7 | `backend/test/phase3/handleQuery-clarify-fallback.test.js` | 新增 | 见 §4.2 | 1h |

---

## 4. 测试用例

### 4.1 `schema-discovery-searchquery.test.js`

```js
it('searchQuery 必须包含 userQuery 原文 + physicalHints', async () => {
  const spy = jest.spyOn(require('../../src/core/toolLoop'), 'executeToolLoop')
    .mockResolvedValue({ tables: [] });

  await engine.schemaDiscoveryPhase(
    '取 typeid=1743 的 int_key5 数据',
    { entities:['玩家'], physicalHints:['typeid=1743','int_key5'],
      filters:[{field:'game_id',value:30}] },
    {}
  );

  const searchQuery = spy.mock.calls[0][0];
  expect(searchQuery).toContain('typeid=1743');
  expect(searchQuery).toContain('int_key5');
  expect(searchQuery).toContain('game_id=30');
  spy.mockRestore();
});

it('SCHEMA_SEARCH_INCLUDE_RAW=false 时回退旧行为', async () => {
  process.env.SCHEMA_SEARCH_INCLUDE_RAW = 'false';
  const spy = jest.spyOn(require('../../src/core/toolLoop'), 'executeToolLoop')
    .mockResolvedValue({ tables: [] });

  await engine.schemaDiscoveryPhase('typeid=1743', { entities:['玩家'] }, {});
  expect(spy.mock.calls[0][0]).not.toContain('typeid');
  expect(spy.mock.calls[0][0]).toContain('玩家');

  delete process.env.SCHEMA_SEARCH_INCLUDE_RAW;
  spy.mockRestore();
});
```

### 4.2 `handleQuery-clarify-fallback.test.js`

```js
it('老前端发短回答时 handleQuery 自动路由到 handleClarifyAnswer', async () => {
  const sessionId = 'sess-test';
  // 预置:最新 assistant 消息为 clarification
  await database.addMessage(sessionId, 'assistant', '你要用哪个字段?', 'clarification', {
    clarification: { clarificationType:'general' },
    originalQuery: '取 typeid=1743 的战场等级',
    decomposition: { originalQuery:'取 typeid=1743 的战场等级',
      dataUnits:[{id:'u1',filters:[{field:'typeid',operator:'=',value:1743}]}] }
  });
  const spy = jest.spyOn(sseHandler, 'handleClarifyAnswer').mockResolvedValue({ sql:'SELECT 1' });

  await sseHandler.handleQuery(sessionId, 'int_key5', {});

  expect(spy).toHaveBeenCalled();
  expect(spy.mock.calls[0][2]).toBe('int_key5');
  spy.mockRestore();
});

it('长 query 不走澄清兜底', async () => {
  const spy = jest.spyOn(sseHandler, 'handleClarifyAnswer');
  await sseHandler.handleQuery('sess-x', 
    '这是一个超过 30 字符的新查询,不应该被识别为澄清回答,要走正常流程', {});
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});
```

---

## 5. 验收标准

1. 新增测试全绿；Phase 3 全量 + 批次 A/B 新增单测全绿。
2. 手工用**未升级前端**（仍走 `/sse/query` 发选项）复跑本案例：
   - 第一轮完整需求 → 命中澄清
   - 第二轮短文本回答 → 后端自动路由到 `handleClarifyAnswer`
   - SQL 仍包含 `typeid = 1743` + `int_key5`。
3. Phase 1 日志观察 `searchQuery` 含原始 query 和 physicalHints。

---

## 6. 回滚

| 改动 | 回滚方式 |
|------|----------|
| Schema 发现扩展 | `SCHEMA_SEARCH_INCLUDE_RAW=false` |
| planningPhase prompt 扩展 | `physicalHints` 是 optional 字段，旧 prompt 行为由解析兜底保证 |
| handleQuery 兜底 | 用 `FF_HANDLE_QUERY_CLARIFY_FALLBACK=false` 环境变量关闭（代码中加 if 判断） |

---

## 7. 风险

- **短 query 误判**：兜底只在"query<30 字符 + 最新 assistant 消息是 clarification + 有 decomposition metadata"三条件同时成立时触发，误判概率低。
- **`physicalHints` 解析失败**：LLM 有时不返回该字段，代码里 `plan.physicalHints || []` 兜底，不 throw。
- **会话隔离**：`getLatestAssistantMessage` 必须按 `session_id` 过滤，避免跨会话污染。
