/**
 * Phase 4 · 任务 A.3 单测:sqlGenerator 导出契约 + generateSchemaMappingHints
 * 运行:node backend/test/phase4/test-sqlGenerator-exports.js
 */

const path = require('path');
const sqlGenerator = require(path.resolve(__dirname, '../../src/core/sqlGenerator'));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

console.log('\n[sqlGenerator 导出]');
ok(typeof sqlGenerator.generateSQL === 'function', 'generateSQL 是函数');
ok(typeof sqlGenerator.generateSchemaMappingHints === 'function', 'generateSchemaMappingHints 是函数');

// ========================================
// generateSchemaMappingHints 分支
// ========================================
console.log('\n[generateSchemaMappingHints]');

ok(sqlGenerator.generateSchemaMappingHints([]) === '', '空表 → 空串');
ok(sqlGenerator.generateSchemaMappingHints(['unknown_table']) === '', '未命中任何关键词 → 空串');

const regHint = sqlGenerator.generateSchemaMappingHints(['tzpingtai_tz_sdk_log_pf_reg']);
ok(regHint.includes('注册时间'), '注册表 → 注册时间 hint');
ok(regHint.includes('COUNT(DISTINCT'), '注册表 → COUNT(DISTINCT ...)');

const loginHint = sqlGenerator.generateSchemaMappingHints(['tzpingtai_tz_sdk_log_pf_login']);
ok(loginHint.includes('登录时间'), 'login 表 → 登录时间 hint');

const orderHint = sqlGenerator.generateSchemaMappingHints(['tzpingtai_tz_sdk_log_pf_order']);
ok(orderHint.includes('real_amount'), 'order 表 → real_amount 提示');
ok(orderHint.includes('SUM('), 'order 表 → SUM 聚合');

const chatHint = sqlGenerator.generateSchemaMappingHints(['tzhlxxyi_log_game_user_chat']);
ok(chatHint.includes('发言'), 'chat 表 → 发言 hint');

// 混合表
const multi = sqlGenerator.generateSchemaMappingHints([
  'tzpingtai_tz_sdk_log_pf_reg',
  'tzpingtai_tz_sdk_log_pf_order'
]);
ok(multi.includes('注册时间') && multi.includes('real_amount'), '多表组合命中多组 hint');

// ========================================
console.log('\n--------');
console.log(`结果: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
