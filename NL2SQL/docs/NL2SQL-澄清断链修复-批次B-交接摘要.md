# 批次 B 交接摘要:澄清断链修复(主战场)

> 所属计划:[NL2SQL-澄清断链修复计划.md](./NL2SQL-澄清断链修复计划.md)
> 批次文档:[NL2SQL-澄清断链修复-批次B-澄清链路重建.md](./NL2SQL-澄清断链修复-批次B-澄清链路重建.md)
> 完成日期:2026-04-23
> 覆盖根因:R1(澄清断链)、R5(applyClarificationResult 分支贫弱)
> 独立可发布:✅(配合批次 A 一起上线效果最佳;独立上线时年份注入缺失,但澄清链路已打通)

---

## 1. 已修改的核心接口和逻辑

### 1.1 `backend/src/core/database.js`

- **`addMessage(sessionId, role, content, type, metadata)` — 小调整**
  - 语义不变,仍返回 `{ id, session_id, role, content, type, metadata }`
  - `id` 字段一直是 SQLite `lastID`,批次 B 在 JSDoc 明确声明新调用点可以用
  - 旧调用点 `await database.addMessage(...)` 忽略返回值完全不受影响

- **`getMessage(id)` — 新增**
  - 按自增 id 读一条消息,metadata 自动 `JSON.parse`
  - 同时返回 `type` 和 `message_type` 字段(语义重叠,`message_type` 别名兼容文档描述的命名)
  - 不存在 / `id` 为空时返回 `null`,不 throw
  - 已加入 module.exports,供 sseHandler 的 `handleClarifyAnswer` 取父澄清消息

### 1.2 `backend/src/core/clarificationEngine.js`

- **`applyUncoveredDataUnit(decomposition, clarification, userAnswer)` — 新增**
  - 从用户自由文本抽 `field=number` 形式的 filter 和常见物理字段
    (`int_keyN` / `str_keyN` / `typeid` / `game_id` / `channel_id`)
  - 根据 `clarification.details.uncoveredUnits` 选择性回写;`uncoveredUnits` 为空时 fallback 到全部 `dataUnits`
  - 幂等:同 `field` 不重复 push;`outputFields` / `keywords` 用 `Set` 去重
  - 支持中文/全角等号(`=` 或 `＝`)
  - 作为独立函数 export,方便测试和复用
- **`applyClarificationResult` — 补 `general` / default 分支**
  - 原先 default 只写 `clarificationNote`;现在会先调 `applyUncoveredDataUnit` 再写 note

### 1.3 `backend/src/core/agenticEngine.js`

- **`resumeFromClarification({ originalQuery, decomposition, clarification, userAnswer, context })` — 新增类方法 + 便捷函数**
  - 跳过 planning / schemaDiscovery / decomposition / clarification 阶段
  - 直接 `applyClarificationResult` → `retrieveTablesByDataUnits` → `generationPhase` → `verificationPhase`,必要时 `recoveryPhase`
  - 锁回 `updatedDecomposition.originalQuery = originalQuery`,避免下游误用 userAnswer
  - 模块级 `module.exports.resumeFromClarification` 便捷入口,内部 `new AgenticNL2SQLEngine()`
  - 返回 shape 与 `processQuery` 成功分支一致,额外带 `resumed: true` 标记

### 1.4 `backend/src/core/sseHandler.js`

- **`persistAgenticMessages(sessionId, query, tagged, options)` — 改造**
  - 新增 `options.persistUser` 参数,默认 `true`;`handleClarifyAnswer` 传 `false` 避免重复落用户消息
  - 澄清分支 metadata 扩展为:
    ```js
    {
      clarification,
      originalQuery: query,
      decomposition: tagged.decomposition,
      tableCandidates: slice(0,8).map(c => ({ name, score }))  // 仅 name + score,实测 <2KB
    }
    ```
  - `addMessage` 返回的 `id` 回写到 `tagged.message_id`,供前端记住
  - 老客户端不认识新字段自动忽略,向后兼容

- **`handleClarifyAnswer(sessionId, parentMessageId, userAnswer, context)` — 新增**
  - 取父澄清消息,校验 `type==='clarification'` 且 `metadata.{decomposition, originalQuery}` 完整
  - 任一缺失 → 降级调用 `handleQuery(sessionId, userAnswer, context)`(老会话兼容)
  - 组装 `context.history`:原 query(user) + 澄清问(assistant) + 用户答(user),
    触发批次 A 的 `buildSQLPrompt` 把对话上下文和澄清记录注入 prompt
  - 异步写 user 消息(澄清回答) → 调 `agenticEngine.resumeFromClarification`
    → 调 `persistAgenticMessages(..., { persistUser: false })` 写 assistant 结果
  - 广播 `processing` / `result` / `error` 三种事件,对前端协议零新增
  - `engineUsed = 'agentic-resume'`,`fallbackUsed = false`

