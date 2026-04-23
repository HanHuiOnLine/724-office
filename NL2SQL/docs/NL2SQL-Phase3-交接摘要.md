# NL2SQL Phase 3 交接摘要

## 文档信息

- 版本:v1.0
- 日期:2026-04-23
- 范围:Phase 3(Week 3)Agentic 接入 + 日志安全 + 数据安全
- 对应计划:`docs/NL2SQL核心模块优化实施计划.md` 第 3 章 Phase 3
- 实施计划(含代码清单):`C:\Users\hanhui\.claude\plans\f-learn-724-office-nl2sql-docs-nl2sql-md-enumerated-lemur.md`
- 前置:`docs/NL2SQL-Phase2-交接摘要.md`

---

## 0. 概览

Phase 3 分五条子轨道落地,全部通过单测:

| 轨道 | 范围 | 默认开关 |
|------|------|----------|
| T2 | Prompt 日志脱敏 | 永久启用(console.log 仅在 `LOG_PROMPT_FULL=true` 时恢复) |
| T1 | 引擎入口切换(legacy ↔ agentic + 自动回退) | `FF_AGENTIC_ENGINE=false`(opt-in),`FF_AGENTIC_AUTO_FALLBACK=true`(默认) |
| T3a | 结果脱敏(7 种规则) | `FF_RESULT_MASKING=true`(默认,反向开关) |
| T3b | 行级权限 SQL 改写(RLS) | `FF_RLS_ENFORCEMENT=false`(最高风险,opt-in) |
| T3c | query_history 审计字段(7 列) | `FF_AUDIT_LOG_EXTENDED=true`(默认,反向开关) |

Phase 3 累计单测 **177 条全绿**(另回归 Phase 2 的 43 条,共 220 条)。

---

## 1. 核心接口与逻辑变更

### 1.1 新增 `safeLog` 日志脱敏工具(T2)

**位置**:`backend/src/utils/safeLog.js`(新建,~55 行)

**契约**:

```js
hashPrompt(text) → string             // 8 字符 SHA-1 前缀;空/null → 'empty',非字符串 → 'nonstr'
summarizePrompt(text, {head=60,tail=60}={}) → {length, hash, head?, tail?}
isPromptFullLoggingEnabled() → boolean  // 读 LOG_PROMPT_FULL === 'true'
```

**设计要点**:短文本(length ≤ head + tail)省略 tail,避免冗余;`LOG_PROMPT_FULL` 是纯 env 逃生门,不进 feature-flags 体系。

### 1.2 Prompt 日志调用点改造(T2)

| 位置 | 改动 |
|------|------|
| `llmService.js:228-232` | 三条 `console.log` → `logger.debug + summarizePrompt`;`LOG_PROMPT_FULL=true` 时走原 console 全量输出分支(逃生门) |
| `nl2sqlEngine.js:1679-1685` | schemaDetail / schemaMappingHints 从 `logger.info` 降为 `logger.debug + summarizePrompt` |
| `nl2sqlEngine.js:1792-1797` | 已是纯计数,无改动(审计时确认) |
| `nl2sqlEngine.js:2197` processQuery 开场 | `query: userQuery` → `query: safeLog.summarizePrompt(userQuery)` |
| `queryDecomposer.js:41` | `{query: userQuery}` → `safeLog.summarizePrompt(userQuery)` |
| `toolLoop.js:64-67` | `query: userQuery` → `query: safeLog.summarizePrompt(userQuery)` |
| `toolLoop.js:131` | `args` → `sanitizeToolArgs(args)`(新增本地辅助,对任何超 200 字符的字符串字段自动 summary) |
| `toolLoop.js:308` | `{query: userQuery}` → `safeLog.summarizePrompt(userQuery)` |

### 1.3 新增 `requestContext` 请求上下文工具(T1)

**位置**:`backend/src/core/requestContext.js`(新建,~70 行)

**契约**:

```js
extractContext(req) → {
  userId,          // X-User-Id header / req.query.user_id / req.body.user_id / 'anonymous'
  userRole,        // X-User-Role / 'user'
  tenantId,        // X-Tenant-Id / null
  requestSource,   // X-Request-Source / 'web'
  requestIp        // req.ip / req.connection.remoteAddress / null
}
mergeIntoContext(base, extra) → object   // extra 中 undefined 不覆盖;null 覆盖
```

