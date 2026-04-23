# 批次 A 交接摘要:Prompt 日期 + history 注入(止血)

> 所属计划:[NL2SQL-澄清断链修复计划.md](./NL2SQL-澄清断链修复计划.md)
> 批次文档:[NL2SQL-澄清断链修复-批次A-Prompt注入.md](./NL2SQL-澄清断链修复-批次A-Prompt注入.md)
> 完成日期:2026-04-23
> 覆盖根因:R2(Prompt 无日期)、R4(未传 history)
> 独立可发布:✅

---

## 1. 已修改的核心接口和逻辑

### 1.1 `backend/src/core/agenticEngine.js`

**`buildSQLPrompt(decomposition, schemaDetail, context = {})` — 重写**

签名扩展一个 `context` 参数(带默认值,老调用点零成本兼容)。行为变化:

| 新增小节 | 内容来源 |
|---------|---------|
| `## 当前时间` | `new Date()` 格式化 `YYYY-MM-DD HH:mm:ss`,LLM 以此作为相对时间/缺省年份锚点 |
| `## 对话上下文(最近 3 轮 user 消息)` | `tokenBudget.trimHistory(context.history, 3).history` 过滤 `role==='user'` |
| `## 澄清记录` | `decomposition.clarificationHistory.slice(-5)` 渲染为 `Q:/A:` 对 |
| `## 数据需求单元` | 改用 `formatUnitVerbose` 渲染,含 `filters / timeRange / metric / outputFields` |
| `## 生成要求` | 新增第 3、4 条:typeid/int_key* 必须落 WHERE;缺省年份用"当前时间" |

回滚开关:`PROMPT_INJECT_NOW=false` → 走 `buildSQLPromptLegacy`(保留旧格式,零变更)。

**`buildSQLPromptLegacy(decomposition, schemaDetail)` — 新增**

原 `buildSQLPrompt` 主体直接搬过来,供环境变量回退使用。不对外导出。

**`generationPhase` 调用点(行 368) — 修改**

```diff
- const sqlPrompt = this.buildSQLPrompt(decomposition, schemaDetail);
+ const sqlPrompt = this.buildSQLPrompt(decomposition, schemaDetail, context);
```

`context` 原本已在 `processQuery` 里透传到 `generationPhase`,本次只是把它继续传到 `buildSQLPrompt`。

**`formatUnitVerbose(u)` — 新增(模块级辅助函数,紧跟 `sendProgress` 之后)**

把单个 `dataUnit` 序列化为多行文本。所有字段 optional,缺失跳过,不 throw。输出示例:

```
- [基础属性筛选] 类型
  filters: typeid=1743, int_key5=30
  timeRange: 2026-03-28 ~ 2026-04-12 on create_time
```

### 1.2 `backend/.env.example`

新增小节"澄清断链修复 - 批次 A",导出:

```bash
PROMPT_INJECT_NOW=true   # 默认 true;关闭后回退 buildSQLPromptLegacy
```

### 1.3 `backend/test/phase3/sql-prompt-date.test.js`(新增)

6 用例 / 18 断言:
1. 默认含当前年份 + `## 当前时间` 小节 + `originalQuery` 原文
2. `context.history` 最近 3 轮 user 消息注入,assistant 消息被过滤
3. `dataUnits.filters` 的 `typeid=1743` 落 prompt,`timeRange.start/field` 落 prompt
4. `clarificationHistory` 回答文本注入
5. `PROMPT_INJECT_NOW=false` 回退到旧 Prompt 格式
6. 空/缺省字段不 throw(健壮性兜底)

---

## 2. 验收结果

- ✅ `node test/phase3/sql-prompt-date.test.js` → 18/18 pass
- ✅ Phase 3 全量回归(test-auditMigration / test-fallback-integration / test-masking / test-requestContext / test-safeLog / test-sqlRewriter)→ 30+20+43+23+23+38 = **177/177 pass**
- ⏳ 手工 smoke(真实 LLM 链路验证 typeid=1743 + 2026 年份落 SQL):留给批次 B 上线前一起跑,本批次只覆盖 Prompt 构造逻辑。

---

## 3. 遗留到下一阶段的临时代码(TODOs)

> 本批次**没有引入 TODO 注释**或临时兜底代码。`buildSQLPromptLegacy` 是显式的回退开关实现,不是 TODO。

以下是**留给批次 B / C 处理**的已知限制,不属于本批次 TODO,仅列作交接信息:

