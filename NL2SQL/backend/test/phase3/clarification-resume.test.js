/**
 * 批次 B 单测:agenticEngine.resumeFromClarification
 *
 * 用 mock 绕过真实 LLM / schemaLoader / queryDecomposer,
 * 验证:
 *  1. 应用 clarification(uncovered_data_unit)后,updatedDecomposition 含 typeid=1743 + int_key5
 *  2. LLM 收到的 prompt 必含 typeid=1743 / int_key5(批次 A 的 Prompt 注入生效)
 *  3. 最终结果 SQL 命中 mock 返回的 SQL,含 typeid=1743 / int_key5
 *  4. traceLog 至少含 apply_clarification / table_retrieval / generation / verification
 *
 * 运行:node backend/test/phase3/clarification-resume.test.js
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'warn';
// 确保批次 A 的 Prompt 注入开启(默认 true,这里显式兜底)
delete process.env.PROMPT_INJECT_NOW;

const path = require('path');

// 先 mock llmService,再 require engine(agenticEngine 内 require 时拿到 mock 引用)
const llmService = require(path.resolve(__dirname, '../../src/core/llmService'));
const schemaLoader = require(path.resolve(__dirname, '../../src/core/schemaLoader'));
const queryDecomposer = require(path.resolve(__dirname, '../../src/core/queryDecomposer'));
const schemaTools = require(path.resolve(__dirname, '../../src/core/schemaTools'));

// 保存原始实现以便最后恢复
const origSimpleChat = llmService.simpleChat;
const origGetLevel2Detail = schemaLoader.getLevel2Detail;
const origTableExists = schemaLoader.tableExists;
const origRetrieveTables = queryDecomposer.retrieveTablesByDataUnits;
const origGetLevel1Index = schemaTools.getLevel1Index;

// Mock 固定返回值,避免真实网络/DB 调用
schemaLoader.getLevel2Detail = () => 'MOCK TABLE foo (typeid INT, int_key5 INT, create_time DATETIME)';
schemaLoader.tableExists = () => true;
schemaLoader.searchRelevantTables = async () => [{ name: 'foo' }];
schemaTools.getLevel1Index = () => ({ tables: [] });
queryDecomposer.retrieveTablesByDataUnits = async (decomposition) => ({
  decomposition,
  tableCandidates: [{ table: { name: 'foo', description: 'mock' }, units: ['u1', 'u2'], score: 2 }],
  recommendedTables: ['foo']
});

// 记录最近一次 LLM 收到的 prompt,供断言批次 A Prompt 注入
let lastPrompt = '';
llmService.simpleChat = async (_system, prompt) => {
  lastPrompt = String(prompt || '');
  // 返回一段合规 JSON,触发 parseSQLResponse → verificationPhase pass
  return JSON.stringify({
    sql: 'SELECT int_key5, typeid FROM foo WHERE typeid = 1743 AND create_time >= \'2026-03-28 00:00:00\'',
    explanation: 'mock',
    selectedTables: ['foo']
  });
};

const agenticEngine = require(path.resolve(__dirname, '../../src/core/agenticEngine'));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

(async () => {
  // ========================================
  // case 1: 澄清回答里含 typeid=1743 + int_key5,应被抽入 decomposition 并落入 SQL
  // ========================================
  console.log('\n[resumeFromClarification 端到端:typeid=1743 + int_key5]');
  {
    const decomposition = {
      originalQuery: '取 typeid=1743 的数据, int_key5 为战场等级, 时间 2026-03-28~04-12',
      primaryEntity: '玩家',
      dataUnits: [
        {
          id: 'u1', type: '基础属性筛选', description: '类型筛选',
          filters: [] // 原始为空,等澄清补充
        },
        {
          id: 'u2', type: '输出字段需求', description: '战场等级',
          outputFields: []
        }
      ]
    };
    const clarification = {
      clarificationType: 'general',
      details: { uncoveredUnits: [{ id: 'u1' }, { id: 'u2' }] },
      question: '请提供具体 typeid 和字段'
    };

    const engine = new agenticEngine.AgenticNL2SQLEngine();
    const result = await engine.resumeFromClarification({
      originalQuery: decomposition.originalQuery,
      decomposition,
      clarification,
      userAnswer: '通过 int_key5 字段, typeid=1743',
      context: {
        sessionId: 'sid-resume-test',
        history: [
          { role: 'user', content: decomposition.originalQuery }
        ]
      }
    });

    ok(result && result.resumed === true, 'result.resumed === true');
    ok(result.success === true, 'result.success === true');
    ok(result.type === 'sql_result', "result.type === 'sql_result'");
    ok(typeof result.sql === 'string' && result.sql.length > 0, 'result.sql 非空');
    ok(/typeid\s*=\s*1743/i.test(result.sql), 'SQL 含 typeid = 1743');
    ok(/int_key5/i.test(result.sql), 'SQL 含 int_key5');

    // 验证 updatedDecomposition
    ok(result.decomposition && result.decomposition.clarified === true, 'decomposition.clarified=true');
    const u1Filters = result.decomposition.dataUnits.find(u => u.id === 'u1').filters || [];
    ok(
      u1Filters.find(f => f.field === 'typeid' && f.value === 1743),
      'u1.filters 含 typeid=1743'
    );
    const u2Outs = result.decomposition.dataUnits.find(u => u.id === 'u2').outputFields || [];
    ok(u2Outs.includes('int_key5'), 'u2.outputFields 含 int_key5');

    // 验证 Prompt 注入(批次 A)
    ok(lastPrompt.includes('typeid=1743'), 'LLM prompt 含 typeid=1743(批次 A 注入)');
    ok(lastPrompt.includes('int_key5'), 'LLM prompt 含 int_key5');
    ok(lastPrompt.includes('## 当前时间'), "LLM prompt 含 '## 当前时间' 小节");
    ok(lastPrompt.includes('## 澄清记录'), "LLM prompt 含 '## 澄清记录' 小节");
    ok(lastPrompt.includes('通过 int_key5 字段'), '澄清记录包含用户回答原文');

    // 验证 traceLog
    const phases = (result.traceLog || []).map(t => t.phase);
    ok(phases.includes('apply_clarification'), "traceLog 含 'apply_clarification'");
    ok(phases.includes('table_retrieval'), "traceLog 含 'table_retrieval'");
    ok(phases.includes('generation'), "traceLog 含 'generation'");
    ok(phases.includes('verification'), "traceLog 含 'verification'");

    // originalQuery 被锁回
    ok(
      result.decomposition.originalQuery === decomposition.originalQuery,
      'decomposition.originalQuery 被锁回第一轮原文'
    );
  }

  // ========================================
  // case 2: 验证失败 → recoveryPhase 触发(mock LLM 首次返回空 SQL,触发 verification 失败)
  // ========================================
  console.log('\n[验证失败触发 recoveryPhase]');
  {
    let callCount = 0;
    llmService.simpleChat = async (_s, p) => {
      callCount++;
      if (callCount === 1) {
        // 首次返回无 SELECT 的垃圾,触发 verification 失败
        return JSON.stringify({ sql: 'BROKEN SQL', explanation: '', selectedTables: ['foo'] });
      }
      // recoveryPhase 再次调用时返回合规 SQL
      return JSON.stringify({
        sql: 'SELECT 1 FROM foo WHERE typeid = 1743',
        explanation: 'recovered',
        selectedTables: ['foo']
      });
    };

    const engine = new agenticEngine.AgenticNL2SQLEngine();
    const result = await engine.resumeFromClarification({
      originalQuery: 'x',
      decomposition: { originalQuery: 'x', dataUnits: [{ id: 'u1', filters: [] }] },
      clarification: { clarificationType: 'general', details: { uncoveredUnits: [{ id: 'u1' }] } },
      userAnswer: 'typeid=1743',
      context: { sessionId: 'sid-recovery' }
    });
    const phases = (result.traceLog || []).map(t => t.phase);
    ok(phases.includes('verification'), 'verification 阶段执行');
    // BROKEN SQL 含 SQL 关键字但无 SELECT/FROM → 不通过 basic_syntax
    // recoveryPhase 被触发说明 verification 判为失败
    // 注意:recoveryPhase 分类 UNKNOWN 时直接返回 success:false,此分支只验证 recoveryPhase 被触发即可
    ok(phases.includes('recovery') || result.success === false,
      'verification 失败后走 recovery 或最终失败返回');
  }

  // ========================================
  // case 3 (B-15): recovery UNKNOWN 失败 + 原 SQL 基本语法完整 → 降级为可用+警告
  // ========================================
  console.log('\n[B-15 降级:原 SQL 基本语法完整时保留 + 警告]');
  {
    // mock verification 失败场景:LLM 返回一个引用不存在表的 SQL(tableExists=false)
    // 让 verification.table_exists 失败,recovery 分类为 UNKNOWN(我们的错误串无关键词)
    schemaLoader.tableExists = (t) => t === 'foo'; // 只 foo 存在
    llmService.simpleChat = async () => JSON.stringify({
      sql: 'SELECT typeid, int_key5 FROM nonexistent_table WHERE typeid = 1743',
      explanation: 'user 原意 SQL',
      selectedTables: ['nonexistent_table']
    });

    const engine = new agenticEngine.AgenticNL2SQLEngine();
    const result = await engine.resumeFromClarification({
      originalQuery: 'x',
      decomposition: { originalQuery: 'x', dataUnits: [{ id: 'u1', filters: [] }] },
      clarification: { clarificationType: 'general', details: { uncoveredUnits: [{ id: 'u1' }] } },
      userAnswer: 'typeid=1743',
      context: { sessionId: 'sid-b15' }
    });

    ok(result.type === 'sql_result', "type='sql_result'(降级保留)");
    ok(result.success === true, 'success=true(降级为可用+警告)');
    ok(/typeid\s*=\s*1743/i.test(result.sql || ''), 'SQL 被保留含原内容');
    ok(typeof result.verificationWarning === 'string' && result.verificationWarning.length > 0,
      'verificationWarning 字段非空');
    ok(/请人工核对/.test(result.explanation || ''), 'explanation 含警告文案');
    const phases = (result.traceLog || []).map(t => t.phase);
    ok(phases.includes('recovery_fallback'), "traceLog 含 'recovery_fallback'");

    // 恢复 tableExists
    schemaLoader.tableExists = origTableExists;
  }

  // ========================================
  // case 4 (B-15): 原 SQL 破损(无 SELECT) + recovery 失败 → type='error'
  // ========================================
  console.log('\n[B-15 无合法 SQL 时返回 type=error]');
  {
    llmService.simpleChat = async () => JSON.stringify({
      sql: 'GIBBERISH NO SQL HERE',
      explanation: '',
      selectedTables: ['foo']
    });

    const engine = new agenticEngine.AgenticNL2SQLEngine();
    const result = await engine.resumeFromClarification({
      originalQuery: 'x',
      decomposition: { originalQuery: 'x', dataUnits: [{ id: 'u1', filters: [] }] },
      clarification: { clarificationType: 'general', details: { uncoveredUnits: [{ id: 'u1' }] } },
      userAnswer: 'x',
      context: { sessionId: 'sid-b15-err' }
    });

    ok(result.type === 'error', "type='error'(彻底无 SQL 可用)");
    ok(result.success === false, 'success=false');
    ok(typeof result.error === 'string' && result.error.length > 0, 'error 字段非空');
  }

  // ========================================
  // 恢复原函数,避免影响其他测试
  // ========================================
  llmService.simpleChat = origSimpleChat;
  schemaLoader.getLevel2Detail = origGetLevel2Detail;
  schemaLoader.tableExists = origTableExists;
  queryDecomposer.retrieveTablesByDataUnits = origRetrieveTables;
  schemaTools.getLevel1Index = origGetLevel1Index;

  console.log(`\n===== 结果 pass=${pass} fail=${fail} =====`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
