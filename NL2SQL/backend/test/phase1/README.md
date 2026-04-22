# Phase 1 最小回归测试

对应 `docs/NL2SQL核心模块优化实施计划.md` 中 Phase 1 六项任务。

| 脚本 | 对应任务 | 断言 |
|------|---------|------|
| `test-summarizer.js` | 任务 6：summarizer const→let | 超长摘要进入裁剪分支不抛 TypeError |
| `test-executeQuery.js` | 任务 1：真实 DB 执行层 | DRY_RUN 兜底生效；未配置时 srDatabase 不 ready；配置 `SR_DATABASE_URL_TEST` 后 `SELECT 1` 通过 |
| `test-query-history.js` | 任务 2：query_history 写入 | createQueryHistory / markQueryHistorySuccess / markQueryHistoryFailure 三步路径字段齐全 |
| `test-embedding-flag.js` | 任务 3：Embedding 开关 | `EMBEDDING_ENABLED=false` 时 config.embedding.enabled 为 false，维度可被覆盖 |
| `test-sse-error-feedback.js` | 任务 4：SSE 异步错误链路 | 无连接时 hasActiveConnection=false，pushError 静默，handleQuery 返回 null 不 throw |
| `test-entity-resolve.js` | 任务 5：实体解析 DB 接口 | srDatabase 未就绪时 resolveEntity 返回 `{found:false, reason:'SR_DB_NOT_READY'}` |

## 运行

依次（或并行）执行：

```bash
cd backend
node test/phase1/test-summarizer.js
node test/phase1/test-executeQuery.js
node test/phase1/test-query-history.js
node test/phase1/test-embedding-flag.js
node test/phase1/test-sse-error-feedback.js
node test/phase1/test-entity-resolve.js
```

每个脚本独立进程，以 exit code 0/1 表达结果。

## 可选环境变量

- `SR_DATABASE_URL_TEST`：设置后 `test-executeQuery.js` 会尝试真实连接执行 `SELECT 1`。
- `DB_PATH_TEST`：指定 SQLite 测试库路径，默认 `backend/data/sessions.test.db`，避免污染正式数据。
