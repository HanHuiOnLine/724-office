# NL2SQL 真实数据输出实施计划

## 1. 文档信息
- 版本：v1.0
- 日期：2026-04-24
- 目标：将项目最终输出从“SQL 文本”为主，升级为“真实数据结果”为主
- 适用范围：`backend/src/core`、`backend/src/memory`、`frontend/src`、`backend/test`
- 关联文档：
  - `docs/自然语言提数工具需求文档.md`
  - `docs/NL2SQL核心模块优化实施计划.md`
  - `docs/NL2SQL-Phase1-交接摘要.md` ~ `docs/NL2SQL-Phase4-交接摘要.md`

---

## 2. 现状与问题

### 2.1 现状
1. `legacy` 主链路（`nl2sqlEngine.processQuery`）已具备“生成 SQL -> 执行 -> 返回数据”能力。
2. `agentic` 主链路（`agenticEngine.processQuery` / `resumeFromClarification`）成功分支默认返回 `type='sql_result'`，核心产物是 SQL 与解释，未执行 SQL。
3. `sseHandler` 在 `engineUsed='agentic'` 时会将 `sql_result` 直接下发前端，前端通常展示解释和 SQL，真实数据常为空。

### 2.2 直接影响
1. 与“自然语言提数工具”目标存在体验偏差：用户拿到 SQL 但没有数据。
2. 审计语义不一致：agentic 成功路径 `rowCount` 固定 0，`executionTime` 混入规划耗时。
3. 前端结果体验分裂：legacy 有数据表，agentic 常只有解释文本。

---

## 3. 目标定义（Data-first）

### 3.1 总体目标
1. 正常成功请求默认返回真实数据（`rows/columns/rowCount`），SQL 仅作为附带信息。
2. 除“澄清阶段”外，不再以 `sql_result` 作为最终成功态主输出。
3. 在不降低安全性的前提下实现（只读、白名单、LIMIT、脱敏、审计、可回滚）。

### 3.2 验收 KPI
1. `result` 事件中包含 `data.rows` 的成功请求占比 >= 95%（剔除澄清和明确无数据场景）。
2. `query_history` 中 `status=success` 记录的 `row_count` 与真实执行一致，agentic 不再固定 0。
3. 真实环境回归通过：`SR_DATABASE_URL_TEST` + `LLM_API_KEY` 两类测试均通过。
4. 数据安全不回退：禁止 DML，LIMIT 强制，脱敏规则命中率不下降。

---

## 4. 方案总览

### 4.1 总体思路
1. 短期止血：先保证“任何成功查询都尽量执行并回数”。
2. 中期统一：将 agentic 成功态从 `sql_result` 升级为 `result`（Data-first 契约）。
3. 长期治理：统一执行/审计语义，消除双轨差异。

### 4.2 目标响应契约（建议）
```json
{
  "success": true,
  "type": "result",
  "message": "查询完成",
  "sql": "SELECT ... LIMIT 1000",
  "data": {
    "columns": ["..."],
    "rows": [],
    "rowCount": 123,
    "truncated": false
  },
  "executionTime": 820,
  "engineUsed": "agentic",
  "fallbackUsed": false,
  "verificationWarning": null
}
```

---

## 5. 分阶段实施计划

## Phase A（0.5-1 天）：基线冻结与观测补齐
### 任务
1. 记录当前 `sql_result` 占比、`result` 占比、空数据占比。
2. 在日志中增加 `result.hasData`、`result.rowCount`、`engineUsed` 聚合字段。

### 文件建议
- `backend/src/core/sseHandler.js`
- `backend/src/core/agenticEngine.js`
- `backend/src/core/database.js`

### 验收
1. 可按引擎统计“只出 SQL 不出数据”的比例。
2. 形成改造前基线报表（至少 1 天样本）。

---

## Phase B（1-2 天）：快速止血（确保成功请求尽量回数）
### 任务
1. 在 `sseHandler` 增加“agentic 成功但仅 `sql_result` 时的执行桥接”。
2. 桥接执行复用 `sqlExecutor.validateSQL/executeQuery`，不重复造执行逻辑。
3. 增加 feature flag：`FF_AGENTIC_DATA_EXECUTION`（默认 false，灰度开启）。

### 文件建议
- `backend/src/core/sseHandler.js`
- `backend/src/core/sqlExecutor.js`
- `backend/config/feature-flags.js`
- `backend/.env.example`

### 验收
1. 开启 `FF_AGENTIC_DATA_EXECUTION=true` 后，agentic 成功场景返回 `type='result'` 且含 `data`。
2. 关闭开关可一键回滚到现状。

---

## Phase C（2-4 天）：agentic 引擎原生数据闭环
### 任务
1. 在 `agenticEngine.processQuery` 中增加执行阶段：
   - 生成/验证 SQL 后，进入执行（不再止于 SQL 文本）。
