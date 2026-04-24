# NL2SQL Phase 4 回归测试

本目录包含 Phase 4（架构治理与质量保障）相关的模块级单测。

## 运行方式

```bash
# 只跑 Phase 4
npm run test:phase4

# Phase 1-4 全量（跳过需外部依赖的脚本）
npm run test:smoke

# Phase 1-4 全量（含外部依赖，需提前设置 LLM_API_KEY / SR_DATABASE_URL_TEST）
npm test

# 单跑一个脚本
node test/phase4/test-nl2sql-facade.js
```

## 覆盖矩阵

| 脚本 | 覆盖任务 | 外部依赖 |
|------|---------|---------|
| `test-nl2sql-facade.js` | A.6 `nl2sqlEngine.js` exports 契约硬拦截（与 Phase 3 一致） | 无 |
| `test-intentAnalyzer-exports.js` | A.1 `intentAnalyzer` 导出 + `checkIntentComplete` / `isAffirmativeClarificationReply` / `getDialogueSummary` / `extractDefaultOptionsFromClarification` 纯逻辑 | 无 |
| `test-entityResolver-exports.js` | A.2 `entityResolver` 导出 + `inferTablesFromQuery` / `extractPotentialEntityNames` / `resolveEntity`（SR 未就绪降级） | 无 |
| `test-sqlGenerator-exports.js` | A.3 `sqlGenerator` 导出 + `generateSchemaMappingHints` 多表组合 | 无 |
| `test-sqlExecutor-exports.js` | A.4 `validateSQL` 全分支（SELECT/WITH/UPDATE/DELETE/无 LIMIT/注释/空行）+ `executeQuery` 错误码枚举 | 无 |
| `test-resultFormatter-exports.js` | A.5 `formatResult` 失败路径（不调 LLM） | 无 |
| `test-selfRepair-audit.js` | B `generateErrorRecommendations` 8 个 error_code 映射 + fallback advice | 无 |
| `test-memoryFailedQueue-migration.js` | C.1 `memory_failed_queue` 幂等迁移 + 3 个 helper（add/list/update） | 临时 sqlite |
| `test-memoryQueue-retry.js` | C.2 指数退避重试（前 2 次失败第 3 次成功、一次成功两种形态） | 无 |
| `test-memoryQueue-deadletter.js` | C.2 重试耗尽后写入死信表；`deadLettered` 计数；死信记录字段正确 | 临时 sqlite |
| `test-agentic-audit.js` | E 源码扫描：`agenticEngine.processQuery` 成功路径接入 `createQueryHistory` + `markQueryHistorySuccess`，避免双写 | 无 |

## 外部依赖

- **临时 sqlite**：`test-memoryFailedQueue-migration.js` / `test-memoryQueue-deadletter.js` 通过 `DB_PATH` 环境变量指向 `os.tmpdir()`/`nl2sql-phase4-*.db`，测试末尾自动清理。在 CI 中无需额外配置。
- **无 LLM 依赖**：全部 Phase 4 用例不调 LLM。
- **无 SR DB 依赖**：全部用例在 SR DB 未就绪时走降级分支。

## 验收门槛

- Phase 4 所有用例 100% pass
- Phase 1-3 既有用例 0 回归（`npm run test:smoke` 应显示 20 pass + 2 skip + 0 fail）

## 回滚指南

每个拆分后的新文件都可独立 `git revert`。`nl2sqlEngine.js` 的 exports 契约由 `test-nl2sql-facade.js` 保护，任何漏掉的 re-export 都会在此用例失败。
