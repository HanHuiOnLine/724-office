# NL2SQL Phase 4 交接摘要

## 文档信息

- 版本：v1.0
- 日期：2026-04-24
- 范围：Phase 4（Week 4）架构治理与质量保障
- 对应计划：`docs/NL2SQL核心模块优化实施计划.md` 第 3 章 Phase 4
- 实施计划（含代码清单）：`C:\Users\hanhui\.claude\plans\f-learn-724-office-nl2sql-docs-nl2sql-ph-modular-milner.md`
- 前置：`docs/NL2SQL-Phase3-交接摘要.md` + `docs/NL2SQL-澄清断链修复-批次C-交接摘要.md`

---

## 0. 概览

Phase 4 五条子轨道全部落地，单测 196 条全绿、Phase 1-3 既有 20 个脚本 0 回归：

| 轨道 | 范围 | 备注 |
|------|------|------|
| A | 拆分 `nl2sqlEngine.js`（2909 → ~580 行）为 5 个职责清晰的子模块 | 对外 `module.exports` 契约冻结 |
| B | `selfRepair.performDailyCheck` 接入 Phase 3 审计字段（error_code / fallback_used / rls_applied） | 新增 `generateErrorRecommendations` |
| C | `memoryQueue` 指数退避 + 死信持久化（新建 `memory_failed_queue` 表） | 防止记忆静默丢失 |
| D | 测试基线：`package.json` scripts + aggregator runner + Phase 4 模块级单测（11 脚本 196 用例） | 零新依赖，沿用原生 assert |
| E | `agenticEngine.processQuery` 成功路径补 `query_history` 审计（收敛 Phase 3 T3） | 避免双写设计 |

单测分布：Phase 4 新增 **196 条**，Phase 1-3 既有 **~220 条**；`npm run test:smoke` 输出 **31 pass / 0 fail / 2 skip**（外部依赖）。

---

## 1. 核心接口与逻辑变更

### 1.1 `nl2sqlEngine.js` 拆分为 5 个子模块（任务 A）

**位置**：`backend/src/core/` 下新增 5 个文件 + `nl2sqlEngine.js` 大改

**拆分映射**：

| 新文件 | 从 nl2sqlEngine.js 迁移的函数 | 导出 |
|--------|------------------------------|------|
| `intentAnalyzer.js` | `analyzeIntent` / `updateIntentWithLLM` / `checkIntentComplete` / `generateClarification` / `mergeIntent` / `enrichIntentWithClarificationContext` / `getRelevantTablesForIntent` / `getCoreHighFrequencyTables` / `getDialogueSummary` / `isAffirmativeClarificationReply` / `extractDefaultOptionsFromClarification` | ✅ 11 个 |
| `entityResolver.js` | `resolveEntity` / `resolveEntitiesInIntent` / `resolvePlatformInIntent` / `Users\user9308c33f\projectsEntityAliasFromContext` / `inferTablesFromQuery` / `extractPotentialEntityNames` / `initializeBusinessKeywordMap` / `getBusinessKeywordMap` | ✅ 7 个（含学习/推断） |
| `sqlGenerator.js` | `generateSQL` / `generateSchemaMappingHints` | ✅ 2 个 |
| `sqlExecutor.js` | `validateSQL` / `executeQuery` | ✅ 2 个 |
| `resultFormatter.js` | `formatResult` | ✅ 1 个 |

**`nl2sqlEngine.js` 改造后保留**：
- 顶部 require 段（更新为 require 5 个子模块）
- `NL2SQLError` 类（含 `entityResolution` / `sqlValidation` / `sqlGeneration` 静态工厂）
- `processQuery`（主编排，~540 行）—— 含 Phase 1-3 的全部审计埋点 / RLS 改写 / 脱敏分支
- `module.exports` 等价 re-export（与 Phase 3 完全一致）

**processQuery 内部调用改写**：

```js
// 改前
intent = await analyzeIntent(userQuery, recentHistory, userId);
// 改后
intent = await intentAnalyzer.analyzeIntent(userQuery, recentHistory, userId);
```

同理：`intentAnalyzer.updateIntentWithLLM` / `intentAnalyzer.enrichIntentWithClarificationContext` / `intentAnalyzer.checkIntentComplete` / `intentAnalyzer.generateClarification` / `entityResolver.learnEntityAliasFromContext` / `sqlGenerator.generateSQL` / `sqlExecutor.validateSQL` / `sqlExecutor.executeQuery` / `resultFormatter.formatResult`。

