/**
 * Phase 2 / 步骤5 单测:tableRanker.rank
 *
 * 覆盖:
 *   - 空信号 → selected 为空
 *   - 仅向量信号 → 分数顺序 = 向量 priorityScore 顺序
 *   - 核心表得分低 + 非核心得分高 + cap=3 → 核心表必定进结果
 *   - 语义层 priority=1 + score=1 的表被显著加权
 *   - explicit 命中时加成生效
 *   - FF_UNIFIED_RANKER=false → 回退到 Set+slice(0,5) 老行为
 *
 * 运行:node backend/test/phase2/test-tableRanker-unit.js
 */

const assert = require('assert');
const path = require('path');

process.env.NODE_ENV = 'test';

function reloadRanker() {
  const keys = Object.keys(require.cache).filter(k =>
    k.includes(path.join('backend', 'src', 'core', 'tableRanker')) ||
    k.includes(path.join('backend', 'config', 'feature-flags')) ||
    k.includes(path.join('backend', 'src', 'utils', 'tableScope'))
  );
  keys.forEach(k => delete require.cache[k]);
}

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

// 默认启用 UNIFIED_RANKER
delete process.env.FF_UNIFIED_RANKER;
reloadRanker();
const tableRanker = require(path.resolve(__dirname, '../../src/core/tableRanker'));

// ---------- case 1: 空信号 ----------
console.log('\n[case 1] 空信号');
{
  const r = tableRanker.rank('q', {});
  ok(r.selected.length === 0, 'selected 为空');
  ok(r.ranked.length === 0, 'ranked 为空');
}

// ---------- case 2: 仅向量信号 ----------
console.log('\n[case 2] 仅向量信号,排序 = priorityScore 顺序');
{
  const r = tableRanker.rank('q', {
    vectorResults: [
      { name: 'other_table_a', priorityScore: 50 },
      { name: 'other_table_b', priorityScore: 120 },
      { name: 'other_table_c', priorityScore: 80 }
    ]
  }, { cap: 8 });
  // 均为非核心(非 tzpingtai_tz_sdk_*/dwd_* 前缀),按向量分排序
  ok(r.selected[0] === 'other_table_b', `第1 = other_table_b, 实际=${r.selected[0]}`);
  ok(r.selected[1] === 'other_table_c', `第2 = other_table_c, 实际=${r.selected[1]}`);
  ok(r.selected[2] === 'other_table_a', `第3 = other_table_a, 实际=${r.selected[2]}`);
  ok(r.debug.coreCount === 0, 'coreCount=0');
}

// ---------- case 3: 核心表保护 ----------
console.log('\n[case 3] 核心表低分 + 非核心高分 + cap=3 → 核心表必须入选');
{
  const r = tableRanker.rank('q', {
    vectorResults: [
      { name: 'other_table_x', priorityScore: 160 },
      { name: 'other_table_y', priorityScore: 150 },
      { name: 'other_table_z', priorityScore: 140 },
      { name: 'tzpingtai_tz_sdk_log_pf_order', priorityScore: 10 }  // 核心表,低分
    ]
  }, { cap: 3 });
  ok(r.selected.includes('tzpingtai_tz_sdk_log_pf_order'), '核心表必须在 selected 中');
  ok(r.selected.length === 3, 'selected 长度 = cap = 3');
  ok(r.debug.coreCount >= 1, 'coreCount >= 1');
}

// ---------- case 4: 语义层 priority=1 显著加分 ----------
console.log('\n[case 4] 语义层 priority=1 加权');
{
  const r = tableRanker.rank('q', {
    vectorResults: [
      { name: 'other_table_y', priorityScore: 100 }  // 较高向量分
    ],
    semanticTables: [
      { tableName: 'other_table_x', priority: 1, score: 1.0 }  // 最高优先级,无向量信号
    ]
  }, { cap: 8 });
  // 对比:other_table_y 基础分 = 0.45*(100/160*100) ≈ 28
  //      other_table_x 基础分 = 0.30*(70+30) = 30
  // 语义层应胜出
  ok(r.selected[0] === 'other_table_x',
    `语义 p=1 应排第1(实际=${r.selected[0]}, ranked=${JSON.stringify(r.ranked.map(x=>[x.name,x.finalScore.toFixed(1)]))})`);
}

