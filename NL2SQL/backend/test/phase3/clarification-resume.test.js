/**
 * 批次 B 单测:agenticEngine.resumeFromClarification
 *
 * 用 mock 绕过真实 LLM / schemaLoader / queryDecomposer / sqlExecutor / database,
 * 验证:
 *  1. 应用 clarification(uncovered_data_unit)后,updatedDecomposition 含 typeid=1743 + int_key5
 *  2. LLM 收到的 prompt 必含 typeid=1743 / int_key5(批次 A 的 Prompt 注入生效)
 *  3. 最终结果 SQL 命中 mock 返回的 SQL,含 typeid=1743 / int_key5
 *  4. 【批次 D3】最终响应升级为 type='result' + data + executionTime,
 *     成功路径写 markQueryHistorySuccess,降级路径仍带 verificationWarning
 *  5. traceLog 至少含 apply_clarification / table_retrieval / generation / verification / execution
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
const sqlExecutor = require(path.resolve(__dirname, '../../src/core/sqlExecutor'));
const database = require(path.resolve(__dirname, '../../src/core/database'));

// 保存原始实现以便最后恢复
const origSimpleChat = llmService.simpleChat;
const origGetLevel2Detail = schemaLoader.getLevel2Detail;
const origTableExists = schemaLoader.tableExists;
const origRetrieveTables = queryDecomposer.retrieveTablesByDataUnits;
const origGetLevel1Index = schemaTools.getLevel1Index;
const origValidateSQL = sqlExecutor.validateSQL;
const origExecuteQuery = sqlExecutor.executeQuery;
const origCreateQueryHistory = database.createQueryHistory;
const origMarkSuccess = database.markQueryHistorySuccess;
const origMarkFailure = database.markQueryHistoryFailure;

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

// 【批次 D3】mock sqlExecutor:默认认为校验通过且执行返回 1 行结果
sqlExecutor.validateSQL = () => ({ valid: true });
sqlExecutor.executeQuery = async (sql) => ({
  success: true,
  data: { columns: ['typeid', 'int_key5'], rows: [{ typeid: 1743, int_key5: 12 }], rowCount: 1, truncated: false },
  executionTime: 12,
  sql
});

// 【批次 D3】mock database 审计写入,捕获调用方便断言,且不污染 sqlite
let auditCalls = [];
database.createQueryHistory = async (params) => {
  auditCalls.push({ phase: 'create', params });
  return 'mock-history-id';
};
database.markQueryHistorySuccess = async (historyId, payload) => {
  auditCalls.push({ phase: 'success', historyId, payload });
};
database.markQueryHistoryFailure = async (historyId, payload) => {
  auditCalls.push({ phase: 'failure', historyId, payload });
};

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
  // case 1: 澄清回答里含 typeid=1743 + int_key5,应被抽入 decomposition、落入 SQL、并执行返回真实数据
  // ========================================
  console.log('\n[resumeFromClarification 端到端:typeid=1743 + int_key5 → type=result + data]');
  {
    auditCalls = [];
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
    ok(result.type === 'result', "result.type === 'result'(D3 升级)");
    ok(result.data && Array.isArray(result.data.rows), 'result.data.rows 为数组');
    ok(result.data && result.data.rowCount === 1, 'result.data.rowCount === 1');
    ok(typeof result.executionTime === 'number', 'result.executionTime 为数字');
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
    ok(phases.includes('execution'), "traceLog 含 'execution'(D3 新增)");

    // originalQuery 被锁回
    ok(
      result.decomposition.originalQuery === decomposition.originalQuery,
      'decomposition.originalQuery 被锁回第一轮原文'
    );

    // 【批次 D3】审计写入断言
    const successAudit = auditCalls.find(c => c.phase === 'success');
    ok(!!successAudit, 'markQueryHistorySuccess 被调用');
    ok(successAudit && successAudit.payload.executionTime === 12,
      'audit.executionTime 为真实 SQL 耗时');
    ok(successAudit && successAudit.payload.rowCount === 1,
      'audit.rowCount 为真实行数');
    ok(successAudit && successAudit.payload.fallbackUsed === false,
      'audit.fallbackUsed === false');
    const createAudit = auditCalls.find(c => c.phase === 'create');
    ok(createAudit && createAudit.params.naturalQuery === decomposition.originalQuery,
      'createQueryHistory.naturalQuery 为第一轮原文(非 userAnswer)');
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
  // case 3 (B-15): recovery UNKNOWN 失败 + 原 SQL 基本语法完整 → 降级为可用+警告 → 进入 executionPhase 执行成功
  // ========================================
  console.log('\n[B-15 降级:原 SQL 基本语法完整时保留 + 警告 + D3 执行返回 type=result]');
  {
    auditCalls = [];
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

    ok(result.type === 'result', "type='result'(降级保留 + D3 执行成功)");
    ok(result.success === true, 'success=true(降级 SQL 通过 mock 执行)');
    ok(/typeid\s*=\s*1743/i.test(result.sql || ''), 'SQL 被保留含原内容');
    ok(typeof result.verificationWarning === 'string' && result.verificationWarning.length > 0,
      'verificationWarning 字段非空(降级警告透传到 result)');
    ok(/请人工核对/.test(result.explanation || ''), 'explanation 含警告文案');
    ok(result.data && result.data.rowCount === 1, 'result.data 含真实行数');
    const phases = (result.traceLog || []).map(t => t.phase);
    ok(phases.includes('recovery_fallback'), "traceLog 含 'recovery_fallback'");
    ok(phases.includes('execution'), "traceLog 含 'execution'(D3 新增)");

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
  // case 5 (D3 新增): executionPhase 失败 + recovery 后再失败 → type='error' + 写 markQueryHistoryFailure
  // ========================================
  console.log('\n[D3 执行失败 → markQueryHistoryFailure 写真实 errorCode]');
  {
    auditCalls = [];
    schemaLoader.tableExists = () => true;
    llmService.simpleChat = async () => JSON.stringify({
      sql: 'SELECT typeid FROM foo WHERE typeid = 1743',
      explanation: 'mock',
      selectedTables: ['foo']
    });
    // mock executeQuery 总是失败
    sqlExecutor.executeQuery = async () => ({
      success: false,
      error: 'Table foo doesn\'t exist',
      errorCode: 'SR_DB_NOT_FOUND',
      executionTime: 7
    });

    const engine = new agenticEngine.AgenticNL2SQLEngine();
    const result = await engine.resumeFromClarification({
      originalQuery: 'q',
      decomposition: { originalQuery: 'q', dataUnits: [{ id: 'u1', filters: [] }] },
      clarification: { clarificationType: 'general', details: { uncoveredUnits: [{ id: 'u1' }] } },
      userAnswer: 'typeid=1743',
      context: { sessionId: 'sid-d3-execfail' }
    });

    ok(result.type === 'error', "type='error'(执行失败)");
    ok(result.success === false, 'success=false');
    ok(result.errorCode === 'SR_DB_NOT_FOUND', 'errorCode 透传 sqlExecutor');
    ok(typeof result.executionTime === 'number', 'executionTime 为真实耗时(失败也应有)');
    const failureAudit = auditCalls.find(c => c.phase === 'failure');
    ok(!!failureAudit, 'markQueryHistoryFailure 被调用');
    ok(failureAudit && failureAudit.payload.errorCode === 'SR_DB_NOT_FOUND',
      'audit.errorCode === SR_DB_NOT_FOUND');
    ok(failureAudit && failureAudit.payload.fallbackUsed === false,
      'audit.fallbackUsed === false');

    // 还原 executeQuery
    sqlExecutor.executeQuery = async (sql) => ({
      success: true,
      data: { columns: ['typeid', 'int_key5'], rows: [{ typeid: 1743, int_key5: 12 }], rowCount: 1, truncated: false },
      executionTime: 12,
      sql
    });
  }

  // ========================================
  // 恢复原函数,避免影响其他测试
  // ========================================
  llmService.simpleChat = origSimpleChat;
  schemaLoader.getLevel2Detail = origGetLevel2Detail;
  schemaLoader.tableExists = origTableExists;
  queryDecomposer.retrieveTablesByDataUnits = origRetrieveTables;
  schemaTools.getLevel1Index = origGetLevel1Index;
  sqlExecutor.validateSQL = origValidateSQL;
  sqlExecutor.executeQuery = origExecuteQuery;
  database.createQueryHistory = origCreateQueryHistory;
  database.markQueryHistorySuccess = origMarkSuccess;
  database.markQueryHistoryFailure = origMarkFailure;

  console.log(`\n===== 结果 pass=${pass} fail=${fail} =====`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
