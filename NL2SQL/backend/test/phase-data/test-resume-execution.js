/**
 * NL2SQL 真实数据输出 · 批次 D5
 * 端到端行为测试:agenticEngine.resumeFromClarification 澄清恢复路径
 *
 * 覆盖(全部用 stub,不依赖外部 LLM/SR DB/SQLite):
 *   1. 澄清恢复成功 → type==='result' + data + executionTime,resumed===true
 *   2. SSE 层注入打标:tagged.engineUsed === 'agentic-resume'(模拟 sseHandler 流程)
 *   3. 审计 createQueryHistory.naturalQuery === originalQuery(非 userAnswer)
 *      (锁第一轮原文,审计语义稳定)
 *   4. 执行失败 + recovery 后仍失败 → type='error' + markQueryHistoryFailure
 *      写真实 errorCode/executionTime
 *
 * 与 phase3/clarification-resume.test.js 互补:
 *   - phase3 偏 unit 级:断言 decomposition 应用、prompt 注入、单条 case 的成功
 *   - 本文件偏 phase-data:聚焦审计契约 + SSE 层 engineUsed 打标 + DRY_RUN 路径
 *
 * 运行:node backend/test/phase-data/test-resume-execution.js
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'warn';
delete process.env.PROMPT_INJECT_NOW;

const path = require('path');

const llmService = require(path.resolve(__dirname, '../../src/core/llmService'));
const schemaLoader = require(path.resolve(__dirname, '../../src/core/schemaLoader'));
const queryDecomposer = require(path.resolve(__dirname, '../../src/core/queryDecomposer'));
const schemaTools = require(path.resolve(__dirname, '../../src/core/schemaTools'));
const sqlExecutor = require(path.resolve(__dirname, '../../src/core/sqlExecutor'));
const database = require(path.resolve(__dirname, '../../src/core/database'));

const orig = {
  simpleChat: llmService.simpleChat,
  getLevel2Detail: schemaLoader.getLevel2Detail,
  tableExists: schemaLoader.tableExists,
  searchRelevantTables: schemaLoader.searchRelevantTables,
  retrieveTablesByDataUnits: queryDecomposer.retrieveTablesByDataUnits,
  getLevel1Index: schemaTools.getLevel1Index,
  validateSQL: sqlExecutor.validateSQL,
  executeQuery: sqlExecutor.executeQuery,
  createQueryHistory: database.createQueryHistory,
  markQueryHistorySuccess: database.markQueryHistorySuccess,
  markQueryHistoryFailure: database.markQueryHistoryFailure
};

schemaLoader.getLevel2Detail = () => 'MOCK foo (typeid INT, int_key5 INT, create_time DATETIME)';
schemaLoader.tableExists = () => true;
schemaLoader.searchRelevantTables = async () => [{ name: 'foo' }];
schemaTools.getLevel1Index = () => ({ tables: [] });
queryDecomposer.retrieveTablesByDataUnits = async (decomposition) => ({
  decomposition,
  tableCandidates: [{ table: { name: 'foo', description: 'mock' }, units: ['u1'], score: 1 }],
  recommendedTables: ['foo']
});

sqlExecutor.validateSQL = () => ({ valid: true });
let nextExecResult = null;
function defaultExecResult(sql) {
  return {
    success: true,
    data: {
      columns: ['typeid', 'int_key5'],
      rows: [{ typeid: 1743, int_key5: 12 }],
      rowCount: 1,
      truncated: false
    },
    executionTime: 18,
    sql
  };
}
sqlExecutor.executeQuery = async (sql) => {
  if (nextExecResult) {
    const v = typeof nextExecResult === 'function' ? nextExecResult(sql) : nextExecResult;
    nextExecResult = null;
    return v;
  }
  return defaultExecResult(sql);
};

llmService.simpleChat = async () => JSON.stringify({
  sql: 'SELECT typeid, int_key5 FROM foo WHERE typeid = 1743',
  explanation: 'mock resume sql',
  selectedTables: ['foo']
});

let auditCalls = [];
database.createQueryHistory = async (params) => {
  auditCalls.push({ phase: 'create', params });
  return 'mock-resume-id';
};
database.markQueryHistorySuccess = async (id, payload) => {
  auditCalls.push({ phase: 'success', id, payload });
};
database.markQueryHistoryFailure = async (id, payload) => {
  auditCalls.push({ phase: 'failure', id, payload });
};

const agenticEngine = require(path.resolve(__dirname, '../../src/core/agenticEngine'));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

// 模拟 sseHandler.handleClarifyAnswer L613-L617 的打标逻辑
// 引擎本身不动 engineUsed/fallbackUsed,这两字段由 SSE 层注入
function simulateSseTag(result) {
  return {
    ...(result || {}),
    engineUsed: 'agentic-resume',
    fallbackUsed: false
  };
}

(async () => {
  // ========================================
  // case 1: 澄清恢复成功 → type='result' + data + executionTime
  // ========================================
  console.log('\n[case 1] resumeFromClarification 成功 → type=result + data');
  {
    auditCalls = [];
    const decomposition = {
      originalQuery: '取 typeid=1743 的数据,int_key5 为战场等级',
      primaryEntity: '玩家',
      dataUnits: [{ id: 'u1', type: '基础属性筛选', description: '类型筛选', filters: [] }]
    };
    const clarification = {
      clarificationType: 'general',
      details: { uncoveredUnits: [{ id: 'u1' }] },
      question: '请提供 typeid'
    };

    const engine = new agenticEngine.AgenticNL2SQLEngine();
    const raw = await engine.resumeFromClarification({
      originalQuery: decomposition.originalQuery,
      decomposition,
      clarification,
      userAnswer: 'typeid=1743',
      context: { sessionId: 'sid-d5-resume-1' }
    });

    ok(raw && raw.success === true, 'success === true');
    ok(raw.type === 'result', "type === 'result'");
    ok(raw.data && Array.isArray(raw.data.rows) && raw.data.rows.length === 1,
      'data.rows 为 1 行真实数据');
    ok(raw.data && raw.data.rowCount === 1, 'data.rowCount === 1');
    ok(typeof raw.executionTime === 'number' && raw.executionTime >= 0,
      'executionTime 为非负数字');
    ok(raw.resumed === true, 'resumed === true(澄清恢复路径标识)');
    ok(typeof raw.sql === 'string' && /typeid\s*=\s*1743/i.test(raw.sql),
      'sql 含 typeid=1743(澄清回答透传 LLM)');

    const phases = (raw.traceLog || []).map(t => t.phase);
    ok(phases.includes('apply_clarification'), "traceLog 含 'apply_clarification'");
    ok(phases.includes('execution'), "traceLog 含 'execution'");
  }

  // ========================================
  // case 2: SSE 层注入 engineUsed='agentic-resume'(模拟 handleClarifyAnswer L613-L617)
  // ========================================
  console.log('\n[case 2] SSE 层打标 engineUsed=agentic-resume');
  {
    const decomposition = {
      originalQuery: 'q',
      dataUnits: [{ id: 'u1', filters: [] }]
    };
    const engine = new agenticEngine.AgenticNL2SQLEngine();
    const raw = await engine.resumeFromClarification({
      originalQuery: 'q',
      decomposition,
      clarification: { clarificationType: 'general', details: { uncoveredUnits: [{ id: 'u1' }] } },
      userAnswer: 'typeid=1743',
      context: { sessionId: 'sid-d5-resume-2' }
    });
    const tagged = simulateSseTag(raw);

    ok(tagged.engineUsed === 'agentic-resume',
      "tagged.engineUsed === 'agentic-resume'(由 SSE 层 handleClarifyAnswer 注入)");
    ok(tagged.fallbackUsed === false,
      'tagged.fallbackUsed === false(SSE 层强制覆盖,resume 路径与 legacy fallback 解耦)');
    ok(tagged.type === 'result' && tagged.data,
      '打标后仍保留 type=result + data');
    ok(tagged.resumed === true, '打标后 resumed=true 保留');
    // 引擎自身不写 engineUsed
    ok(raw.engineUsed === undefined,
      '引擎返回的 raw.engineUsed === undefined(引擎不应自打标,职责留给 SSE 层)');
  }

  // ========================================
  // case 3: 审计 naturalQuery 锁第一轮原文(非 userAnswer)
  // ========================================
  console.log('\n[case 3] createQueryHistory.naturalQuery === originalQuery(非 userAnswer)');
  {
    auditCalls = [];
    const originalQuery = '帮我看下数据'; // 第一轮模糊问题
    const userAnswer = 'typeid=1743 看 int_key5'; // 澄清回答

    const engine = new agenticEngine.AgenticNL2SQLEngine();
    await engine.resumeFromClarification({
      originalQuery,
      decomposition: { originalQuery, dataUnits: [{ id: 'u1', filters: [] }] },
      clarification: { clarificationType: 'general', details: { uncoveredUnits: [{ id: 'u1' }] } },
      userAnswer,
      context: { sessionId: 'sid-d5-resume-3' }
    });

    const createAudit = auditCalls.find(c => c.phase === 'create');
    ok(!!createAudit, 'createQueryHistory 被调用');
    ok(createAudit && createAudit.params.naturalQuery === originalQuery,
      'naturalQuery 为第一轮原文(锁定不漂)');
    ok(createAudit && createAudit.params.naturalQuery !== userAnswer,
      'naturalQuery 不应被替换为 userAnswer');

    const successAudit = auditCalls.find(c => c.phase === 'success');
    ok(!!successAudit, 'markQueryHistorySuccess 被调用');
    ok(successAudit && successAudit.payload.rowCount === 1,
      'audit.rowCount === data.rowCount');
    const r = successAudit && successAudit.payload.result;
    ok(r && typeof r.sampleHash === 'string' && /^[0-9a-f]{16}$/.test(r.sampleHash),
      'audit.result.sampleHash 为 16 位 hex');
    ok(r && !('rows' in r) && !('sampleRows' in r),
      'audit.result 不含 rows/sampleRows(数据最小化)');
  }

  // ========================================
  // case 4: 执行失败 + recovery 后仍失败 → type='error' + markQueryHistoryFailure
  // ========================================
  console.log('\n[case 4] resume 路径执行失败 + 一次 recovery 后仍失败 → markFailure');
  {
    auditCalls = [];
    let execCount = 0;
    sqlExecutor.executeQuery = async (sql) => {
      execCount++;
      return {
        success: false,
        error: 'Syntax error near token',
        errorCode: 'SR_EXEC_ERROR',
        executionTime: execCount === 1 ? 5 : 9,
        sql
      };
    };

    const engine = new agenticEngine.AgenticNL2SQLEngine();
    const raw = await engine.resumeFromClarification({
      originalQuery: 'q',
      decomposition: { originalQuery: 'q', dataUnits: [{ id: 'u1', filters: [] }] },
      clarification: { clarificationType: 'general', details: { uncoveredUnits: [{ id: 'u1' }] } },
      userAnswer: 'typeid=1743',
      context: { sessionId: 'sid-d5-resume-4' }
    });

    ok(raw.success === false, 'success === false');
    ok(raw.type === 'error', "type === 'error'");
    ok(raw.errorCode === 'SR_EXEC_ERROR', 'errorCode 透传 sqlExecutor');
    ok(typeof raw.executionTime === 'number', 'executionTime 为数字');
    ok(raw.resumed === true, '失败仍带 resumed=true(语义不丢)');

    const phases = (raw.traceLog || []).map(t => t.phase);
    ok(phases.includes('execution'), "traceLog 含 'execution'");
    ok(phases.includes('recovery'), "traceLog 含 'recovery'(执行失败后触发)");
    ok(phases.includes('execution_retry'), "traceLog 含 'execution_retry'(recovery 后重试)");
    ok(execCount === 2, 'executeQuery 被调用 2 次(首次 + 重试)');

    const failureAudit = auditCalls.find(c => c.phase === 'failure');
    ok(!!failureAudit, 'markQueryHistoryFailure 被调用');
    ok(failureAudit && failureAudit.payload.errorCode === 'SR_EXEC_ERROR',
      'audit.errorCode 透传');
    ok(failureAudit && failureAudit.payload.fallbackUsed === false,
      'audit.fallbackUsed === false');
    ok(failureAudit && typeof failureAudit.payload.executionTime === 'number',
      'audit.executionTime 为真实重试耗时');

    // SSE 层打标后仍是 error
    const tagged = simulateSseTag(raw);
    ok(tagged.engineUsed === 'agentic-resume',
      'error 路径 SSE 层仍打 engineUsed=agentic-resume');
    ok(tagged.type === 'error',
      'error 路径打标后 type 不变');

    sqlExecutor.executeQuery = async (sql) => defaultExecResult(sql);
  }

  // ========================================
  // 恢复
  // ========================================
  llmService.simpleChat = orig.simpleChat;
  schemaLoader.getLevel2Detail = orig.getLevel2Detail;
  schemaLoader.tableExists = orig.tableExists;
  schemaLoader.searchRelevantTables = orig.searchRelevantTables;
  queryDecomposer.retrieveTablesByDataUnits = orig.retrieveTablesByDataUnits;
  schemaTools.getLevel1Index = orig.getLevel1Index;
  sqlExecutor.validateSQL = orig.validateSQL;
  sqlExecutor.executeQuery = orig.executeQuery;
  database.createQueryHistory = orig.createQueryHistory;
  database.markQueryHistorySuccess = orig.markQueryHistorySuccess;
  database.markQueryHistoryFailure = orig.markQueryHistoryFailure;

  console.log(`\n===== 结果 pass=${pass} fail=${fail} =====`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(err => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
