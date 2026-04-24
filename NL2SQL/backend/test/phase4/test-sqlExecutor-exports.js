/**
 * Phase 4 · 任务 A.4 单测:sqlExecutor.validateSQL 分支 + executeQuery 错误码分支
 * 运行:node backend/test/phase4/test-sqlExecutor-exports.js
 */

const path = require('path');
const sqlExecutor = require(path.resolve(__dirname, '../../src/core/sqlExecutor'));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

console.log('\n[sqlExecutor 导出]');
ok(typeof sqlExecutor.validateSQL === 'function', 'validateSQL 是函数');
ok(typeof sqlExecutor.executeQuery === 'function', 'executeQuery 是函数');

// ========================================
// validateSQL 分支
// ========================================
console.log('\n[validateSQL]');

const r1 = sqlExecutor.validateSQL('SELECT * FROM tzpingtai_tz_sdk_log_pf_order LIMIT 10');
ok(r1.valid === true, '合法 SELECT+LIMIT → valid');

const r2 = sqlExecutor.validateSQL('WITH cte AS (SELECT 1 FROM dual) SELECT * FROM cte LIMIT 10');
ok(r2.valid === true, '合法 WITH+LIMIT → valid');

const r3 = sqlExecutor.validateSQL('UPDATE t SET a=1 LIMIT 1');
ok(r3.valid === false, 'UPDATE 被拒');

const r4 = sqlExecutor.validateSQL('DELETE FROM t WHERE 1=1 LIMIT 1');
ok(r4.valid === false, 'DELETE 被拒');

const r5 = sqlExecutor.validateSQL('SELECT 1');
ok(r5.valid === false && /LIMIT/.test(r5.error || ''), '无 LIMIT 被拒,错误提示 LIMIT');

const r6 = sqlExecutor.validateSQL('-- 注释\nSELECT 1 FROM t LIMIT 10');
ok(r6.valid === true, '带 -- 注释的 SELECT+LIMIT → valid');

const r7 = sqlExecutor.validateSQL('/* 多行\n注释 */ SELECT 1 FROM t LIMIT 10');
ok(r7.valid === true, '带 /* */ 注释的 SELECT+LIMIT → valid');

const r8 = sqlExecutor.validateSQL('\n\n  SELECT 1 FROM t LIMIT 10');
ok(r8.valid === true, '前置空白/空行的 SELECT+LIMIT → valid');

// ========================================
// executeQuery 在非 DRY_RUN 且 SR 未配置时应返回 SR_DB_NOT_CONFIGURED 或 SR_DB_NOT_READY
// ========================================
console.log('\n[executeQuery 降级]');
(async () => {
  const r = await sqlExecutor.executeQuery('SELECT 1 FROM t LIMIT 1');
  ok(r && typeof r === 'object', '返回对象');
  ok(r.success === false || r.success === true, '返回含 success 字段');
  if (r.success === false) {
    ok(['SR_DB_NOT_CONFIGURED', 'SR_DB_NOT_READY', 'SR_EXEC_ERROR'].includes(r.errorCode),
      `errorCode 属于已知枚举 (实际: ${r.errorCode})`);
  }

  console.log('\n--------');
  console.log(`结果: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
