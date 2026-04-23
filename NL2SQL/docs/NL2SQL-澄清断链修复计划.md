# NL2SQL 澄清断链 & SQL 跑偏修复 - 总览

## 文档信息

- 版本：v1.1（拆分版，取代原单文件）
- 日期：2026-04-23
- 背景案例：用户提"问鼎天下-战场等级数据"复杂需求（typeid=1743、int_key1、int_key5、2026-03-28~04-12、游戏ID=30），经两轮澄清后最终 SQL 完全跑偏：
  ```sql
  SELECT create_time, tz_account_id, channel_id, game_id
  FROM tzpingtai_tz_sdk_log_pf_action
  WHERE create_time >= '2024-01-01 00:00:00'
    AND create_time <= '2024-12-31 23:59:59'
  ORDER BY create_time DESC LIMIT 1000;
  ```
  typeid / int_key1 / int_key5 / 游戏ID 全丢失，时间区间还错成 2024。
- 开关基线：`FF_AGENTIC_ENGINE=true`、`FF_CLARIFICATION_ENGINE=true`

---

## 1. 根因速览（定位证据）

| 编号 | 根因 | 关键代码位置 |
|------|------|--------------|
| **R1** | 澄清流程无断点续跑，第二轮 query 完全脱离原需求 | `agenticEngine.js:111-121` 澄清直接 return 不落库；`sseHandler.js:386-393` 落库丢 decomposition；`ChatView.vue:318-323` 选项当新 query；`agenticEngine.js:629` `applyClarification` **无任何调用者** |
| **R2** | SQL 生成 Prompt 未注入当前日期 → LLM 默认 2024 | `agenticEngine.js:390-413` `buildSQLPrompt` 仅拼 originalQuery + dataUnits + schemaDetail |
| **R3** | Phase 1 Schema 发现入参过窄，丢高信号 token | `agenticEngine.js:237-238` `searchQuery = entities.join(' ')`，丢 typeid / int_key* |
| **R4** | `buildSQLPrompt` 未传 `context.history` | 多轮对话中前一条交代的字段筛选，生成环节看不见 |
| **R5** | `applyClarificationResult` 分支贫弱 | `clarificationEngine.js:398-414` 未覆盖 `uncovered_data_unit` 场景 |

---

## 2. 修复目标

| 目标 | 衡量指标 |
|------|----------|
| **G1** | 澄清后第二轮 query 必须带全第一轮 `originalQuery + decomposition`（案例 SQL 含 `typeid=1743` + `int_key5`） |
| **G2** | SQL Prompt 默认注入"当前日期 + 对话历史"（时间区间复跑命中 `2026-03-28 ~ 2026-04-12`） |
| **G3** | Phase 1 Schema 检索入参包含原始 query 物理 token（typeid / int_key*） |
| **G4** | `applyClarificationResult` 覆盖 `uncovered_data_unit` 场景 |

---

## 3. 分批实施索引

每批独立文档，实施时只加载对应批次即可：

| 批次 | 文档 | 预估工时 | 覆盖根因 |
|------|------|----------|----------|
| **A** 止血：Prompt 日期 + history 注入 | [NL2SQL-澄清断链修复-批次A-Prompt注入.md](./NL2SQL-澄清断链修复-批次A-Prompt注入.md) | 0.5 天 | R2、R4 |
| **B** 澄清断链修复（主战场） | [NL2SQL-澄清断链修复-批次B-澄清链路重建.md](./NL2SQL-澄清断链修复-批次B-澄清链路重建.md) | 1-1.5 天 | R1、R5 |
| **C** 兜底与健壮性 | [NL2SQL-澄清断链修复-批次C-兜底与健壮性.md](./NL2SQL-澄清断链修复-批次C-兜底与健壮性.md) | 0.5 天 | R3 + R1 兜底 |

建议执行顺序：A → B → C。A 独立可发布；B 依赖 A 的 Prompt 注入；C 依赖 B 的 clarify-answer 链路。

---

## 4. 代码清单总表（跨批次索引）

用于评审变更面/人员分工，详细说明见各批次文档。

### 4.1 后端