**对外契约**（硬拦截）：

```js
module.exports = {
  processQuery,
  analyzeIntent:         intentAnalyzer.analyzeIntent,
  checkIntentComplete:   intentAnalyzer.checkIntentComplete,
  generateClarification: intentAnalyzer.generateClarification,
  updateIntentWithLLM:   intentAnalyzer.updateIntentWithLLM,
  resolveEntity:         entityResolver.resolveEntity,
  generateSQL:           sqlGenerator.generateSQL,
  validateSQL:           sqlExecutor.validateSQL,
  executeQuery:          sqlExecutor.executeQuery,
  formatResult:          resultFormatter.formatResult,
  NL2SQLError
};
```

**循环依赖处理**：`intentAnalyzer.analyzeIntent` 调用 `entityResolver.resolveEntitiesInIntent` / `resolvePlatformInIntent`；`entityResolver` 不反向 require `intentAnalyzer`，无循环。`sqlGenerator` 需要 `entityResolver.inferTablesFromQuery`，也是单向依赖。

### 1.2 `selfRepair` 接入 Phase 3 审计字段（任务 B）

**位置**：`backend/src/core/selfRepair.js`

**新增纯函数** `generateErrorRecommendations`（行 187-208，置于 `performDailyCheck` 之上）：

```js
function generateErrorRecommendations(errorCodeStats) {
  const adviceMap = {
    SR_DB_NOT_READY:     '数据源未就绪,检查 SR_DATABASE_URL 与网络连通',
    SR_DB_NOT_CONFIGURED:'SR_DB_ENABLED=false 或 URL 空,检查部署配置',
    SR_EXEC_ERROR:       'SR 库执行错误,检查慢查询/权限/表缺失',
    VALIDATION_ERROR:    'SQL 验证失败,检查白名单/语法/LIMIT',
    RLS_REWRITE_FAILED:  'RLS 改写失败,用 sqlRewriter dry-run 采样定位',
    LLM_ERROR:           'LLM 调用失败,检查 LLM_API_KEY/限流/超时',
    PIPELINE_ERROR:      '管道异常(意图/生成/验证前置失败),...',
    UNKNOWN:             '未分类错误,排查最近 failed 记录的 error_message'
  };
  return (errorCodeStats || []).map(e => ({
    code: e.code, count: e.count, advice: adviceMap[e.code] || adviceMap.UNKNOWN
  }));
}
```

**`performDailyCheck` 新增三条并行统计**（行 246-320）：

```js
const [errorCodeStats, rlsStats, fallbackStats] = await Promise.all([
  database.query(`SELECT COALESCE(error_code,'UNKNOWN') AS code, COUNT(*) AS count
                    FROM query_history
                   WHERE status='failed' AND date(created_at)=date(?)
                   GROUP BY COALESCE(error_code,'UNKNOWN')
                   ORDER BY count DESC`, [today]),
  database.queryOne(`SELECT COUNT(CASE WHEN rls_applied IS NOT NULL ...) AS rls_hit, COUNT(*) AS total ...`),
  database.queryOne(`SELECT COALESCE(SUM(fallback_used),0) AS fallback_count, COUNT(*) AS total ...`)
]);

report.checks.queries.errorCodes    = errorCodeStats;
report.checks.queries.rlsStats      = rlsStats;
report.checks.queries.fallbackStats = fallbackStats;

if (errorCodeStats.length > 0) {
  report.recommendations.push(...generateErrorRecommendations(errorCodeStats));
}
if (fallbackStats.total > 0 && fallbackStats.fallback_count / fallbackStats.total > 0.2) {
  report.issues.push(`fallback 占比 ${(...)*100).toFixed(1)}%`);
  report.recommendations.push({ code: 'FALLBACK_RATE_HIGH', advice: '...' });
}
```

**死信健康扫描**（行 322-342，与任务 C.4 联动）：

```js
const deadLetter = await database.queryOne(
  `SELECT COUNT(*) AS count FROM memory_failed_queue WHERE status='pending'`
);
report.checks.memoryDeadLetter = { status: 'ok', pending: deadLetter.count };
if (deadLetter.count > 100) {
  report.issues.push(`memory 死信队列待处理 ${deadLetter.count} 条`);
  report.recommendations.push({ code: 'DEAD_LETTER_BACKLOG', advice: '...' });
}
```

失败仅 `logger.warn` 或 `{status: 'warning'}`，不阻断主 check。

