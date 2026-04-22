# NL2SQL Phase 1 交接摘要

## 文档信息

- 版本：v1.0
- 日期：2026-04-22
- 范围：Phase 1（Week 1）核心闭环打通
- 对应计划：`docs/NL2SQL核心模块优化实施计划.md` 第 3 章 Phase 1
- 实施计划（含代码清单）：`C:\Users\hanhui\.claude\plans\f-learn-724-office-nl2sql-docs-nl2sql-md-rustling-kahn.md`

---

## 1. 核心接口与逻辑变更

### 1.1 `executeQuery`（真实 DB 执行层）

**位置**：`backend/src/core/nl2sqlEngine.js:2010-2094`
**契约**：`executeQuery(sql) → {success, data?, error?, errorCode?, executionTime, sql}`

| 分支 | 触发条件 | 返回结构 |
|------|---------|---------|
| DRY_RUN | `config.security.dryRun=true` | `success:true, data:{rows:[], dryRun:true}` |
| 未配置 | `SR_DATABASE_URL` 空或 `SR_DB_ENABLED=false` | `success:false, errorCode:'SR_DB_NOT_CONFIGURED'` |
| 池未就绪 | mysql2 缺失 / 握手失败 | `success:false, errorCode:'SR_DB_NOT_READY'` |
| 正常执行 | pool ready | `success:true, data:{columns, rows, rowCount, truncated}` |
| 执行异常 | MySQL 抛错 | `success:false, errorCode: err.code \|\| 'SR_EXEC_ERROR'` |

**新增模块**：`backend/src/core/srDatabase.js`
- mysql2/promise 连接池单例
- 每次取连接后 `SET SESSION TRANSACTION READ ONLY` + `MAX_EXECUTION_TIME`
- 行数限流 `config.srDatabase.maxRows`，超量截断并 `data.truncated=true`
- 懒加载 mysql2 模块（未安装时 `initialize()` 仅告警，不阻塞启动）

### 1.2 `query_history` 写入（三步式）

**新增 helper（`backend/src/core/database.js` 末尾）：**

```js
createQueryHistory({ sessionId, userId, naturalQuery }) → id | null
markQueryHistorySuccess(id, { generatedSql, executionTime, rowCount, result })
markQueryHistoryFailure(id, { generatedSql, executionTime, errorMessage })
```

**埋点（`nl2sqlEngine.processQuery`）：**

| 位置 | 动作 |
|------|------|
| 函数入口（try 之前） | `createQueryHistory` 获取 `historyId` |
| `executeQuery` 返回后 | 按 `queryResult.success` 调 `markQueryHistorySuccess` / `markQueryHistoryFailure` |
| 外层 `catch` | 兜底 `markQueryHistoryFailure`（覆盖 SQL 生成/验证等前置阶段异常） |

**影响**：`/api/queries/history` 与 `selfRepair.performDailyCheck` 从此获得真实数据源。`result` 字段仅存 `columns` + 前 20 行样本，避免 JSON 爆炸。

### 1.3 其他修正

| 修正点 | 文件 | 说明 |
|--------|------|------|
| `config.embedding.enabled` | `backend/src/core/config.js` | 新增字段，默认 `true`；原两处 `config.embedding && config.embedding.enabled` 分支从"恒为 falsy"变为可控 |
| 实体解析 DB 接口 | `backend/src/core/nl2sqlEngine.js:315、521` | 把不存在的 `database.getConnection()` 改为 `srDatabase.executeQuery()`；未就绪时返回 `{found:false, reason:'SR_DB_NOT_READY'}`，不再 throw |
| SSE 错误反馈 | `backend/src/core/sseHandler.js` + `routes.js` | 新增 `hasActiveConnection` / `pushError`；`handleQuery` 不再 throw；`POST /sse/query` 先校验连接存在（无连接返 409），后台异步 `.catch` 兜底推 error 事件 |
| summarizer 二次赋值 | `backend/src/memory/summarizer.js:151` | `const summary` → `let summary`，裁剪分支不再抛 `TypeError: Assignment to constant variable` |

### 1.4 启动 / 关闭流程

`backend/src/app.js`：

