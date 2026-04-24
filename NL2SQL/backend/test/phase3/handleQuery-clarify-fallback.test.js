/**
 * 批次 C 单测:handleQuery 澄清回答自动路由兜底
 *
 * 覆盖根因 R1 兜底:老前端未升级到 /sse/clarify-answer 仍把澄清选项当新 query 发时,
 * 后端检测"短 query + 最新 assistant 为未回答 clarification + metadata 完整"自动路由
 * 到 handleClarifyAnswer,避免第二轮 query 脱离原需求
 *
 * 验证:
 *   case 1: 短 query(<30) + clarification 父消息完整 → 自动路由 handleClarifyAnswer
 *   case 2: 长 query(≥30) → 不触发兜底,走正常 handleQuery 流程
 *   case 3: 最新 assistant 消息非 clarification → 不触发兜底
 *   case 4: metadata 缺 decomposition → 不触发兜底
 *   case 5: FF_HANDLE_QUERY_CLARIFY_FALLBACK=false → 不触发兜底
 *   case 6: context.skipClarifyFallback=true → 不触发兜底(避免递归)
 *
 * 运行:node backend/test/phase3/handleQuery-clarify-fallback.test.js
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'warn';
process.env.FF_AGENTIC_ENGINE = 'true';
process.env.FF_AGENTIC_AUTO_FALLBACK = 'true';

const path = require('path');

const database = require(path.resolve(__dirname, '../../src/core/database'));
const agenticEngine = require(path.resolve(__dirname, '../../src/core/agenticEngine'));
const nl2sqlEngine = require(path.resolve(__dirname, '../../src/core/nl2sqlEngine'));
const sseHandler = require(path.resolve(__dirname, '../../src/core/sseHandler'));

database.getSession = async () => ({ id: 'test-session', title: 'test' });

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

// 备份原始
const origAddMessage = database.addMessage;
const origGetMessage = database.getMessage;
const origGetLatest = database.getLatestAssistantMessage;
const origResume = agenticEngine.resumeFromClarification;
const origProcessQuery = agenticEngine.processQuery;
const origLegacyProcess = nl2sqlEngine.processQuery;

function makeFakeRes(captured) {
  return {
    writeHead: () => {},
    write: (chunk) => {
      const m = /^data:\s*(.+)$/m.exec(String(chunk));
      if (m) {
        try { captured.push(JSON.parse(m[1])); } catch (e) { captured.push({ raw: m[1] }); }
      }
    },
    end: () => {},
    status: () => ({ json: () => {} })
  };
}
function makeFakeReq(sessionId) {
  return {
    query: { session_id: sessionId, user_id: 'tester' },
    headers: {},
    ip: '127.0.0.1',
    on: () => {}
  };
}
async function buildConnection(sessionId) {
  const captured = [];
  await sseHandler.handleConnection(makeFakeReq(sessionId), makeFakeRes(captured));
  return captured;
}

(async () => {
  // ============================================
  // case 1: 短 query + 完整 clarification 父消息 → 自动路由 handleClarifyAnswer
  // ============================================
  console.log('\n[case 1] 短 query + clarification 父消息 → 自动路由 handleClarifyAnswer');
  {
    let resumeCalled = 0;
    let resumeParams = null;
    agenticEngine.resumeFromClarification = async (params) => {
      resumeCalled++;
      resumeParams = params;
      return {
        success: true,
        type: 'sql_result',
        sql: 'SELECT int_key5 FROM foo WHERE typeid = 1743',
        explanation: 'mock',
        selectedTables: ['foo']
      };
    };
    agenticEngine.processQuery = async () => {
      ok(false, 'processQuery 不应被调用');
      return { success: true, type: 'sql_result' };
    };
    nl2sqlEngine.processQuery = async () => {
      ok(false, 'legacy processQuery 不应被调用');
      return { success: true };
    };

    database.getLatestAssistantMessage = async (sid) => ({
      id: 777,
      session_id: sid,
      role: 'assistant',
      type: 'clarification',
      message_type: 'clarification',
      content: '请澄清 typeid',
      metadata: {
        clarification: { question: '请澄清 typeid', clarificationType: 'general' },
        originalQuery: '取 typeid=1743 的数据',
        decomposition: {
          originalQuery: '取 typeid=1743 的数据',
          dataUnits: [{ id: 'u1', filters: [] }]
        }
      }
    });
    database.getMessage = async (id) => {
      if (id === 777) return database.getLatestAssistantMessage('sid-fallback-1');
      return null;
    };
    database.addMessage = async () => ({ id: 1 });

    const sid = 'sid-fallback-1';
    await buildConnection(sid);

    const out = await sseHandler.handleQuery(sid, 'int_key5', {});

    ok(resumeCalled === 1, 'resumeFromClarification 被调用 1 次(走兜底路径)');
    ok(resumeParams && resumeParams.userAnswer === 'int_key5',
      "resume.userAnswer === 'int_key5'(短 query 作为用户回答)");
    ok(resumeParams && resumeParams.originalQuery === '取 typeid=1743 的数据',
      'resume.originalQuery 取自父消息 metadata');
    ok(out && out.engineUsed === 'agentic-resume',
      "返回 engineUsed === 'agentic-resume'");
  }

  // ============================================
  // case 2: 长 query(≥30 字符)→ 不触发兜底
  // ============================================
  console.log('\n[case 2] 长 query 不走兜底');
  {
    let resumeCalled = 0;
    let agenticCalled = 0;
    agenticEngine.resumeFromClarification = async () => { resumeCalled++; return {}; };
    agenticEngine.processQuery = async () => {
      agenticCalled++;
      return { success: true, type: 'sql_result', sql: 'SELECT 1' };
    };
    nl2sqlEngine.processQuery = async () => ({ success: true, sql: 'SELECT 1' });

    // 最新 assistant 仍是 clarification,但 query 长
    database.getLatestAssistantMessage = async () => ({
      id: 888,
      type: 'clarification',
      message_type: 'clarification',
      metadata: {
        clarification: { question: 'q' },
        originalQuery: 'orig',
        decomposition: { dataUnits: [] }
      }
    });
    database.addMessage = async () => ({ id: 1 });

    const longQuery = '这是一个超过 30 字符的新查询,不应该被识别为澄清回答,要走正常流程';
    const sid = 'sid-fallback-2';
    await buildConnection(sid);
    await sseHandler.handleQuery(sid, longQuery, {});

    ok(resumeCalled === 0, '长 query 不触发 resumeFromClarification');
    ok(agenticCalled === 1, '长 query 走正常 agentic processQuery');
  }

  // ============================================
  // case 3: 最新 assistant 非 clarification → 不触发兜底
  // ============================================
  console.log('\n[case 3] 最新 assistant 非 clarification');
  {
    let resumeCalled = 0;
    let agenticCalled = 0;
    agenticEngine.resumeFromClarification = async () => { resumeCalled++; return {}; };
    agenticEngine.processQuery = async () => {
      agenticCalled++;
      return { success: true, type: 'sql_result' };
    };
    nl2sqlEngine.processQuery = async () => ({ success: true });

    database.getLatestAssistantMessage = async () => ({
      id: 1,
      type: 'result',
      message_type: 'result',
      metadata: { sql: 'SELECT 1' }
    });
    database.addMessage = async () => ({ id: 1 });

    const sid = 'sid-fallback-3';
    await buildConnection(sid);
    await sseHandler.handleQuery(sid, 'short', {});

    ok(resumeCalled === 0, '非 clarification 不触发兜底');
    ok(agenticCalled === 1, '走正常流程');
  }

  // ============================================
  // case 4: metadata 缺 decomposition → 不触发兜底
  // ============================================
  console.log('\n[case 4] metadata 缺 decomposition');
  {
    let resumeCalled = 0;
    let agenticCalled = 0;
    agenticEngine.resumeFromClarification = async () => { resumeCalled++; return {}; };
    agenticEngine.processQuery = async () => {
      agenticCalled++;
      return { success: true, type: 'sql_result' };
    };
    nl2sqlEngine.processQuery = async () => ({ success: true });

    database.getLatestAssistantMessage = async () => ({
      id: 2,
      type: 'clarification',
      message_type: 'clarification',
      metadata: { clarification: { question: 'q' } } // 缺 decomposition / originalQuery
    });
    database.addMessage = async () => ({ id: 1 });

    const sid = 'sid-fallback-4';
    await buildConnection(sid);
    await sseHandler.handleQuery(sid, 'ans', {});

    ok(resumeCalled === 0, 'metadata 不完整不触发兜底');
    ok(agenticCalled === 1, '走正常流程');
  }

  // ============================================
  // case 5: FF_HANDLE_QUERY_CLARIFY_FALLBACK=false → 不触发兜底
  // ============================================
  console.log('\n[case 5] 开关关闭:FF_HANDLE_QUERY_CLARIFY_FALLBACK=false');
  {
    process.env.FF_HANDLE_QUERY_CLARIFY_FALLBACK = 'false';
    let resumeCalled = 0;
    let agenticCalled = 0;
    agenticEngine.resumeFromClarification = async () => { resumeCalled++; return {}; };
    agenticEngine.processQuery = async () => {
      agenticCalled++;
      return { success: true, type: 'sql_result' };
    };
    nl2sqlEngine.processQuery = async () => ({ success: true });

    database.getLatestAssistantMessage = async () => ({
      id: 3,
      type: 'clarification',
      message_type: 'clarification',
      metadata: {
        clarification: { question: 'q' },
        originalQuery: 'orig',
        decomposition: { dataUnits: [] }
      }
    });
    database.addMessage = async () => ({ id: 1 });

    const sid = 'sid-fallback-5';
    await buildConnection(sid);
    await sseHandler.handleQuery(sid, 'short', {});

    ok(resumeCalled === 0, '开关关闭不触发兜底');
    ok(agenticCalled === 1, '走正常流程');

    delete process.env.FF_HANDLE_QUERY_CLARIFY_FALLBACK;
  }

  // ============================================
  // case 6: context.skipClarifyFallback=true → 不触发(递归保护)
  // ============================================
  console.log('\n[case 6] context.skipClarifyFallback=true 不触发兜底');
  {
    let resumeCalled = 0;
    let agenticCalled = 0;
    agenticEngine.resumeFromClarification = async () => { resumeCalled++; return {}; };
    agenticEngine.processQuery = async () => {
      agenticCalled++;
      return { success: true, type: 'sql_result' };
    };
    nl2sqlEngine.processQuery = async () => ({ success: true });

    database.getLatestAssistantMessage = async () => ({
      id: 4,
      type: 'clarification',
      message_type: 'clarification',
      metadata: {
        clarification: { question: 'q' },
        originalQuery: 'orig',
        decomposition: { dataUnits: [] }
      }
    });
    database.addMessage = async () => ({ id: 1 });

    const sid = 'sid-fallback-6';
    await buildConnection(sid);
    await sseHandler.handleQuery(sid, 'short', { skipClarifyFallback: true });

    ok(resumeCalled === 0, 'skipClarifyFallback=true 不触发兜底');
    ok(agenticCalled === 1, '走正常流程');
  }

  // ============================================
  // case 7: getLatestAssistantMessage 抛异常不阻断主流程
  // ============================================
  console.log('\n[case 7] getLatestAssistantMessage 异常兜底');
  {
    let agenticCalled = 0;
    agenticEngine.processQuery = async () => {
      agenticCalled++;
      return { success: true, type: 'sql_result' };
    };
    nl2sqlEngine.processQuery = async () => ({ success: true });

    database.getLatestAssistantMessage = async () => {
      throw new Error('db error');
    };
    database.addMessage = async () => ({ id: 1 });

    const sid = 'sid-fallback-7';
    await buildConnection(sid);
    let threw = false;
    try {
      await sseHandler.handleQuery(sid, 'short', {});
    } catch (e) {
      threw = true;
    }
    ok(!threw, '数据库异常不抛到外层');
    ok(agenticCalled === 1, '异常降级后仍走正常流程');
  }

  // 恢复
  database.addMessage = origAddMessage;
  database.getMessage = origGetMessage;
  database.getLatestAssistantMessage = origGetLatest;
  agenticEngine.resumeFromClarification = origResume;
  agenticEngine.processQuery = origProcessQuery;
  nl2sqlEngine.processQuery = origLegacyProcess;

  console.log(`\n===== 结果 pass=${pass} fail=${fail} =====`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