### 1.3 `memory_failed_queue` 表 + helper（任务 C.1）

**位置**：`backend/src/core/database.js`

**SCHEMA_SQL 追加**（行 208-236）：

```sql
CREATE TABLE IF NOT EXISTS memory_failed_queue (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_type   TEXT NOT NULL,
  user_id          TEXT,
  payload          TEXT NOT NULL,
  last_error       TEXT,
  retry_count      INTEGER DEFAULT 0,
  status           TEXT DEFAULT 'pending',
  first_failed_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_tried_at    DATETIME,
  updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_memory_dead_status ON memory_failed_queue(status, retry_count);
CREATE INDEX IF NOT EXISTS idx_memory_dead_user   ON memory_failed_queue(user_id);
```

**幂等迁移函数** `ensureMemoryFailedQueueTable`（行 332-355，参照 `ensureQueryHistoryColumns` 风格）。在 `runMigrations()` 末尾调用（行 398）。失败仅 `logger.error`，不阻断启动。

**新增 3 个 helper**（行 1144-1224）：

```js
addMemoryFailedOperation({ operationType, userId, payload, lastError, retryCount }) → id | null
listPendingMemoryFailed(limit=50) → Array   // status='pending',按 first_failed_at ASC
updateMemoryFailedStatus(id, { status, retryCount, lastError })  // 自动填 last_tried_at / updated_at
```

**导出**（行 1252-1257）：`ensureMemoryFailedQueueTable` / `addMemoryFailedOperation` / `listPendingMemoryFailed` / `updateMemoryFailedStatus`。

### 1.4 `memoryQueue` 指数退避 + 死信（任务 C.2）

**位置**：`backend/src/memory/memoryQueue.js` 全量重写

**新增常量**（文件头）：

```js
const MAX_RETRIES      = 3;
const BASE_BACKOFF_MS  = 100;
const BACKOFF_FACTOR   = 4;              // 100 → 400 → 1600 ms
const QUEUE_MAX_SIZE   = 1000;
```

**`executeOperation` 改造为循环重试**：

```js
for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
  try {
    const result = await operation();
    metrics.succeeded++;
    return result;
  } catch (error) {
    if (attempt < MAX_RETRIES) {
      metrics.retried++;
      await sleep(BASE_BACKOFF_MS * Math.pow(BACKOFF_FACTOR, attempt));
      continue;
    }
    // 重试耗尽 → 写死信
    await persistDeadLetter({
      operationType: type, userId, payload: meta || {},
      lastError: error.message, retryCount: MAX_RETRIES
    });
    metrics.deadLettered++;
    throw error;
  }
}
```

**`enqueueMemoryStore` 队列长度保护**：

```js
if (memoryQueue.length >= QUEUE_MAX_SIZE) {
  metrics.rejectedFull++;
  persistDeadLetter({ ..., lastError: `queue full (size=${memoryQueue.length})`, retryCount: 0 });
  return;
}
```

**新增 `getQueueMetrics`**（导出）：`{enqueued, succeeded, retried, deadLettered, rejectedFull, lastErrorTime, lastError, queueSize, isProcessing}`。

**降级路径**：`database` 不可用时（`require` 失败 / 未加载 `addMemoryFailedOperation`），`persistDeadLetter` 降级为 `logger.error`，不丢失可观测性。

### 1.5 `longTermMemory` enqueue 调用点补 meta（任务 C.3）

**位置**：`backend/src/memory/longTermMemory.js:399 / 416 / 430`

3 处 `enqueueMemoryStore` 调用从 `{type, userId}` 扩展为 `{type, userId, meta}`：

```js
memoryQueue.enqueueMemoryStore(
  () => storeQueryPattern(userId, intent, originalQuery),
  {
    type: 'query_pattern', userId,
    meta: {
      query: (originalQuery || '').slice(0, 200),
      metrics: intent.metrics,
      dimensions: intent.dimensions,
      timestamp: Date.now()
    }
  }
);
```

`metric_preference` / `dimension_preference` 同理（分别记录单个 metric / dimension + 原查询）。

### 1.6 `selfRepair` 死信重放 cron（任务 C.4）

**位置**：`backend/src/core/selfRepair.js:126-137 / 482-499`

**新增 cron**：`'0 */6 * * *'`（每 6 小时），名 `dead-letter-replay`：