**设计选择**:Header 透传,信任上游网关;无鉴权中间件。Header 值首尾空白 trim、空串走默认、数组 header 取首个。

### 1.4 `sseHandler.handleQuery` 签名 + 引擎选择器(T1)

**位置**:`backend/src/core/sseHandler.js`(handleQuery 约 line 255-366)

**签名变更**:

```js
// 改前
async function handleQuery(sessionId, query)
// 改后
async function handleQuery(sessionId, query, context = {})
```

**引擎选择器核心逻辑**:

```js
const useAgentic = featureFlags.isEnabled('AGENTIC_ENGINE');
const autoFallback = featureFlags.isEnabled('AGENTIC_AUTO_FALLBACK');
let fallbackUsed = false, engineUsed = 'legacy';

if (useAgentic) {
  engineUsed = 'agentic';
  try {
    result = await agenticEngine.processQuery(query, {sessionId, ...context}, onProgress);
    if (!result || result.success === false) {
      if (!autoFallback) throw new Error(result?.error || 'agentic 引擎返回失败');
      fallbackUsed = true;
    }
  } catch (err) {
    if (!autoFallback) throw err;
    fallbackUsed = true;
  }
}
if (fallbackUsed || !useAgentic) {
  engineUsed = fallbackUsed ? 'legacy-after-agentic' : 'legacy';
  context.fallbackUsed = fallbackUsed;  // T3c 回流审计
  result = await nl2sqlEngine.processQuery(query, sessionId, onProgress, context.userId, context);
}
const tagged = {...result, engineUsed, fallbackUsed};
broadcastToSession(sessionId, {type: 'result', data: tagged});
```

**SSE 协议决策**:不新增 `engine_switched` 事件;fallback 对前端**静默**,观测走 server 日志 + `query_history.fallback_used`。

**handleConnection 同步**:在 `connectionInfo` 里新增 `context: extractContext(req)` 作 POST 路径缺 header 时的兜底。

### 1.5 `routes.js` POST /api/sse/query 注入 context(T1)

**位置**:`backend/src/core/routes.js:972-1012`

```js
router.post('/sse/query', async (req, res) => {
  ...
  const context = requestContext.extractContext(req);
  sseHandler.handleQuery(session_id, query, context).catch(...);
  ...
});
```

### 1.6 `nl2sqlEngine.processQuery` 签名扩展(T1 + T3c)

**位置**:`backend/src/core/nl2sqlEngine.js:2199`

```js
// 改前
async function processQuery(userQuery, sessionId, onProgress = null, userId = null)
// 改后
async function processQuery(userQuery, sessionId, onProgress = null, userId = null, context = {})
```

- `context.userId` 作 `userId` 参数空时兜底
- 开场 info 日志改走 `safeLog.summarizePrompt`
- `createQueryHistory` 调用点注入 `userRole/tenantId/requestSource/requestIp`(T3c)
- `markQueryHistorySuccess/Failure` 传入 `fallbackUsed`(从 context 读)+ `rlsApplied` + `errorCode`(T3c)

### 1.7 新增 `maskResult` 结果脱敏工具(T3a)

**位置**:`backend/src/utils/maskResult.js`(新建,~130 行)

**契约**:

```js
maskRows(rows, columns, rules) → {rows: Array, maskedCells: number}
// + 导出 7 种规则纯函数:maskMid4 / maskDomainOnly / maskHeadTail / maskRedact /
//                      maskFirst1 / maskLast4 / maskLengthStars
// + RULE_IMPL 映射表
```

**规则清单**:

| 规则 | 输入示例 | 输出 |
|------|----------|------|
| `mid_4` | `'13812345678'` | `'138****5678'`(长度<8 降级为 length_stars) |
| `domain_only` | `'alice@example.com'` | `'***@example.com'`(无 `@` 降级为 redact) |
| `head_tail` | `'110101199001011234'` | `'110101*********234'`(长度<10 降级) |
| `redact` | 任意 | `'***'` |
| `first_1` | `'张三丰'` | `'张**'` |
| `last_4` | `'6228480000001234'` | `'************1234'` |
| `length_stars` | `'abc'` | `'***'` |