### 1.5 `backend/src/core/routes.js`

- **`POST /api/sse/clarify-answer` — 新增路由**
  - 请求体:`{ session_id, parent_message_id, option }`
  - 前置校验:参数必填 + SSE 已建连(`hasActiveConnection`)
  - 后台异步调 `handleClarifyAnswer`,失败时通过 `pushError` 推 SSE error
  - 立即返回 `{ success: true }`,结果通过 SSE 推回
  - 路由 catch 兜底 + 参数缺失 400,与 `/sse/query` 行为对齐

### 1.6 前端

- **`frontend/src/utils/api.js` — 新增 `sendClarifyAnswer(sessionId, parentMessageId, option)`**
  - axios POST `/sse/clarify-answer`
- **`frontend/src/stores/session.js`**
  - 新增 `sendClarifyAnswer(parentMessageId, option)` action:立即 addMessage 用户回答,
    再 POST 接续;失败时重置 isProcessing + 写 error 消息
  - `handleSSEMessage.case 'result'` 的 clarification 分支:注入 `id: data.data.message_id`
    到前端消息对象,供后续 clarify-answer 使用
  - Actions 导出 `sendClarifyAnswer`
- **`frontend/src/views/ChatView.vue`**
  - `answerClarification(message, option)` 改为调 `sessionStore.sendClarifyAnswer(message.id, option)`
  - `message.id` 缺失时降级 `sendQuery(option)`(老消息 / 渲染异常兜底)

### 1.7 测试

- `backend/test/phase3/clarification-apply.test.js`(15 用例,全 pass)
  - `applyUncoveredDataUnit` 抽取 / 回写 / 幂等 / default 分支 / 健壮性 / 导出
- `backend/test/phase3/clarification-resume.test.js`(21 用例,全 pass)
  - 端到端:decomposition 更新 + SQL 命中 typeid=1743 / int_key5
  - Prompt 注入(批次 A)校验:当前时间 / 澄清记录 / originalQuery
  - traceLog / originalQuery 锁回
  - verification 失败触发 recoveryPhase
- `backend/test/phase3/sse-clarify-answer-route.test.js`(19 用例,全 pass)
  - 父消息完整 → resume 路径,SSE 事件 + addMessage 落库校验
  - 父消息不存在 / metadata 缺失 → 降级 handleQuery
  - 空 userAnswer → pushError + SSE error

---

## 2. 验收结果

- ✅ `node test/phase3/clarification-apply.test.js` → 15/15 pass
- ✅ `node test/phase3/clarification-resume.test.js` → 21/21 pass
- ✅ `node test/phase3/sse-clarify-answer-route.test.js` → 19/19 pass
- ✅ Phase 3 全量回归:`test-safeLog`(23) + `test-requestContext`(23) + `test-fallback-integration`(20)
  + `test-masking`(43) + `test-sqlRewriter`(38) + `test-auditMigration`(30) + `sql-prompt-date`(18)
  = **195/195 pass**(原 177 条 + 批次 A 的 18 条)
- ✅ 批次 B 新增 55 条全 pass
- ✅ 累计 Phase 3 测试数:**250/250 pass**

⏳ 手工 smoke(端到端真实 LLM + 前端点澄清选项):留给上线前与批次 A 联合 smoke。

---

## 3. 遗留到下一阶段的临时代码(TODOs)

> 本批次**没有引入 TODO 注释**或临时兜底代码。

留给批次 C 处理的已知限制:

| 条目 | 说明 | 下个批次 |
|------|------|---------|
| `handleQuery` 老前端兜底 | 老前端若仍把 option 当 `sendQuery` 发出,当前会丢失 decomposition 上下文 | 批次 C:`handleQuery` 检测 option 意图并按前一条 clarification 消息的 metadata 恢复 |
| `schemaDiscoveryPhase` 入参过窄(R3) | `searchQuery = entities.join(' ')` 仍会丢 typeid/int_key* 物理 token | 批次 C |
| `applyUncoveredDataUnit` 未识别条件 | 目前只支持 `field=number`;`field>value` / `field IN (...)` / 字符串值未覆盖 | 后续需求驱动补充 |
| metadata 中 tableCandidates 字段仅存 `{name, score}` | 恢复时重新做表检索,不复用原候选(避免 metadata 膨胀) | 实测 metadata <2KB |

