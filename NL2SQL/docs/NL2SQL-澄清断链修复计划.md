# NL2SQL 澄清断链 & SQL 跑偏修复计划

## 文档信息

- 版本：v1.0
- 日期：2026-04-23
- 背景案例：用户提"问鼎天下-战场等级数据"复杂需求（typeid=1743、int_key1、int_key5、2026-03-28~04-12、游戏ID=30），经两轮澄清后最终 SQL 完全跑偏：
  ```sql
  SELECT create_time, tz_account_id, channel_id, game_id
  FROM tzpingtai_tz_sdk_log_pf_action
  WHERE create_time >= '2024-01-01 00:00:00'
    AND create_time <= '2024-12-31 23:59:59'
  ORDER BY create_time DESC LIMIT 1000;
  ```
  —— typeid / int_key1 / int_key5 / 游戏ID 全丢失，时间区间还错成 2024。
- 相关模块：`agenticEngine`、`sseHandler`、`clarificationEngine`、`queryDecomposer`、`ChatView`、`session store`
- 开关基线：`FF_AGENTIC_ENGINE=true`、`FF_CLARIFICATION_ENGINE=true`（当前 `.env` 默认）

---

## 1. 根因（定位证据）

### R1 【致命】澄清流程无"断点续跑"，第二轮 query 完全脱离原需求

- `agenticEngine.js:111-121` 命中澄清后 `return { type:'clarification', decomposition, tableCandidates, ... }`，`decomposition` 只走一次 HTTP 响应，未落库。
- `sseHandler.js:382-417` 的 `persistAgenticMessages` 澄清分支仅写入 `clarification.question` 文本，`originalQuery / decomposition / tableCandidates` 全丢。
- 前端 `ChatView.vue:318-323` `answerClarification` 把选项文本作为**新 query** 调 `sessionStore.sendQuery(option)`；`session.js:302` 的 `sendQuery` 直接走 `POST /api/sse/query`。
- 后端 `sseHandler.handleQuery(sessionId, option)` → `agenticEngine.processQuery(option, ...)`，Phase 1 LLM 只看到选项那一句（如"通过 int_key5 字段"），原需求 typeid=1743 / int_key1 / int_key5 / 游戏ID=30 / 时间区间**全部丢失**。
- `agenticEngine.js:629` 定义了 `applyClarification`，但**全代码库无任何调用者**（grep 仅命中定义与 export）。

### R2 SQL 生成 Prompt 未注入当前日期 → LLM 默认 2024

- `agenticEngine.js:390-413` `buildSQLPrompt` 只拼 `originalQuery + dataUnits + schemaDetail`，无 `当前日期`、无 `对话历史`。
- LLM 训练数据偏 2024，用户写"3月28日-4月12日"无年份时被回填成 `2024-01-01 ~ 2024-12-31`。

### R3 Phase 1 Schema 发现入参过窄，丢高信号 token

- `agenticEngine.js:237-238` `schemaDiscoveryPhase` 中 `searchQuery = entities.join(' ')`，只用 LLM 规划阶段抽出的实体（如"玩家 战场等级"）。
- `typeid=1743`、`int_key1`、`int_key5` 这种物理字段 / 编码在向量检索阶段就没有参与，后续拿不回来。

### R4 `buildSQLPrompt` 未传 `context.history`

- `context.history` 在 `toolLoop`、`nl2sqlEngine` 用过，但 Phase 4 生成 SQL 时被完全忽略（`agenticEngine.js:345-385`）。
- 多轮对话中用户在前一条已经交代过的字段/筛选，到生成环节看不见。

### R5 `applyClarificationResult` 分支贫弱

- `clarificationEngine.js:398-414` 只处理 `table_selection / metric_source / time_granularity`，其它类型仅写入 `clarificationNote`。
- 对于 `uncovered_data_unit`、`low_confidence` 这种最常见触发，即使路径接通也没有真正回写 `dataUnits.filters / outputFields`。

---

## 2. 修复目标与范围

| 目标 | 衡量指标 |
|------|----------|
| **G1**：澄清后第二轮 query 必须带全第一轮 `originalQuery + decomposition` 上下文 | 本文案例复跑：SQL 含 `typeid = 1743` 和 `int_key5` |
| **G2**：SQL Prompt 默认注入"当前日期 + 对话历史最近 N 轮" | 案例时间区间复跑：`2026-03-28 00:00:00 ~ 2026-04-12 23:59:59` |
| **G3**：Phase 1 Schema 检索入参包含原始 query 物理 token | `typeid / int_key1` 出现在向量检索 query |
| **G4**：`applyClarificationResult` 覆盖 `uncovered_data_unit` 场景，把选项回写 `dataUnits` | 单测覆盖 |

