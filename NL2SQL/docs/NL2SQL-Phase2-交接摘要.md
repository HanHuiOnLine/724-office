# NL2SQL Phase 2 交接摘要

## 文档信息

- 版本:v1.0
- 日期:2026-04-22
- 范围:Phase 2(Week 2)主链路准确率修复
- 对应计划:`docs/NL2SQL核心模块优化实施计划.md` 第 3 章 Phase 2
- 实施计划(含代码清单):`C:\Users\hanhui\.claude\plans\f-learn-724-office-nl2sql-docs-nl2sql-md-floofy-gem.md`

---

## 1. 核心接口与逻辑变更

### 1.1 新增统一表候选打分器 `tableRanker`

**位置**:`backend/src/core/tableRanker.js`(新建,约 240 行)

**契约**:

```js
rank(query, signals, options = {}) → { ranked, selected, debug }
isCoreTable(tableName, scope?) → boolean
SCORE_WEIGHTS / CORE_BOOST / INFERRED_BOOST / CORE_CAP   // 常量导出
```

**signals 结构**:

| 字段 | 来源 | 说明 |
|------|------|------|
| `vectorResults`  | `searchSchemaSmart` 返回 | `[{name, priorityScore, metadata}]` |
| `semanticTables` | `semanticLayer.recommendTables().tables` | `[{tableName, priority, score}]`,保留完整对象 |
| `keywordMatches` | `keywordMatchTables` | `[{name, score}]` |
| `explicitTables` | 用户 SQL 内 `@` 引用 | `[name]` |
| `inferredTables` | `inferTablesFromQuery` | `[name]`,+15 固定加成 |

**打分公式**:

```
baseScore = 0.45*V + 0.30*S + 0.15*K + 0.10*E   (0-100 归一化)
finalScore = baseScore + (isCore ? +30 : 0) + (inferred ? +15 : 0)
```

**选择策略**:核心表(`scope ∈ {platform_core, report}`)按分排序全保留(≤ cap),剩余名额从非核心表按分补足,总数 ≤ 8。兜底:cores 为空且 explicitTables 非空时,explicitTables[0] 置顶。

**feature flag**:`FF_UNIFIED_RANKER`(默认 true)。设 `false` 回退到老 `Set + slice(0, 5)` 行为,无需改代码。

### 1.2 新增 LIMIT 注入工具 `sqlLimit`

**位置**:`backend/src/utils/sqlLimit.js`(新建,约 35 行)

```js
hasOuterLimit(sql) → boolean
ensureLimit(sql, maxRows) → { sql, injected }
```

**关键**:`OUTER_LIMIT_RE = /\blimit\s+\d+(\s*,\s*\d+|\s+offset\s+\d+)?\s*;*\s*$/i` 只识别 SQL **最外层末尾** LIMIT,不被子查询 / 列名(如 `LIMIT_TIME` / `WHERE name="limit"`)干扰。

### 1.3 新增表作用域工具 `tableScope`

**位置**:`backend/src/utils/tableScope.js`(新建,约 45 行)

```js
inferScopeSubtype(tableName, originalScope?) → 'platform_core'|'report'|'platform_newdb'|...
isCoreTable(tableName, scope?) → boolean   // scope ∈ {platform_core, report}
```

`inferScopeSubtype` 从 `vectorStore.js:586-605` 搬出,供 `tableRanker` / `schemaLoader` 共用,避免循环依赖。`vectorStore.js` 改为 `require('../utils/tableScope')`。

### 1.4 `nl2sqlEngine.generateSQL` 主路径改造

**位置**:`backend/src/core/nl2sqlEngine.js:1581-1675`(原 1581-1643)