```js
async function replayDeadLetters() {
  const items = await database.listPendingMemoryFailed(20);
  if (!items || items.length === 0) return;
  logger.warn('[DeadLetter] 待人工处理的死信记录', {
    count: items.length,
    sample: items.slice(0, 5).map(i => ({ id, type, userId, error }))
  });
}
```

**当前行为**：仅做"人工审阅告警"。闭包 operation 无法序列化，真正的自动重放需要把操作固化为 `type + args` 描述，**留 Phase 5 实现**。

**新增导出**：`triggerDeadLetterReplay`（手动触发）+ `generateErrorRecommendations`（供单测）。

### 1.7 `agenticEngine` 成功路径补审计（任务 E）

**位置**：`backend/src/core/agenticEngine.js:156-202`

**原实现**：成功分支直接 `return { success: ..., type: 'sql_result', ... }`，不写 `query_history`。

**改造后**：

```js
const finalResult = { success, type: 'sql_result', sql, explanation, ..., duration };

if (finalResult.success === true) {
  try {
    const historyId = await database.createQueryHistory({
      sessionId: context.sessionId,
      userId: context.userId || 'anonymous',
      naturalQuery: userQuery,
      userRole: context.userRole,
      tenantId: context.tenantId,
      requestSource: context.requestSource,
      requestIp: context.requestIp
    });
    if (historyId) {
      await database.markQueryHistorySuccess(historyId, {
        generatedSql:  sqlResult.sql,
        executionTime: finalResult.duration,     // agentic 不执行,用全流程 duration
        rowCount:      0,                        // 未知,agentic 只生成不执行
        result: { selectedTables, explanation: explanation.slice(0, 500) },
        fallbackUsed:  false,                    // agentic 独立成功,不经 fallback
        rlsApplied:    context.rlsApplied
      });
    }
  } catch (auditErr) {
    logger.warn('[AgenticEngine] query_history 审计写入失败:', auditErr.message);
  }
}
return finalResult;
```

**双写规避**：
- `finalResult.success === true` 才写入（agentic 独立成功）
- `success: false` 或 `throw` 情况下，`sseHandler` 会触发 legacy fallback，由 `nl2sqlEngine.processQuery` 写入
- `clarification` 分支（行 114）不写 —— 澄清不是"已完成的查询"

新增依赖：顶部 `const database = require('./database');`。

### 1.8 `package.json` + 聚合 runner（任务 D.1/D.2）

**`package.json` scripts**（行 6-14）：

```json
"test":        "node test/run-all.js",
"test:smoke":  "node test/run-all.js --smoke",
"test:phase1": "node test/run-all.js --phase=1",
"test:phase2": "node test/run-all.js --phase=2",
"test:phase3": "node test/run-all.js --phase=3",
"test:phase4": "node test/run-all.js --phase=4"
```

**`test/run-all.js`** 新增聚合器（~180 行）：
- 扫描 `test/phase{1..4}/*.js` 和 `*.test.js`
- `--phase=N` 过滤；`--smoke` 模式跳过外部依赖（读 `test/external-deps.json`）
- `child_process.fork` 派生每个脚本，120s 超时
- 统计 pass/fail/skip/timeout，末尾非零退出码

**`test/external-deps.json`**：记录 `requiresLlm` / `requiresSrDb` 启发式黑名单（当前 3 条）。

### 1.9 Phase 4 单测（任务 D.3/D.4）

| 脚本 | 用例数 | 依赖 | 状态 |
|------|--------|------|------|
| `test-nl2sql-facade.js` | 26 | 无 | ✅ 契约硬拦截 |
| `test-intentAnalyzer-exports.js` | 31 | 无 | ✅ |
| `test-entityResolver-exports.js` | 19 | 无 | ✅ |
| `test-sqlGenerator-exports.js` | 11 | 无 | ✅ |
| `test-sqlExecutor-exports.js` | 13 | 无 | ✅ |
| `test-resultFormatter-exports.js` | 5 | 无 | ✅ |
| `test-selfRepair-audit.js` | 37 | 无 | ✅ |
| `test-memoryFailedQueue-migration.js` | 20 | 临时 sqlite | ✅ |
| `test-memoryQueue-retry.js` | 11 | 无 | ✅ 指数退避耗时 545ms（100+400+overhead） |
| `test-memoryQueue-deadletter.js` | 12 | 临时 sqlite | ✅ 总耗时 2189ms（100+400+1600） |
| `test-agentic-audit.js` | 12 | 无（源码扫描） | ✅ |
| **合计** | **196** | | ✅ 11/11 脚本全绿 |