---

## 4. 偏离初始计划的变更及其原因

### 4.1 `persistAgenticMessages` 新增 `options.persistUser` 参数

**偏离点**:计划文档 §3.2 示例仅改 metadata,未说明如何避免 user 消息重复落库。

**实际情况**:`handleClarifyAnswer` 需要先写用户回答 + 再调 `persistAgenticMessages` 写 assistant
结果。如果 `persistAgenticMessages` 无条件写 user 消息,会导致同一回答落库两次。

**实际实现**:增加 `options.persistUser = true` 参数,`handleClarifyAnswer` 传 `false`。
`handleQuery` 老调用点自然沿用默认 `true`,向后兼容。

**原因**:避免重复写库,保持消息列表干净。

### 4.2 `getMessage` 同时暴露 `type` 和 `message_type` 字段

**偏离点**:计划文档 §3.3 使用 `parent.message_type === 'clarification'`,但数据库 schema 列名
是 `type`。

**实际实现**:`getMessage` 返回对象同时暴露两个字段(值相同),
`handleClarifyAnswer` 校验时用 `(parent.type === 'clarification' || parent.message_type === 'clarification')`。

**原因**:计划文档使用了概念化的 `message_type`,实际 schema 是 `type`。保留两个字段既满足
文档原意,又兼容现有代码。

### 4.3 测试拆分:未落 `clarification-resume` 里直接断言 tableResult.recommendedTables

**偏离点**:计划文档 §5.1 的测试只验证 SQL 含 typeid/int_key5。

**实际实现**:测试额外覆盖了 `result.decomposition.dataUnits[].filters / outputFields`,
`result.traceLog` 各阶段,Prompt 内容的关键 section。

**原因**:这些是 resume 链路的核心契约,一旦回归不到位,最后表现为 SQL 缺字段但单元测试难定位。
加强断言的覆盖率让回归更早发现问题。

### 4.4 `context.history` 自己组装,不要求调用方传入

**偏离点**:计划文档 §3.1 的示例代码直接透传 context,未指明 history 如何拼接。

**实际实现**:`handleClarifyAnswer` 自己从父消息 metadata 读取 originalQuery + clarification.question,
拼接成 `[原 user query, 澄清 assistant 问题, user 澄清回答]`,再透传给 engine。
`generationPhase` 只过滤 `role==='user'`,assistant 项仅起序列完整作用。

**原因**:把 history 组装下沉到 sseHandler,避免路由层 / 前端需要组装历史。与批次 A 的 `## 对话上下文`
小节配合,无需修改 `buildSQLPrompt`。

---

## 5. 回滚步骤

1. **路由级回滚**:直接移除 `routes.js` 的 `POST /sse/clarify-answer` 路由注册,前端调用会 404,
   走 `sendQuery` 兜底(取决于批次 C 的兜底是否部署)。
2. **代码回滚**:若需彻底撤下批次 B,按 commit 粒度 revert。metadata 里多出的字段对老客户端无影响
   (JSON 解析时忽略未知字段),不需要清数据库。
3. **前端回滚**:把 `ChatView.vue` 的 `answerClarification` 改回 `sendQuery(option)` 即可。

---

## 6. 风险确认

- **metadata 大小**:已限制 `tableCandidates.slice(0,8)` 且仅 `{name, score}`;
  `decomposition` 序列化后实测 <2KB,远低于 SQLite TEXT 列限制。
- **老会话兼容**:老会话没有新 metadata → `handleClarifyAnswer` 降级走 `handleQuery`。
- **`addMessage` 返回 id 兼容**:老调用点 `await addMessage(...)` 忽略返回值,行为不变。
- **前后端解耦**:后端先行发布时,老前端仍走 `sendQuery`,不会因为缺少新端点而报错。
  批次 C 的 `handleQuery` 兜底将真正抹平这层差距。

---

## 7. 下批次对接说明

- **批次 C** 的 `handleQuery` 老前端兜底需要在 `sseHandler.handleQuery` 开头检查:若前一条 assistant
  消息是未应答的 clarification,则自动走 `resumeFromClarification`。本批次已落好所需 metadata,
  直接读即可。
- **批次 C** 扩 `searchQuery` 加物理 token 后,`resumeFromClarification` 的 `retrieveTablesByDataUnits`
  调用会自然受益(因为 decomposition 里已补充了 filters/outputFields),不需要额外改动。