**特性**:返回新数组(immutable,原 `rows` 未被修改);列名大小写不敏感;null / undefined 透传不脱敏;双 shape(对象行 / 数组行)。

### 1.8 `config.security.masking` 扩展(T3a)

**位置**:`backend/src/core/config.js:149-179`

- 保留 `sensitiveFields` 旧数组作向后兼容别名
- 新增 `masking: {enabled, rules}`,默认含 10 条映射(phone/mobile→mid_4、email→domain_only、id_card/idcard→head_tail、credit_card/creditcard/password/secret/token→redact)
- 两级开关:`FF_RESULT_MASKING`(FF 层,反向默认 true)+ `MASKING_ENABLED`(env 层,反向默认 true)

### 1.9 `executeQuery` 结果脱敏接入(T3a)

**位置**:`backend/src/core/nl2sqlEngine.js:2100-2130`

```js
let limitedRows = truncated ? rows.slice(0, maxRows) : rows;

// Phase 3 · T3a
let maskedCells = 0;
if (featureFlags.isEnabled('RESULT_MASKING') && config.security.masking?.enabled) {
  const masked = maskResult.maskRows(limitedRows, columns, config.security.masking.rules);
  limitedRows = masked.rows;
  maskedCells = masked.maskedCells;
}

logger.info('查询执行完成', {rowCount, returnedRows, truncated, maskedCells, executionTime});
```

### 1.10 新增 `sqlRewriter` RLS 改写工具(T3b)

**位置**:`backend/src/utils/sqlRewriter.js`(新建,~190 行)

**契约**:

```js
injectTenantFilter(sql, tableTenantMap, tenantId, {dialect='mysql'}={}) → {
  sql: string,
  applied: string[],          // 去重后的表名列表(审计用,不是注入次数)
  skippedTables: string[],    // 目前保留字段,当前实现始终为空
  refused?: boolean,
  reason?: string             // PARSE_FAIL/SQLIFY_FAIL/VERIFY_FAIL/WALK_FAIL/NO_TENANT_ID/UNSUPPORTED_TYPE/NODE_SQL_PARSER_NOT_INSTALLED
}
parseTenantMapEnv(str) → {tableName: tenantColumn}  // 解析 "t1:col,t2:col"
```

**关键设计约束**:
- 解析 / sqlify / verify-reparse / walk / 非 SELECT → **全部 `refused:true`**,上游**中止执行**,绝不静默跳过
- 覆盖:单表 SELECT、JOIN(多 `from` 项)、UNION(`_next` 链)、CTE(`with[].stmt.ast`)、FROM 子查询(`from[i].expr.ast`)
- 改写点:在本层 SELECT 的 `where` 追加 `AND <alias|tableName>.<tenantCol> = '<tenantId>'`;不动 JOIN 的 ON 条件
- 改写后再次 `astify` 验证 well-formedness(双重保险)

**依赖**:新增 npm 依赖 `node-sql-parser@^5.3.3`(实际装到 5.3.12)。

### 1.11 `config.security.rls` 扩展(T3b)

**位置**:`backend/src/core/config.js` 顶部(新增 `parseTenantMapEnv` import)+ `security.rls` 段

```js
rls: {
  enabled: process.env.RLS_ENABLED === 'true' || false,
  tableTenantMap: parseTenantMapEnv(process.env.RLS_TABLE_TENANT_MAP)
}
```

**三级开关收紧**:
1. `FF_RLS_ENFORCEMENT`(FF 层,正向默认 false)
2. `RLS_ENABLED`(env 层,默认 false)
3. `RLS_TABLE_TENANT_MAP`(默认空 map,必须 ops 逐表填入)

### 1.12 `nl2sqlEngine` RLS 改写接入(T3b)

**位置**:`backend/src/core/nl2sqlEngine.js` validateSQL 通过后、executeQuery 之前(约 line 2625-2670)

