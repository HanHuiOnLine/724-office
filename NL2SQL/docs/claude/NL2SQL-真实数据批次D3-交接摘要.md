# NL2SQL 真实数据批次 D3 · 交接摘要

## 来源
- **批次任务计划**:[NL2SQL-真实数据批次D3-任务计划.md](NL2SQL-真实数据批次D3-任务计划.md)
- **总览文档**:[NL2SQL-真实数据批次总览.md](NL2SQL-真实数据批次总览.md)
- **上游交接**:[NL2SQL-真实数据批次D2-交接摘要.md](NL2SQL-真实数据批次D2-交接摘要.md)
- **执行日期**:2026-04-25
- **执行结果**:✅ 通过(`test:smoke` 31 pass / 0 fail / 2 skip,与 D2 基线一致;`phase3/clarification-resume.test.js` 48 pass / 0 fail)

---

## 1. 已修改的核心接口和逻辑

### 1.1 [backend/src/core/agenticEngine.js](../../backend/src/core/agenticEngine.js) · `resumeFromClarification`
**位置**:[agenticEngine.js:949-1197](../../backend/src/core/agenticEngine.js#L949-L1197)

**改动一句话**:在 verification → recovery 链路之后接入 D2 的 `executionPhase`,失败时触发一次 recovery 重试,成功/失败两路均写真实审计;成功响应升级为 `type='result' + data + executionTime`。

**关键改动位点**:
| 行 | 改动 |
|---|---|
| L995-L1053 | 保持原 verification + recovery + 降级 fallback 逻辑;新增 `let recoveryUsed = false;` 在 verification 失败分支内置位 |
| L1055-L1085 | **新增** `executionPhase` 调用 + traceLog `phase:'execution'`;失败 + `recoveryUsed===false` 时触发 recovery → 重试,traceLog `phase:'execution_retry'` |
| L1108-L1141 | **新增** 成功路径 `type='result'` + `data` + `executionTime` + `verificationWarning`(透传);成功审计 `markQueryHistorySuccess` 真实 `executionTime`/`rowCount`/摘要 `result`/`fallbackUsed:false`/`rlsApplied` |
| L1144-L1185 | **新增** 执行失败路径 `type='error'` + `errorCode` + `executionTime`(真实);失败审计 `markQueryHistoryFailure` 真实值 |
| L1186-L1196 | 顶层 catch 维持原状,**不写**审计(与 processQuery 一致,顶层异常仍交由 sseHandler/legacy fallback 处理) |

**复用契约**:`executionPhase(finalSql, ctx)` 直接复用 D2 实现 [agenticEngine.js:715-741](../../backend/src/core/agenticEngine.js#L715-L741),签名零变更。`ctx` 透传 `context`,语义与 `processQuery` 一致(`sessionId / userId / userRole / tenantId / requestSource / requestIp / rlsApplied`)。

### 1.2 新成功响应契约(对外可见,与 D2 主路径完全对齐)
| 字段 | D2 前(批次 B 完工态) | D3 后 |
|---|---|---|
| `type` | `'sql_result'` | **`'result'`** |
| `data` | (无) | **`{ columns, rows, rowCount, truncated }`** |
| `executionTime` | (无) | **真实 SQL 执行耗时(ms)** |
| `verificationWarning` | 仅降级路径有 | 不变(降级 SQL 执行成功时仍透传) |
| `resumed` | `true` | 不变 |
| `sql` / `explanation` / `selectedTables` / `decomposition` / `verification` / `traceLog` / `duration` | 同前 | 同前 |

**失败响应**:`{ success:false, type:'error', error, errorCode, sql, explanation, selectedTables, decomposition, verification, executionTime, traceLog, duration, resumed:true }`

### 1.3 审计写入对齐 D2
| 路径 | 行号 | 字段 |
|---|---|---|
| 成功 | L1116-L1141 | `naturalQuery: originalQuery`(锁第一轮原文,**非** userAnswer);`executionTime`/`rowCount` 真实;`result: summarizeResultForAudit(execResult.data)`;`fallbackUsed:false`;`rlsApplied: context.rlsApplied` |
| 失败 | L1156-L1185 | `errorCode`(`SQL_VALIDATION_FAILED` / `SR_EXEC_ERROR` / `SR_DB_NOT_*` / 等);`executionTime` 真实;`errorMessage: execResult.error`;`fallbackUsed:false` |
| 顶层异常(L1186-L1196) | 同 D2 | **不写**(交 sseHandler/legacy fallback 处理,避免与 fallback 互写) |

### 1.4 [backend/test/phase3/clarification-resume.test.js](../../backend/test/phase3/clarification-resume.test.js) · 测试升级到 D3 新契约
**位置**:整文件重写(48 pass)

**改动**:
- 新增 mock `sqlExecutor`(`validateSQL` → `{valid:true}`、`executeQuery` → 返回 1 行真实 data)
- 新增 mock `database`(`createQueryHistory` 返回 `'mock-history-id'`,`markQueryHistorySuccess`/`markQueryHistoryFailure` 捕获 payload 供断言),避免污染 sqlite
- case 1 升级断言:`type==='result'`、`data.rows` 数组、`data.rowCount===1`、`executionTime` 数字、`traceLog` 含 `'execution'`、`markQueryHistorySuccess` 调用 + 真实 `executionTime/rowCount/fallbackUsed`、`createQueryHistory.naturalQuery === originalQuery`(锁原文)
- case 3(降级)升级断言:降级 SQL 仍走 `executionPhase`,mock 让其执行成功,断言 `type='result'` + `verificationWarning` 透传 + `data` 含真实行数 + `traceLog` 含 `recovery_fallback` 与 `execution`
- case 4(GIBBERISH 早退):无变化,仍 `type='error'`(不进入 executionPhase)
- **新增 case 5**:`executeQuery` 失败 + 一次 recovery 后仍失败 → `type='error'`、`errorCode='SR_DB_NOT_FOUND'`、`markQueryHistoryFailure` 写真实 `errorCode/fallbackUsed:false`

---

## 2. 给 D4 / D5 的提示

### 2.1 给 D4(SSE / 前端)的提示 ⚠️ 协议变更已对齐 D2
- `resumeFromClarification` 的 SSE result 事件 **`type` 从 `'sql_result'` 升级为 `'result'`**,与 D2 主路径完全一致 → 前端按 `type==='result'` 一条分支统一处理即可,**不需要为 resume 路径单独分支**
- agentic resume 成功事件**新增 `data` 字段**(shape:`{ columns, rows, rowCount, truncated }`)与 `executionTime`,与 D2 主路径同形
- `engineUsed` 标识由 sseHandler 外层注入:主路径 `'agentic'`,resume 路径 `'agentic-resume'`(引擎内部不动该字段,本批次也未触碰)
- `resumed:true` 字段保留,前端可选用以区分"首问"还是"澄清后回答"
- `verificationWarning` 字段**仅在 type='result' 的降级路径**出现,前端可在表格上显示一个"已通过执行,但此前 verification 给出过警告"的小提示;失败响应不带此字段
- `type='clarification'` 与 `type='error'` 不变;DRY_RUN 模式下后端透传 `data.rows=[]`,前端按"空结果"渲染

### 2.2 给 D5(行为级测试)的提示
- **D2 + D3 完成后 agentic 引擎两条成功路径已完全一致**,可在 `test/phase-data/` 用同一套 stub(stub `sqlExecutor` + stub LLM)同时覆盖
- 建议 D5 至少各加 1 条端到端用例:
  - `processQuery` 成功 → `markQueryHistorySuccess` 含真实值
  - `resumeFromClarification` 成功 → `markQueryHistorySuccess` 含真实值
  - `resumeFromClarification` 执行失败 → 一次 recovery → 仍失败 → `markQueryHistoryFailure` 含 `errorCode`
- D3 已固化 mock 模式可直接借鉴 [phase3/clarification-resume.test.js](../../backend/test/phase3/clarification-resume.test.js) 的 stub 结构(`sqlExecutor.validateSQL` / `executeQuery` / `database.createQueryHistory` / `markQueryHistorySuccess` / `markQueryHistoryFailure`)

---

## 3. D2 + D3 完成后两条成功路径一致性确认表

| 维度 | `processQuery`(主路径,D2) | `resumeFromClarification`(澄清路径,D3) | 一致 |
|---|---|---|---|
| 验证后调用 | `executionPhase(sqlResult.sql, context)` | `executionPhase(sqlResult.sql, context)` | ✅ |
| 失败 + recoveryUsed=false | recovery → 重试 executionPhase | recovery → 重试 executionPhase | ✅ |
| 失败 + recoveryUsed=true | 不再 recovery,返回 type='error' | 不再 recovery,返回 type='error' | ✅ |
| 成功 type | `'result'` | `'result'` | ✅ |
| 成功 `data` shape | `{columns, rows, rowCount, truncated}` | `{columns, rows, rowCount, truncated}` | ✅ |
| 成功 `executionTime` | 真实 SQL 耗时 | 真实 SQL 耗时 | ✅ |
| 成功审计 | `markQueryHistorySuccess` + 真实值 + 摘要 | `markQueryHistorySuccess` + 真实值 + 摘要 | ✅ |
| 失败 type | `'error'` + `errorCode` | `'error'` + `errorCode` | ✅ |
| 失败审计 | `markQueryHistoryFailure` + 真实值 | `markQueryHistoryFailure` + 真实值 | ✅ |
| 顶层异常审计 | **不写**(交 sseHandler/fallback) | **不写**(交 sseHandler/fallback) | ✅ |
| traceLog 阶段 | …/verification/(recovery)/execution/(execution_retry) | …/verification/(recovery_fallback)/(recovery)/execution/(execution_retry) | ✅(语义一致) |
| `resumed` 字段 | (无) | `true` | ⚠️ 唯一差异(by design) |
| `engineUsed` 标识 | sseHandler 注入 `'agentic'` | sseHandler 注入 `'agentic-resume'`(D4 任务) | ⚠️ 由 D4 处理 |
| `naturalQuery` 入审计 | `userQuery`(本轮原文) | `originalQuery`(第一轮原文,锁定不漂) | ✅(语义一致) |

---

## 4. 遗留到下一阶段的临时代码 (TODOs)

### TODO-D3.1 · sseHandler 与前端尚未感知 resume 路径的 `type='result'` → 由 D4 收敛
与 D2 一样,resume 路径目前虽然能产出新契约,但 sseHandler 层仍需把 `type='result'` 的 `data` / `executionTime` 转发出去,前端 ChatView.vue 也需识别。**部署上线前必须先完成 D4**,或保持 `FF_AGENTIC_ENGINE=false`。

### TODO-D3.2 · `engineUsed='agentic-resume'` 由 D4 在 sseHandler 注入
本批次未触碰 sseHandler;D4 需在广播 resume 路径的 result 事件时打标 `engineUsed='agentic-resume'`,以便前端/数据分析区分两条路径。

### TODO-D3.3 · 与 D2 同样的 `executionPhase(ctx)` 参数未消费
继承 D2 TODO-D2.3,本批次维持 `ctx` 透传不消费,保留接口扩展余地。

### TODO-D3.4 · 行为级测试待 D5 补齐端到端
本批次只在 unit 层(stub LLM/sqlExecutor/database)证明了 resume 链路,完整端到端测试由 D5 在 `test/phase-data/` 补齐。

---

## 5. 偏离初始计划的变更及其原因

### 偏离 5.1 · 修改了 `test/phase3/clarification-resume.test.js`(超出计划写入范围)
- **计划写入范围**:仅 `agenticEngine.js::resumeFromClarification`(任务计划 §写入范围)
- **实际**:同时改写了 `backend/test/phase3/clarification-resume.test.js`
- **原因**:该测试在批次 B 阶段断言"`result.type === 'sql_result'`"——这是当时 resume 路径不执行 SQL 的契约。D3 计划 §目标 与 §写入范围 1 明确要求"成功 → `type='result'` + data"。**两份合同直接冲突**,继续保持旧测试就等于违反 D3 计划。改造模式与 [NL2SQL-真实数据批次D2-交接摘要.md §偏离 4.1](NL2SQL-真实数据批次D2-交接摘要.md) 完全一致。新增 mock `sqlExecutor` / `database`,断言升级到 D3 契约,新增 case 5 覆盖执行失败 + recovery 路径;48 个断言全部通过。
- **影响评估**:零代码副作用;mock 仅在测试进程内生效,通过末尾 orig 还原避免影响其他测试。

### 偏离 5.2 · 早退分支(verification 失败 + recovery 失败 + 无降级)不写审计
- **计划**:计划未明确处理"无 SQL 可用即早退"分支的审计行为
- **实际**:[agenticEngine.js:1047-1053](../../backend/src/core/agenticEngine.js#L1047-L1053) 维持原状,直接 `type='error'` 返回,**不写** `markQueryHistoryFailure`
- **原因**:与 D2 processQuery 早退分支一致(D2 偏离 4.2)——此时尚未真正执行 SQL,`executionTime`/`errorCode` 都不可信,写审计反而污染。这种顶级 SQL 生成失败仍交 sseHandler/legacy fallback 处理。
- **影响评估**:与 D2 行为一致,符合"agentic 自身真正执行后才算自身审计"的语义。

### 偏离 5.3 · 降级 fallback 路径(`recovery_fallback`)进入 executionPhase
- **计划**:计划未明确"verification 失败 → recovery 失败 → 降级 fallback"路径在 D3 后的执行行为
- **实际**:降级 fallback 后 `sqlResult.success=true`,**进入 executionPhase**;`recoveryUsed` 已置位,执行失败时不再 recovery,直接 `type='error'`
- **原因**:降级 SQL 既然已被赋予 `success=true` 的可执行权,语义上就应当走真实执行;但既然 verification 已警告,执行失败也合理(不再做无谓 recovery)。`verificationWarning` 字段在 finalResult 中透传,前端仍能感知警告。
- **影响评估**:对外可见行为更干净;失败时 `type='error'` + 真实 `errorCode`,审计落 `markQueryHistoryFailure`。

### 无偏离的事项(备查)
- `executionPhase(finalSql, ctx)` 调用方式与 D2 摘要 §1.2 完全一致
- `recoveryUsed` 锁 1 次:verification 已用过 recovery 的不再用;execution 失败才允许触发第二次 recovery(与 processQuery 完全一致)
- 输出契约升级 `type='result' + data + executionTime` 与总览 §目标响应契约完全一致
- `engineUsed='agentic-resume'` **不在引擎内部设置**(交 D4 sseHandler 层)
- `resumed:true` 字段保持不变,新老前端兼容

---

## 6. 验证结果存档

```
$ node test/phase3/clarification-resume.test.js
[resumeFromClarification 端到端:typeid=1743 + int_key5 → type=result + data]   28 ✓
[验证失败触发 recoveryPhase]                                                      2 ✓
[B-15 降级:原 SQL 基本语法完整时保留 + 警告 + D3 执行返回 type=result]            8 ✓
[B-15 无合法 SQL 时返回 type=error]                                              3 ✓
[D3 执行失败 → markQueryHistoryFailure 写真实 errorCode]                         7 ✓
===== 结果 pass=48 fail=0 =====
```

```
$ npm run test:smoke
[runner] 汇总:
  ✓ pass:    31
  ✗ fail:    0
  ✗ timeout: 0
  ⊘ skip:    2          # phase1/test-executeQuery.js (no SR_DB)
                        # phase2/test-regression-complex.js (no LLM key)
  总计:     33
```

与 D2 基线完全一致(31 pass / 0 fail / 2 skip)。

---

## 7. 手动联调提示(D4 完成前不要打开 FF)

D3 完成后,如果**仅**为了本地验证 resume 路径真实执行,可以临时启 agentic 看日志,但**不要把数据返回到老前端**:

```bash
FF_AGENTIC_ENGINE=true npm run dev
# 1. 触发一次澄清查询(让首轮返回 type='clarification')
# 2. 在前端点选/输入澄清回答 → 观察后端日志:
#    [AgenticEngine] resumeFromClarification 开始
#    [AgenticEngine] Phase 4: Execution
#    traceLog 含 phase:'execution' result.success=true
# 3. query_history 表新行(naturalQuery 应为第一轮原文,非 userAnswer):
#    status='success', execution_time=<SQL 真实耗时>,
#    row_count=<真实行数>, result={"columns":[...],"rowCount":...,"truncated":false,"sampleHash":"..."}
```

DRY_RUN 回归:
```bash
DRY_RUN=true FF_AGENTIC_ENGINE=true npm run dev
# 澄清 → 回答 → data.rows === [] 且 query_history.row_count === 0
```

⚠️ 因前端尚未感知 resume 路径的 `type='result'`(D4 范围),手动联调时建议直接看后端日志和 SQLite,而不是前端表格。

---

## 8. D4 启动条件确认
- [x] `resumeFromClarification` 成功 → `type='result' + data + executionTime`,与 D2 主路径完全同构
- [x] 失败 → `type='error' + errorCode + executionTime`,与 D2 主路径完全同构
- [x] 审计写入对齐 D2(成功 + 失败两路真实值,顶层异常不写)
- [x] `resumed:true` 保留,`engineUsed='agentic-resume'` 由 D4 sseHandler 层打标
- [x] smoke 31 pass / 0 fail;phase3/clarification-resume.test.js 48 pass / 0 fail
- [x] D2 + D3 一致性确认表(本文档 §3)

D4 可以开工:在 sseHandler 层把 agentic 主路径与 resume 路径的 `type='result' + data + executionTime` 通过 SSE 推给前端,并在前端 ChatView.vue 按 `type==='result'` 渲染表格。

---

## 9. 回滚方式

代码回滚:
1. 还原 [agenticEngine.js:949-1197](../../backend/src/core/agenticEngine.js#L949-L1197) 的 `resumeFromClarification` 为批次 B 完工态(`type='sql_result'`,无 `data`,无 `executionTime`,不写 `markQueryHistorySuccess/Failure`)
2. 还原 [test/phase3/clarification-resume.test.js](../../backend/test/phase3/clarification-resume.test.js) 为批次 B 形态(无 `sqlExecutor`/`database` mock,断言 `type='sql_result'`)

紧急回滚不需要改代码,可直接:
- `DRY_RUN=true`:agentic resume 仍生成 SQL 但不执行,`data.rows=[]`(临时关闭执行)
- `FF_AGENTIC_ENGINE=false`:整体切回 legacy 主链路,resume 不会被触发(legacy 不走 agentic 澄清流)
- `FF_AGENTIC_AUTO_FALLBACK=true`(现状):agentic 失败自动回退 legacy