| 改造点 | 前 | 后 |
|-------|----|-----|
| 语义层推荐 | `semanticLayerTables = [tableName...]`(丢失 priority/score) | 保留 `semanticTableObjects`(完整对象)+ `semanticLayerTables`(仅名字兜底) |
| 表候选检索 | `searchRelevantTables(q, 3, ctx)`(topK=3) | `searchRelevantTables(q, 16, ctx, {returnRawSignals:true})` |
| 合并策略 | `Set([vec, inferred, semantic]).slice(0, 5)` | `tableRanker.rank(...)`,核心表保护 + cap=8 |
| 日志 | 无选表调试信息 | `[SQL生成] tableRanker 选表` 含 totalCandidates / coreCount / topScores |

**`FF_UNIFIED_RANKER=false` 分支**保留完整老逻辑,便于紧急回滚。

### 1.5 `nl2sqlEngine.generateSQL` LIMIT 注入 + Prompt 硬约束

| 位置 | 改动 |
|------|------|
| `nl2sqlEngine.js:1935-1943` | `result.sql.includes('LIMIT')` 子串匹配 → `ensureLimit(result.sql, config.security.maxQueryRows)`。`injected=true` 时记录 info 日志 |
| `nl2sqlEngine.js:1819-1826`(Prompt) | "6. 添加LIMIT限制,默认不超过1000条" → "**【硬性约束】LIMIT 必须存在**:每条 SQL 必须以 LIMIT N 结尾;COUNT/SUM/聚合也要带;反例展示两条错误写法会被拒绝" |

### 1.6 `srDatabase.executeQuery` 兜底(TODO T3)

**位置**:`backend/src/core/srDatabase.js:94-113`

在 `conn.getConnection()` 之前插入:

```js
let finalSql = sql;
if (!hasOuterLimit(sql)) {
  finalSql = ensureLimit(sql, config.srDatabase.maxRows).sql;
  logger.warn('[SR-DB] 执行前补 LIMIT(上游未注入)', { maxRows });
}
```

`conn.query` 改用 `finalSql`,阻止大结果集从 MySQL 整体拉回再 `.slice()`。

### 1.7 `schemaLoader.searchRelevantTables` 签名扩展

**位置**:`backend/src/core/schemaLoader.js:571-692`

```js
// 改造前
async function searchRelevantTables(query, topK = 5, context = {})
// 改造后
async function searchRelevantTables(query, topK = 8, context = {}, options = {})
```

`options.returnRawSignals = true` 时返回富信号给 ranker:

```js
{ vectorResults: [{name, priorityScore, metadata}], explicitTableNames, tableNames }
```

向量路径和关键词回退路径**均支持** `returnRawSignals`(关键词回退路径用 `80 - i*5` 粗略打分填充 priorityScore)。默认 `false` 保持与 Phase 1 所有调用点完全兼容。

`keywordMatchTables` 签名从 `(query, explicitTableNames)` 扩展为 `(query, explicitTableNames, topK = 8)`,内部 `.slice(0, 5)` 改为 `.slice(0, topK)`。

### 1.8 `queryDecomposer` 两处截断改造

**位置**:`backend/src/core/queryDecomposer.js`

| 函数 | 改动 |
|------|------|
| `retrieveTablesByDataUnits:296` | `slice(0, 5)` → `slice(0, 8)`(放宽,交由下游 ranker 裁剪) |
| `mergeTableCandidates:371-410` | `scoredCandidates.slice(0, 5)` → 若 `FF_UNIFIED_RANKER` 启用,走 `tableRanker.rank(keywordMatches=finalScore*10)`,否则保留 slice(0,5) 老行为 |

**新增常量**:`KEYWORD_SCALE = 10`,把 `mergeTableCandidates` 的 0-1 分缩放到 ranker `normalizeKeyword` 的 0-10 有效域。

### 1.9 `agenticEngine.generationPhase:349` 改造

**位置**:`backend/src/core/agenticEngine.js:345-370`

```js
// 改前
const selectedTables = tableResult.recommendedTables?.slice(0, 5) || [];
// 改后
let selectedTables = tableResult.recommendedTables || [];
if (selectedTables.length === 0) {
  const fallback = await schemaLoader.searchRelevantTables(q, 8);
  selectedTables = fallback.map(t => t.name);
}
```

