/**
 * Phase 4 · 任务 B 单测:selfRepair.generateErrorRecommendations 逻辑
 * 运行:node backend/test/phase4/test-selfRepair-audit.js
 *
 * 仅测纯逻辑函数 generateErrorRecommendations（无 db/cron 依赖）。
 * performDailyCheck 依赖 database/sseHandler/vectorStore,涉及启动副作用,
 * 不在此测试 — 通过冒烟验证覆盖。
 */

const path = require('path');
const selfRepair = require(path.resolve(__dirname, '../../src/core/selfRepair'));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

console.log('\n[selfRepair 导出]');
ok(typeof selfRepair.start === 'function', 'start 是函数');
ok(typeof selfRepair.stop === 'function', 'stop 是函数');
ok(typeof selfRepair.triggerDailyCheck === 'function', 'triggerDailyCheck 是函数');
ok(typeof selfRepair.triggerDeadLetterReplay === 'function', 'triggerDeadLetterReplay 是函数');
ok(typeof selfRepair.generateErrorRecommendations === 'function',
  'generateErrorRecommendations 导出(Phase 4)');

// ========================================
// generateErrorRecommendations 映射
// ========================================
console.log('\n[generateErrorRecommendations]');

const empty = selfRepair.generateErrorRecommendations([]);
ok(Array.isArray(empty) && empty.length === 0, '空数组 → []');

const nullRes = selfRepair.generateErrorRecommendations(null);
ok(Array.isArray(nullRes) && nullRes.length === 0, 'null → []');

const codes = [
  { code: 'SR_DB_NOT_READY',     count: 5 },
  { code: 'SR_DB_NOT_CONFIGURED',count: 1 },
  { code: 'SR_EXEC_ERROR',       count: 12 },
  { code: 'VALIDATION_ERROR',    count: 3 },
  { code: 'RLS_REWRITE_FAILED',  count: 2 },
  { code: 'LLM_ERROR',           count: 4 },
  { code: 'PIPELINE_ERROR',      count: 1 },
  { code: 'UNKNOWN_CODE_XYZ',    count: 7 }
];
const advices = selfRepair.generateErrorRecommendations(codes);

ok(advices.length === codes.length, `8 条 → 8 条建议`);
for (let i = 0; i < codes.length; i++) {
  ok(advices[i].code === codes[i].code, `第 ${i} 项 code 对齐`);
  ok(advices[i].count === codes[i].count, `第 ${i} 项 count 保留`);
  ok(typeof advices[i].advice === 'string' && advices[i].advice.length > 0,
    `第 ${i} 项 advice 非空`);
}

// 具体映射
const byCode = {};
for (const a of advices) byCode[a.code] = a.advice;

ok(/SR_DATABASE_URL/.test(byCode.SR_DB_NOT_READY), 'SR_DB_NOT_READY → 提 SR_DATABASE_URL');
ok(/SR_DB_ENABLED/.test(byCode.SR_DB_NOT_CONFIGURED), 'SR_DB_NOT_CONFIGURED → 提 SR_DB_ENABLED');
ok(/sqlRewriter/.test(byCode.RLS_REWRITE_FAILED), 'RLS_REWRITE_FAILED → 提 sqlRewriter');
ok(/LLM_API_KEY/.test(byCode.LLM_ERROR), 'LLM_ERROR → 提 LLM_API_KEY');
ok(byCode.UNKNOWN_CODE_XYZ && byCode.UNKNOWN_CODE_XYZ.length > 0,
  '未知 code 也有 fallback advice');

// ========================================
console.log('\n--------');
console.log(`结果: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