```js
let finalSql = sqlResult.sql;
if (featureFlags.isEnabled('RLS_ENFORCEMENT') && config.security.rls?.enabled) {
  const r = sqlRewriter.injectTenantFilter(finalSql, config.security.rls.tableTenantMap, context?.tenantId);
  if (r.refused) {
    // 返回 { success: false, type: 'error', errorCode: 'RLS_REWRITE_FAILED', ... }
    // 日志 + addMessage + endTrace + 审计
    return ...
  }
  finalSql = r.sql;
  if (r.applied.length > 0) context.rlsApplied = r.applied;
}
const queryResult = await executeQuery(finalSql);
```

### 1.13 `query_history` schema 扩展 + 迁移(T3c)

**位置**:`backend/src/core/database.js`

- **CREATE TABLE** 补 7 列:`user_role TEXT`、`tenant_id TEXT`、`request_source TEXT`、`request_ip TEXT`、`error_code TEXT`、`fallback_used INTEGER DEFAULT 0`、`rls_applied TEXT`
- **新增 `ensureQueryHistoryColumns()`** idempotent 迁移函数(约 line 288-327):
  - `PRAGMA table_info` → 缺失列逐一 `ALTER TABLE ... ADD COLUMN`
  - 末尾无条件 `CREATE INDEX IF NOT EXISTS idx_query_history_tenant_id`(统一索引创建,规避升级路径列依赖冲突)
  - 失败仅 error 日志,不阻断启动
- **`runMigrations()` 调用** `await ensureQueryHistoryColumns()`
- 导出新增:`ensureQueryHistoryColumns`(供单测直接调用)

### 1.14 3 个 writer 扩参(T3c)

**位置**:`backend/src/core/database.js:871-980`

```js
createQueryHistory({
  sessionId, userId, naturalQuery,
  userRole, tenantId, requestSource, requestIp  // T3c 新增
})

markQueryHistorySuccess(id, {
  generatedSql, executionTime, rowCount, result,
  fallbackUsed, rlsApplied                        // T3c 新增
})

markQueryHistoryFailure(id, {
  generatedSql, executionTime, errorMessage,
  errorCode, fallbackUsed, rlsApplied             // T3c 新增
})
```

**序列化约定**:
- `fallbackUsed: boolean` → DB `fallback_used INTEGER`(true→1,false/undefined→0)
- `rlsApplied: string[]` → DB `rls_applied TEXT`(JSON 串);空数组 / undefined → NULL

### 1.15 `sseHandler.handleQuery` fallback 回流(T3c)

**位置**:`backend/src/core/sseHandler.js:334-345`

```js
if (fallbackUsed || !useAgentic) {
  engineUsed = fallbackUsed ? 'legacy-after-agentic' : 'legacy';
  context.fallbackUsed = fallbackUsed;  // ← 写入 context 再传给 processQuery
  result = await nl2sqlEngine.processQuery(query, sessionId, onProgress, context.userId, context);
}
```

注意这里对 context 做了 mutation,见遗留 TODO T2。

### 1.16 Feature Flag 与 .env(4 个新)

**位置**:`backend/config/feature-flags.js` + `backend/.env.example`

| Flag | 默认 | 方向 | 说明 |
|------|------|------|------|
| `FF_AGENTIC_AUTO_FALLBACK` | **true** | 反向 | agentic 失败自动回退 legacy |
| `FF_RESULT_MASKING` | **true** | 反向 | 结果脱敏 |
| `FF_RLS_ENFORCEMENT` | **false** | 正向 opt-in | RLS 改写(最高风险) |
| `FF_AUDIT_LOG_EXTENDED` | **true** | 反向 | 审计字段写入 |
| `LOG_PROMPT_FULL` | unset | 正向 env | Prompt 日志逃生门(不进 FF 体系) |

### 1.17 单测清单(`backend/test/phase3/`)

| 脚本 | 用例数 | 依赖 | 状态 |
|------|--------|------|------|
| `test-safeLog.js` | 23 | 无 | ✅ |
| `test-requestContext.js` | 23 | 无 | ✅ |
| `test-masking.js` | 43 | 无 | ✅ |
| `test-sqlRewriter.js` | 38 | node-sql-parser | ✅ |
| `test-auditMigration.js` | 30 | sqlite3 + 临时 DB 文件 | ✅ |
| `test-fallback-integration.js` | 20(4 场景) | 无外部依赖(引擎 mock) | ✅ |
| **合计** | **177** | | ✅ 全绿 |

