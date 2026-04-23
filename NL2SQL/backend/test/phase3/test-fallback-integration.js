/**
 * Phase 3 / T1 集成测试:引擎入口切换 + 自动回退
 *
 * 覆盖三个场景:
 *   场景 A: agenticEngine 返回 {success:false} → 自动回退 legacy,fallbackUsed=true
 *   场景 B: agenticEngine 抛异常 → 自动回退 legacy,fallbackUsed=true
 *   场景 C: FF_AGENTIC_ENGINE=false → 直接走 legacy,fallbackUsed=false
 *
 * 运行:node backend/test/phase3/test-fallback-integration.js
 * 不依赖 LLM_API_KEY / DB 连接(全部 mock)。
 */

// 先设环境变量,确保 feature-flags 初始化时读到正确值
process.env.FF_AGENTIC_ENGINE = 'true';
process.env.FF_AGENTIC_AUTO_FALLBACK = 'true';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'warn'; // 降噪

const assert = require('assert');
const path = require('path');

// 加载模块(database 要先 stub getSession)
const database = require(path.resolve(__dirname, '../../src/core/database'));
database.getSession = async () => ({ id: 'test-session', title: '测试会话' });

const agenticEngine = require(path.resolve(__dirname, '../../src/core/agenticEngine'));
const nl2sqlEngine = require(path.resolve(__dirname, '../../src/core/nl2sqlEngine'));
const sseHandler = require(path.resolve(__dirname, '../../src/core/sseHandler'));
const featureFlags = require(path.resolve(__dirname, '../../config/feature-flags'));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

// ----------------------------------------
// 辅助:假 SSE res / req,收集广播事件
// ----------------------------------------
function makeFakeRes(captured) {
  return {
    writeHead: () => {},
    write: (chunk) => {
      // SSE 格式 "data: <json>\n\n"
      const m = /^data:\s*(.+)$/m.exec(String(chunk));
      if (m) {
        try { captured.push(JSON.parse(m[1])); } catch (e) { captured.push({ raw: m[1] }); }
      }
    },
    end: () => {},
    status: () => ({ json: () => {} })
  };
}

function makeFakeReq(sessionId, opts = {}) {
  return {
    query: { session_id: sessionId, user_id: opts.userId || 'tester' },
    headers: opts.headers || { 'x-tenant-id': 'acme' },
    ip: opts.ip || '127.0.0.1',
    on: () => {}
  };
}

async function buildConnection(sessionId, opts = {}) {
  const captured = [];
  const res = makeFakeRes(captured);
  const req = makeFakeReq(sessionId, opts);
  await sseHandler.handleConnection(req, res);
  return { captured, res, req };
}

// 保存原始引擎函数供回滚
const origAgentic = agenticEngine.processQuery;
const origLegacy = nl2sqlEngine.processQuery;

// ========================================
// 场景 A: agentic 返回 success:false → 回退 legacy
// ========================================
async function caseA() {
  console.log('\n[场景 A] agenticEngine 返回 success:false,应自动回退 legacy');

  let agenticCalled = 0, legacyCalled = 0;
  let legacyCtx = null, legacyUserId = null;

  agenticEngine.processQuery = async (q, ctx, onProgress) => {
    agenticCalled++;
    return { success: false, error: 'mocked_agentic_failure', type: 'error' };
  };
  nl2sqlEngine.processQuery = async (q, sid, onProgress, userId, ctx) => {
    legacyCalled++;
    legacyUserId = userId;
    legacyCtx = ctx;
    return { success: true, sql: 'SELECT 1 LIMIT 1', result: 'ok' };
  };

  const sid = 'sid-case-a';
  const { captured } = await buildConnection(sid);

  const out = await sseHandler.handleQuery(sid, '查询A', { userId: 'alice', tenantId: 'acme' });

  ok(agenticCalled === 1, 'agentic 被调用 1 次');
  ok(legacyCalled === 1, 'legacy 被调用 1 次(作 fallback)');
  ok(legacyUserId === 'alice', 'legacy 拿到 context.userId');
  ok(legacyCtx && legacyCtx.tenantId === 'acme', 'legacy 拿到 context.tenantId');
  ok(out && out.fallbackUsed === true, 'result.fallbackUsed === true');
  ok(out && out.engineUsed === 'legacy-after-agentic', "result.engineUsed === 'legacy-after-agentic'");

  const resultEvt = captured.find(e => e.type === 'result');
  ok(!!resultEvt, "SSE 广播了 'result' 事件");
  ok(resultEvt && resultEvt.data && resultEvt.data.fallbackUsed === true,
    "SSE 'result' 事件携带 fallbackUsed:true");
}

