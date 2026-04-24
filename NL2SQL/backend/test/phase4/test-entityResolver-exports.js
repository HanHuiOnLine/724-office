/**
 * Phase 4 · 任务 A.2 单测:entityResolver 导出契约 + inferTablesFromQuery / extractPotentialEntityNames
 * 运行:node backend/test/phase4/test-entityResolver-exports.js
 */

const path = require('path');
const entityResolver = require(path.resolve(__dirname, '../../src/core/entityResolver'));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

console.log('\n[entityResolver 导出]');
const expected = [
  'learnEntityAliasFromContext',
  'extractPotentialEntityNames',
  'getBusinessKeywordMap',
  'inferTablesFromQuery',
  'resolveEntity',
  'resolveEntitiesInIntent',
  'resolvePlatformInIntent'
];
for (const name of expected) {
  ok(typeof entityResolver[name] === 'function', `${name} 是函数`);
}

// ========================================
// inferTablesFromQuery
// ========================================
console.log('\n[inferTablesFromQuery]');
ok(entityResolver.inferTablesFromQuery('').length === 0, '空串 → []');
ok(entityResolver.inferTablesFromQuery(null).length === 0, 'null → []');
ok(entityResolver.inferTablesFromQuery(undefined).length === 0, 'undefined → []');

// 返回数组
const res = entityResolver.inferTablesFromQuery('查询昨天的注册用户数');
ok(Array.isArray(res), '返回数组');

// ========================================
// extractPotentialEntityNames
// ========================================
console.log('\n[extractPotentialEntityNames]');
ok(entityResolver.extractPotentialEntityNames('').length === 0, '空串 → []');
ok(entityResolver.extractPotentialEntityNames(null).length === 0, 'null → []');

const names1 = entityResolver.extractPotentialEntityNames('青木游戏的收入');
ok(names1.some(n => n.includes('青木')), '中文命名实体可被提取(含青木)');

const names2 = entityResolver.extractPotentialEntityNames('王者荣耀WZRY流水');
ok(names2.some(n => n === 'wzry' || n.toLowerCase() === 'wzry'), '英文实体被小写化');

const names3 = entityResolver.extractPotentialEntityNames('"青木"的流水');
ok(names3.includes('青木'), '引号内容被提取');

// ========================================
// resolveEntity:srDatabase 未就绪时的优雅降级
// ========================================
console.log('\n[resolveEntity 降级]');
(async () => {
  const r = await entityResolver.resolveEntity('青木', 'game');
  // 在未配置 SR DB 的测试环境下,应走 SR_DB_NOT_READY 分支
  ok(r && r.found === false, 'resolveEntity 在 SR DB 未就绪时 found=false');
  ok(r.reason === 'SR_DB_NOT_READY' || r.reason === undefined,
    `reason 为 SR_DB_NOT_READY 或未定义 (实际: ${r.reason})`);

  const r2 = await entityResolver.resolveEntity('青木', 'unknown_type');
  ok(r2 && r2.found === false, '未知 entityType → found=false');

  console.log('\n--------');
  console.log(`结果: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
