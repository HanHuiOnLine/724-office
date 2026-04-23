/**
 * 批次 B 单测:clarificationEngine.applyClarificationResult + applyUncoveredDataUnit
 *
 * 运行:node backend/test/phase3/clarification-apply.test.js
 * 无外部依赖,原生 assert,match 项目现有测试风格(phase3/test-safeLog.js)。
 */

const path = require('path');

const clarificationEngine = require(path.resolve(__dirname, '../../src/core/clarificationEngine'));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

// ========================================
// case 1: applyUncoveredDataUnit 基础用例 — 从回答抽 typeid=1743 + int_key5
// ========================================
console.log('\n[applyUncoveredDataUnit 从回答抽 typeid=1743 + int_key5]');
{
  const d = {
    originalQuery: 'x',
    dataUnits: [{ id: 'u1', type: 't', description: 'd', filters: [], keywords: [] }]
  };
  const c = {
    clarificationType: 'general',
    details: { uncoveredUnits: [{ id: 'u1' }] },
    question: '请澄清'
  };
  const r = clarificationEngine.applyClarificationResult(d, c, 'typeid=1743 int_key5');

  const f = r.dataUnits[0].filters || [];
  ok(
    f.find(x => x.field === 'typeid' && x.value === 1743) != null,
    '回答中 typeid=1743 被抽入 filters'
  );
  ok(
    (r.dataUnits[0].outputFields || []).includes('int_key5'),
    '回答中 int_key5 字段名被抽入 outputFields'
  );
  ok(
    (r.dataUnits[0].keywords || []).includes('int_key5'),
    'int_key5 也被写入 keywords'
  );
  ok(
    (r.dataUnits[0].keywords || []).includes('typeid=1743'),
    'typeid=1743 作为 keyword 落入 keywords'
  );
  ok(
    String(r.dataUnits[0].description).includes('int_key5'),
    'description 追加用户澄清文本'
  );
  ok(r.clarified === true, 'clarified 标记为 true');
  ok(Array.isArray(r.clarificationHistory) && r.clarificationHistory.length === 1,
    'clarificationHistory 写入一条记录');
}

// ========================================
// case 2: uncoveredUnits 为空 → 回写到全部 units(避免漏补)
// ========================================
console.log('\n[uncoveredUnits 为空时 fallback 回写全部 units]');
{
  const d = {
    dataUnits: [
      { id: 'u1', filters: [], keywords: [] },
      { id: 'u2', filters: [], keywords: [] }
    ]
  };
  const c = { clarificationType: 'general', details: {}, question: 'q' };
  const r = clarificationEngine.applyClarificationResult(d, c, 'game_id=30');

  ok(
    (r.dataUnits[0].filters || []).find(x => x.field === 'game_id' && x.value === 30) != null,
    'u1 收到 game_id=30'
  );
  ok(
    (r.dataUnits[1].filters || []).find(x => x.field === 'game_id' && x.value === 30) != null,
    'u2 也收到 game_id=30'
  );
}

// ========================================
// case 3: 幂等 — 同 field 重复调用不重复 push
// ========================================
console.log('\n[同 field 不重复 push]');
{
  const d = {
    dataUnits: [{ id: 'u1', filters: [{ field: 'typeid', operator: '=', value: 1743 }], keywords: [] }]
  };
  const c = { clarificationType: 'general', details: { uncoveredUnits: [{ id: 'u1' }] } };
  const r = clarificationEngine.applyClarificationResult(d, c, 'typeid=1743');

  const typeidFilters = (r.dataUnits[0].filters || []).filter(x => x.field === 'typeid');
  ok(typeidFilters.length === 1, 'typeid 仍然只有 1 条 filter');
}

// ========================================
// case 4: clarificationType=table_selection 不触发 uncovered 抽取(走原有分支)
// ========================================
console.log('\n[clarificationType=table_selection 走原逻辑]');
{
  const d = { dataUnits: [{ id: 'u1', filters: [], keywords: [] }] };
  const c = { clarificationType: 'table_selection', details: {}, question: 'q' };
  const r = clarificationEngine.applyClarificationResult(d, c, '详细数据 typeid=1743');

  // table_selection 分支不会抽 typeid 到 filters
  const has = (r.dataUnits[0].filters || []).find(x => x.field === 'typeid');
  ok(!has, 'table_selection 分支不抽 typeid 到 filters');
  ok(r.preferSummaryTable === false, '"详细数据" 触发 preferSummaryTable=false');
}

// ========================================
// case 5: 健壮性 — 空 decomposition / 缺失字段不 throw
// ========================================
console.log('\n[健壮性:空/缺失字段]');
{
  let threw = false;
  try {
    clarificationEngine.applyClarificationResult({ dataUnits: [] }, { clarificationType: 'general' }, 'x');
  } catch (e) {
    threw = true;
    console.error('  throw:', e.message);
  }
  ok(!threw, '空 dataUnits 不 throw');

  let threw2 = false;
  try {
    clarificationEngine.applyClarificationResult(
      { dataUnits: [{ id: 'u1' }] },
      { clarificationType: 'general', details: { uncoveredUnits: [{ id: 'u1' }] } },
      'int_key5 typeid=1743'
    );
  } catch (e) {
    threw2 = true;
    console.error('  throw:', e.message);
  }
  ok(!threw2, '缺失 filters/keywords 字段不 throw');
}

// ========================================
// case 6: applyUncoveredDataUnit 独立导出
// ========================================
console.log('\n[applyUncoveredDataUnit 独立导出]');
{
  ok(typeof clarificationEngine.applyUncoveredDataUnit === 'function',
    'applyUncoveredDataUnit 已导出');
}

// ========================================
// 总结
// ========================================
console.log(`\n===== 结果 pass=${pass} fail=${fail} =====`);
if (fail > 0) process.exit(1);