// ========================================
// 场景 B: agentic 抛异常 → 回退 legacy
// ========================================
async function caseB() {
  console.log('\n[场景 B] agenticEngine 抛异常,应自动回退 legacy');

  let agenticCalled = 0, legacyCalled = 0;

  agenticEngine.processQuery = async () => {
    agenticCalled++;
    throw new Error('mocked_agentic_throw');
  };
  nl2sqlEngine.processQuery = async () => {
    legacyCalled++;
    return { success: true, sql: 'SELECT 2 LIMIT 1' };
  };

  const sid = 'sid-case-b';
  const { captured } = await buildConnection(sid);

  const out = await sseHandler.handleQuery(sid, '查询B', { userId: 'bob' });

  ok(agenticCalled === 1, 'agentic 被调用 1 次(抛异常)');
  ok(legacyCalled === 1, 'legacy 被调用 1 次(catch 兜底)');
  ok(out && out.fallbackUsed === true, 'result.fallbackUsed === true');
  ok(out && out.engineUsed === 'legacy-after-agentic', "engineUsed === 'legacy-after-agentic'");

  const errEvt = captured.find(e => e.type === 'error');
  ok(!errEvt, '前端未收到 error 事件(fallback 对前端静默)');
}

// ========================================
// 场景 C: FF_AGENTIC_ENGINE=false → 直走 legacy
// ========================================
async function caseC() {
  console.log('\n[场景 C] FF_AGENTIC_ENGINE=false,直走 legacy');

  // 临时关掉 agentic flag(需要绕过 featureFlags 缓存,直接改引用)
  const origIsEnabled = featureFlags.isEnabled;
  featureFlags.isEnabled = (name) => name === 'AGENTIC_ENGINE' ? false : origIsEnabled(name);

  try {
    let agenticCalled = 0, legacyCalled = 0;

    agenticEngine.processQuery = async () => { agenticCalled++; return { success: true }; };
    nl2sqlEngine.processQuery = async () => {
      legacyCalled++;
      return { success: true, sql: 'SELECT 3 LIMIT 1' };
    };

    const sid = 'sid-case-c';
    await buildConnection(sid);

    const out = await sseHandler.handleQuery(sid, '查询C', { userId: 'carol' });

    ok(agenticCalled === 0, 'agentic 未被调用');
    ok(legacyCalled === 1, 'legacy 被调用 1 次');
    ok(out && out.fallbackUsed === false, 'result.fallbackUsed === false');
    ok(out && out.engineUsed === 'legacy', "result.engineUsed === 'legacy'");
  } finally {
    featureFlags.isEnabled = origIsEnabled;
  }
}

// ========================================
// 场景 D: FF_AGENTIC_AUTO_FALLBACK=false + agentic 失败 → 抛出 error 事件
// ========================================
async function caseD() {
  console.log('\n[场景 D] FF_AGENTIC_AUTO_FALLBACK=false + agentic 失败,应抛 error');

  const origIsEnabled = featureFlags.isEnabled;
  featureFlags.isEnabled = (name) => {
    if (name === 'AGENTIC_ENGINE') return true;
    if (name === 'AGENTIC_AUTO_FALLBACK') return false;
    return origIsEnabled(name);
  };

  try {
    let legacyCalled = 0;
    agenticEngine.processQuery = async () => ({ success: false, error: 'hard_fail' });
    nl2sqlEngine.processQuery = async () => { legacyCalled++; return { success: true }; };

    const sid = 'sid-case-d';
    const { captured } = await buildConnection(sid);

    let threw = false;
    try {
      await sseHandler.handleQuery(sid, '查询D', { userId: 'dave' });
    } catch (e) {
      threw = true;
    }
    ok(threw, 'handleQuery 抛出异常(AUTO_FALLBACK 关闭时)');
    ok(legacyCalled === 0, 'legacy 未被调用(无兜底)');

    const errEvt = captured.find(e => e.type === 'error');
    ok(!!errEvt, "前端收到 'error' 事件");
  } finally {
    featureFlags.isEnabled = origIsEnabled;
  }
}

// ========================================
// 主流程
// ========================================
(async () => {
  try {
    await caseA();
    await caseB();
    await caseC();
    await caseD();
  } catch (e) {
    console.error('测试执行异常:', e);
    fail++;
  } finally {
    // 恢复原始引擎
    agenticEngine.processQuery = origAgentic;
    nl2sqlEngine.processQuery = origLegacy;

    console.log(`\n--------\n结果: ${pass} passed, ${fail} failed`);
    // 强制退出,避免被 db 连接等资源挂住
    process.exit(fail > 0 ? 1 : 0);
  }
})();
