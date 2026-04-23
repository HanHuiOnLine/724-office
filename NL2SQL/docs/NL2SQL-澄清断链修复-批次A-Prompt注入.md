# 批次 A：Prompt 日期 + history 注入（止血）

> 总览：[NL2SQL-澄清断链修复计划.md](./NL2SQL-澄清断链修复计划.md)
> 预估工时：0.5 天
> 覆盖根因：R2（Prompt 无日期）、R4（未传 history）
> 独立可发布：✅（不依赖其他批次）

---

## 1. 目标

即使暂不修澄清断链，也要保证：

- **G2a**：生成的 SQL 年份不再出现 2024（用户用"3月28日-4月12日"时自动补当前年）。
- **G2b**：用户一轮就给全信息时 SQL 包含 `typeid / int_key*` 等物理约束。

---

## 2. 设计

### 2.1 `agenticEngine.buildSQLPrompt` 改造

```js
function buildSQLPrompt(decomposition, schemaDetail, context = {}) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const tokenBudget = require('../utils/tokenBudget');
  const recentHistory = tokenBudget.trimHistory(context.history || [], 3)
    .filter(m => m.role === 'user')
    .map(m => `- user: ${m.content}`)
    .join('\n');

  const clarifications = (decomposition.clarificationHistory || [])
    .slice(-5)
    .map(h => `Q: ${h.question}\nA: ${h.answer}`)
    .join('\n\n');

  return `基于以下信息,生成 SQL 查询语句。

## 当前时间
${now}（所有相对时间/缺省年份以此为锚点）

## 查询需求(原文)
${decomposition.originalQuery}

## 对话上下文(最近 3 轮 user 消息)
${recentHistory || '(无)'}

## 澄清记录
${clarifications || '(无)'}

## 数据需求单元
${(decomposition.dataUnits || []).map(formatUnitVerbose).join('\n') || '(无)'}

## 可用表结构
${schemaDetail}

## 生成要求
1. 符合 MySQL 语法
2. 时间字段格式 YYYY-MM-DD HH:mm:ss
3. 用户给出的 typeid / int_key* 等物理约束必须落到 WHERE
4. 用户需求缺省年份时,使用"当前时间"的年份
5. 输出 JSON: { "sql": "...", "explanation": "...", "selectedTables": [...] }
`;
}

function formatUnitVerbose(u) {
  const lines = [`- [${u.type}] ${u.description}`];
  if (u.filters?.length) {
    lines.push(`  filters: ${u.filters.map(f => `${f.field}${f.operator||'='}${f.value}`).join(', ')}`);
  }
  if (u.timeRange?.start || u.timeRange?.end) {
    lines.push(`  timeRange: ${u.timeRange.start || '?'} ~ ${u.timeRange.end || '?'} on ${u.timeRange.field || '?'}`);
  }
  if (u.metric) lines.push(`  metric: ${u.metric} ${u.operator||''} ${u.value||''}`);
  if (u.outputFields?.length) lines.push(`  outputFields: ${u.outputFields.join(', ')}`);
  return lines.join('\n');
}
```

### 2.2 调用点改造

`agenticEngine.generationPhase` 传递 context：

```js
// 改动前
const sqlPrompt = this.buildSQLPrompt(decomposition, schemaDetail);
// 改动后
const sqlPrompt = this.buildSQLPrompt(decomposition, schemaDetail, context);
```

### 2.3 回滚开关

环境变量 `PROMPT_INJECT_NOW=true`（默认 true），为 false 时退回原 prompt：

```js
if (process.env.PROMPT_INJECT_NOW === 'false') {
  return originalBuildSQLPrompt(decomposition, schemaDetail);
}
```

---

## 3. 代码清单

| # | 文件 | 改动类型 | 改动说明 | 工作量 |
|---|------|---------|----------|--------|
| A-1 | `backend/src/core/agenticEngine.js` | 修改 | `buildSQLPrompt` 注入 `now / history / clarificationHistory / unit verbose`；新增 `formatUnitVerbose` 内部函数；`generationPhase` 调用点透传 `context` | 1h |
| A-2 | `backend/src/core/agenticEngine.js` | 修改 | `PROMPT_INJECT_NOW=false` 时回退旧实现（保留旧函数副本 `buildSQLPromptLegacy`） | 30min |
| A-3 | `backend/src/utils/tokenBudget.js` | 复用 | 验证 `trimHistory(history, 3)` 已存在；若未导出需 export | 15min |
| A-4 | `backend/test/phase3/sql-prompt-date.test.js` | 新增 | 单测：见 §4 | 1.5h |
| A-5 | `backend/.env.example` | 修改 | 追加 `PROMPT_INJECT_NOW=true` 及注释 | 15min |

---

## 4. 测试用例

`backend/test/phase3/sql-prompt-date.test.js`：

```js
const agenticEngine = require('../../src/core/agenticEngine');

describe('buildSQLPrompt 日期与 history 注入', () => {
  const engine = new agenticEngine.AgenticNL2SQLEngine();

  it('默认包含当前年份字符串', () => {
    const prompt = engine.buildSQLPrompt(
      { originalQuery: '查 3月28日-4月12日的数据', dataUnits: [] },
      'TABLE foo',
      {}
    );
    const currentYear = new Date().getFullYear().toString();
    expect(prompt).toContain(currentYear);
    expect(prompt).toContain('当前时间');
  });

  it('context.history 最近 3 轮 user 消息进入 prompt', () => {
    const prompt = engine.buildSQLPrompt(
      { originalQuery: 'x', dataUnits: [] },
      'TABLE foo',
      { history: [
        { role: 'user', content: '我要查青木游戏' },
        { role: 'assistant', content: '好的' },
        { role: 'user', content: 'typeid=1743' }
      ]}
    );
    expect(prompt).toContain('typeid=1743');
    expect(prompt).toContain('青木游戏');
  });

  it('dataUnits.filters 必须落到 prompt', () => {
    const prompt = engine.buildSQLPrompt(
      { originalQuery: 'x', dataUnits: [
        { type:'基础属性筛选', description:'类型', filters:[{field:'typeid',operator:'=',value:1743}] }
      ]},
      'TABLE foo',
      {}
    );
    expect(prompt).toContain('typeid=1743');
  });

  it('PROMPT_INJECT_NOW=false 回退旧实现', () => {
    process.env.PROMPT_INJECT_NOW = 'false';
    const prompt = engine.buildSQLPrompt(
      { originalQuery: 'x', dataUnits: [] },
      'TABLE foo',
      {}
    );
    expect(prompt).not.toContain('当前时间');
    delete process.env.PROMPT_INJECT_NOW;
  });
});
```

---

## 5. 验收标准

1. `npm test -- test/phase3/sql-prompt-date.test.js` 全绿。
2. Phase 3 全量回归 177 条仍全绿。
3. 手工 smoke：对本案例 query 一次性输入所有信息，生成 SQL 含 `typeid = 1743`、`int_key5`、且时间区间为 `2026-xx-xx`。

---

## 6. 回滚

- 环境变量 `PROMPT_INJECT_NOW=false` 立即回退。
- 代码层面保留 `buildSQLPromptLegacy`，无需 revert 合并。

---

## 7. 风险

- **Prompt 变长**：已通过 `trimHistory(..., 3)` 兜底；`clarificationHistory` 限制 `.slice(-5)`。
- **formatUnitVerbose 对老 decomposition 兼容**：所有字段都 optional，缺字段时跳过该行，不 throw。