非目标（本轮不做）：

- 多轮澄清的状态机（≥2 次澄清）—— 先让 1 次澄清链路打通，后续增量扩展。
- SQL 生成模型换型 —— 沿用现有 LLM。
- 前端 UI 大改 —— 仅在消息元数据中埋 `parent_message_id`，视图层改动最小。

---

## 3. 方案设计

### 3.1 澄清上下文复原链路（G1，优先级 P0）

```
第一轮
  前端 POST /sse/query (query=完整需求)
  └─ handleQuery → agenticEngine.processQuery
     └─ 命中 clarification
        ├─ persistAgenticMessages: assistant 消息 metadata 增写
        │    { clarification, decomposition, originalQuery, tableCandidates }
        └─ SSE: type=clarification（附 message_id 供前端记住）

第二轮（用户点选项）
  前端 ChatView.answerClarification(message, option)
  └─ POST /sse/clarify-answer  ← 新端点
       body: { session_id, parent_message_id, option }
  └─ sseHandler.handleClarifyAnswer
     ├─ database.getMessage(parent_message_id) → 取回 decomposition/originalQuery
     ├─ agenticEngine.resumeFromClarification({
     │     originalQuery, decomposition, clarification, userAnswer, context
     │   })
     │   ├─ clarificationEngine.applyClarificationResult(...)
     │   ├─ queryDecomposer.retrieveTablesByDataUnits(updatedDecomposition)
     │   └─ generationPhase → verificationPhase → recoveryPhase
     └─ persistAgenticMessages（写入最终 sql_result）
```

**兼容策略**：老前端仍用 `/sse/query` 发澄清回答时，后端通过 session 最新一条 `type=clarification` 消息兜底取回 `decomposition`，不强制要求前端立即升级。

### 3.2 SQL Prompt 增强（G2/G4，优先级 P0）

`agenticEngine.buildSQLPrompt` 改造：

```
## 当前时间
${new Date().toISOString().slice(0,19).replace('T',' ')} （所有相对时间以此为锚点）

## 查询需求（原文）
${decomposition.originalQuery}

## 对话上下文（最近 N=3 轮，仅保留 user 消息）
${trimHistory(context.history).map(m => `- ${m.role}: ${m.content}`).join('\n')}

## 澄清记录（若有）
${(decomposition.clarificationHistory || []).map(h => `Q: ${h.question}\nA: ${h.answer}`).join('\n\n')}

## 数据需求单元
${decomposition.dataUnits?.map(u => formatUnitVerbose(u)).join('\n')}

## 可用表结构
${schemaDetail}

## 生成要求
- 时间字段格式：YYYY-MM-DD HH:mm:ss
- 若用户给出 typeid / int_key* 等物理约束，必须落到 WHERE
- 若用户需求缺省年份，使用"当前时间"年份
```

`formatUnitVerbose` 要把 `filters`、`timeRange`、`metric`、`outputFields` 全打出，不能只出 `type: description`。

### 3.3 Phase 1 Schema 发现入参扩展（G3，优先级 P1）

`agenticEngine.schemaDiscoveryPhase`：

```js
const searchQuery = [
  userQuery,                               // 新增：原文
  ...(plan.entities || []),
  ...(plan.filters || []).map(f => `${f.field}=${f.value}`),
  ...(plan.aggregations || [])
].filter(Boolean).join(' ');
```

额外：`plan.entities` 解析的 prompt（`agenticEngine.js:190-207`）里加一条"请同时提取出现的物理字段名 / 数字编码（如 typeid=xxx、int_keyN）"。

### 3.4 `applyClarificationResult` 增强（G4，优先级 P1）

针对 `uncovered_data_unit`（案例触发的类型）补一个分支：

```js
case 'uncovered_data_unit':
  applyUncoveredDataUnit(updatedDecomposition, clarification, userAnswer);
  break;
```

`applyUncoveredDataUnit` 的行为：把 `userAnswer` 作为补充约束追加到对应 `dataUnit.description`，并尝试从中抽出 `field = value` 形式的 filter 合入 `dataUnit.filters`。

---

## 4. 代码清单