| 条目 | 说明 | 下个批次 |
|------|------|---------|
| `context.history` 实际内容 | 当前 `sseHandler` 传给引擎的 `context.history` 是否已含第一轮 originalQuery + 澄清回答,在澄清回合未验证 | 批次 B(澄清断链修复) |
| `decomposition.clarificationHistory` 持续性 | 澄清直接 return 不落库,二轮请求读不到第一轮的 clarificationHistory → Prompt 的 `## 澄清记录` 会是 `(无)` | 批次 B(resumeFromClarification + persistAgenticMessages) |
| Schema 检索入参 token 丢失 | `schemaDiscoveryPhase` 的 `searchQuery = entities.join(' ')` 仍会丢 `typeid`/`int_key*` 物理 token,即使 Prompt 已正确注入,检索到的表可能不含目标列 | 批次 C(R3) |
| smoke 验证 | 真实链路端到端 smoke 未跑,等批次 B 把澄清链路接通后一起验证 | 批次 B 验收一起做 |

---

## 4. 偏离初始计划的变更及其原因

### 4.1 `trimHistory` 返回值处理修正(对设计稿的修正)

**偏离点**:计划文档 §2.1 写的是:

```js
const recentHistory = tokenBudget.trimHistory(context.history || [], 3)
  .filter(m => m.role === 'user')
  .map(...)
```

直接在 `trimHistory` 返回值上链式 `.filter`。

**实际情况**:`backend/src/utils/tokenBudget.js:227-253` 的 `trimHistory` 返回的是对象 `{ trimmed, history, removed }`,不是数组。按设计稿直接链式调用会 `TypeError`。

**实际实现**:先取 `.history`,并做 `Array.isArray` 兜底以防未来返回形态调整:

```js
const trimmed = tokenBudget.trimHistory(context.history || [], 3);
const trimmedHistory = Array.isArray(trimmed) ? trimmed : (trimmed?.history || []);
const recentHistory = trimmedHistory.filter(m => m && m.role === 'user' && ...)
```

**原因**:设计稿笔误,不是方案变更。无需回滚或告警。

### 4.2 测试框架:Jest 语法 → plain Node assert

**偏离点**:计划文档 §4 使用 `describe/it/expect` 的 Jest 语法。

**实际情况**:`backend/package.json` 没有 Jest,现有 Phase 3 全部 177 条回归测试都走 **plain Node + 原生 `assert`** 风格(例如 `test-safeLog.js` 的 `ok(cond, msg)` 模式)。引入 Jest 会污染依赖树、拖慢 CI、且必须同步改造老测试。

**实际实现**:`sql-prompt-date.test.js` 用 `node backend/test/phase3/sql-prompt-date.test.js` 直接跑,与 Phase 3 既有风格完全一致。文件名保留设计稿的 `sql-prompt-date.test.js`(未加 `test-` 前缀),文件命名风格与既有测试略有不同,但不影响运行方式。

**原因**:与仓库约定对齐。若后续全项目迁移 Jest,再统一调整。

### 4.3 `formatUnitVerbose` 位置:类内方法 → 模块级函数

**偏离点**:计划文档 §2.1 把 `formatUnitVerbose` 写在 `buildSQLPrompt` 下方,暗示是类方法。

**实际情况**:放在了模块末尾 `sendProgress` 之后(辅助函数区域)。

**原因**:该函数无状态、不依赖 `this`,属纯格式化工具。放类外与 `sendProgress` 同层,保持类接口整洁,也避免后续有人误加实例状态。未来如需跨模块复用,可直接 export。

### 4.4 `formatUnitVerbose` 的健壮性加强

**偏离点**:计划文档的 `formatUnitVerbose` 对 filter 对象的 `f` 字段缺失、filter 数组空项未做防御。

**实际实现**:增加了 `if (!u) return '';`、`if (!f) return '';` 以及 `filter(Boolean)` 去空串,对 `metric.value` 用 `??` 而不是 `||`(区分 0 和缺省)。

**原因**:老 decomposition 字段不稳定,历史 bug 曾出现 `filters: [null]` 的情况;加固后不会因为一个坏记录让整次生成 throw。测试 case 6 已覆盖。

---

## 5. 回滚步骤

1. **热回滚**:在运行环境设置 `PROMPT_INJECT_NOW=false` 后重启 backend,立即恢复老 Prompt 行为。无需改代码。
2. **代码回滚**:若需彻底撤下本批次,按 commit 粒度 revert 即可(`agenticEngine.js` / `.env.example` / `sql-prompt-date.test.js`),无数据库迁移、无配置文件迁移、无 schema 变更。

---

## 6. 下批次对接说明

- **批次 B** 新增的 `resumeFromClarification` 生成 `context.history` 时,建议把"第一轮用户原 query + 澄清回答"一并塞入,这样批次 A 的 `## 对话上下文` 小节会自动带上全部上下文,**无需二次改 `buildSQLPrompt`**。
- **批次 B** 落库 `decomposition.clarificationHistory` 后,本批次的 `## 澄清记录` 小节会自动生效。
- **批次 C** 若扩展 `searchQuery` 加上原始 query 物理 token,不影响本批次的 Prompt 注入逻辑,两者正交。