---

## 2. 遗留 TODO(Phase 4+)

| # | 位置 | 性质 | 建议阶段 | 说明 |
|---|------|------|---------|------|
| T1 | `sqlRewriter.skippedTables` 字段 | 冗余字段 | Phase 4 清理 | 当前实现始终为空数组;设计意图是"map 命中但 AST 无法识别的表"落此,实际走 WALK_FAIL → refused 分支。保留或删除 |
| T2 | `sseHandler.handleQuery:337` `context.fallbackUsed = fallbackUsed` | 对入参 context 做 mutation | Phase 4 小重构 | 更纯净:用 `requestContext.mergeIntoContext(context, {fallbackUsed})` 产出新对象传给 processQuery。当前 context 只在 handleQuery 内使用,影响面有限 |
| T3 | `agenticEngine` 成功路径不写 `query_history` | 审计缺口 | Phase 4 | 当前只有 legacy(含 fallback 后)写入 `query_history`。agentic 独立成功的查询在审计表缺席。需要在 agenticEngine 内部集成 createQueryHistory / markSuccess,或改为 sseHandler 统一代理写入 |
| T4 | RLS 对 SR MySQL 方言的兼容 sampling | 正式开启前的准备 | 开启 RLS 前 ops 协作 | 单测只覆盖标准 MySQL AST。正式 `FF_RLS_ENFORCEMENT=true` 之前,用真实 SR 历史 SQL 采样 50-100 条,确认无 PARSE_FAIL。特殊语法(STRAIGHT_JOIN、GROUP_CONCAT、hint、/*! */)可能不受支持 |
| T5 | `rls_applied` 大小写未归一化 | 审计混淆 | Phase 4 低优先 | `applied` 直接取自 AST 的 `f.table`(原始大小写)。map 用 `orders` 但 SQL 写 `Orders` 时,`rls_applied` 里会是 `Orders` |
| T6 | `masking.rules` 列名碰撞风险 | 配置文档化 | Phase 4 | `token`/`secret` 等短 key 可能误伤合法业务列(例"奖券 token")。需要"表级排除" / "精确列白名单"机制。短期靠 ops 调整 `config.security.masking.rules` |
| T7 | `ALTER TABLE ADD COLUMN` 对旧行 DEFAULT 0 的 SQLite 行为 | 行为差异观察 | 多环境验证 | 测试里观察到旧行 `fallback_used=0`(非 NULL),但 SQLite 规范是"DEFAULT 对已有行可能填 NULL"。不同 SQLite 版本行为可能不一致。如需严格统计,可在迁移末尾加 `UPDATE query_history SET fallback_used=0 WHERE fallback_used IS NULL` |
| T8 | RLS 仅支持 SELECT | 已知范围限制 | 视业务扩展 | 当前 `injectTenantFilter` 非 SELECT → refused。若未来放开 DML 但仍需 RLS,需扩展:UPDATE/DELETE 追加 WHERE、INSERT 值校验。超出 Phase 3 范围 |
| T9 | `test-fallback-integration.js` 依赖 `handleConnection` 建真连接 | 测试耦合 | Phase 4 拆分时 | Stub `database.getSession` 绕开 DB。若 Phase 4 做 DI / 模块拆分,建议重写为直接注入 connections Map 的测试模式 |
| T10 | `nl2sqlEngine.js` 仍单文件 ~2900 行 | 架构治理 | **Phase 4 主任务** | 原计划 Phase 4 拆分为 intentAnalyzer / sqlGenerator / sqlExecutor / resultFormatter / entityResolver。Phase 3 新增的 RLS / 脱敏 / 审计注入点都集中在 processQuery 内,拆分时需同步迁移 |
| T11 | Token 估算未整合进 safeLog | 成本审计 | Phase 4 低优先 | `summarizePrompt` 只记 length/hash,未估 tokens。若要用日志做 LLM 成本审计,需整合 `tokenBudget` |
| T12 | Phase 2 遗留项 T1/T2 尚未收敛 | 与 Phase 2 联动 | Phase 4 | `FF_UNIFIED_RANKER` 的 legacy 分支已稳定 2 周+,Phase 4 可清理 `tableRanker.legacySelect` 与 `nl2sqlEngine.generateSQL` 的双路径 |