// ---------- case 5: explicit 加成 ----------
console.log('\n[case 5] explicit 命中');
{
  const r = tableRanker.rank('q', {
    vectorResults: [{ name: 'other_a', priorityScore: 50 }],
    explicitTables: ['other_b']
  }, { cap: 8 });
  // other_b 仅有 explicit 信号,basescore = 0.10 * 100 = 10
  // other_a 仅有 vector=50,basescore = 0.45 * (50/160*100) ≈ 14
  // 这里 explicit 相对较弱,但应该都入选
  ok(r.selected.includes('other_b'), 'explicit 表应进入 selected');
  ok(r.selected.includes('other_a'), '向量表也应入选');
  const bEntry = r.ranked.find(x => x.name === 'other_b');
  ok(bEntry.reasons.includes('explicit'), 'reasons 包含 explicit');
}

// ---------- case 6: core floor 兜底 explicit 置顶 ----------
console.log('\n[case 6] 无核心表时 explicit[0] 兜底置顶');
{
  const r = tableRanker.rank('q', {
    vectorResults: [{ name: 'game_other_a', priorityScore: 10 }],
    explicitTables: ['user_specified_table']
  }, { cap: 2 });
  ok(r.selected[0] === 'user_specified_table',
    `explicit[0] 置顶(实际 selected=${JSON.stringify(r.selected)})`);
}

// ---------- case 7: 推断加成 ----------
console.log('\n[case 7] inferred 加成 +15');
{
  const r1 = tableRanker.rank('q', {
    vectorResults: [{ name: 'other_a', priorityScore: 80 }]
  });
  const r2 = tableRanker.rank('q', {
    vectorResults: [{ name: 'other_a', priorityScore: 80 }],
    inferredTables: ['other_a']
  });
  const s1 = r1.ranked[0].finalScore;
  const s2 = r2.ranked[0].finalScore;
  ok(Math.abs(s2 - s1 - 15) < 0.01, `inferred 加成 = ${s2 - s1} (期望 15)`);
}

// ---------- case 8: cap=8 上限 ----------
console.log('\n[case 8] cap=8 生效');
{
  const vectorResults = Array.from({ length: 20 }, (_, i) => ({
    name: `other_${String.fromCharCode(97 + i)}`,
    priorityScore: 100 - i
  }));
  const r = tableRanker.rank('q', { vectorResults });
  ok(r.selected.length === 8, `cap 默认 = 8 (实际长度=${r.selected.length})`);
}

// ---------- case 9: feature flag 关闭回退 ----------
console.log('\n[case 9] FF_UNIFIED_RANKER=false 回退 legacy');
{
  process.env.FF_UNIFIED_RANKER = 'false';
  reloadRanker();
  const legacyRanker = require(path.resolve(__dirname, '../../src/core/tableRanker'));
  const r = legacyRanker.rank('q', {
    vectorResults: Array.from({ length: 10 }, (_, i) => ({ name: `t_${i}`, priorityScore: 100 - i })),
    semanticTables: [{ tableName: 't_100', priority: 1, score: 1.0 }]
  });
  ok(r.debug.legacy === true, 'debug.legacy = true');
  ok(r.selected.length === 5, `legacy 行为 slice(0,5) 生效(实际=${r.selected.length})`);
  delete process.env.FF_UNIFIED_RANKER;
}

console.log(`\n结果: pass=${pass}, fail=${fail}`);
if (fail > 0) {
  console.error('❌ test-tableRanker-unit 失败');
  process.exit(1);
}
console.log('✅ test-tableRanker-unit 全部通过');
process.exit(0);