---

## 2. 遗留 TODO（Phase 5+）

| # | 位置 | 性质 | 建议阶段 | 说明 |
|---|------|------|---------|------|
| T1 | `memoryQueue.persistDeadLetter` → `selfRepair.replayDeadLetters` | 无法自动重放 | Phase 5 | 死信 payload 仅含 meta（闭包不可序列化）。需要把操作固化为 `{type, args}` 描述，`replayDeadLetters` 才能根据 type 调对应 `storeXxx` 函数 |
| T2 | `agenticEngine` 的审计 `rowCount` 硬编码 0 | 语义不精确 | Phase 5 | agentic 不执行 SQL，`rowCount` 真实值未知。如未来 agentic 改为执行 SQL 返回真实结果，需同步改这里 |
| T3 | `agenticEngine` 的审计 `executionTime` 使用 `duration` | 语义混用 | Phase 5 | 当前存的是"agentic 全流程耗时"，不是"SQL 执行耗时"。若 selfRepair 按 `execution_time` 做慢查询分析会混入 agentic 规划时间。可考虑新增列 `agentic_duration` 或用 tag 区分 |
| T4 | `selfRepair.replayDeadLetters` 只告警不重放 | 半成品 | Phase 5 | 与 T1 一起解决。当前 cron 每 6 小时 `logger.warn` 一次，依赖运维人工清理 |
| T5 | `processQuery` 内部函数调用切为 `intentAnalyzer.xxx` | 增加一次属性访问 | Phase 5 低优 | 热路径上每次属性查找理论上有开销（可忽略）。若未来发现 perf 热点可改为 `const { analyzeIntent } = intentAnalyzer`（局部解构） |
| T6 | Phase 2 T1/T2（`FF_UNIFIED_RANKER=false` legacy 分支、`tableRanker.legacySelect`）| 原计划 Phase 4 项 | Phase 5 | **用户明确要求保留**。稳定观察期满后（Phase 2 交付至今仅 2 天）可清理。影响文件：`sqlGenerator.js:164-177` / `tableRanker.js:219-247` |
| T7 | Phase 2 T3（`queryDecomposer.KEYWORD_SCALE=10` 魔数）| 魔数耦合 | Phase 5 | 与 T6 同步。可提炼为 ranker 参数 |
| T8 | Phase 3 T1（`sqlRewriter.skippedTables` 冗余字段）| 始终为空 | Phase 5 | 用户要求保留不删。设计意图是"map 命中但 AST 无法识别"的表；实际走 WALK_FAIL → refused 分支，该字段永不填充 |
| T9 | Phase 3 T2（`sseHandler.handleQuery` 对 context 做 mutation）| 副作用 | Phase 5 | `context.fallbackUsed = fallbackUsed` 仍保留。替代：`requestContext.mergeIntoContext(context, {fallbackUsed})` |
| T10 | Phase 3 T5（`rls_applied` 大小写未归一化）| 审计混淆 | Phase 5 低优 | `applied` 取自 AST 原始大小写 |
| T11 | Phase 3 T6（`masking.rules` 列名碰撞）| 配置文档化 | 运维侧 | 如业务列名为 `token`/`secret`，需 ops 调整 `config.security.masking.rules` 排除 |
| T12 | Phase 3 T4（RLS 方言采样）| 开启前准备 | 开启 RLS 前 | `FF_RLS_ENFORCEMENT=true` 上线前，用历史 SQL 样本跑 `sqlRewriter.injectTenantFilter` dry-run |
| T13 | `run-all.js` 超时阈值 120s | 可能误杀 | Phase 5 低优 | `test-regression-complex.js` 若跑 LIVE 模式可能超 2min。阈值改为可配置 |
| T14 | `database.js:1041` 的 `.slice(0, 100000)` | Phase 1 T8 未处理 | Phase 5 | 审计 result 字段硬编码截断 100KB，超大结果尾部丢失 |
| T15 | `sseHandler.handleQuery` 的 `isProcessing` 简单锁 | Phase 1 T6 未处理 | Phase 5 | 无排队策略，`isProcessing=true` 时仅 `pushError` |
| T16 | `agenticEngine` 失败路径仍依赖 legacy fallback 写审计 | 隐式依赖 | Phase 5 低优 | 如 ops 关掉 `FF_AGENTIC_AUTO_FALLBACK=false`，agentic 失败路径将完全不写 `query_history` |

