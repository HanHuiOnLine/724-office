/**
 * Phase 4 · 任务 A.5 单测:resultFormatter 失败路径 + 空结果分支
 * 运行:node backend/test/phase4/test-resultFormatter-exports.js
 *
 * 只测不需要 LLM 的分支(失败路径和异常降级),成功路径依赖 LLM 略过。
 */

const path = require('path');
const resultFormatter = require(path.resolve(__dirname, '../../src/core/resultFormatter'));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

console.log('\n[resultFormatter 导出]');
ok(typeof resultFormatter.formatResult === 'function', 'formatResult 是函数');

(async () => {
  // ========================================
  // 失败路径:result.success=false → 直接拼错误文本,不调 LLM
  // ========================================
  console.log('\n[formatResult 失败路径]');
  const r1 = await resultFormatter.formatResult(
    { success: false, error: 'SR_DB_NOT_READY' },
    '最近7天流水'
  );
  ok(typeof r1 === 'string', '返回字符串');
  ok(r1.includes('查询失败'), '含"查询失败"');
  ok(r1.includes('SR_DB_NOT_READY'), '含原错误信息');

  const r2 = await resultFormatter.formatResult(
    { success: false, error: 'timeout' },
    'test'
  );
  ok(r2.includes('timeout'), '另一错误信息');

  console.log('\n--------');
  console.log(`结果: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
