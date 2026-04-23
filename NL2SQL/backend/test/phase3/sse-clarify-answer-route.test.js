/**
 * 批次 B 集成测试:POST /sse/clarify-answer 全链路
 *
 * 通过 sseHandler.handleClarifyAnswer 直接驱动(绕过 Express 路由,因路由层
 * 仅做参数校验和 pushError 兜底)。
 *
 * 覆盖:
 *   case 1: 父澄清消息 metadata 完整 → resumeFromClarification 被触发,SSE 广播 result,
 *           user/assistant 消息落库,SQL 非空含澄清补充字段
 *   case 2: 父澄清消息不存在 → 降级调用 handleQuery(此处 mock agenticEngine.processQuery)
 *   case 3: 父澄清消息 metadata 缺 decomposition → 同上降级
 *
 * 运行:node backend/test/phase3/sse-clarify-answer-route.test.js
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'warn';
process.env.FF_AGENTIC_ENGINE = 'true';
process.env.FF_AGENTIC_AUTO_FALLBACK = 'true';
delete process.env.PROMPT_INJECT_NOW;

const path = require('path');

// 先 stub database.getSession 以便 SSE 建连通过
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

// 保存原始函数供最终恢复
const origResume = agenticEngine.resumeFromClarification;
const origProcessQuery = agenticEngine.processQuery;
const origLegacyProcess = nl2sqlEngine.processQuery;
const origAddMessage = database.addMessage;
const origGetMessage = database.getMessage;

// 假 SSE 响应
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
  // case 1: 父澄清消息 metadata 完整 → resumeFromClarification 被触发
  // ============================================
  console.log('\n[case 1] 父消息 metadata 完整,走 resume 路径');
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
        explanation: 'mock resumed',
        selectedTables: ['foo'],
        decomposition: params.decomposition,
        resumed: true
      };
    };

    const parentId = 42;
    database.getMessage = async (id) => {
      if (id !== parentId) return null;
      return {
        id: parentId,
        session_id: 'sid-clar-1',
        role: 'assistant',
        type: 'clarification',
        message_type: 'clarification',
        content: '请澄清',
        metadata: {
          clarification: {
            clarificationType: 'general',
            details: { uncoveredUnits: [{ id: 'u1' }] },
            question: '请澄清'
          },
          originalQuery: '取 typeid=1743 的数据, int_key5 为战场等级',
          decomposition: {
            originalQuery: '取 typeid=1743 的数据, int_key5 为战场等级',
            dataUnits: [{ id: 'u1', filters: [], keywords: [] }]
          }
        }
      };
    };

    const addMessageCalls = [];
    database.addMessage = async (sid, role, content, type, metadata) => {
      addMessageCalls.push({ sid, role, content, type });
      return { id: 999 };
    };

    const sid = 'sid-clar-1';
    const captured = await buildConnection(sid);

    const out = await sseHandler.handleClarifyAnswer(sid, parentId, '通过 int_key5, typeid=1743', {});

    ok(resumeCalled === 1, 'resumeFromClarification 被调用 1 次');
    ok(resumeParams && resumeParams.originalQuery === '取 typeid=1743 的数据, int_key5 为战场等级',
      'originalQuery 透传正确');
    ok(resumeParams && Array.isArray(resumeParams.context.history) &&
       resumeParams.context.history.length >= 3,
      'context.history 组装 ≥3 条(原问 + 澄清问 + 用户答)');
    ok(resumeParams.context.history[resumeParams.context.history.length - 1].role === 'user',
      'context.history 最后一条是 user(澄清回答)');

    ok(out && out.success === true, '返回 success=true');
    ok(out && out.engineUsed === 'agentic-resume', "engineUsed === 'agentic-resume'");
    ok(out && /typeid\s*=\s*1743/i.test(out.sql || ''), 'SQL 含 typeid=1743');

    const resultEvt = captured.find(e => e.type === 'result');
    ok(!!resultEvt, "SSE 广播了 'result' 事件");
    ok(resultEvt && resultEvt.data && /int_key5/i.test(resultEvt.data.sql || ''),
      "result 事件携带 SQL 含 int_key5");

    const procEvt = captured.find(e => e.type === 'processing');
    ok(!!procEvt, "SSE 广播了 'processing' 事件");

    // 落库:1 次 user(澄清回答) + 1 次 assistant(result)
    const userCalls = addMessageCalls.filter(c => c.role === 'user');
    const assistantCalls = addMessageCalls.filter(c => c.role === 'assistant');
    ok(userCalls.length === 1, 'user 消息落库 1 次(未重复)');
    ok(assistantCalls.length === 1, 'assistant result 消息落库 1 次');
  }

  // ============================================
  // case 2: 父澄清消息不存在 → 降级走 handleQuery
  // ============================================
  console.log('\n[case 2] 父消息不存在,降级走 handleQuery');
  {
    let resumeCalled = 0;
    let legacyCalled = 0;
    let agenticCalled = 0;
    agenticEngine.resumeFromClarification = async () => {
      resumeCalled++;
      return { success: true, type: 'sql_result', sql: 'X' };
    };
    agenticEngine.processQuery = async () => {
      agenticCalled++;
      return { success: true, type: 'sql_result', sql: 'SELECT 1' };
    };
    nl2sqlEngine.processQuery = async () => {
      legacyCalled++;
      return { success: true, sql: 'SELECT 1' };
    };

    database.getMessage = async () => null; // 模拟父消息不存在
    database.addMessage = async () => ({ id: 1 });

    const sid = 'sid-clar-2';
    await buildConnection(sid);
    await sseHandler.handleClarifyAnswer(sid, 99999, 'random answer', {});

    ok(resumeCalled === 0, 'resumeFromClarification 未被调用(降级)');
    ok(agenticCalled + legacyCalled >= 1,
      '降级路径:agentic 或 legacy 至少一个被调用(handleQuery 兜底)');
  }

  // ============================================
  // case 3: 父消息 metadata 缺 decomposition → 降级
  // ============================================
  console.log('\n[case 3] metadata 缺 decomposition,降级');
  {
    let resumeCalled = 0;
    let handleQueryHit = 0;
    agenticEngine.resumeFromClarification = async () => {
      resumeCalled++;
      return { success: true, type: 'sql_result' };
    };
    agenticEngine.processQuery = async () => {
      handleQueryHit++;
      return { success: true, type: 'sql_result' };
    };
    nl2sqlEngine.processQuery = async () => {
      handleQueryHit++;
      return { success: true };
    };

    database.getMessage = async (id) => ({
      id,
      type: 'clarification',
      message_type: 'clarification',
      content: 'q',
      metadata: { clarification: { question: 'q' } } // 缺 decomposition / originalQuery
    });
    database.addMessage = async () => ({ id: 2 });

    const sid = 'sid-clar-3';
    await buildConnection(sid);
    await sseHandler.handleClarifyAnswer(sid, 123, 'any', {});

    ok(resumeCalled === 0, '不完整 metadata → resume 未被调用');
    ok(handleQueryHit >= 1, '触发 handleQuery 兜底');
  }

  // ============================================
  // case 4: userAnswer 空串 → pushError,不触发任何引擎
  // ============================================
  console.log('\n[case 4] 空 userAnswer → 仅 pushError');
  {
    let resumeCalled = 0;
    agenticEngine.resumeFromClarification = async () => { resumeCalled++; return {}; };

    const sid = 'sid-clar-4';
    const captured = await buildConnection(sid);
    const out = await sseHandler.handleClarifyAnswer(sid, 1, '   ', {});

    ok(out === null, '返回 null');
    ok(resumeCalled === 0, 'resume 未被调用');
    const err = captured.find(e => e.type === 'error');
    ok(!!err, "SSE 广播 'error' 事件");
  }

  // 恢复
  agenticEngine.resumeFromClarification = origResume;
  agenticEngine.processQuery = origProcessQuery;
  nl2sqlEngine.processQuery = origLegacyProcess;
  database.addMessage = origAddMessage;
  database.getMessage = origGetMessage;

  console.log(`\n===== 结果 pass=${pass} fail=${fail} =====`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
