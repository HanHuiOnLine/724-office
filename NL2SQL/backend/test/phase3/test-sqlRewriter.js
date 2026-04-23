/**
 * Phase 3 / T3b 单测:sqlRewriter.injectTenantFilter
 *
 * 覆盖:
 *   - 单表 SELECT 注入
 *   - JOIN 多表(WHERE 追加两个条件)
 *   - UNION ALL(每段独立注入)
 *   - CTE(WITH...AS 内的 SELECT 被注入)
 *   - FROM 子查询(嵌套 SELECT 被注入)
 *   - alias 保留(AS so → so.tenant_id)
 *   - unmapped 表 → 原样
 *   - malformed SQL → refused:true PARSE_FAIL
 *   - tenantId 空 → refused NO_TENANT_ID
 *   - 空 tableTenantMap → 放行不视为错误
 *   - 列名/表名大小写不敏感匹配
 *   - parseTenantMapEnv 各种形式
 *
 * 运行:node backend/test/phase3/test-sqlRewriter.js
 */

const assert = require('assert');
const path = require('path');

const { injectTenantFilter, parseTenantMapEnv } = require(
  path.resolve(__dirname, '../../src/utils/sqlRewriter')
);

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

const MAP = { orders: 'tenant_id', users: 'tenant_id' };