---

## 3. 偏离原计划的变更

| 变更项 | 原计划 | 实际做法 | 原因 |
|-------|-------|---------|------|
| **`sqlRewriter.applied` 去重** | 计划未明说 | 返回去重后的表列表(`Array.from(new Set(applied))`) | `applied` 语义是"哪些表被保护",不是"注入次数"。UNION 两段都注入 orders 时审计记录一个 orders 更清晰。SQL 里 2 次 tenant_id 已证明两段都生效 |
| **tenant_id 索引创建位置** | 计划里 CREATE TABLE 中直接加 `CREATE INDEX ... tenant_id` | 索引创建从 SCHEMA_SQL 里**移出**,改由 `ensureQueryHistoryColumns()` 末尾无条件执行 | 升级路径下 SCHEMA_SQL 先跑、ALTER 后跑:旧库还没有 tenant_id 列时,`CREATE INDEX ... ON query_history(tenant_id)` 会报 `SQLITE_ERROR: no such column: tenant_id`,启动崩溃。测试里暴露,遂调整 |
| **`toolLoop.js:131 args` 日志** | 计划建议"小则保留,有 args.query 才脱敏" | 新增 `sanitizeToolArgs` 本地辅助,对任何超 200 字符的字符串字段自动 summary | 比"仅 args.query"更统一。无论 tool 定义如何扩展,都有兜底 |
| **`LOG_PROMPT_FULL` 启用后的全量输出** | 计划"gate a full dump behind `isPromptFullLoggingEnabled()`" | 保留原 3 条 `console.log`,仅在 env=true 时分支执行 | 真 dev 排障时 stdout 直出比 logger.debug + JSON 格式更直观。语义无损 |
| **`fallbackUsed` 回流到审计的方式** | 计划未明说 | sseHandler 调 processQuery 前 `context.fallbackUsed = fallbackUsed`(mutation),processQuery 从 context 读取后传给 markSuccess/Failure | 替代方案是 processQuery 额外接一个参数,但已经 5 参数了,再加会臃肿。mutation 代价小,记为 TODO T2 |
| **`config.js` 顶部引入 `sqlRewriter`** | 计划未明说 | `const { parseTenantMapEnv } = require('../utils/sqlRewriter');` 放在 config 定义前 | 为了在 config 对象字面量里就能调用 `parseTenantMapEnv(process.env.RLS_TABLE_TENANT_MAP)`。sqlRewriter **不反向 require config**(干净无循环依赖),已确认 |
| **nl2sqlEngine 的 featureFlags import** | 计划建议新增 `const featureFlags = require(...)` | 未新增(撤回了一次重复导入) | 文件内原已有 `let featureFlags = null; try { ... }` 兜底导入(line 60),再加 `const` 会重声明。直接复用已有 |
| **`config.security.sensitiveFields` 旧数组** | 计划"保留作兼容别名" | 按计划保留 | 没删除,维持向后兼容 |
| **`executeQuery` 返回 `finalSql` 字段未回传上层** | 计划没要求 | RLS 改写后的 SQL 只传给真实执行,不在 `queryResult` 返回对象里暴露给前端 | 避免把含 tenant_id 的内部 SQL 回流给前端,保护 RLS 机制不被嗅探。前端展示的 SQL 仍是 `sqlResult.sql`(改写前版本)—— 这是设计选择 |
| **`node-sql-parser` 实际版本** | 计划 `^5.3.3` | `npm install` 装到 5.3.12 | 小版本升级,无 breaking |
| **`test-fallback-integration.js` 拆成 4 场景** | 计划只要求"mock agentic 返回 success:false,断言 legacy 被调用" | 扩展为 4 场景:A 软失败、B 抛异常、C FF 关闭直走 legacy、D 关闭 auto fallback | 覆盖引擎选择器的全部分支。后两场景用动态替换 `featureFlags.isEnabled` 而非改 env(避免污染其他测试) |
| **测试风格** | 计划未明说单测基线 | 沿用 Phase 2 原生 `assert` + `ok()` 断言器风格,无 mocha/jest 依赖 | 与 Phase 1/2 一致,零新依赖;测试文件可直接 `node <path>` 运行 |