信任上游 `queryDecomposer` 已完成 ranker 排序;空值时 schemaLoader 兜底,不再二次截断。

### 1.10 Feature Flag 与 .env

**位置**:`backend/config/feature-flags.js` + `backend/.env.example`

```js
UNIFIED_RANKER: process.env.FF_UNIFIED_RANKER === 'false' ? false : true
```

注意:这是**默认 true、反向开关**(其他 FF 都是 `=== 'true' || false` 默认 false)。意图是让 ranker 立刻生效,需要回滚时显式设 `FF_UNIFIED_RANKER=false`。

### 1.11 回归测试(`backend/test/phase2/`)

| 脚本 | 依赖 | 覆盖 | 状态 |
|------|------|------|------|
| `test-limit-injection.js` | 无 | hasOuterLimit 正反例 15 条 + ensureLimit 6 条 | ✅ 25/25 |
| `test-tableRanker-unit.js` | 无 | 空信号/仅向量/核心保护/语义加权/explicit/inferred/cap/legacy 回退 9 组 | ✅ 18/18 |
| `test-tableRanker-integration.js` | schema-metadata.json | 5 条复杂用例端到端选表断言(mustInclude / maxSize / coreTableCount) | ✅ 13/13 |
| `test-regression-complex.js` | LLM_API_KEY | processQuery 端到端,断言 sqlKeywords;LIVE 模式断言 rowCount | ⚠️ 未运行(需 LLM key) |
| `fixtures/complex-queries.json` | - | 5 条用例:多维过滤 × 2 / 行为序列 × 2 / 聚合+明细 × 1 | ✅ |
| `README.md` | - | 运行方式 + 验收门槛 | ✅ |

---

## 2. 遗留 TODO(Phase 3+)

| # | 位置 | 性质 | 建议阶段 | 说明 |
|---|------|------|---------|------|
| T1 | `tableRanker.js` `legacySelect` | 临时兼容代码 | Phase 4 | FF_UNIFIED_RANKER 回退分支,稳定运行 2+ 周后可删除 |
| T2 | `nl2sqlEngine.js:1600-1670` | 双路径(ranker / legacy) | Phase 4 | 同上,与 T1 一起收敛 |
| T3 | `queryDecomposer.mergeTableCandidates` | KEYWORD_SCALE=10 魔数 | Phase 4 | 该缩放因子是经验值,与 tableRanker 的 KEYWORD_SCORE_MAX=10 耦合。建议后续提炼到 ranker 参数里 |
| T4 | `srDatabase.executeQuery` 后的应用层 `.slice(maxRows)` | 保留冗余 | Phase 4+ | LIMIT 注入后理论上不会触发,但保留作为"最终一道防线"(CTE/UNION 漏网 + truncated 标志前端使用) |
| T5 | `backend/test/phase2/test-regression-complex.js` | 需要 LLM_API_KEY 才能跑 | 运维层 | 当前在 CI 中需提供 API key 或跳过。建议接入前与 Phase 1 `SR_DATABASE_URL_TEST` 保持同等 opt-in 策略 |
| T6 | `test-tableRanker-integration.js` | `process.chdir(backend/)` | Phase 4 | schema-metadata.json 路径相对 CWD。彻底解决需要 `config.js` 的 `configPath` 改用 `path.join(__dirname, ...)` 绝对化 |
| T7 | `fixtures/complex-queries.json` c3 | `mustIncludeAny` 双分支 | 视 Schema 演进 | 当前 Schema 里不存在独立的 `tzpingtai_tz_sdk_log_pf_first_order`(首充走 pf_order WHERE is_first_order=1)。若 Phase 3+ 新增独立表,收窄为 `mustInclude` |
| T8 | Agentic 引擎入口切换 | 原计划 Phase 3 项 | Phase 3 | `sseHandler` / `app.js` 尚未按 FF 切 legacy/agentic,Phase 2 只确保 agenticEngine 内部逻辑走 ranker |
| T9 | `llmService.js` 完整 Prompt 输出 | 原计划 Phase 3 项 | Phase 3 | 安全收敛项,未处理。见 Phase 1 交接摘要 T5 |

