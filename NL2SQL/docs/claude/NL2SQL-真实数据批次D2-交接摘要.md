# NL2SQL 真实数据批次 D2 · 交接摘要

## 来源
- **批次任务计划**:[NL2SQL-真实数据批次D2-任务计划.md](NL2SQL-真实数据批次D2-任务计划.md)
- **总览文档**:[NL2SQL-真实数据批次总览.md](NL2SQL-真实数据批次总览.md)
- **上游交接**:[NL2SQL-真实数据批次D1-交接摘要.md](NL2SQL-真实数据批次D1-交接摘要.md)
- **执行日期**:2026-04-25
- **执行结果**:✅ 通过(`test:smoke` 31 pass / 0 fail / 2 skip,与 D1 基线完全一致)

---

## 1. 已修改的核心接口和逻辑

### 1.1 [backend/src/core/agenticEngine.js](../../backend/src/core/agenticEngine.js) · 顶部依赖
| 行 | 改动 |
|---|---|
| L32-L34 | 新增 `require('./sqlExecutor')` 与 `require('./auditHelper').summarizeResultForAudit` |

### 1.2 新增 `executionPhase` 私有方法
**位置**:[agenticEngine.js:715-741](../../backend/src/core/agenticEngine.js#L715-L741)

**签名**:
```js
async executionPhase(finalSql, ctx)
  => { success, data?, executionTime, error?, errorCode?, sql? }
```

**契约**:
- 入参:`finalSql` 必为非空 string;`ctx` 当前透传未消费(为 D3 复用预留语义,例:`sessionId` / RLS 上下文)
- 1) `sqlExecutor.validateSQL(finalSql)`:白名单 + LIMIT + 仅 SELECT/WITH;失败返回 `errorCode='SQL_VALIDATION_FAILED'`、`executionTime:0`
- 2) `sqlExecutor.executeQuery(finalSql)`:**透传**结果(含 RLS、脱敏、LIMIT、DRY_RUN、超时,与 legacy 完全一致路径)
- 入参非法返回 `errorCode='EXEC_INVALID_INPUT'`
- **绝不**绕过 `sqlExecutor` 直连 mysql 驱动

**复用约定**(D3 启动条件):D3 直接 `await this.executionPhase(finalSql, ctx)` 即可,`ctx` 必须包含 `sessionId / userId / userRole / tenantId / requestSource / requestIp / rlsApplied`,与 `processQuery` 一致。