---

## 4. 验收状态(对齐 Phase 3 验收标准)

### 对齐原计划 §3.3.3 验收

| # | 验收标准 | 状态 | 备注 |
|---|---------|------|------|
| 1 | 在灰度环境可切换 Agentic 流程,失败时可自动回退 | ✅ | 集成测试 4 场景 20/20,真实灰度需 ops 配 `FF_AGENTIC_ENGINE=true` |
| 2 | 日志中不再出现完整 Prompt 明文 | ✅ | `llmService.js:228-232` 已脱敏;其他 5 处日志点同步脱敏。默认情况下 stdout 只见 `{length, hash, head, tail}`;`LOG_PROMPT_FULL=true` 可恢复 |
| 3 | 功能切换不影响 SSE 与前端交互协议 | ✅ | SSE 事件类型不变(connected / processing / progress / result / error);result 载荷新增 `engineUsed` / `fallbackUsed`,前端可忽略 |
| 4 | 敏感字段返回结果符合脱敏规则 | ✅ | 7 种规则 + 43 单测全过;executeQuery 后置注入 |
| 5 | 行级权限策略在测试角色下生效 | ⚠️ 待真实 schema 验证 | sqlRewriter 单测 38/38,覆盖单表 / JOIN / CTE / UNION / 子查询 / 失败路径。真实 SR 方言 sampling 列为遗留 T4 |
| 6 | 审计日志可追溯查询来源与执行信息 | ✅ | 7 个新列 + idempotent 迁移 + 3 个 writer 扩参 + sseHandler 回流 fallbackUsed + nl2sqlEngine 串联 rlsApplied / errorCode |

### 附加目标

| # | 目标 | 状态 | 备注 |
|---|------|------|------|
| A1 | 177 条 Phase 3 单测 + Phase 2 回归 43 条全绿 | ✅ | 0 failure |
| A2 | 无新语法错误、模块互不循环依赖 | ✅ | 所有改动文件 `node -c` 通过;config 顶部引 sqlRewriter 单向,sqlRewriter 不 require config |
| A3 | 升级路径迁移幂等 | ✅ | `test-auditMigration.js` 专测"旧 schema → 迁移 → 二次迁移 no-op" |

---

## 5. Phase 4 起手建议

1. **收敛 Phase 2 遗留**:`FF_UNIFIED_RANKER` 的 legacy 分支已稳定 2 周+,可删除 `tableRanker.legacySelect` + `nl2sqlEngine.generateSQL` 双路径(Phase 2 T1/T2)。同时清理 `KEYWORD_SCALE=10` 魔数(Phase 2 T3)。

2. **收敛 Phase 3 遗留**:`sqlRewriter.skippedTables`(T1)、`context.fallbackUsed` mutation(T2)可一并清理。

3. **拆分 `nl2sqlEngine.js`**(Phase 4 主任务):按职责拆为 `intentAnalyzer` / `sqlGenerator` / `sqlExecutor`(RLS 改写 + executeQuery + 脱敏)/ `resultFormatter` / `entityResolver`。Phase 3 注入点已聚焦在 processQuery 中,拆分时连带迁移即可。

4. **真实 SR 方言 RLS 兼容性采样**(T4):开启 `FF_RLS_ENFORCEMENT=true` 前,用 `query_history.generated_sql` 的历史样本跑 `sqlRewriter.injectTenantFilter` dry-run(不需执行),统计 `refused` 比例。如 >5% 需要调整 parser 或黑名单。

5. **统一审计写入**(T3):把 agenticEngine 成功路径也接入 `createQueryHistory`,或把写入逻辑上移到 sseHandler 统一代理。

6. **跑端到端回归**:前提 `LLM_API_KEY` 已配。
   ```bash
   cd backend
   node test/phase2/test-regression-complex.js
   ```
   观测 5 条用例在 Phase 3 RLS/脱敏/审计链路下的表现(默认 RLS 关,脱敏开,审计开)。