---

## 3. 偏离原计划的变更

| 变更项 | 原计划 | 实际做法 | 原因 |
|-------|-------|---------|------|
| **Prompt 中的反例引号** | 使用 ``` ` ``` 包裹代码样例 | 改用 `"..."` 和裸写 | SQL 生成 Prompt 本身是 template literal(反引号包裹),内嵌反引号会提前闭合字符串,节点加载时 `SyntaxError: Unexpected identifier 'LIMIT'`。语义无损 |
| **`searchRelevantTables` 返回结构** | `{ vectorResults, explicitTableNames }` | 额外加 `tableNames` 字段 | 关键词回退路径下 ranker 需要 fallback table 列表;同时 `tableNames` 能让日志更直观 |
| **打分权重具体值** | 文档只给方向 | 落地 `{vector:0.45, semantic:0.30, keyword:0.15, explicit:0.10}` + CORE_BOOST=30 + INFERRED_BOOST=15 | 文档"归一化到 0-100"需要具体值落地;单测 case 4 中 `p=1,score=1.0` 的 `other_table_x`(semantic=30 分) 超过 `priorityScore=100` 的 `other_table_y`(vector=28.1 分),证明权重设置符合"语义 priority=1 应能逆转向量分"的意图 |
| **回归测试拆分** | 单一 `test-regression-complex.js` | 拆为 `test-tableRanker-integration.js`(无 LLM)+ `test-regression-complex.js`(需 LLM) | 集成测试必须可在 CI / 开发机无 LLM key 时跑通;sqlKeywords 断言离不开真实 LLM,故拆分。前者作为 Phase 2 主验收,后者 opt-in |
| **c3 用例断言** | `mustInclude: [pf_reg, pf_first_order]` | `mustIncludeAny: [[pf_reg, pf_first_order], [pf_reg, pf_order]]` | 核查 `backend/config/business-semantic-layer.json` 发现"首充"概念的 `primary_table = tzpingtai_tz_sdk_log_pf_order`(带 `is_first_order=1` 过滤器),**没有独立 first_order 表**。若强写 `mustInclude`,第一条用例必败。用 `mustIncludeAny` 容纳两种合法 Schema 解读 |
| **`FF_UNIFIED_RANKER` 默认值** | 计划未明确 | 默认 `true`(反向开关) | 与 Phase 1 - 4 FF 模式不同(它们都是默认 `false` 的 opt-in)。Phase 2 的 ranker 是 bug 修复级改造(解决"语义层表被挤出"的关键表丢失),应默认启用;FF 仅用于紧急回滚 |
| **应用层 `.slice(maxRows)` 是否保留** | 计划倾向于"降级为最后防线" | 保留未改 | 结论一致,但未显式做改动,因为原本就是 success 分支后的轻量 slice,不影响执行层性能 |
| **集成测试 CWD 处理** | 计划未提及 | 新增 `process.chdir(path.resolve(__dirname, '../../'))` | schema-metadata.json 路径相对 CWD。计划默认"测试在 backend/ 下运行",但实际 `node backend/test/phase2/...` 常从项目根跑。调整测试脚本兼容两种 CWD。T6 记为长期修整项 |

---

## 4. 验收状态(对齐 Phase 2 验收标准)

| # | 验收标准 | 状态 | 备注 |
|---|---------|------|------|
| 1 | 复杂查询的关键表召回率明显提升(至少不再因固定截断丢关键表) | ✅ | 5 条用例选表全部包含预期核心表;c1/c2 填满到 cap=8 体现动态上限生效;FF_UNIFIED_RANKER=false 回退到 slice(0,5) 作为回滚基线 |
| 2 | 澄清轮次下降,且澄清内容更聚焦缺失信息 | ⚠️ 待观测 | 需上线后采集统计,Phase 2 在代码层面打通了基础 |
| 3 | 新增回归用例通过率 ≥ 85% | ✅ | 集成测试 13/13(100%);端到端 `test-regression-complex.js` 需 LLM key 运行 |

附加目标(Phase 2 纳入):

| # | 目标 | 状态 | 备注 |
|---|------|------|------|
| A1 | LIMIT 注入覆盖最外层 + srDatabase 兜底 | ✅ | test-limit-injection 25/25 |
| A2 | agenticEngine 同步改造 | ✅ | 349 行改为信任 + 兜底,不再 slice(0,5) |
| A3 | 回归测试延续 Phase 1 风格 | ✅ | 原生 assert + 独立脚本,无新依赖 |

---

## 5. Phase 3 起手建议

1. **跑一遍端到端回归**(前提:LLM_API_KEY 已配):
   ```bash
   cd backend
   node test/phase2/test-regression-complex.js
   # LIVE 模式(可选)
   SR_DATABASE_URL_TEST=mysql://user:pw@host:3306/new_tzpingtai \
     node test/phase2/test-regression-complex.js
   ```
   观测 5 条用例的 `sqlKeywords` 命中率与实际选表日志,校准 ranker 权重。

2. **观察 `[SQL生成] tableRanker 选表` 日志**:前 2-3 天关注 `totalCandidates` / `coreCount` / `selected` 分布,若核心表长期不出现或总是 cap=8 塞满,说明权重或 cap 需要调。

3. **Phase 3 优先级**(按原计划):
   - **引擎入口切换**(legacy/agentic):T8,sseHandler 或 app.js 按 FF_AGENTIC_ENGINE 决定走哪条链路,失败回退 legacy
   - **Prompt 日志脱敏**:T9,去掉 llmService 的完整 Prompt console.log,改为长度/hash
   - **数据安全增强**:敏感字段脱敏、行级权限、审计字段

4. **若 Phase 2 稳定 2 周**,收敛 T1 / T2:从 tableRanker.js 和 nl2sqlEngine.js 中删掉 legacy 分支,FF_UNIFIED_RANKER 作为 deprecated 标记。

---

## 6. 关键文件索引

| 文件 | 角色 | 变更 |
|------|------|------|
| `backend/src/utils/sqlLimit.js` | 新增 | hasOuterLimit / ensureLimit |
| `backend/src/utils/tableScope.js` | 新增 | inferScopeSubtype(从 vectorStore 迁出) / isCoreTable |
| `backend/src/core/tableRanker.js` | 新增 | 4 信号融合打分 + 核心保护 + cap=8 + FF 回退 |
| `backend/src/core/nl2sqlEngine.js` | 修改 | 主路径 1581-1675 走 ranker;1936 换 ensureLimit;Prompt LIMIT 硬约束 |
| `backend/src/core/schemaLoader.js` | 修改 | searchRelevantTables 增 options.returnRawSignals;keywordMatchTables topK |
| `backend/src/core/queryDecomposer.js` | 修改 | retrieveTablesByDataUnits slice→8;mergeTableCandidates 接入 ranker |
| `backend/src/core/agenticEngine.js` | 修改 | generationPhase:349 信任 + 兜底,去掉 slice(0,5) |
| `backend/src/core/srDatabase.js` | 修改 | executeQuery 前 ensureLimit 兜底 |
| `backend/src/memory/vectorStore.js` | 修改 | inferScopeSubtype 切为 require('../utils/tableScope') |
| `backend/config/feature-flags.js` | 修改 | 新增 UNIFIED_RANKER(默认 true,反向开关) |
| `backend/.env.example` | 修改 | 新增 FF_UNIFIED_RANKER 说明 |
| `backend/test/phase2/` | 新增 | 4 个 test-*.js + fixtures/complex-queries.json + README.md |