// ========================================
// 单表 SELECT
// ========================================
console.log('\n[单表 SELECT]');
{
  const r = injectTenantFilter('SELECT * FROM orders WHERE amount > 100 LIMIT 10', MAP, 'acme');
  ok(!r.refused, 'refused=false');
  ok(r.applied.length === 1 && r.applied[0] === 'orders', 'applied=[orders]');
  ok(/tenant_id.*=.*['"]acme['"]/i.test(r.sql), `注入 tenant_id='acme':${r.sql}`);
  ok(/amount/i.test(r.sql) && /LIMIT 10/i.test(r.sql), '原 WHERE/LIMIT 保留');
}

// ========================================
// JOIN 多表
// ========================================
console.log('\n[JOIN 多表 alias 保留]');
{
  const r = injectTenantFilter(
    'SELECT o.id FROM orders AS o INNER JOIN users AS u ON u.id = o.user_id WHERE o.status = 1',
    MAP, 'acme'
  );
  ok(!r.refused, 'refused=false');
  ok(r.applied.sort().join(',') === 'orders,users', 'applied=[orders,users]');
  ok(/`o`\.`tenant_id`/.test(r.sql), 'orders 的 alias o 保留');
  ok(/`u`\.`tenant_id`/.test(r.sql), 'users 的 alias u 保留');
}

// ========================================
// UNION ALL
// ========================================
console.log('\n[UNION ALL]');
{
  const r = injectTenantFilter(
    'SELECT id FROM orders WHERE status=1 UNION ALL SELECT id FROM orders WHERE status=2',
    MAP, 'acme'
  );
  ok(!r.refused, 'refused=false');
  ok(r.applied.includes('orders'), 'applied 包含 orders(去重后只出现 1 次是设计)');
  // 两段 SQL 都应含 tenant_id
  const sqlUp = r.sql.toUpperCase();
  const firstMatch = (sqlUp.match(/TENANT_ID/g) || []).length;
  ok(firstMatch === 2, `SQL 中出现 2 次 tenant_id(实际 ${firstMatch})`);
}

// ========================================
// CTE
// ========================================
console.log('\n[CTE]');
{
  const r = injectTenantFilter(
    'WITH ranked AS (SELECT * FROM orders) SELECT * FROM ranked',
    MAP, 'acme'
  );
  ok(!r.refused, 'CTE 改写未被拒绝');
  ok(r.applied.includes('orders'), 'CTE 内 orders 被注入');
  ok(/WITH.*ranked.*AS.*SELECT.*tenant_id/is.test(r.sql), 'tenant_id 出现在 CTE 内部');
}

// ========================================
// FROM 子查询
// ========================================
console.log('\n[FROM 子查询]');
{
  const r = injectTenantFilter(
    'SELECT * FROM (SELECT * FROM orders WHERE amount > 50) AS sub',
    MAP, 'acme'
  );
  ok(!r.refused, 'FROM 子查询改写未被拒绝');
  ok(r.applied.includes('orders'), '子查询中 orders 被注入');
  ok(/tenant_id.*=.*['"]acme['"]/i.test(r.sql), '嵌套 SELECT 含 tenant_id');
}

// ========================================
// unmapped 表 → 原样
// ========================================
console.log('\n[unmapped 表]');
{
  const r = injectTenantFilter(
    'SELECT * FROM products WHERE price > 10',
    MAP, 'acme'
  );
  ok(!r.refused, '不拒绝');
  ok(r.applied.length === 0, 'applied=空');
  ok(r.sql === 'SELECT * FROM products WHERE price > 10', '原 SQL 未被改写');
}

// ========================================
// malformed SQL
// ========================================
console.log('\n[malformed SQL]');
{
  const r = injectTenantFilter('SELEC * FROM orders', MAP, 'acme');
  ok(r.refused === true, 'refused=true');
  ok(/^PARSE_FAIL/.test(r.reason), `reason 以 PARSE_FAIL 开头(${r.reason})`);
}

// ========================================
// tenantId 空 / 缺失
// ========================================
console.log('\n[tenantId 空]');
{
  const r1 = injectTenantFilter('SELECT * FROM orders', MAP, '');
  ok(r1.refused === true && r1.reason === 'NO_TENANT_ID', "空串 tenantId → refused:NO_TENANT_ID");

  const r2 = injectTenantFilter('SELECT * FROM orders', MAP, null);
  ok(r2.refused === true && r2.reason === 'NO_TENANT_ID', 'null tenantId → refused');

  const r3 = injectTenantFilter('SELECT * FROM orders', MAP, undefined);
  ok(r3.refused === true && r3.reason === 'NO_TENANT_ID', 'undefined tenantId → refused');
}

// ========================================
// 空 map / null map
// ========================================
console.log('\n[空 map]');
{
  const r1 = injectTenantFilter('SELECT * FROM orders', {}, 'acme');
  ok(!r1.refused && r1.applied.length === 0 && r1.sql === 'SELECT * FROM orders',
    '空 map 放行,不改写');
  const r2 = injectTenantFilter('SELECT * FROM orders', null, 'acme');
  ok(!r2.refused && r2.applied.length === 0, 'null map 放行');
}

// ========================================
// 大小写不敏感
// ========================================
console.log('\n[大小写不敏感匹配]');
{
  const r = injectTenantFilter('SELECT * FROM Orders WHERE id=1', { orders: 'tenant_id' }, 'acme');
  ok(!r.refused, '大小写不一致仍命中 map');
  ok(r.applied.includes('Orders') || r.applied.includes('orders'), 'applied 含该表');
  ok(/tenant_id/i.test(r.sql), '已注入');
}

// ========================================
// 非 SELECT 拒绝
// ========================================
console.log('\n[非 SELECT 语句]');
{
  const r = injectTenantFilter('UPDATE orders SET amount=100', MAP, 'acme');
  ok(r.refused === true, '非 SELECT → refused(UPDATE/DELETE 不应走到这一步,validateSQL 先拦住;这里作为第二道防线)');
}

// ========================================
// 改写后可被 sqlify + 重新 astify 验证
// ========================================
console.log('\n[改写后 well-formedness 验证]');
{
  // 这里没法直接 stub sqlify 失败,但走一遍回归:改写后的 SQL 应含 AND 且括号配对
  const r = injectTenantFilter(
    'SELECT o.id FROM orders o WHERE o.amount > 100',
    MAP, 'acme'
  );
  ok(!r.refused, '未被 VERIFY 拒绝');
  const opens = (r.sql.match(/\(/g) || []).length;
  const closes = (r.sql.match(/\)/g) || []).length;
  ok(opens === closes, `括号配对 (${opens}=${closes})`);
}

// ========================================
// parseTenantMapEnv
// ========================================
console.log('\n[parseTenantMapEnv]');
{
  const m1 = parseTenantMapEnv('orders:tenant_id,users:tenant_id');
  ok(m1.orders === 'tenant_id' && m1.users === 'tenant_id', '基本格式');

  const m2 = parseTenantMapEnv(' orders : tenant_id , users : tid ');
  ok(m2.orders === 'tenant_id' && m2.users === 'tid', '允许空白');

  const m3 = parseTenantMapEnv('');
  ok(typeof m3 === 'object' && Object.keys(m3).length === 0, '空串 → {}');

  const m4 = parseTenantMapEnv(null);
  ok(typeof m4 === 'object' && Object.keys(m4).length === 0, 'null → {}');

  const m5 = parseTenantMapEnv('badformat');
  ok(Object.keys(m5).length === 0, '无冒号 → 跳过');
}

// ========================================
// 汇总
// ========================================
console.log(`\n--------\n结果: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
