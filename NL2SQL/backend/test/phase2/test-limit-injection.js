/**
 * Phase 2 / 步骤1 单测:sqlLimit(hasOuterLimit / ensureLimit)
 *
 * 运行:node backend/test/phase2/test-limit-injection.js
 */

const assert = require('assert');
const path = require('path');

const { hasOuterLimit, ensureLimit } = require(
  path.resolve(__dirname, '../../src/utils/sqlLimit')
);

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

// ---------- hasOuterLimit: 应返回 true ----------
console.log('\n[hasOuterLimit 正例]');
[
  'SELECT * FROM t LIMIT 10',
  'SELECT * FROM t LIMIT 10;',
  'select * from t limit 10   ;',
  'SELECT * FROM t LIMIT 10, 20',
  'SELECT * FROM t LIMIT 10 OFFSET 5',
  'SELECT * FROM t ORDER BY id DESC LIMIT 100',
  'SELECT id FROM t WHERE name = "x" LIMIT 1;;',
].forEach(sql => {
  ok(hasOuterLimit(sql) === true, `识别为有 LIMIT: ${sql.slice(0, 60)}`);
});

// ---------- hasOuterLimit: 应返回 false ----------
console.log('\n[hasOuterLimit 反例]');
[
  'SELECT * FROM t',
  'SELECT * FROM t WHERE name = "limit"',               // 列值里有 limit 字样
  'SELECT LIMIT_TIME FROM t WHERE x=1',                 // 列名以 LIMIT 开头
  'SELECT * FROM (SELECT id FROM t LIMIT 5) sub',       // 仅子查询有 LIMIT
  'SELECT COUNT(*) FROM t',
  '',
  null,
  undefined,
].forEach(sql => {
  ok(hasOuterLimit(sql) === false, `识别为无 LIMIT: ${String(sql).slice(0, 60)}`);
});

// ---------- ensureLimit 行为 ----------
console.log('\n[ensureLimit 注入]');
{
  const r = ensureLimit('SELECT * FROM t', 100);
  ok(r.injected === true, 'injected=true');
  ok(r.sql === 'SELECT * FROM t LIMIT 100', `sql=${r.sql}`);
}
{
  const r = ensureLimit('SELECT * FROM t;', 500);
  ok(r.injected === true, 'injected=true(去掉分号后追加)');
  ok(r.sql === 'SELECT * FROM t LIMIT 500', `sql=${r.sql}`);
}
{
  const r = ensureLimit('SELECT * FROM t LIMIT 10', 1000);
  ok(r.injected === false, '已有 LIMIT 不重复注入');
  ok(r.sql === 'SELECT * FROM t LIMIT 10', 'sql 保持原样');
}
{
  const r = ensureLimit('SELECT * FROM (SELECT x FROM y LIMIT 3) z', 1000);
  ok(r.injected === true, '仅子查询有 LIMIT 时应注入外层 LIMIT');
  ok(r.sql.endsWith(' LIMIT 1000'), `sql 以 LIMIT 1000 结尾: ${r.sql}`);
}
{
  const r = ensureLimit(null, 100);
  ok(r.injected === false && r.sql === null, 'null 输入兜底');
}
{
  const r = ensureLimit('SELECT 1', 0);
  ok(r.injected === false, 'maxRows<=0 不注入');
}

console.log(`\n结果: pass=${pass}, fail=${fail}`);
if (fail > 0) {
  console.error('❌ test-limit-injection 失败');
  process.exit(1);
}
console.log('✅ test-limit-injection 全部通过');
process.exit(0);