```js
// 启动步骤 4.7（featureFlags 之后）
await srDatabase.initialize();  // 失败仅告警不阻塞
logger.info('[Startup] SR.enabled=%s DRY_RUN=%s EMB.enabled=%s', ...);

// gracefulShutdown 新增
await srDatabase.shutdown();
```

### 1.5 新增依赖与配置

| 文件 | 改动 |
|------|------|
| `backend/package.json` | 新增 `mysql2: ^3.10.0`（需 `npm install`） |
| `backend/.env.example` | 新增 `SR_DB_ENABLED` / `SR_QUERY_TIMEOUT_MS` / `SR_MAX_ROWS` / `DRY_RUN` / `EMBEDDING_ENABLED` / `EMBEDDING_DIMENSION` |

### 1.6 回归测试

`backend/test/phase1/`：

| 脚本 | 覆盖任务 | 状态 |
|------|---------|------|
| `test-summarizer.js` | 任务 6 | ✅ 本地通过 |
| `test-executeQuery.js` | 任务 1 | ✅ 本地通过（真连接 case 需 `SR_DATABASE_URL_TEST`） |
| `test-query-history.js` | 任务 2 | ✅ 本地通过 |
| `test-embedding-flag.js` | 任务 3 | ✅ 本地通过 |
| `test-sse-error-feedback.js` | 任务 4 | ✅ 本地通过 |
| `test-entity-resolve.js` | 任务 5 | ✅ 本地通过 |

---

## 2. 遗留 TODO（Phase 2+）

| # | 位置 | 性质 | 建议阶段 | 说明 |
|---|------|------|---------|------|
| T1 | `nl2sqlEngine.js`（全局） | 固定截断未拆 | Phase 2 | 去掉 `slice(0,5)` / `top3` 硬截断，采用核心表保护 + 动态上限 |
| T2 | `srDatabase.executeQuery` | 只读兜底靠 SESSION | Phase 3 | 仅通过 `SET SESSION TRANSACTION READ ONLY` 约束。建议应用层再加一道 SELECT/WITH 首词白名单 |
| T3 | `srDatabase.js` | `maxRows` 应用层截断 | Phase 2 | 未在 SQL 注入 `LIMIT`，超量仍会从 MySQL 拉回再截断。建议 prompt 里让 LLM 默认带 LIMIT |
| T4 | `nl2sqlEngine.processQuery` 主入口 | agenticEngine 未接入 | Phase 3 | 与原计划一致，保留到 Phase 3 落地引擎切换 |
| T5 | `llmService.js` | 完整 Prompt 仍打到控制台 | Phase 3 | 安全收敛项，本阶段未处理 |
| T6 | `sseHandler.handleQuery` | 并发请求策略简化 | Phase 4 | `isProcessing=true` 时仅 `pushError`，无排队/拒绝策略 |
| T7 | `test/phase1/test-entity-resolve.js` | 依赖 `resolveEntity` 导出 | Phase 4 | 当前有 `typeof === 'function'` 兜底。Phase 4 拆出 `entityResolver` 后删除兜底分支 |
| T8 | `database.js` 的 `result` 截断 | 硬编码 100KB | Phase 4 | `.slice(0, 100000)` 超大结果会丢尾。建议走专门的结果存储或压缩 |

---

## 3. 偏离原计划的变更

| 变更项 | 原计划 | 实际做法 | 原因 |
|-------|-------|---------|------|
| **实体解析数据源** | 用 `database.query` 查 SQLite `user_preferences` | 用 `srDatabase.executeQuery` 查 MySQL `game_list` / `channel_list` | 读代码发现原函数查的是业务实体表（SR 库），不是用户偏好表。原计划写法会改变函数语义，修正为走 srDatabase。连带产生依赖 → **执行顺序调整为任务 1 → 任务 5** |
| **SSE `handleQuery` 错误处理** | routes.js 侧 `.catch` 兜底 + `handleQuery` 内分支保留 throw | `handleQuery` "无连接 / 正在处理 / 空 query" 三个分支全部改为 `logger.warn + pushError + return`，不再 throw | 兼顾 fire-and-forget 场景下的 unhandled rejection 风险；错误反馈一律走 SSE 事件更一致。路由侧 `.catch` 仍保留做最后兜底 |
| **日志格式 bug 修复** | 未提及 | `srDatabase.js` 三处 `logger.error/warn` 从 `msg + err.message` 改为 `msg, err`（Error 对象） | 首次启动时出现 `{"error":{}}` 吞掉真实错误。logger 第二参数期望 Error 对象，原先传字符串导致 `.message` / `.stack` 读不到。属于代码 bug 修复，非计划变更 |
| **跨库访问** | 默认单库 | 保持 URL 单库写法（`SR_DATABASE_URL=.../new_tzpingtai`），依赖 LLM 生成的 SQL 带 `<db>.<table>` 前缀实现跨库 | schema-metadata 已用 `new_tzpingtai.xxx` / `new_tzpingtaiold.xxx` 完整前缀（31875、34999 行等）。默认库写哪个都行。**前提**：MySQL 账号对两个库都有 `SELECT` 权限（运维侧保证） |
| **mysql2 版本** | 计划未锁定 | `^3.10.0` | 计划推荐未敲定，按当前稳定版锁定 |