2. 引入与 legacy 对齐的执行前处理：
   - SQL 验证统一走 `sqlExecutor.validateSQL`
   - RLS 改写能力复用（可提炼 helper，避免重复逻辑）
   - 脱敏能力沿用 `sqlExecutor.executeQuery` 内置流程
3. 调整成功返回契约：
   - 成功返回 `type='result'`
   - `sql_result` 仅作为兼容期中间态（可配开关）
4. `resumeFromClarification` 同步支持执行并回数。

### 文件建议
- `backend/src/core/agenticEngine.js`
- `backend/src/core/sqlExecutor.js`
- `backend/src/core/nl2sqlEngine.js`（抽公共执行 helper 可选）
- `backend/src/core/sseHandler.js`

### 验收
1. agentic 普通路径与澄清恢复路径均可返回真实数据。
2. 成功请求不再固定 `rowCount=0`。
3. `verificationWarning` 只作为提示，不阻断安全策略。

---

## Phase D（1-2 天）：审计与存储语义修正
### 任务
1. 修正 agentic 审计写入语义：
   - `execution_time` 改为真实执行耗时
   - `row_count` 记录真实行数
2. 明确“数据最小化”：
   - `query_history.result` 存储从“样本行”改为可配置摘要（默认不落业务行数据）
3. 对齐失败路径：
   - agentic 失败且未 fallback 时也应审计失败原因。

### 文件建议
- `backend/src/core/database.js`
- `backend/src/core/agenticEngine.js`
- `backend/src/core/selfRepair.js`
- `backend/src/core/config.js`

### 验收
1. 审计字段可区分“生成耗时”与“执行耗时”。
2. 不再出现“成功但 row_count 恒 0”的系统性偏差。
3. 数据最小化策略可通过配置开关审计。

---

## Phase E（2-3 天）：前端体验与兼容收口
### 任务
1. 前端 `session store` 优先消费 `data.rows`，SQL 仅作为“查看 SQL”附加信息。
2. 表格渲染支持 `truncated`、空数据提示、脱敏标识提示。
3. 兼容期策略：
   - 仍兼容历史 `sql_result` 消息读取
   - 新消息统一为 `result`

### 文件建议
- `frontend/src/stores/session.js`
- `frontend/src/views/ChatView.vue`
- `frontend/src/utils/api.js`（如需）

### 验收
1. 用户主视图默认看到数据表，不需要额外点击 SQL。
2. 历史会话与旧消息不崩溃。

---

## Phase F（2-4 天）：真实环境验收与灰度发布
### 任务
1. 运行真实依赖回归：
   - `SR_DATABASE_URL_TEST=... node test/phase1/test-executeQuery.js`
   - `LLM_API_KEY=... node test/phase2/test-regression-complex.js`
2. 新增专项测试集：
   - `agentic -> execute -> result` 主路径
   - `clarification -> resume -> execute -> result` 路径
   - `RLS/脱敏/LIMIT` 三类安全回归
3. 灰度发布：10% -> 30% -> 100%，分阶段观察失败率与时延。

### 验收
1. 灰度期间 `data.rows` 成功占比持续达标。
2. 无明显性能回退（P95 时延可控）。
3. 出现异常时可 1 分钟内通过开关回滚。

---

## 6. 测试计划

### 6.1 单元测试
1. `agenticEngine`：成功返回 `result` 且包含 `data`。
2. `sseHandler`：`sql_result` 桥接执行逻辑正确。
3. `database writer`：审计字段语义准确。

### 6.2 集成测试
1. 澄清前后两轮都能回数。
2. fallback 场景下返回与审计一致。
3. RLS 开关开启/关闭行为一致。

### 6.3 端到端测试
1. 前端发起查询 -> SSE 返回数据表。
2. 大结果集 `truncated=true` 呈现正确。
3. 脱敏列展示符合规则。

---

## 7. 风险与回滚

### 7.1 主要风险
1. 执行时延上升：agentic 从“只生成”变“生成+执行”。
2. 大结果集风险：网络与前端渲染压力升高。
3. 安全回退风险：若绕过统一执行器，可能出现策略不一致。

### 7.2 回滚策略
1. `FF_AGENTIC_DATA_EXECUTION=false`：立即退回“agentic 仅生成 SQL”。
2. `FF_AGENTIC_ENGINE=false`：整体切回 legacy 主链路。
3. `DRY_RUN=true`：紧急只生成不执行，保护数据库侧稳定。

---

## 8. 交付清单
1. Data-first 契约文档与接口示例。
2. agentic 原生执行闭环代码与回滚开关。
3. 前端数据优先展示改造。
4. 新增测试脚本与真实环境验收记录。
5. 灰度观察报表（成功率、rowCount、时延、错误码）。

---

## 9. 里程碑结论
本计划通过“先止血、再统一、后收口”的路径，把项目输出从“SQL 优先”升级为“数据优先”。
核心原则是：不牺牲安全约束，不破坏可回滚能力，在真实环境中完成闭环验证后再全量切换。
