/**
 * Phase 2 / 步骤7 集成测试:tableRanker 整体选表行为
 *
 * 针对每条复杂查询用例,直接调用 schemaLoader + semanticLayer + tableRanker
 * 验证 tablesCalled(mustInclude / maxSize / coreTableCount)。
 *
 * 不依赖 LLM,但依赖 Schema 元数据加载和向量索引(走已有缓存)。
 * SQL 关键词断言见 test-regression-complex.js。
 *
 * 运行:node backend/test/phase2/test-tableRanker-integration.js
 */

const path = require('path');

process.env.NODE_ENV = 'test';
// schema-metadata.json 路径相对 CWD,显式切到 backend/
process.chdir(path.resolve(__dirname, '../../'));
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const fixtures = require(path.resolve(__dirname, './fixtures/complex-queries.json'));
const tableRanker = require(path.resolve(__dirname, '../../src/core/tableRanker'));
const { isCoreTable } = require(path.resolve(__dirname, '../../src/utils/tableScope'));

let pass = 0, fail = 0, skip = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`    ✓ ${msg}`); }
  else { fail++; console.error(`    ✗ ${msg}`); }
}

function assertTablesCalled(caseId, selected, rule) {
  if (rule.mustInclude) {
    for (const t of rule.mustInclude) {
      ok(selected.includes(t), `[${caseId}] mustInclude: ${t}`);
    }
  }
  if (rule.mustIncludeAny) {
    const satisfied = rule.mustIncludeAny.some(set => set.every(t => selected.includes(t)));
    ok(satisfied,
      `[${caseId}] mustIncludeAny 满足(当前 selected=${selected.join(',')})`);
  }
  if (rule.maxSize) {
    ok(selected.length <= rule.maxSize,
      `[${caseId}] selected.length(${selected.length}) <= maxSize(${rule.maxSize})`);
  }
  if (rule.coreTableCount && typeof rule.coreTableCount.min === 'number') {
    const coreN = selected.filter(t => isCoreTable(t)).length;
    ok(coreN >= rule.coreTableCount.min,
      `[${caseId}] coreTableCount(${coreN}) >= min(${rule.coreTableCount.min})`);
  }
}

(async () => {
  const schemaLoader = require(path.resolve(__dirname, '../../src/core/schemaLoader'));
  let semanticLayer;
  try {
    semanticLayer = require(path.resolve(__dirname, '../../src/core/semanticLayer'));
  } catch (_) {
    semanticLayer = null;
  }

  console.log('[setup] 加载 Schema...');
  try {
    await schemaLoader.load();
  } catch (e) {
    console.warn('[setup] schemaLoader.load 失败,可能已加载:', e.message);
  }
  if (semanticLayer && typeof semanticLayer.load === 'function') {
    try { await semanticLayer.load(); } catch (_) { /* ignore */ }
  }

  // Schema 向量可能未初始化(缺 embedding 服务),此时 searchRelevantTables 会退到关键词匹配路径
  // 关键词路径仍能跑通 ranker 集成(returnRawSignals=true 路径覆盖两种分支)
  for (const c of fixtures.cases) {
    console.log(`\n[${c.id}] ${c.category}: ${c.query}`);
    try {
      const raw = await schemaLoader.searchRelevantTables(
        c.query, 16, {}, { returnRawSignals: true }
      );
      const inferredTables = [];
      let semanticTables = [];
      if (semanticLayer && typeof semanticLayer.matchConcepts === 'function') {
        try {
          const concepts = semanticLayer.matchConcepts(c.query);
          const rec = semanticLayer.recommendTables(concepts);
          semanticTables = (rec && rec.tables) || [];
        } catch (_) { /* ignore */ }
      }
      const rankResult = tableRanker.rank(c.query, {
        vectorResults: raw.vectorResults || [],
        semanticTables,
        keywordMatches: [],
        inferredTables,
        explicitTables: raw.explicitTableNames || []
      }, { cap: 8 });

      console.log(`    selected (${rankResult.selected.length}): ${rankResult.selected.join(', ')}`);
      assertTablesCalled(c.id, rankResult.selected, c.tablesCalled || {});
    } catch (err) {
      console.error(`    ✗ [${c.id}] 抛出异常:`, err.message);
      fail++;
    }
  }

  console.log(`\n结果: pass=${pass}, fail=${fail}, skip=${skip}`);
  if (fail > 0) {
    console.error('❌ test-tableRanker-integration 失败');
    process.exit(1);
  }
  console.log('✅ test-tableRanker-integration 全部通过');
  process.exit(0);
})().catch(err => {
  console.error('❌ 运行失败:', err);
  process.exit(1);
});
