# 批次 C 交接摘要:兜底与健壮性

> 所属计划:[NL2SQL-澄清断链修复计划.md](./NL2SQL-澄清断链修复计划.md)
> 批次文档:[NL2SQL-澄清断链修复-批次C-兜底与健壮性.md](./NL2SQL-澄清断链修复-批次C-兜底与健壮性.md)
> 完成日期:2026-04-23
> 覆盖根因:R3(Schema 发现入参过窄)、R1 的兜底兼容(老前端走 /sse/query 发澄清回答)
> 独立可发布:✅(依赖批次 B 的 `handleClarifyAnswer` + `resumeFromClarification`,需在批次 B 后发布)

---

## 1. 已修改的核心接口和逻辑

### 1.1 `backend/src/core/agenticEngine.js`

- **`planningPhase(userQuery, context)` — 修改 Prompt**
  - Prompt 追加第 5 条「物理字段/编码」要求:让 LLM 在规划阶段显式列出查询中出现的物理字段
    名或数字编码(`typeid=1743`、`int_key1`、`int_key5`、`game_id=30` 等)
  - 返回 JSON 示例新增 `physicalHints: [...]` 字段
  - 解析结果兜底:`!Array.isArray(parsed.physicalHints) → parsed.physicalHints = []`
  - 默认计划对象也新增 `physicalHints: []`,LLM 完全失败时不会丢该键

- **`schemaDiscoveryPhase(userQuery, plan, context)` — 签名扩展**
  - 原签名 `schemaDiscoveryPhase(plan, context)` 扩展为 `(userQuery, plan, context)`
  - 老签名兼容:`typeof userQuery === 'object'` 时降级为旧签名,`userQuery = ''`,
    原 `plan/context` 位移,老测试/调用点不受影响
  - `searchQuery` 组装逻辑改造:
    ```
    [userQuery, ...entities, ...filters(field=value), ...aggregations, ...physicalHints]
    .filter(非空字符串).join(' ')
    ```
  - `SCHEMA_SEARCH_INCLUDE_RAW=false` 回退旧行为 `entities.join(' ')`,紧急回滚用
  - `filters` 支持对象 `{field, value}` 和字符串两种形式,字符串直通,对象拼成 `field=value`
  - `processQuery` 内调用点同步为 `schemaDiscoveryPhase(userQuery, plan, context)`

### 1.2 `backend/src/core/database.js`

- **`getLatestAssistantMessage(sessionId)` — 新增**
  - 按 `session_id + role='assistant'` 取最新一条消息(`ORDER BY id DESC LIMIT 1`)
  - metadata 自动 `JSON.parse`,解析失败返回 null(不 throw)
  - 同时暴露 `type` 和 `message_type` 字段(与 `getMessage` 对齐)
  - `sessionId` 为空 → 直接返回 null
  - 已加入 module.exports,供 `handleQuery` 兜底检测父澄清消息

### 1.3 `backend/src/core/sseHandler.js`

- **`handleQuery(sessionId, query, context)` — 新增澄清自动路由兜底**
  - 位置:query 非空校验之后、标记 `isProcessing` 之前
  - 触发条件(四个同时成立):
    1. `FF_HANDLE_QUERY_CLARIFY_FALLBACK !== 'false'`(默认启用)
    2. `context.skipClarifyFallback !== true`(递归保护,见下)
    3. `query.length < 30`(老前端点选项,option 文本通常很短)
    4. `getLatestAssistantMessage(sessionId)` 返回的最新 assistant 消息是未回答的
       `clarification`,且 `metadata.{decomposition, originalQuery}` 完整
  - 命中后:`return handleClarifyAnswer(sessionId, latest.id, query, context)`,
    对前端 SSE 协议零新增;`handleClarifyAnswer` 内部会广播 `processing/result`
  - 异常兜底:`getLatestAssistantMessage` 抛异常时 warn 并继续走正常 `handleQuery` 流程,
    不阻塞主链路