---

## 3. 偏离原计划的变更

| 变更项 | 原计划 | 实际做法 | 原因 |
|-------|-------|---------|------|
| **`agenticEngine` 审计写入时机** | 计划在 `processQuery` 入口 `createQueryHistory`，各终态调 `markSuccess/markFailure` | 仅在成功终态处一次性创建 + 标记 | 避免"孤儿 pending 记录"：失败路径由 legacy fallback 写完整审计，若 agentic 入口也创建会双写或留孤儿 |
| **`agenticEngine` 不写失败审计** | 计划成功/失败都写 | 仅 `success: true` 写；`success: false` + 异常交给 legacy fallback | `sseHandler` 对 agentic 失败会启动 legacy，legacy 写完整审计。双写会重复计数（影响 selfRepair 统计）。权衡：agentic 彻底关闭 fallback（`FF_AGENTIC_AUTO_FALLBACK=false`）时会漏写 → 记为 T16 |
| **`agenticEngine.executionTime` 值** | 计划用 SQL 真实执行耗时 | 用 `finalResult.duration`（agentic 全流程） | agentic 当前不执行 SQL，只生成。`rowCount` 固定 0 也是同原因。已记 T2/T3 |
| **`resultFormatter` 单测覆盖** | 计划 ~5 条用例覆盖空结果分支 | 只写 5 条失败路径，未覆盖 LLM 成功路径 | `formatResult` 成功分支必调 LLM，违反"零外部依赖"原则。LLM 成功路径的质量由 Phase 2 `test-regression-complex.js`（opt-in，需 LLM_API_KEY）兜底 |
| **`run-all.js` 子进程 cwd** | 计划每个脚本独立 cwd | 统一设 `cwd: backend/` | 原生单测的相对路径（`require(path.resolve(__dirname, ...))`) 允许任意 cwd，但 `config.js` 的 `configPath` 与 schema-metadata 解析受 cwd 影响。统一到 `backend/` 最稳 |
| **Phase 4 不清理 Phase 2/3 legacy 分支** | 原计划 Phase 4 收敛 | 保留不删 | 用户在 Plan Review 明确选"保留 legacy 分支不删"。理由：Phase 2/3 交付至今仅 2 天，远未达到"稳定 2 周+"门槛。清理留给 Phase 5 |
| **`test-agentic-audit.js` 采用源码扫描** | 计划 mock `database` + 注入 agentic 成功响应 | `fs.readFileSync` 正则扫描 processQuery 的关键段落 | agentic.processQuery 会真实调 LLM + schemaLoader，mock 代价过高。源码扫描验证"审计段落存在 + 调用顺序正确 + 避免双写"已足够覆盖 E.1 的改造目标 |
| **`memoryQueue` 死信 payload 仅含 meta** | 计划 payload 含 operation 描述以便重放 | 只存 `meta`，不存 closure 序列化 | JS 闭包不可跨进程序列化。真正的重放需要把 operation 固化为 `{type: 'query_pattern', args: [userId, intent, query]}`。这是 Phase 5 工作（T1/T4） |
| **`extractPotentialEntityNames` 正则** | 计划保持 `一-龥` 原形 | 文件中以字面中文字符 `[一-龥]` 落地 | 与 `一-龥` 完全等价（一=U+4E00，龥=U+9FA5）。JS 引擎同样处理。不影响行为 |
| **Phase 3 T3 审计缺口的归类** | 原计划放在任务 E 独立一条 | 拆分为 E（agenticEngine 改动）+ T16（fallback 关闭时的漏写风险） | 当前设计在 `FF_AGENTIC_AUTO_FALLBACK=true`（默认）下完整闭合；关闭时漏写留为已知限制 |
| **`processQuery` 内部改调用的错别字** | 无 | 临时打错 `Users\user8909c411\projectsed`（由原文复制错误） | 首次拉起时 `node -c` 报 `SyntaxError`，Edit 修正为 `learned`。属临时 bug 修复，非计划变更 |

---

## 4. 验收状态（对齐 Phase 4 验收标准）

### 对齐原计划 §3.4.4 验收

