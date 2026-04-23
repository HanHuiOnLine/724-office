/**
 * Phase 3 / T1 单测:requestContext
 *
 * 覆盖:
 *   - 4 个 header 全齐 → 全部取到
 *   - header 缺失 → 默认值(anonymous / user / null / web)
 *   - user_id 缺 header 时走 req.query.user_id 再走 req.body.user_id
 *   - req.ip 透传;fallback req.connection.remoteAddress
 *   - header 值首尾空白去除;空串不覆盖默认
 *   - mergeIntoContext:undefined 不覆盖;非 undefined 覆盖
 *
 * 运行:node backend/test/phase3/test-requestContext.js
 */

const assert = require('assert');
const path = require('path');

const { extractContext, mergeIntoContext } = require(
  path.resolve(__dirname, '../../src/core/requestContext')
);

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

// ========================================
// extractContext
// ========================================
console.log('\n[extractContext]');

// 1. 4 个 header 全齐
const ctx1 = extractContext({
  headers: {
    'x-user-id': 'alice',
    'x-user-role': 'admin',
    'x-tenant-id': 'acme',
    'x-request-source': 'cli'
  },
  ip: '10.0.0.1'
});
ok(ctx1.userId === 'alice', 'userId 从 header 取到');
ok(ctx1.userRole === 'admin', 'userRole 从 header 取到');
ok(ctx1.tenantId === 'acme', 'tenantId 从 header 取到');
ok(ctx1.requestSource === 'cli', 'requestSource 从 header 取到');
ok(ctx1.requestIp === '10.0.0.1', 'requestIp 从 req.ip 取到');

// 2. header 全缺失 → 默认值
const ctx2 = extractContext({ headers: {}, ip: null });
ok(ctx2.userId === 'anonymous', 'userId 缺省 anonymous');
ok(ctx2.userRole === 'user', 'userRole 缺省 user');
ok(ctx2.tenantId === null, 'tenantId 缺省 null');
ok(ctx2.requestSource === 'web', 'requestSource 缺省 web');
ok(ctx2.requestIp === null, 'requestIp 缺省 null');

// 3. user_id 从 query param 兜底(Phase 1 兼容)
const ctx3 = extractContext({
  headers: {},
  query: { user_id: 'bob_from_query' }
});
ok(ctx3.userId === 'bob_from_query', 'userId 从 query param 兜底');

// 4. user_id 从 body 兜底
const ctx4 = extractContext({
  headers: {},
  query: {},
  body: { user_id: 'carol_from_body' }
});
ok(ctx4.userId === 'carol_from_body', 'userId 从 body 兜底');

// 5. header 优先级最高
const ctx5 = extractContext({
  headers: { 'x-user-id': 'header_wins' },
  query: { user_id: 'query_loses' },
  body: { user_id: 'body_loses' }
});
ok(ctx5.userId === 'header_wins', 'header > query > body 优先级');

// 6. req.connection.remoteAddress 作 req.ip 兜底
const ctx6 = extractContext({
  headers: {},
  connection: { remoteAddress: '192.168.1.5' }
});
ok(ctx6.requestIp === '192.168.1.5', 'requestIp 用 connection.remoteAddress 兜底');

// 7. header 值空白/空串 → 走默认
const ctx7 = extractContext({
  headers: {
    'x-user-id': '   ',
    'x-user-role': '',
    'x-tenant-id': ' acme '
  }
});
ok(ctx7.userId === 'anonymous', '空白 header 视为空,走默认');
ok(ctx7.userRole === 'user', '空串 header 走默认');
ok(ctx7.tenantId === 'acme', 'header 值首尾空白被 trim');

// 8. 数组 header 取第一个(某些代理会传多个)
const ctx8 = extractContext({
  headers: { 'x-user-id': ['first', 'second'] }
});
ok(ctx8.userId === 'first', '数组 header 取首个');

// 9. req 为空对象兜底
const ctx9 = extractContext({});
ok(ctx9.userId === 'anonymous' && ctx9.tenantId === null, '空 req 全走默认');

// ========================================
// mergeIntoContext
// ========================================
console.log('\n[mergeIntoContext]');

const merged1 = mergeIntoContext({ userId: 'a', tenantId: 't1' }, { tenantId: 't2', userRole: 'admin' });
ok(merged1.userId === 'a' && merged1.tenantId === 't2' && merged1.userRole === 'admin',
  'extra 覆盖 base 的同名字段,其他字段保留');

const merged2 = mergeIntoContext({ userId: 'a' }, { userId: undefined });
ok(merged2.userId === 'a', 'undefined 不覆盖');

const merged3 = mergeIntoContext({ userId: 'a' }, { userId: null });
ok(merged3.userId === null, 'null 覆盖(与 undefined 行为区分)');

const merged4 = mergeIntoContext(undefined, undefined);
ok(typeof merged4 === 'object' && Object.keys(merged4).length === 0,
  '两个 undefined 输入返回空对象,不抛异常');

// ========================================
// 汇总
// ========================================
console.log(`\n--------\n结果: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