- **`handleClarifyAnswer` 降级路径小改**
  - 父消息不完整时降级调用 `handleQuery(..., { ...context, skipClarifyFallback: true })`,
    避免 handleQuery 再次反向路由回 handleClarifyAnswer 造成循环(防御性保护)

### 1.4 `backend/.env.example`

- 追加批次 C 两个开关及注释:
  - `SCHEMA_SEARCH_INCLUDE_RAW=true`(反向开关,关闭回退旧行为)
  - `FF_HANDLE_QUERY_CLARIFY_FALLBACK=true`(反向开关,关闭禁用兜底)

### 1.5 测试

- `backend/test/phase3/schema-discovery-searchquery.test.js`(16 用例,全 pass)
  - case 1: 默认启用,searchQuery 含 userQuery + entities + filters + aggregations + physicalHints
  - case 2: `SCHEMA_SEARCH_INCLUDE_RAW=false` → 仅 `entities.join(' ')`
  - case 3: 老签名 `(plan, context)` 仍兼容
  - case 4: 空 entities / 缺字段不抛
  - case 5: `FF_TOOL_LOOP_MODE=false` 时不调 `toolLoop`,返回 `toolExploration=null`

- `backend/test/phase3/handleQuery-clarify-fallback.test.js`(16 用例,全 pass)
  - case 1: 短 query + 完整 clarification 父消息 → 自动路由 `handleClarifyAnswer`,
    `engineUsed='agentic-resume'`,SQL 含 typeid=1743
  - case 2: 长 query(≥30)→ 不触发兜底,走 `processQuery`
  - case 3: 最新 assistant 非 clarification(result/text)→ 不触发
  - case 4: metadata 缺 `decomposition` / `originalQuery` → 不触发
  - case 5: `FF_HANDLE_QUERY_CLARIFY_FALLBACK=false` → 不触发
  - case 6: `context.skipClarifyFallback=true` → 不触发(递归保护)
  - case 7: `getLatestAssistantMessage` 抛异常 → warn,继续走正常流程不抛

---

## 2. 验收结果

- ✅ `node test/phase3/schema-discovery-searchquery.test.js` → 16/16 pass
- ✅ `node test/phase3/handleQuery-clarify-fallback.test.js` → 16/16 pass
- ✅ Phase 3 全量回归:
  - 批次 A `sql-prompt-date.test.js` → 18/18 pass
  - 批次 B `clarification-apply.test.js` → 15/15 pass
  - 批次 B `clarification-resume.test.js` → 30/30 pass
  - 批次 B `sse-clarify-answer-route.test.js` → 19/19 pass
  - T3 legacy:`test-safeLog`(23)+`test-requestContext`(23)+`test-fallback-integration`(20)
    +`test-masking`(43)+`test-sqlRewriter`(38)+`test-auditMigration`(30)= 177/177 pass
- ✅ 批次 C 新增 32 条全 pass
- ✅ 累计 Phase 3 测试数:**291/291 pass**

⏳ 手工 smoke(未升级前端 + 真实 LLM)留给上线前与批次 A/B 联合 smoke。
   验收剧本:复跑"问鼎天下-战场等级"案例,第二轮用老前端发短 option,SQL 仍含
   `typeid=1743` + `int_key5` + 年份 2026。

### 关于 Phase 2 `test-regression-complex.js`

该测试依赖真实 LLM + SQLite 外键约束的完整会话创建路径,在当前 CI 环境因
`SQLITE_CONSTRAINT: FOREIGN KEY constraint failed` 失败。确认为**批次 C 前已存在的
环境问题**(git stash 后基线同样失败),与本批次无关,不阻断发布。

---

## 3. 遗留到下一阶段的临时代码(TODOs)

> 本批次**没有引入 TODO 注释**或临时兜底代码。

