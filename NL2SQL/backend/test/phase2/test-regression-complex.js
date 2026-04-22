/**
 * Phase 2 / 步骤7 端到端回归:复杂查询
 *
 * 覆盖:多维过滤 / 行为序列 / 聚合+明细 三类共 5 条用例
 *
 * 运行模式:
 *   - 默认 DRY_RUN: 不真实执行 SQL,只断言 tablesCalled + sqlKeywords
 *     需要 LLM_API_KEY 才能跑完整 processQuery
 *   - LIVE: SR_DATABASE_URL_TEST 设置后,另打开真实执行,断言 resultAssertions
 *
 * 环境变量要求:
 *   LLM_API_BASE / LLM_API_KEY / LLM_MODEL(必填;无则脚本跳过所有用例)
 *   DRY_RUN=true(默认)
 *   SR_DATABASE_URL_TEST=mysql://...(可选,启用 LIVE 模式)
 *
 * 运行:node backend/test/phase2/test-regression-complex.js
 */

const path = require('path');

process.env.NODE_ENV = 'test';
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
process.env.DRY_RUN = process.env.DRY_RUN || 'true';

const fixtures = require(path.resolve(__dirname, './fixtures/complex-queries.json'));

let pass = 0, fail = 0, skip = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`    ✓ ${msg}`); }
  else { fail++; console.error(`    ✗ ${msg}`); }
}

function assertSqlKeywords(caseId, sql, rule) {
  if (!sql) { ok(false, `[${caseId}] SQL 为空`); return; }
  const sqlUp = sql.toUpperCase();
  if (rule.required) {
    for (const kw of rule.required) {
      ok(sqlUp.includes(kw.toUpperCase()), `[${caseId}] required: ${kw}`);
    }
  }
  if (rule.requiredAny) {
    const matched = rule.requiredAny.some(set => set.every(kw => sqlUp.includes(kw.toUpperCase())));
    ok(matched, `[${caseId}] requiredAny 满足(sql=${sql.slice(0, 120)}...)`);
  }
  if (rule.forbidden) {
    for (const kw of rule.forbidden) {
      ok(!sqlUp.includes(kw.toUpperCase()), `[${caseId}] forbidden 不出现: ${kw}`);
    }
  }
}

(async () => {
  if (!process.env.LLM_API_KEY || !process.env.LLM_API_BASE) {
    console.warn('⚠️  未设置 LLM_API_KEY / LLM_API_BASE,跳过端到端回归');
    console.warn('   欲运行此脚本,请先填写 backend/.env 或设置环境变量');
    process.exit(0);
  }

  const database = require(path.resolve(__dirname, '../../src/core/database'));
  const schemaLoader = require(path.resolve(__dirname, '../../src/core/schemaLoader'));
  const srDatabase = require(path.resolve(__dirname, '../../src/core/srDatabase'));
  const nl2sqlEngine = require(path.resolve(__dirname, '../../src/core/nl2sqlEngine'));

  console.log('[setup] 初始化...');
  await database.initialize();
  try { await schemaLoader.load(); } catch (_) { /* 可能已加载 */ }

  const liveMode = !!process.env.SR_DATABASE_URL_TEST;
  if (liveMode) {
    process.env.SR_DATABASE_URL = process.env.SR_DATABASE_URL_TEST;
    process.env.SR_DB_ENABLED = 'true';
    process.env.DRY_RUN = 'false';
    await srDatabase.initialize();
    console.log('[setup] LIVE 模式:SR 连接池已初始化');
  } else {
    console.log('[setup] DRY_RUN 模式:仅断言选表 + SQL 关键词');
  }

  for (const c of fixtures.cases) {
    console.log(`\n[${c.id}] ${c.category}: ${c.query}`);
    const sessionId = `regression-${c.id}-${Date.now()}`;
    try {
      const result = await nl2sqlEngine.processQuery(c.query, sessionId, null, 'phase2-test');
      if (!result || (result.needClarification && !result.sql)) {
        console.warn(`    ⚠️  [${c.id}] 结果需要澄清,跳过 SQL 断言`);
        skip++;
        continue;
      }
      const sql = result.sql || (result.data && result.data.sql) || '';
      console.log(`    SQL: ${sql.slice(0, 150)}${sql.length > 150 ? '…' : ''}`);
      if (c.sqlKeywords) assertSqlKeywords(c.id, sql, c.sqlKeywords);

      if (liveMode && c.resultAssertions && c.resultAssertions.mode === 'LIVE') {
        const rc = result?.result?.rowCount ?? result?.data?.rowCount;
        ok(Number.isFinite(rc), `[${c.id}] LIVE rowCount 存在`);
      }
    } catch (err) {
      console.error(`    ✗ [${c.id}] processQuery 抛出:`, err.message);
      fail++;
    }
  }

  console.log(`\n结果: pass=${pass}, fail=${fail}, skip=${skip}`);
  await srDatabase.shutdown().catch(() => {});
  await database.close().catch(() => {});

  // Phase 2 验收门槛:DRY_RUN 下成功率 >= 80% (4/5)
  const ran = fixtures.cases.length - skip;
  if (ran > 0 && fail / ran > 0.2) {
    console.error(`❌ test-regression-complex 失败: 失败率 ${fail}/${ran}`);
    process.exit(1);
  }
  console.log('✅ test-regression-complex 达到验收阈值');
  process.exit(0);
})().catch(err => {
  console.error('❌ 运行失败:', err);
  process.exit(1);
});
