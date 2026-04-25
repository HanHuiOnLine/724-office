/**
 * NL2SQL 真实数据输出 · 批次 D5
 * 端到端行为测试:agenticEngine.processQuery 主路径
 *
 * 覆盖(全部用 stub,不依赖外部 LLM/SR DB/SQLite):
 *   1. processQuery 成功 → type==='result',data.rows/columns/rowCount/truncated 完整
 *   2. query_history 审计写入:rowCount === data.rowCount,executionTime 一致(±100ms),
 *      result 字段为摘要形态(含 sampleHash,无业务 rows / sampleRows)
 *   3. DRY_RUN 模式:executeQuery 返回 dryRun → success:true + rows:[],既有行为不回退
 *   4. truncated 透传:data.truncated===true 直接出 result,前端兜底由 D4 处理
 *   5. 执行失败 + recovery 后仍失败 → type='error' + markQueryHistoryFailure 写真实
 *      executionTime / errorCode,fallbackUsed===false
 *
 * 运行:node backend/test/phase-data/test-agentic-execution.js
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'warn';
// 避免被外部 FF 影响:本测试只覆盖纯流程链路,各 Phase 走默认实现
delete process.env.PROMPT_INJECT_NOW;
delete process.env.FF_DYNAMIC_INTENT_DECOMPOSITION;
delete process.env.FF_TOOL_LOOP_MODE;
delete process.env.FF_CLARIFICATION_ENGINE;
delete process.env.FF_ENABLE_ALL;

const path = require('path');

// 先 require 所有依赖,再 mock,再 require engine
const llmService = require(path.resolve(__dirname, '../../src/core/llmService'));
const schemaLoader = require(path.resolve(__dirname, '../../src/core/schemaLoader'));
const queryDecomposer = require(path.resolve(__dirname, '../../src/core/queryDecomposer'));
const schemaTools = require(path.resolve(__dirname, '../../src/core/schemaTools'));
const clarificationEngine = require(path.resolve(__dirname, '../../src/core/clarificationEngine'));
const sqlExecutor = require(path.resolve(__dirname, '../../src/core/sqlExecutor'));
const database = require(path.resolve(__dirname, '../../src/core/database'));

// 备份原实现以便最后恢复,避免污染同进程其他测试
const orig = {
  simpleChat: llmService.simpleChat,
  getLevel2Detail: schemaLoader.getLevel2Detail,
  tableExists: schemaLoader.tableExists,
  searchRelevantTables: schemaLoader.searchRelevantTables,
  retrieveTablesByDataUnits: queryDecomposer.retrieveTablesByDataUnits,
  decomposeQueryDynamically: queryDecomposer.decomposeQueryDynamically,
  getLevel1Index: schemaTools.getLevel1Index,
  checkClarificationNeeded: clarificationEngine.checkClarificationNeeded,
  validateSQL: sqlExecutor.validateSQL,
  executeQuery: sqlExecutor.executeQuery,
  createQueryHistory: database.createQueryHistory,
  markQueryHistorySuccess: database.markQueryHistorySuccess,
  markQueryHistoryFailure: database.markQueryHistoryFailure
};

// ---------------- Schema / Decomposer / Clarification stubs ----------------
schemaLoader.getLevel2Detail = () => 'MOCK foo (id INT, name VARCHAR)';
schemaLoader.tableExists = () => true;
schemaLoader.searchRelevantTables = async () => [{ name: 'foo' }];
schemaTools.getLevel1Index = () => ({ tables: [] });
queryDecomposer.retrieveTablesByDataUnits = async (decomposition) => ({
  decomposition,
  tableCandidates: [{ table: { name: 'foo', description: 'mock' }, units: ['u1'], score: 1 }],
  recommendedTables: ['foo']
});
queryDecomposer.decomposeQueryDynamically = async (q) => ({
  originalQuery: q,
  primaryEntity: 'mock',
  dataUnits: [{ id: 'u1', type: '整体查询', description: q }]
});
// 关键:让 clarification 不触发,直接进入 Phase 4
clarificationEngine.checkClarificationNeeded = () => ({ needsClarification: false });

// ---------------- LLM stub:按调用顺序返回 planning / SQL ----------------
let llmCallCount = 0;
let nextSqlOverride = null; // 测试可临时覆盖下一次 SQL JSON 内容
function defaultPlanningJson() {
  return JSON.stringify({
    entities: ['玩家'], filters: [], aggregations: [], risks: [],
    physicalHints: [], estimatedComplexity: 'low'
  });
}
function defaultSqlJson() {
  return JSON.stringify({
    sql: 'SELECT id, name FROM foo LIMIT 1000',
    explanation: 'mock sql',
    selectedTables: ['foo']
  });
}
llmService.simpleChat = async (_system, prompt) => {
  llmCallCount++;
  // planningPhase prompt 含 "physicalHints" / "estimatedComplexity" 关键字
  if (typeof prompt === 'string' && /physicalHints|estimatedComplexity/.test(prompt)) {
    return defaultPlanningJson();
  }
  // generationPhase / recoveryPhase prompt
  if (nextSqlOverride) {
    const v = nextSqlOverride;
    nextSqlOverride = null;
    return v;
  }
  return defaultSqlJson();
};

// ---------------- sqlExecutor stubs(默认成功 1 行) ----------------
sqlExecutor.validateSQL = () => ({ valid: true });
let nextExecResult = null; // 单次覆盖
function defaultExecResult(sql) {
  return {
    success: true,
    data: {
      columns: ['id', 'name'],
      rows: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }],
      rowCount: 3,
      truncated: false
    },
    executionTime: 42,
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

// ---------------- database 审计捕获 ----------------
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

const agenticEngine = require(path.resolve(__dirname, '../../src/core/agenticEngine'));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

(async () => {
  // ========================================
  // case 1: processQuery 普通成功 → type='result' + data
  // ========================================
  console.log('\n[case 1] processQuery 普通成功 → type=result + data');
  {
    auditCalls = [];
    llmCallCount = 0;
    const engine = new agenticEngine.AgenticNL2SQLEngine();
    const result = await engine.processQuery('查询 foo 表前几行', {
      sessionId: 'sid-d5-1',
      userId: 'tester'
    });

    ok(result && result.success === true, 'success === true');
    ok(result.type === 'result', "type === 'result'");
    ok(result.data && Array.isArray(result.data.columns), 'data.columns 是数组');
    ok(result.data && Array.isArray(result.data.rows), 'data.rows 是数组');
    ok(result.data && result.data.rowCount === 3, 'data.rowCount === 3');
    ok(result.data && result.data.truncated === false, 'data.truncated === false');
    ok(typeof result.executionTime === 'number' && result.executionTime >= 0,
      'executionTime 为非负数字');
    ok(typeof result.sql === 'string' && result.sql.length > 0, 'sql 非空字符串');
    ok(Array.isArray(result.selectedTables) && result.selectedTables.includes('foo'),
      'selectedTables 含 foo');
    const phases = (result.traceLog || []).map(t => t.phase);
    ok(phases.includes('execution'), "traceLog 含 'execution'");
    ok(!phases.includes('execution_retry'), "traceLog 不应含 'execution_retry'(无 recovery)");
  }

  // ========================================
  // case 2: 审计写入对齐 - rowCount/executionTime 一致,result 为摘要
  // ========================================
  console.log('\n[case 2] 审计写入:rowCount/executionTime 一致 + result 为摘要');
  {
    const successAudit = auditCalls.find(c => c.phase === 'success');
    const createAudit = auditCalls.find(c => c.phase === 'create');
    ok(!!createAudit, 'createQueryHistory 被调用');
    ok(createAudit && createAudit.params.naturalQuery === '查询 foo 表前几行',
      'createQueryHistory.naturalQuery 为本轮 userQuery');
    ok(!!successAudit, 'markQueryHistorySuccess 被调用');
    ok(successAudit && successAudit.payload.rowCount === 3,
      'audit.rowCount === data.rowCount(3)');
    ok(successAudit && successAudit.payload.executionTime === 42,
      'audit.executionTime === stub 返回的 42');

    const r = successAudit && successAudit.payload.result;
    ok(r && Array.isArray(r.columns) && r.columns.includes('id'),
      'audit.result.columns 透传');
    ok(r && r.rowCount === 3, 'audit.result.rowCount === 3');
    ok(r && r.truncated === false, 'audit.result.truncated === false');
    ok(r && typeof r.sampleHash === 'string' && /^[0-9a-f]{16}$/.test(r.sampleHash),
      'audit.result.sampleHash 为 16 位 hex(D1 摘要契约)');
    ok(r && !('rows' in r), 'audit.result 不含 rows(数据最小化)');
    ok(r && !('sampleRows' in r), 'audit.result 不含 sampleRows(旧形态已废弃)');
    ok(successAudit && successAudit.payload.fallbackUsed === false,
      'audit.fallbackUsed === false');
    ok(successAudit && successAudit.payload.generatedSql &&
      successAudit.payload.generatedSql.length > 0,
      'audit.generatedSql 非空');
  }

  // ========================================
  // case 3: DRY_RUN 模式 → success:true + rows:[],既有行为不回退
  // ========================================
  console.log('\n[case 3] DRY_RUN 模式 → 空 rows + 不报错');
  {
    auditCalls = [];
    nextExecResult = (sql) => ({
      success: true,
      data: { columns: [], rows: [], rowCount: 0, dryRun: true, message: 'DryRun 模式' },
      executionTime: 0,
      sql,
      dryRun: true
    });

    const engine = new agenticEngine.AgenticNL2SQLEngine();
    const result = await engine.processQuery('dry run query', { sessionId: 'sid-d5-3' });

    ok(result.success === true, 'DRY_RUN 仍 success === true');
    ok(result.type === 'result', "DRY_RUN type='result'(由前端走空结果占位)");
    ok(result.data && Array.isArray(result.data.rows) && result.data.rows.length === 0,
      'DRY_RUN data.rows === []');
    ok(result.data && result.data.rowCount === 0, 'DRY_RUN data.rowCount === 0');

    const successAudit = auditCalls.find(c => c.phase === 'success');
    ok(!!successAudit, 'DRY_RUN 仍写 markQueryHistorySuccess(执行视为成功)');
    ok(successAudit && successAudit.payload.rowCount === 0,
      'DRY_RUN audit.rowCount === 0');
    ok(successAudit && successAudit.payload.result && successAudit.payload.result.sampleHash === '',
      'DRY_RUN audit.result.sampleHash 为空字符串(空 rows)');
  }

  // ========================================
  // case 4: truncated=true 透传
  // ========================================
  console.log('\n[case 4] truncated=true 透传到 data');
  {
    auditCalls = [];
    nextExecResult = (sql) => ({
      success: true,
      data: {
        columns: ['id'],
        rows: Array.from({ length: 1000 }, (_, i) => ({ id: i })),
        rowCount: 99999,
        truncated: true
      },
      executionTime: 88,
      sql
    });

    const engine = new agenticEngine.AgenticNL2SQLEngine();
    const result = await engine.processQuery('big query', { sessionId: 'sid-d5-4' });

    ok(result.type === 'result', "truncated 仍 type='result'");
    ok(result.data && result.data.truncated === true, 'data.truncated === true 透传');
    ok(result.data && result.data.rowCount === 99999, 'data.rowCount 透传真实总数');
    ok(result.data && result.data.rows.length === 1000, '前端拿到截断后的 1000 行');

    const successAudit = auditCalls.find(c => c.phase === 'success');
    ok(successAudit && successAudit.payload.result.truncated === true,
      'audit.result.truncated 透传');
    ok(successAudit && successAudit.payload.rowCount === 99999,
      'audit.rowCount 为真实总数(非截断后行数)');
  }

  // ========================================
  // case 5: 执行失败 + recovery 后仍失败 → type='error' + markQueryHistoryFailure
  // ========================================
  console.log('\n[case 5] 执行失败两次 → type=error + markQueryHistoryFailure');
  {
    auditCalls = [];
    // executeQuery 始终失败,error 用 "Syntax error" 触发 recoveryPhase 的 SYNTAX_ERROR 分支
    // (UNKNOWN 分支会返回 sql:null 而不重试,无法验证 execution_retry)
    let execCount = 0;
    sqlExecutor.executeQuery = async (sql) => {
      execCount++;
      return {
        success: false,
        error: 'Syntax error near unknown column',
        errorCode: 'SR_EXEC_ERROR',
        executionTime: execCount === 1 ? 7 : 11,
        sql
      };
    };

    const engine = new agenticEngine.AgenticNL2SQLEngine();
    const result = await engine.processQuery('exec fail query', { sessionId: 'sid-d5-5' });

    ok(result.success === false, 'success === false');
    ok(result.type === 'error', "type === 'error'");
    ok(result.errorCode === 'SR_EXEC_ERROR', 'errorCode 透传 sqlExecutor');
    ok(typeof result.executionTime === 'number', 'executionTime 为数字(失败也带)');

    const phases = (result.traceLog || []).map(t => t.phase);
    ok(phases.includes('execution'), "traceLog 含 'execution'(首次)");
    ok(phases.includes('recovery'), "traceLog 含 'recovery'(执行失败后触发)");
    ok(phases.includes('execution_retry'), "traceLog 含 'execution_retry'(recovery 后再执行)");
    ok(execCount === 2, 'executeQuery 被调用 2 次(首次 + 重试)');

    const failureAudit = auditCalls.find(c => c.phase === 'failure');
    ok(!!failureAudit, 'markQueryHistoryFailure 被调用');
    ok(failureAudit && failureAudit.payload.errorCode === 'SR_EXEC_ERROR',
      'audit.errorCode === SR_EXEC_ERROR');
    ok(failureAudit && failureAudit.payload.fallbackUsed === false,
      'audit.fallbackUsed === false(agentic 自身的尝试,与 legacy fallback 解耦)');
    ok(failureAudit && typeof failureAudit.payload.executionTime === 'number',
      'audit.executionTime 为真实重试耗时(非规划 duration)');

    // 还原 executeQuery 用 default
    sqlExecutor.executeQuery = async (sql) => defaultExecResult(sql);
  }

  // ========================================
  // 恢复全部原函数,避免污染 fork 进程内的其他测试
  // ========================================
  llmService.simpleChat = orig.simpleChat;
  schemaLoader.getLevel2Detail = orig.getLevel2Detail;
  schemaLoader.tableExists = orig.tableExists;
  schemaLoader.searchRelevantTables = orig.searchRelevantTables;
  queryDecomposer.retrieveTablesByDataUnits = orig.retrieveTablesByDataUnits;
  queryDecomposer.decomposeQueryDynamically = orig.decomposeQueryDynamically;
  schemaTools.getLevel1Index = orig.getLevel1Index;
  clarificationEngine.checkClarificationNeeded = orig.checkClarificationNeeded;
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