---

## 4. 验收状态（对齐 Phase 1 验收标准）

| # | 验收标准 | 状态 | 备注 |
|---|---------|------|------|
| 1 | 真实 SQL 可执行，失败错误可返回明确原因 | ✅ | errorCode 枚举覆盖四类失败 |
| 2 | `/api/stats` 与 `selfRepair` 查询统计值与实际请求一致 | ✅ | query_history 主流程三步写入已接入 |
| 3 | Embedding 开关可控，日志可确认分支命中 | ✅ | `[Startup] ... EMB.enabled=...` 启动日志已输出 |
| 4 | SSE 提交后无"假成功"场景 | ✅ | 无连接 → 409；后台异常 → SSE error 事件 |
| 5 | 实体解析具备可复现测试（命中/歧义/未命中） | ⚠️ 部分 | 接口路径打通，但 hit/ambiguous 路径需真实 SR 连接才能端到端验证 |
| 6 | 长会话压缩无摘要模块异常 | ✅ | test-summarizer.js 裁剪分支通过 |

---

## 5. Phase 2 起手建议

1. **验证 MySQL 权限**：
   ```sql
   SELECT 1 FROM new_tzpingtai.tzpingtai_tz_sdk_log_pf_order LIMIT 1;
   SELECT 1 FROM new_tzpingtaiold.tzpingtaiold_tz_sdk_log_pf_order LIMIT 1;
   ```
   两条都能执行 → 跨库方案无需改造。

2. **`npm install`**：安装 mysql2，随后：
   ```bash
   SR_DATABASE_URL_TEST=mysql://user:pw@host:3306/new_tzpingtai \
     node backend/test/phase1/test-executeQuery.js
   ```
   做一次真连接冒烟。

3. **端到端回归**：
   - 正常查询 → SSE 收到 result，`query_history` 新增 `status=success` 行，`execution_time` / `row_count` 非空
   - 故意错误 SQL → SSE 收到 `type:error`，`query_history` 新增 `status=failed` 行，`error_message` 非空
   - 断开 SSE 后提交 → HTTP 409

4. **进入 Phase 2**：按原计划去掉 `slice(0,5)` 硬截断 + 统一表候选排序。

---

## 6. 关键文件索引

| 文件 | 角色 |
|------|------|
| `backend/src/core/srDatabase.js` | 新增：SR 业务库连接池 |
| `backend/src/core/nl2sqlEngine.js` | 修改：executeQuery / processQuery / resolveEntity |
| `backend/src/core/database.js` | 修改：query_history helper |
| `backend/src/core/sseHandler.js` | 修改：hasActiveConnection / pushError / handleQuery 不 throw |
| `backend/src/core/routes.js` | 修改：`POST /sse/query` 前置校验 + 后台 .catch |
| `backend/src/core/config.js` | 修改：embedding.enabled + srDatabase.{enabled,queryTimeoutMs,maxRows} |
| `backend/src/memory/summarizer.js` | 修改：const → let |
| `backend/src/app.js` | 修改：启动/关闭钩子 |
| `backend/package.json` | 修改：mysql2 依赖 |
| `backend/.env.example` | 修改：新增 6 个环境变量样例 |
| `backend/test/phase1/` | 新增：6 个回归脚本 + README |