### 4.1 后端改动

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 1 | `backend/src/core/agenticEngine.js` | 修改 | `buildSQLPrompt` 注入当前日期、`context.history`、`clarificationHistory`；`formatUnitVerbose` 打印完整单元；`schemaDiscoveryPhase` `searchQuery` 合入 `userQuery` + `filters` + `aggregations`；`planningPhase` prompt 追加"提取物理字段名 / 编码"说明 |
| 2 | `backend/src/core/agenticEngine.js` | 新增 | `resumeFromClarification({ originalQuery, decomposition, clarification, userAnswer, context })`：调用 `applyClarification` → 重跑 `retrieveTablesByDataUnits` → `generationPhase` → `verificationPhase`；复用现有 `recoveryPhase` |
| 3 | `backend/src/core/sseHandler.js` | 修改 | `persistAgenticMessages` 澄清分支 `metadata` 增写 `decomposition`、`originalQuery`、`tableCandidates.slice(0,8)`；返回消息 id 供 SSE 推送（新增字段 `message_id`） |
| 4 | `backend/src/core/sseHandler.js` | 新增 | `handleClarifyAnswer(sessionId, parentMessageId, userAnswer, context)`：从 DB 取父消息 metadata → 调 `agenticEngine.resumeFromClarification` → 走与 `handleQuery` 相同的 SSE 推送 / 落库路径 |
| 5 | `backend/src/core/sseHandler.js` | 新增 | `handleQuery` 兜底：若当前 query 很短（< 30 字符）且会话最近一条 assistant 消息 `type=clarification`，自动走 `handleClarifyAnswer` 路径，防止老前端绕过新端点 |
| 6 | `backend/src/core/routes.js` | 新增 | `POST /api/sse/clarify-answer`：body `{ session_id, parent_message_id, option }`，路由到 `sseHandler.handleClarifyAnswer` |
| 7 | `backend/src/core/clarificationEngine.js` | 修改 | `applyClarificationResult` switch 新增 `case 'uncovered_data_unit'`；新增 `applyUncoveredDataUnit(decomposition, clarification, userAnswer)`；简易 `extractFilterFromAnswer(text)`（正则：`([a-zA-Z_]+)\s*[=＝]\s*([0-9]+)`） |
| 8 | `backend/src/core/database.js` | 修改 | 提供 `getMessage(messageId)`（若无），`addMessage` 返回新行 id；确认 `messages.metadata` 列为 TEXT/JSON（长文能存） |
| 9 | `backend/src/utils/tokenBudget.js` | 复用 | 在 `buildSQLPrompt` 调用 `trimHistory(context.history, 3)` 做长度兜底（防止 Prompt 超长） |

### 4.2 前端改动

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 10 | `frontend/src/views/ChatView.vue` | 修改 | `answerClarification(message, option)` 改为调用 `sessionStore.sendClarifyAnswer(message.id, option)` |
| 11 | `frontend/src/stores/session.js` | 新增 | `sendClarifyAnswer(parentMessageId, option)`：`POST /api/sse/clarify-answer`；同时本地追加 `role=user, content=option` 消息 |
| 12 | `frontend/src/stores/session.js` | 修改 | `handleSSEMessage` 的 `result + clarification` 分支：把后端返回的 `message_id` 写入 `addMessage({ id, ... })`，保证后续 `answerClarification` 有 id 可用 |
| 13 | `frontend/src/utils/api.js` | 新增 | `sendClarifyAnswer(sessionId, parentMessageId, option)` 包装 `POST /api/sse/clarify-answer` |

### 4.3 测试改动

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 14 | `backend/test/phase3/clarification-resume.test.js` | 新增 | 单测：构造 `decomposition`（含 typeid/int_key5 的 dataUnits）→ `resumeFromClarification(option='通过 int_key5 字段')` → 断言最终 SQL 含 `typeid = 1743` 和 `int_key5` |
| 15 | `backend/test/phase3/sql-prompt-date.test.js` | 新增 | 单测：`buildSQLPrompt` 输出必须包含当前年份字符串；dataUnits 含 `{timeRange:{start:'3月28日'}}` 时模拟 LLM 产物含当前年份 |
| 16 | `backend/test/phase3/clarification-apply.test.js` | 新增 | 单测：`applyClarificationResult` 对 `uncovered_data_unit` 类型，`userAnswer='int_key5'` → `dataUnits[i].description` 含 `int_key5`；`userAnswer='typeid=1743'` → `filters` 新增 `{field:'typeid',operator:'=',value:1743}` |
| 17 | `backend/test/phase3/schema-discovery-searchquery.test.js` | 新增 | 单测：`schemaDiscoveryPhase` 传入 `userQuery='取 typeid=1743 的 int_key5 数据'`、`plan.entities=['玩家']` → `toolLoop.executeToolLoop` 收到的 searchQuery 必须含 `typeid` 与 `int_key5` |
| 18 | `backend/test/phase3/sse-clarify-answer-route.test.js` | 新增 | 集成测试：模拟第一轮 query → 命中澄清 → `POST /sse/clarify-answer` → SSE 收到 `type=result` 且 SQL 非兜底 |