7. **手工验证清单(上线前跑一轮)**:
   - [ ] POST `/api/sse/query` 带 `X-Tenant-Id: acme` → `SELECT tenant_id FROM query_history ORDER BY id DESC LIMIT 1` 返回 `acme`
   - [ ] 命中 `phone` 列查询 → SSE `result.data.rows[*].phone` 形如 `138****5678`
   - [ ] `FF_AGENTIC_ENGINE=true` → 日志出现 `engineUsed: 'agentic'`
   - [ ] 人为令 agentic 抛异常 → SSE result 含 `fallbackUsed:true`,`query_history.fallback_used=1`
   - [ ] `FF_RLS_ENFORCEMENT=true` + 空 map → 查询照常,`rls_applied=NULL`
   - [ ] `FF_RLS_ENFORCEMENT=true` + map 命中表但客户端未传 `X-Tenant-Id` → 返回 error,未执行
   - [ ] `grep -iE '总字符长度' logs/app.log` 在升级后应搜不到旧日志
   - [ ] `PRAGMA table_info(query_history)` 列数 = 原基数 + 7

---

## 6. 关键文件索引

| 文件 | 角色 | 变更 |
|------|------|------|
| `backend/src/utils/safeLog.js` | **新增** | hashPrompt / summarizePrompt / isPromptFullLoggingEnabled(T2) |
| `backend/src/utils/maskResult.js` | **新增** | maskRows + 7 种规则纯函数(T3a) |
| `backend/src/utils/sqlRewriter.js` | **新增** | injectTenantFilter + parseTenantMapEnv(T3b) |
| `backend/src/core/requestContext.js` | **新增** | extractContext + mergeIntoContext(T1) |
| `backend/src/core/sseHandler.js` | 修改 | handleQuery 签名 + 引擎选择器 + 自动回退 + handleConnection context 缓存 |
| `backend/src/core/routes.js` | 修改 | POST /sse/query 注入 context |
| `backend/src/core/llmService.js` | 修改 | 删 3 条 console.log,换 safeLog |
| `backend/src/core/nl2sqlEngine.js` | 修改 | processQuery 签名扩展 context;executeQuery 后置脱敏;RLS 前置改写;3 处审计写入扩参;schema/query 日志脱敏 |
| `backend/src/core/queryDecomposer.js` | 修改 | query 日志 summarizePrompt |
| `backend/src/core/toolLoop.js` | 修改 | query/args 日志 summarizePrompt;新增 sanitizeToolArgs |
| `backend/src/core/database.js` | 修改 | query_history schema 补 7 列 + ensureQueryHistoryColumns 幂等迁移 + 3 个 writer 扩参 + export |
| `backend/src/core/config.js` | 修改 | security.masking 扩展 + security.rls 新增 + 顶部 parseTenantMapEnv 引入 |
| `backend/config/feature-flags.js` | 修改 | 新增 AGENTIC_AUTO_FALLBACK / RESULT_MASKING / RLS_ENFORCEMENT / AUDIT_LOG_EXTENDED |
| `backend/.env.example` | 修改 | Phase 3 段完整说明(5 条 env) |
| `backend/package.json` | 修改 | +`node-sql-parser: ^5.3.3` |
| `backend/test/phase3/` | **新增** | 6 个 test-*.js,177 条用例 |

---

## 7. 风险汇总

| 轨道 | 风险 | 回滚手段 |
|------|------|----------|
| T1 引擎切换 | progress 事件 shape 不匹配 / agentic 未捕获异常 | `FF_AGENTIC_ENGINE=false` 回 legacy。再兜不住 → `FF_AGENTIC_AUTO_FALLBACK=false` 暴露原错误 |
| T2 日志安全 | 调试丢信息 | `LOG_PROMPT_FULL=true` 恢复全量 console.log |
| T3a 脱敏 | 列名误匹配(如 `token` 业务列被脱敏) | `FF_RESULT_MASKING=false`;或调 `config.security.masking.rules` 删除冲突 key |
| **T3b RLS** | **Parser 不覆盖所有 SR MySQL 方言 → 合法查询被 refused;map 配错** | `FF_RLS_ENFORCEMENT=false` 即时关闭;`RLS_TABLE_TENANT_MAP` 渐进加表;默认就是 opt-in |
| T3c 审计 | 迁移失败 / writer 参数误传 | `FF_AUDIT_LOG_EXTENDED=false` 停写;列保留不回滚 |