本修复计划 A+B+C 三批次全部完成,计划内无新留项。下一阶段可考虑的健壮性工作:

| 条目 | 说明 | 优先级 |
|------|------|--------|
| `physicalHints` 规范化 | LLM 返回可能混用 `typeid=1743` / `"typeid": 1743` / `"typeid 1743"`,
  下游按字符串模糊匹配。可在 planningPhase 后加一步规整 | low,按需求驱动 |
| `applyUncoveredDataUnit` 条件扩展 | 目前只识别 `field=number`;`field>value` / `IN (...)`
  / 字符串值(如 `channel_id='qingmu'`)未覆盖 | 待真实 badcase 驱动 |
| 短 query 阈值可配置 | 兜底硬编码 `query.length < 30`,某些场景下澄清回答可能较长
  (如"第1、3、5三个都要") | low,实际遇到时调阈值 |

---

## 4. 偏离初始计划的变更及其原因

### 4.1 `schemaDiscoveryPhase` 老签名自动降级

**偏离点**:计划文档 §2.1 只说"改为 `schemaDiscoveryPhase(userQuery, plan, context)`,
对应调用点改",未提老签名兼容。

**实际实现**:函数开头加一段兼容检测,`typeof userQuery === 'object'` 时把参数整体往
后挪一位,让老调用方式 `engine.schemaDiscoveryPhase(plan, context)` 仍能正确工作。

**原因**:避免潜在的老测试 / 脚本 / 文档在库外调用 `schemaDiscoveryPhase` 时回归;
JSDoc 也更新说明新签名,未来可以删掉该兼容分支。

### 4.2 `handleQuery` 兜底新增 `context.skipClarifyFallback` 递归保护

**偏离点**:计划文档 §2.3 的示例代码没有考虑 `handleClarifyAnswer` 在 metadata 不完整时
降级回 `handleQuery` 的场景。

**实际实现**:
- `handleClarifyAnswer` 降级时传 `skipClarifyFallback: true`
- `handleQuery` 兜底判断时检查该标记,为 true 则不再触发兜底

**原因**:尽管理论上 `handleClarifyAnswer` 降级时父消息 metadata 已缺失,`handleQuery`
的兜底检测拿的是"最新 assistant 消息"(可能是另一条),不构成直接循环;但防御性加一个
标记可以彻底堵死"同一会话连续两条 clarification 中第一条被用来兜底第二条"的边缘情况。
成本极低,回滚时两边代码可独立拆除。

### 4.3 `handleQuery` 兜底 try/catch 包裹 `getLatestAssistantMessage`

**偏离点**:计划文档 §2.3 的示例代码未包裹异常处理。

**实际实现**:`try { ... } catch { logger.warn; 继续 }`。

**原因**:
- 兜底是"锦上添花",不能因数据库读失败拖累正常流程
- 实测 case 7 验证了即使 `getLatestAssistantMessage` 抛异常,正常 `handleQuery` 流程
  仍能正常完成

### 4.4 测试用例数量扩充到 32(计划期望 ~7)

**偏离点**:计划文档 §4 给了 4 个示例断言;实际写了 32 个(两测试文件各 16 个)。

**原因**:
- `schema-discovery-searchquery` 补了老签名兼容 / TOOL_LOOP_MODE 关闭 / 缺字段兜底等断言
- `handleQuery-clarify-fallback` 补了:最新消息非 clarification / metadata 缺字段 /
  开关关闭 / skipClarifyFallback / 异常兜底等边界用例
- 两个改动都在主链路上,密集断言可以更早定位回归

---

## 5. 回滚步骤

按风险从低到高:

1. **关闭 `SCHEMA_SEARCH_INCLUDE_RAW`(Schema 发现扩展回退)**:
   `SCHEMA_SEARCH_INCLUDE_RAW=false`,Phase 1 `searchQuery` 回到旧行为 `entities.join(' ')`。
   `physicalHints` 字段仍存在于 planningPhase 产出,但不参与检索,不影响后续链路。

