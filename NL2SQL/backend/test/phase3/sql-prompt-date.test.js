/**
 * 批次 A 单测:agenticEngine.buildSQLPrompt 的时间 / history / clarification / filters 注入
 *
 * 运行:node backend/test/phase3/sql-prompt-date.test.js
 * 无外部依赖,原生 assert,match 项目现有测试风格(phase3/test-safeLog.js)。
 */

const path = require('path');

// 确保默认开关行为:批次A 默认启用注入
delete process.env.PROMPT_INJECT_NOW;

const agenticEngine = require(path.resolve(__dirname, '../../src/core/agenticEngine'));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

const engine = new agenticEngine.AgenticNL2SQLEngine();

// ========================================
// case 1: 默认含当前年份 + "当前时间" 小节
// ========================================
console.log('\n[buildSQLPrompt 默认注入当前时间]');
{
  const prompt = engine.buildSQLPrompt(
    { originalQuery: '查 3月28日-4月12日的数据', dataUnits: [] },
    'TABLE foo',
    {}
  );
  const currentYear = String(new Date().getFullYear());
  ok(prompt.includes(currentYear), `prompt 含当前年份 ${currentYear}`);
  ok(prompt.includes('## 当前时间'), 'prompt 含 "## 当前时间" 小节');
  ok(prompt.includes('查 3月28日-4月12日的数据'), 'prompt 含 originalQuery 原文');
}

// ========================================
// case 2: context.history 最近 3 轮 user 消息进入 prompt
// ========================================
console.log('\n[context.history 注入]');
{
  const prompt = engine.buildSQLPrompt(
    { originalQuery: 'x', dataUnits: [] },
    'TABLE foo',
    {
      history: [
        { role: 'user', content: '我要查青木游戏' },
        { role: 'assistant', content: '好的' },
        { role: 'user', content: 'typeid=1743' }
      ]
    }
  );
  ok(prompt.includes('typeid=1743'), '最近一轮 user 消息 typeid=1743 注入');
  ok(prompt.includes('青木游戏'), '较早一轮 user 消息 青木游戏 注入');
  ok(prompt.includes('## 对话上下文'), 'prompt 含 "## 对话上下文" 小节');
  // assistant 消息不应出现在 "对话上下文" 里
  // (用粗筛:context 段只过滤 user,assistant 具体字串可以先看不存在)
  ok(!prompt.includes('- user: 好的'), 'assistant 消息不被当作 user 消息注入');
}

// ========================================
// case 3: dataUnits.filters 必须落到 prompt
// ========================================
console.log('\n[dataUnits.filters 落 prompt]');
{
  const prompt = engine.buildSQLPrompt(
    {
      originalQuery: 'x',
      dataUnits: [
        {
          type: '基础属性筛选',
          description: '类型',
          filters: [{ field: 'typeid', operator: '=', value: 1743 }]
        },
        {
          type: '时间区间',
          description: '时间',
          timeRange: { start: '2026-03-28', end: '2026-04-12', field: 'create_time' }
        }
      ]
    },
    'TABLE foo',
    {}
  );
  ok(prompt.includes('typeid=1743'), 'filters 中 typeid=1743 落 prompt');
  ok(prompt.includes('2026-03-28'), 'timeRange 起始时间落 prompt');
  ok(prompt.includes('create_time'), 'timeRange.field 落 prompt');
}

// ========================================
// case 4: clarificationHistory 最近 5 条注入
// ========================================
console.log('\n[clarificationHistory 注入]');
{
  const prompt = engine.buildSQLPrompt(
    {
      originalQuery: 'x',
      dataUnits: [],
      clarificationHistory: [
        { question: '要哪个游戏?', answer: '青木天下' },
        { question: '时间段?', answer: '3月28日-4月12日' }
      ]
    },
    'TABLE foo',
    {}
  );
  ok(prompt.includes('## 澄清记录'), 'prompt 含 "## 澄清记录" 小节');
  ok(prompt.includes('青木天下'), 'clarification 回答 青木天下 注入');
  ok(prompt.includes('3月28日-4月12日'), 'clarification 回答 时间段 注入');
}

// ========================================
// case 5: PROMPT_INJECT_NOW=false 回退旧实现
// ========================================
console.log('\n[PROMPT_INJECT_NOW=false 回退]');
{
  process.env.PROMPT_INJECT_NOW = 'false';
  const prompt = engine.buildSQLPrompt(
    { originalQuery: 'x', dataUnits: [] },
    'TABLE foo',
    {}
  );
  ok(!prompt.includes('## 当前时间'), '回退后 prompt 不含 "## 当前时间"');
  ok(!prompt.includes('## 对话上下文'), '回退后 prompt 不含 "## 对话上下文"');
  ok(prompt.includes('## 查询需求'), '回退后 prompt 仍含 "## 查询需求"(旧格式)');
  delete process.env.PROMPT_INJECT_NOW;
}

// ========================================
// case 6: 空/缺失字段不 throw
// ========================================
console.log('\n[缺省字段健壮性]');
{
  let threw = false;
  try {
    engine.buildSQLPrompt({}, '', {});
  } catch (e) {
    threw = true;
    console.error('  throw:', e.message);
  }
  ok(!threw, '空 decomposition / schemaDetail / context 不 throw');

  let threw2 = false;
  try {
    // 老 decomposition 缺 clarificationHistory / filters / timeRange
    engine.buildSQLPrompt(
      { originalQuery: 'x', dataUnits: [{ type: 't', description: 'd' }] },
      'TABLE foo'
    );
  } catch (e) {
    threw2 = true;
    console.error('  throw:', e.message);
  }
  ok(!threw2, '老 decomposition 兼容不 throw');
}

// ========================================
// 总结
// ========================================
console.log(`\n===== 结果 pass=${pass} fail=${fail} =====`);
if (fail > 0) process.exit(1);