### 1.3 `processQuery` 接入执行链路
**核心改动位点**:[agenticEngine.js:159-300](../../backend/src/core/agenticEngine.js#L159-L300)

**时序图**:
```
generationPhase
   │
   ▼
verificationPhase ─── fail ──► recoveryPhase (recoveryUsed=true)
   │ pass                            │
   │                                 ▼ (可能仍失败:走下面早退 error)
   ▼
executionPhase #1 ─── fail ──► [recoveryUsed===false] recoveryPhase ──► executionPhase #2
   │ ok                              │ recoveryUsed===true 跳过
   │                                 ▼
   │                              [仍 fail] / [recovered fail]
   ▼                                 ▼
type='result' + data         type='error' + errorCode
markQueryHistorySuccess      markQueryHistoryFailure
```

**关键不变量**:
- `recoveryUsed` 锁 1 次:verification 已用过 recovery 的不再用;execution 失败才允许触发第二次 recovery
- 早退分支(L177-L190 之前):若 generation/recovery 后 `sqlResult.success===false` 或无 `sql`,直接 `type='error'` 返回,**不进入 executionPhase**(避免对 null sql 二次校验)

### 1.4 新成功响应契约(对外可见)
| 字段 | 旧值(D1 前) | 新值(D2 后) |
|---|---|---|
| `type` | `'sql_result'` | **`'result'`** |
| `data` | (无) | **`{ columns, rows, rowCount, truncated }`** |
| `executionTime` | (无) | **真实 SQL 执行耗时(ms)** |
| `sql` / `explanation` / `selectedTables` / `decomposition` / `verification` / `traceLog` / `duration` | 同前 | 同前 |

**失败响应**:`{ success:false, type:'error', error, errorCode, sql, explanation, selectedTables, decomposition, verification, executionTime, traceLog, duration }`

**澄清响应**:不变(`type:'clarification'`,与批次 B 协议一致)

### 1.5 审计写入对齐
| 路径 | 行号 | 字段 |
|---|---|---|
| 成功 | L237-L259 | `executionTime: execResult.executionTime`(真实);`rowCount: execResult.data?.rowCount`(真实);`result: summarizeResultForAudit(execResult.data)`(D1 摘要);`fallbackUsed: false`;`rlsApplied: context.rlsApplied` |
| 失败 | L280-L300 | `executionTime: execResult.executionTime`(真实);`errorCode: execResult.errorCode`(`SQL_VALIDATION_FAILED` / `SR_EXEC_ERROR` / `SR_DB_NOT_*` / 等);`errorMessage: execResult.error`;`fallbackUsed: false`;`rlsApplied: context.rlsApplied` |
| 顶层异常(`} catch (error) {`) | L307-L315 | **不写**(顶层异常仍由 sseHandler/legacy fallback 处理,避免与 fallback 互写) |

---

## 2. 给 D3 / D4 的提示

### 2.1 给 D3(`resumeFromClarification`)的提示
- D3 只需要在最末段(`generationPhase` → `verificationPhase` 后)调用 `await this.executionPhase(finalSql, ctx)`,**不要重复造执行链路**
- 输出契约保持与 D2 一致:成功 `type='result' + data`,失败 `type='error'`;`engineUsed: 'agentic-resume'` 仍由 sseHandler 在外层填,引擎内部不动这个字段
- 审计写入参考 D2 的 L237-L300 模式;若 D3 想统一抽函数(`writeAuditSuccess` / `writeAuditFailure`),可放在引擎内私有方法,**不在本批次范围内**

### 2.2 给 D4(SSE / 前端)的提示 ⚠️ 协议变更
- agentic 主路径成功事件 **`type` 由 `'sql_result'` 升级为 `'result'`**,前端 `ChatView.vue` 需按 `type==='result'` 分支渲染表格(列+行+rowCount+truncated)
- agentic 主路径成功事件**新增 `data` 字段**,与 legacy 的 `resultFormatter` 输出 shape 完全一致:`{ columns, rows, rowCount, truncated }`
- agentic 主路径成功事件**新增 `executionTime` 字段**(SQL 真实耗时,非 `duration`/规划耗时);前端可据此显示"耗时"
- `type='clarification'` 与 `type='error'` **不变**
- DRY_RUN 模式下后端透传 `data.rows=[]`,前端按"空结果"渲染即可(不需要新增 dryRun 分支)

---

## 3. 遗留到下一阶段的临时代码 (TODOs)

### TODO-D2.1 · `resumeFromClarification` 仍走旧 SQL 文本返回 → 由 D3 收敛
[agenticEngine.js::resumeFromClarification](../../backend/src/core/agenticEngine.js) 当前不调用 `executionPhase`,澄清后仍返回 `type='sql_result'`。**严格属于 D3 范围**,本批次未触碰。

### TODO-D2.2 · sseHandler 与前端尚未感知 `type='result'` → 由 D4 收敛
当前没人消费新契约,这意味着如果手动启用 `FF_AGENTIC_ENGINE=true`,前端可能因不识别 `type='result'` 而退化展示。**部署上线前必须先完成 D4**,或将 `FF_AGENTIC_ENGINE` 维持 `false`。

### TODO-D2.3 · `executionPhase` 的 `ctx` 参数未消费
当前实现透传 `ctx` 但实际不使用——`sqlExecutor.executeQuery` 不接受 ctx,RLS/脱敏从 `config.security.*` + `featureFlags.RESULT_MASKING` 读取。保留该参数是为 D3 复用时不破坏调用签名,以及未来如果需要把 RLS/tenantId 透传给 sqlExecutor 时不必再次改签名。**ESLint 可能会标 unused**,本批次不处理。

### TODO-D2.4 · 单测仍是源码扫描型,未做行为级覆盖
`test/phase4/test-agentic-audit.js` 仍是 `fs.readFileSync` + 正则模式扫描(继承 Phase 4·任务 E 风格),没有桩 LLM/sqlExecutor 跑全链路。**D5** 会用 `phase-data/` 系列脚本补行为级测试(stub `sqlExecutor` + stub LLM,跑 processQuery 端到端),覆盖:成功路径 → markQueryHistorySuccess、执行失败 + 一次 recovery → 重试成功、recovery 后仍失败 → markQueryHistoryFailure。

---

## 4. 偏离初始计划的变更及其原因

### 偏离 4.1 · 修改了 `test/phase4/test-agentic-audit.js`(超出计划写入范围)
- **计划写入范围**:仅 `agenticEngine.js::processQuery`(任务计划 §写入范围)
- **实际**:同时改写了 `backend/test/phase4/test-agentic-audit.js`
- **原因**:该测试在 Phase 4·任务 E 阶段断言"`createQueryHistory` 仅在 `finalResult.success===true` 内调用"——这是当时 agentic 不执行 SQL 的契约。D2 计划 §3 与 §风险明确要求"`markQueryHistoryFailure`:传入真实 `executionTime` 与 `errorCode`","返回 `type='error'` 并写 `markQueryHistoryFailure`,不静默"。**两份合同直接冲突**,继续保持旧测试就等于违反 D2 计划。我将测试改为 D2 新契约:断言成功路径走 `markQueryHistorySuccess` 含真实值,失败路径走 `markQueryHistoryFailure` 含 `errorCode`,**只有顶层 `} catch (error) {` 块仍不写**(顶层异常仍交 sseHandler/legacy)。新增 22 个断言全部通过。
- **影响评估**:零代码副作用;legacy fallback 仍各写各的 `query_history` 记录(不同 `historyId`),不构成同记录双写。

### 偏离 4.2 · `processQuery` 早退分支(generation/recovery 失败不进入 executionPhase)
- **计划**:计划描述只说"verification 后接 executionPhase",未明确处理 verification fail + recovery fail 的早退
- **实际**:加了 L182-L190 的早退守卫——若 `recoveryPhase` 返回 `success:false` 或无 `sql`,直接 `type='error'` 返回,**不进入 executionPhase**
- **原因**:`executionPhase` 入参契约要求 `finalSql` 是非空 string,如果不早退则会触发 `errorCode='EXEC_INVALID_INPUT'` 这类无意义的二次校验失败,污染 traceLog 和审计;早退后审计写入仍由 sseHandler/legacy fallback 处理(与原行为一致)。
- **影响评估**:对外可见行为更干净;不影响 D3/D4 契约。

### 偏离 4.3 · 失败审计也写入(更早期版本只写成功)
- **计划**:任务计划 §3 已明确 + 风险栏明确,本属"按计划执行",但与 Phase 4·任务 E 注释 `失败分支(success:false)交给 sseHandler 的 legacy fallback 写入,避免双写` 冲突,值得明示。
- **实际**:成功写 `markQueryHistorySuccess`,失败写 `markQueryHistoryFailure`(均带真实 `executionTime` / `errorCode`)
- **原因**:agentic 现已**真实执行 SQL**,执行失败属于"agentic 自身的尝试结果",应单独审计;legacy fallback 若被触发,会写它**自己的** `query_history` 行(独立 `historyId`),与 agentic 的失败行并存,不构成同记录双写。
- **影响评估**:`query_history` 总行数可能略增(每次 agentic 执行失败 + fallback 各 1 行),但审计粒度更高,符合"不静默"要求。

### 偏离 4.4 · `traceLog` 新增 `execution` / `execution_retry` 阶段
- **计划**:未显式定义 traceLog 形状
- **实际**:成功/失败均 push `{ phase:'execution', result:{success, executionTime, rowCount, errorCode} }`;recovery 后重试再 push `{ phase:'execution_retry', ... }`
- **原因**:可观测性所需,且不向外暴露 `data.rows` 等大字段(只记结构)。

### 无偏离的事项(备查)
- `executionPhase` 签名 `(finalSql, ctx)` 与计划 §写入范围 1 完全一致
- 一次性 recovery(`recoveryUsed` 锁)与计划"未走过 recoveryPhase 才允许第二次"完全一致
- 输出契约升级到 `type='result' + data + executionTime` 与总览 §目标响应契约完全一致
- 严格不读 `resumeFromClarification` / SSE / 前端 / 测试(除上述偏离 4.1)
- DRY_RUN 路径透传(由 sqlExecutor 处理),前端行为不回退

---

## 5. 验证结果存档

```
$ npm run test:smoke
[runner] 发现 33 个测试脚本 | smoke=true | phase=all
[runner] 汇总:
  ✓ pass:    31
  ✗ fail:    0
  ✗ timeout: 0
  ⊘ skip:    2          # phase1/test-executeQuery.js (no SR_DB)
                        # phase2/test-regression-complex.js (no LLM key)
  总计:     33
```

```
$ node test/phase4/test-agentic-audit.js
22 passed, 0 failed (D2 新契约全部通过)
```

与 D1 基线一致(31 pass / 0 fail / 2 skip)。

---

## 6. 手动联调提示(D4 完成前不要打开 FF)

D2 完成后,如果**仅**为了本地验证主链路真实执行,可以临时启 agentic 看日志,但**不要把数据返回到老前端**:
```bash
FF_AGENTIC_ENGINE=true npm run dev
# 后端日志应能看到:
#   [AgenticEngine] Phase 4: Execution
#   [AgenticEngine] traceLog 含 phase:'execution' result.success=true
# query_history 表新行:
#   status='success', execution_time=<SQL 真实耗时>,
#   row_count=<真实行数>, result={"columns":[...],"rowCount":...,"truncated":false,"sampleHash":"..."}
```

DRY_RUN 回归:
```bash
DRY_RUN=true FF_AGENTIC_ENGINE=true npm run dev
# 断言 data.rows === [] 且 query_history.row_count === 0(既有行为不回退)
```

⚠️ 因前端尚未感知 `type='result'`(D4 范围),手动联调时建议直接看后端日志和 SQLite,而不是前端表格。

---

## 7. D3 启动条件确认
- [x] `executionPhase(finalSql, ctx)` 已交付,可在 `resumeFromClarification` 内 `await this.executionPhase(...)` 直接复用
- [x] 成功/失败响应契约固化(本文档 §1.4)
- [x] 审计写入对齐(成功 + 失败两路真实值)
- [x] smoke 31 pass / 0 fail
- [x] D4 协议变更点明确(`type='result'` + `data` + `executionTime`,本文档 §2.2)

D3 可以开工:在 `resumeFromClarification` 的 `applyClarificationResult → retrieveTablesByDataUnits → generationPhase → verificationPhase` 之后接入 `executionPhase`,并按本文档 §1.5 写审计。

---

## 8. 回滚方式
1. 还原 [agenticEngine.js:159-300](../../backend/src/core/agenticEngine.js#L159-L300) 为 D1 完成态(`type='sql_result'`,无 `data`,无 `executionTime`,审计只写成功路径且 `executionTime:duration` / `rowCount:0`)
2. 删除 [agenticEngine.js:701-741](../../backend/src/core/agenticEngine.js#L701-L741) 的 `executionPhase` 方法
3. 删除 [agenticEngine.js:32-34](../../backend/src/core/agenticEngine.js#L32-L34) 的 `sqlExecutor` / `auditHelper` import
4. 还原 [test/phase4/test-agentic-audit.js](../../backend/test/phase4/test-agentic-audit.js) 为 D1 形态(只断言 success===true 路径)

紧急回滚不需要改代码,可直接:
- `DRY_RUN=true`:agentic 仍生成 SQL 但不执行,`data.rows=[]`(临时关闭执行)
- `FF_AGENTIC_ENGINE=false`:整体切回 legacy 主链路(完全绕开 agentic)
- `FF_AGENTIC_AUTO_FALLBACK=true`(现状):agentic 失败自动回退 legacy,无需手动干预