### 4.4 文档改动

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 19 | `docs/NL2SQL-Phase3-交接摘要.md` | 修改 | 末尾追加"澄清断链修复"子章节，链接本计划文档 |
| 20 | `CLAUDE.md` | 修改 | "关键数据流"章节补一段澄清分支流程图（含 `/sse/clarify-answer`） |

---

## 5. 实施分批

### 批次 A（P0，预计 0.5 天）：止血，让案例能跑通

- 代码清单 #1（仅 `buildSQLPrompt` 注入日期 + history 子集）
- 代码清单 #15

**验收**：即使不修澄清断链，生成的 SQL 年份不再出现 2024；用户在一轮就给全信息时 SQL 包含 typeid / int_key*。

### 批次 B（P0，预计 1-1.5 天）：澄清断链修复

- 代码清单 #2、#3、#4、#6、#7、#8（后端全链路）
- 代码清单 #10、#11、#12、#13（前端）
- 代码清单 #14、#16、#18

**验收**：复跑本文档案例，澄清后 SQL 必须包含 `typeid = 1743` + `int_key5` + 正确时间区间。

### 批次 C（P1，预计 0.5 天）：兜底与健壮性

- 代码清单 #1 的 `planningPhase` prompt 调整
- 代码清单 #5（老前端兜底）
- 代码清单 #17
- 代码清单 #19、#20

**验收**：未升级前端的客户端依然能正确完成澄清闭环。

---

## 6. 回滚策略

| 组件 | 回滚方式 |
|------|----------|
| `/sse/clarify-answer` 端点 | 新增端点，默认不影响老链路；下线只需移除路由 |
| `persistAgenticMessages` metadata 扩展 | 纯字段叠加，旧客户端忽略即可 |
| `buildSQLPrompt` 注入 | 加环境变量 `PROMPT_INJECT_NOW=true`（默认 true）做兜底总开关，线上出问题可 `PROMPT_INJECT_NOW=false` 恢复原 prompt |
| `schemaDiscoveryPhase` searchQuery 扩展 | 加环境变量 `SCHEMA_SEARCH_INCLUDE_RAW=true`（默认 true） |
| `applyClarificationResult` 新分支 | 新增 case，未命中则走原 default（`clarificationNote`），无兼容风险 |

---

## 7. 风险与注意事项

1. **Prompt 变长导致 token 超支**：`trimHistory(context.history, 3)` 只取最近 3 轮 user 消息文本；`decomposition.clarificationHistory` 限制最多 5 条；监控 `tokenBudget` 对超长 prompt 的告警日志。
2. **`message.metadata` JSON 大小**：`tableCandidates` 只存 `slice(0, 8)` 且仅保留 `{ name, score }`，避免单条消息元数据膨胀到数 KB。
3. **老会话兼容**：`handleClarifyAnswer` 取不到父消息 metadata 时，降级调用 `handleQuery(sessionId, option)`（即现有行为），不 throw。
4. **测试环境**：Phase 3 已有测试基线（177 条），新增 5 条（#14~#18）不得让旧测试 red；批次 B 合入前跑全量回归。
5. **日志脱敏**：新增落库字段 `decomposition.originalQuery` 走 `safeLog.summarizePrompt` 打印，不直出原文，遵守 Phase 3 T2 约束。

---

## 8. 附录：关键代码定位

| 问题点 | 位置 | 现状片段 |
|--------|------|----------|
| 澄清直接 return 无落库 | `backend/src/core/agenticEngine.js:111-121` | `return { success:true, type:'clarification', clarification, decomposition, tableCandidates, ... }` |
| SQL Prompt 无日期 / 历史 | `backend/src/core/agenticEngine.js:390-413` | `buildSQLPrompt(decomposition, schemaDetail)` |
| Schema 发现入参过窄 | `backend/src/core/agenticEngine.js:237-238` | `const searchQuery = entities.join(' ');` |
| `applyClarification` 无调用者 | `backend/src/core/agenticEngine.js:629-631` | grep 全库仅命中定义 + export |
| 澄清回答走错端点 | `frontend/src/views/ChatView.vue:318-323` | `sessionStore.sendQuery(option)` |
| 持久化丢 decomposition | `backend/src/core/sseHandler.js:386-393` | `addMessage(sessionId, 'assistant', clarification.question, 'clarification', { clarification })` |