2. **关闭 `FF_HANDLE_QUERY_CLARIFY_FALLBACK`(兜底路由回退)**:
   `FF_HANDLE_QUERY_CLARIFY_FALLBACK=false`,老前端仍能走 `/sse/clarify-answer`,但
   未升级的前端会回到"第二轮丢 decomposition"的旧行为(对应批次 B 已修复的退化形态)。

3. **planningPhase prompt 回滚**:`physicalHints` 是 optional 字段,LLM 不返回也兜底
   为 `[]`;如需完全撤回 prompt 第 5 条,直接 revert 对应 commit,不影响数据面。

4. **代码级 revert**:
   ```bash
   # 不影响 SQLite 数据,metadata 里多出的字段老客户端自动忽略
   git revert <批次C commit hash>
   ```

---

## 6. 风险确认

- **兜底误触发**:仅在"短 query(<30) + 最新 assistant 为未回答 clarification +
  metadata 完整"三条件同时成立时触发;`case 2/3/4` 单测已覆盖不触发的场景,误判概率低。
- **searchQuery 变长**:`userQuery` 原文 + physicalHints 会让 toolLoop 的检索入参
  更长,但 toolLoop 自身已有 Prompt 截断;即使最坏情况下检索命中不佳,也不会导致
  管线失败(空结果会走 generationPhase 的 schemaLoader 兜底)。
- **`physicalHints` 解析失败**:LLM 不返回时 `[]` 兜底;返回格式异常(非数组)也
  `[]` 兜底;不 throw。
- **老会话兼容**:`getLatestAssistantMessage` 读老会话的 clarification 消息,若其
  metadata 无 `decomposition/originalQuery`(批次 B 前的数据),直接不触发兜底。
- **递归保护**:`skipClarifyFallback` 标记 + `handleClarifyAnswer` 降级时必传该标记,
  双向保护无死循环。

---

## 7. 三批次合并总结

批次 A + B + C 共同解决 NL2SQL 澄清断链 / SQL 跑偏问题。关键变更矩阵:

| 根因 | 修复 | 批次 |
|------|------|------|
| R1 澄清无断点续跑 | `handleClarifyAnswer` + `resumeFromClarification` + 前端 `sendClarifyAnswer` | B |
| R1 兜底:老前端兼容 | `handleQuery` 自动路由(C-3) | C |
| R2 SQL Prompt 无日期 | `buildSQLPrompt` 注入当前时间 + history(批次 A) | A |
| R3 Schema 检索入参窄 | `schemaDiscoveryPhase` 入参扩展 + `physicalHints` | C |
| R4 Prompt 无 history | context.history 组装 + `trimHistory`(批次 A / B) | A + B |
| R5 `applyClarificationResult` 分支贫弱 | `applyUncoveredDataUnit` | B |

案例验收剧本(需手工):用户提"问鼎天下-战场等级数据"需求,触发澄清后回答选项,SQL 应含:
- `typeid = 1743`
- `int_key1` / `int_key5`
- `game_id = 30`
- 时间区间 `2026-03-28 ~ 2026-04-12`(年份锚到当前 2026)

---

## 8. 下一步可考虑的方向(非必须)

- **smoke 自动化**:目前 A+B+C 都依赖手工 smoke,可考虑加一条跑真实 LLM + 真实 DB
  的端到端 case,让 CI 守住这条主链路
- **澄清记录持久化**:`clarificationHistory` 目前存在 decomposition 里,随 resume
  传递;可考虑独立表按 `session_id + parent_message_id` 存储,方便审计和回溯
- **前端 UX**:ChatView 目前选项点击后直接发请求,用户无法编辑答案;可以考虑"点击
  选项 → 填入输入框 → 用户确认后发送"的双步 UX,配合 `applyUncoveredDataUnit` 的
  自由文本抽取能力