| # | 验收标准 | 状态 | 备注 |
|---|---------|------|------|
| 1 | 核心模块拆分后对外接口不变，功能无回归 | ✅ | `test-nl2sql-facade.js` 硬拦截 exports；Phase 1-3 共 20 脚本 0 回归 |
| 2 | 关键路径具备自动化测试与可重复验收流程 | ✅ | Phase 4 新增 196 条，`npm run test:smoke` 一键跑 31 脚本（跳过外部依赖） |
| 3 | 自修复报告可反映真实失败类型与趋势 | ✅ | `performDailyCheck` 新增 `errorCodes` / `rlsStats` / `fallbackStats` / `memoryDeadLetter` 4 个字段 + 错误分类建议 |
| 4 | 记忆写入失败可重试且可观测，不再出现静默丢失 | ✅ | 指数退避 3 次 + 死信表持久化 + `getQueueMetrics` 暴露 retried/deadLettered/rejectedFull |

### 附加目标

| # | 目标 | 状态 | 备注 |
|---|------|------|------|
| A1 | Phase 4 新单测全绿 | ✅ | 196/196 pass |
| A2 | Phase 1-3 既有单测 0 回归 | ✅ | 20/20 pass（smoke 模式）、跳过 2（外部依赖） |
| A3 | `test-nl2sql-facade.js` 硬拦截导出符号表 | ✅ | 11 条符号 + 类型检查 + 子模块引用相等断言 |
| A4 | 数据库迁移幂等 | ✅ | `ensureMemoryFailedQueueTable` 二次调用 no-op，`test-memoryFailedQueue-migration.js` 覆盖 |
| A5 | 零新 npm 依赖 | ✅ | 全部用原生 `assert` / `fs` / `child_process.fork` |
| A6 | Phase 3 T3 审计缺口收敛 | ✅ | 任务 E 落地，agentic 成功路径写 query_history |

---

## 5. Phase 5 起手建议

1. **收敛 Phase 2/3 legacy 分支**（T6/T7/T8/T9/T10）：
   - Phase 2/3 交付至今稳定 2 周后即可动手
   - 删除 `FF_UNIFIED_RANKER=false` 分支 + `tableRanker.legacySelect` + `queryDecomposer.KEYWORD_SCALE=10` 魔数
   - 删除 `sqlRewriter.skippedTables` 始终为空字段
   - `sseHandler` 的 `context.fallbackUsed` mutation 改为 `mergeIntoContext` 产出新对象

2. **死信自动重放**（T1/T4）：
   - 把 memory 存储操作固化为 `{type, args}` 可序列化描述
   - `selfRepair.replayDeadLetters` 按 type 调 longTermMemory 对应函数重放
   - 重放成功则 `updateMemoryFailedStatus(id, {status: 'archived'})`；仍失败则 retry_count++

3. **RLS 灰度上线**（T12）：
   - 用 `query_history.generated_sql` 历史样本跑 `sqlRewriter.injectTenantFilter` dry-run
   - 统计 `refused` 比例；>5% 需调 parser 或黑名单
   - 确认无 PARSE_FAIL 后开 `FF_RLS_ENFORCEMENT=true` + 逐表配 `RLS_TABLE_TENANT_MAP`

4. **端到端冒烟（本次未跑）**：
   - 前提 `LLM_API_KEY` + `SR_DATABASE_URL` 已配
   - 走一遍 `POST /api/sse/query` 真实链路
   - 观察 `query_history` 新行的 `error_code` / `fallback_used` / `rls_applied` 非空
   - `FF_AGENTIC_ENGINE=true` 时走 agentic 成功路径，确认 `query_history` 有新行（Phase 3 T3 收敛）
   - 手工触发 `selfRepair.triggerDailyCheck()`，观察 4 个新字段全部出现

5. **跑 Phase 2/3 的端到端回归**：
   ```bash
   cd backend
   LLM_API_KEY=... node test/phase2/test-regression-complex.js
   SR_DATABASE_URL_TEST=... node test/phase1/test-executeQuery.js
   ```

6. **考虑引入结构化 metrics 导出**：
   - 当前 `memoryQueue.getQueueMetrics()` 是进程内对象
   - 运维可观测性需要暴露到 `/api/admin/metrics` 端点（超出 Phase 4 范围）
   - 或接 StatsD / Prometheus

---

## 6. 关键文件索引