| # | 文件 | 批次 | 改动类型 |
|---|------|------|----------|
| 1 | `backend/src/core/agenticEngine.js` | A + C | 修改（buildSQLPrompt / schemaDiscoveryPhase / planningPhase） |
| 2 | `backend/src/core/agenticEngine.js` | B | 新增 `resumeFromClarification` |
| 3 | `backend/src/core/sseHandler.js` | B | 修改 `persistAgenticMessages`（落 decomposition） |
| 4 | `backend/src/core/sseHandler.js` | B | 新增 `handleClarifyAnswer` |
| 5 | `backend/src/core/sseHandler.js` | C | `handleQuery` 兜底（老前端） |
| 6 | `backend/src/core/routes.js` | B | 新增 `POST /api/sse/clarify-answer` |
| 7 | `backend/src/core/clarificationEngine.js` | B | 新增 `applyUncoveredDataUnit` |
| 8 | `backend/src/core/database.js` | B | `getMessage(id)` / `addMessage` 返回 id |
| 9 | `backend/src/utils/tokenBudget.js` | A | 复用 `trimHistory` |

### 4.2 前端

| # | 文件 | 批次 | 改动类型 |
|---|------|------|----------|
| 10 | `frontend/src/views/ChatView.vue` | B | 修改 `answerClarification` |
| 11 | `frontend/src/stores/session.js` | B | 新增 `sendClarifyAnswer` |
| 12 | `frontend/src/stores/session.js` | B | 修改 `handleSSEMessage`（写 message_id） |
| 13 | `frontend/src/utils/api.js` | B | 新增 API 包装 |

### 4.3 测试

| # | 文件 | 批次 |
|---|------|------|
| 14 | `backend/test/phase3/clarification-resume.test.js` | B |
| 15 | `backend/test/phase3/sql-prompt-date.test.js` | A |
| 16 | `backend/test/phase3/clarification-apply.test.js` | B |
| 17 | `backend/test/phase3/schema-discovery-searchquery.test.js` | C |
| 18 | `backend/test/phase3/sse-clarify-answer-route.test.js` | B |

### 4.4 文档

| # | 文件 | 批次 |
|---|------|------|
| 19 | `docs/NL2SQL-Phase3-交接摘要.md` | B |
| 20 | `CLAUDE.md` | B |

---

## 5. 跨批次共用约定

### 5.1 回滚总开关

- `PROMPT_INJECT_NOW=true`（默认 true）：批次 A 的 Prompt 注入，线上可关
- `SCHEMA_SEARCH_INCLUDE_RAW=true`（默认 true）：批次 C 的 Schema 检索扩展
- `/sse/clarify-answer` 端点可直接移除路由回滚；老前端通过批次 C 的 `handleQuery` 兜底自动降级

### 5.2 日志脱敏

所有新增落库字段（`decomposition.originalQuery` 等）走 `safeLog.summarizePrompt` 打印原文，遵守 Phase 3 T2 约束。

### 5.3 测试基线

Phase 3 已有单测 177 条全绿。本修复新增 5 条（#14-#18），合入前跑全量回归，不得 red。

---

## 6. 风险摘要

1. **Prompt 变长**：A 注入 history 最近 3 轮 + clarificationHistory ≤5 条；超长由 `tokenBudget` 兜底截断。
2. **metadata 膨胀**：B 落库 `tableCandidates` 只保留 `slice(0,8)` + `{name, score}`。
3. **老会话兼容**：B 的 `handleClarifyAnswer` 取不到父消息 metadata 时降级调用 `handleQuery`，不 throw。
4. **前后端解耦升级**：C 的 `handleQuery` 兜底允许前端不升级，后端先行发布。

---

## 7. 附录：原始定位证据（共用）

| 问题点 | 位置 | 现状片段 |
|--------|------|----------|
| 澄清直接 return 无落库 | `backend/src/core/agenticEngine.js:111-121` | `return { success:true, type:'clarification', clarification, decomposition, tableCandidates, ... }` |
| SQL Prompt 无日期 / 历史 | `backend/src/core/agenticEngine.js:390-413` | `buildSQLPrompt(decomposition, schemaDetail)` |
| Schema 发现入参过窄 | `backend/src/core/agenticEngine.js:237-238` | `const searchQuery = entities.join(' ');` |
| `applyClarification` 无调用者 | `backend/src/core/agenticEngine.js:629-631` | grep 全库仅命中定义 + export |
| 澄清回答走错端点 | `frontend/src/views/ChatView.vue:318-323` | `sessionStore.sendQuery(option)` |
| 持久化丢 decomposition | `backend/src/core/sseHandler.js:386-393` | `addMessage(... 'clarification', { clarification })` |