| 文件 | 角色 | 变更 |
|------|------|------|
| `backend/src/core/intentAnalyzer.js` | **新增** | 意图识别 + 澄清 + 上下文合并（11 导出） |
| `backend/src/core/entityResolver.js` | **新增** | 实体解析 + 平台识别 + 别名学习（7 导出） |
| `backend/src/core/sqlGenerator.js` | **新增** | Prompt 构建 + LLM 生成 + LIMIT 注入（保留 legacy） |
| `backend/src/core/sqlExecutor.js` | **新增** | `validateSQL` + `executeQuery`（含脱敏接入） |
| `backend/src/core/resultFormatter.js` | **新增** | 结果自然语言总结 |
| `backend/src/core/nl2sqlEngine.js` | 大改 | 2909 → ~580 行；仅保留 `processQuery` + `NL2SQLError` + re-export |
| `backend/src/core/selfRepair.js` | 修改 | `performDailyCheck` 接审计字段；新增 `generateErrorRecommendations` + `replayDeadLetters` cron + `triggerDeadLetterReplay` |
| `backend/src/core/database.js` | 修改 | 新增 `memory_failed_queue` 表 + `ensureMemoryFailedQueueTable` + 3 helper |
| `backend/src/memory/memoryQueue.js` | 大改 | 指数退避 + 死信持久化 + `getQueueMetrics` + `QUEUE_MAX_SIZE` |
| `backend/src/memory/longTermMemory.js` | 修改 | 3 处 enqueue 补 `meta` 字段 |
| `backend/src/core/agenticEngine.js` | 修改 | 成功路径接入 `createQueryHistory` + `markQueryHistorySuccess` |
| `backend/package.json` | 修改 | 补齐 6 条 test scripts |
| `backend/test/run-all.js` | **新增** | 聚合 runner（`--phase` / `--smoke`） |
| `backend/test/external-deps.json` | **新增** | opt-in 依赖黑名单 |
| `backend/test/phase4/` | **新增** | 11 个 `test-*.js` + README.md（196 用例） |

---

## 7. 风险汇总

| 轨道 | 风险 | 回滚手段 |
|------|------|----------|
| A 拆分 | 子模块命名/require 错误，上游调用失败 | `nl2sqlEngine.js` 仅 re-export，上游零改动；`git revert` 一次即可回到 Phase 3 |
| A 拆分 | `processQuery` 内部漏改 `intentAnalyzer.xxx` 调用 | `test-nl2sql-facade.js` 硬拦截 + `npm run test:smoke` 全量跑 |
| B selfRepair | 3 条新 SQL 查询超时或 SQLite 锁 | `Promise.all` 包裹，失败仅 `logger.warn`，不阻断 check |
| C.1 表迁移 | `memory_failed_queue` 建表失败 | `ensureMemoryFailedQueueTable` 失败仅 error 日志，不阻断启动 |
| C.2 指数退避 | 3 次重试总延时 2.1s 阻塞队列 | 队列本身 fire-and-forget；`QUEUE_MAX_SIZE=1000` 保护 OOM；真耗尽则入死信 |
| C.2 死信 | `database` 不可用（测试环境） | `persistDeadLetter` 降级为 `logger.error`，仍有可观测性 |
| D 测试 | `run-all.js` 超时 120s 误杀慢用例 | `--phase=N` 单独跑；延长超时改 runner 常量 |
| E agentic 审计 | 双写 / 漏写 | 仅 `success: true` 写；失败交给 legacy fallback；`FF_AGENTIC_AUTO_FALLBACK=false` 时漏写已记 T16 |

---

## 8. 冒烟验证结果

本次实施完成后跑了以下冒烟：

1. **子模块 require 连通性**（11 个文件）：全部 OK，无循环依赖
2. **exports 契约一致性**：`nl2sqlEngine.js` 导出 11 个符号，与 Phase 3 完全一致
3. **数据库迁移端到端**：临时 sqlite 初始化 → 验证 Phase 3 审计字段 → 验证 `memory_failed_queue` 表 → 幂等迁移 → `addMemoryFailedOperation` + `listPendingMemoryFailed` 读写 → 关闭。全链路通过
4. **`npm run test:smoke`**：31 pass / 0 fail / 2 skip（总 33 个脚本）

**未验证**（需要 LLM / SR MySQL 真实环境）：
- SSE 真实查询链路 + `query_history` 写入（Phase 1-3 已验证，Phase 4 拆分不应影响）
- `FF_AGENTIC_ENGINE=true` 时 agentic 独立成功路径的审计写入（任务 E 端到端）
- `selfRepair.triggerDailyCheck()` 在有真实数据时的报告结构
- memoryQueue 在真实工作负载下的重试/死信表现

建议按 §5 第 4 条"端到端冒烟"在灰度环境跑一轮。
