/**
 * 批次 C 单测:schemaDiscoveryPhase searchQuery 扩展
 *
 * 覆盖根因 R3:Phase 1 Schema 检索入参过窄,丢失 typeid / int_keyN 等物理 token
 *
 * 验证:
 *   1. 默认(SCHEMA_SEARCH_INCLUDE_RAW 未显式关闭):searchQuery 含 userQuery 原文 +
 *      entities + filters(field=value) + aggregations + physicalHints
 *   2. SCHEMA_SEARCH_INCLUDE_RAW=false:回退旧行为,仅 entities.join(' ')
 *   3. 老签名 schemaDiscoveryPhase(plan, context) 仍能工作(无 userQuery)
 *   4. TOOL_LOOP_MODE 关闭时不调 toolLoop,返回 toolExploration=null
 *
 * 运行:node backend/test/phase3/schema-discovery-searchquery.test.js
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'warn';
process.env.FF_TOOL_LOOP_MODE = 'true';

const path = require('path');

const toolLoop = require(path.resolve(__dirname, '../../src/core/toolLoop'));
const schemaTools = require(path.resolve(__dirname, '../../src/core/schemaTools'));

const origExecuteToolLoop = toolLoop.executeToolLoop;
const origGetLevel1Index = schemaTools.getLevel1Index;

schemaTools.getLevel1Index = () => ({ tables: [] });

// 捕获每次调用的 searchQuery
let capturedSearchQuery = '';
let capturedOptions = null;
toolLoop.executeToolLoop = async (searchQuery, options) => {
  capturedSearchQuery = String(searchQuery || '');
  capturedOptions = options;
  return { tables: [] };
};

const agenticEngine = require(path.resolve(__dirname, '../../src/core/agenticEngine'));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

(async () => {
  const engine = new agenticEngine.AgenticNL2SQLEngine();

  // ============================================
  // case 1: 默认启用时,searchQuery 含 userQuery + physicalHints + filters + aggregations
  // ============================================
  console.log('\n[case 1] 默认启用:searchQuery 含 userQuery + physicalHints');
  {
    delete process.env.SCHEMA_SEARCH_INCLUDE_RAW;
    capturedSearchQuery = '';

    await engine.schemaDiscoveryPhase(
      '取 typeid=1743 的 int_key5 数据',
      {
        entities: ['玩家'],
        filters: [{ field: 'game_id', value: 30 }],
        aggregations: ['count'],
        physicalHints: ['typeid=1743', 'int_key5']
      },
      {}
    );

    ok(capturedSearchQuery.includes('typeid=1743'), "searchQuery 含 'typeid=1743'");
    ok(capturedSearchQuery.includes('int_key5'), "searchQuery 含 'int_key5'");
    ok(capturedSearchQuery.includes('game_id=30'), "searchQuery 含 'game_id=30'(来自 filters)");
    ok(capturedSearchQuery.includes('玩家'), "searchQuery 含 entities '玩家'");
    ok(capturedSearchQuery.includes('count'), "searchQuery 含 aggregations 'count'");
    ok(
      capturedSearchQuery.includes('取 typeid=1743 的 int_key5 数据'),
      'searchQuery 含 userQuery 原文'
    );
  }

  // ============================================
  // case 2: SCHEMA_SEARCH_INCLUDE_RAW=false → 回退旧行为
  // ============================================
  console.log('\n[case 2] SCHEMA_SEARCH_INCLUDE_RAW=false:回退旧行为');
  {
    process.env.SCHEMA_SEARCH_INCLUDE_RAW = 'false';
    capturedSearchQuery = '';

    await engine.schemaDiscoveryPhase(
      '取 typeid=1743 的战场等级',
      {
        entities: ['玩家'],
        physicalHints: ['typeid=1743']
      },
      {}
    );

    ok(!capturedSearchQuery.includes('typeid=1743'),
      'searchQuery 不含 typeid=1743(旧行为)');
    ok(!capturedSearchQuery.includes('取'),
      'searchQuery 不含 userQuery 原文(旧行为)');
    ok(capturedSearchQuery.includes('玩家'), "searchQuery 仅含 entities '玩家'");
    ok(capturedSearchQuery.trim() === '玩家', "searchQuery 精确等于 '玩家'");

    delete process.env.SCHEMA_SEARCH_INCLUDE_RAW;
  }

  // ============================================
  // case 3: 老签名 schemaDiscoveryPhase(plan, context) 仍工作
  // ============================================
  console.log('\n[case 3] 老签名兼容:传 (plan, context)');
  {
    delete process.env.SCHEMA_SEARCH_INCLUDE_RAW;
    capturedSearchQuery = '';

    // 老调用方式:第一个参数是 plan 对象
    await engine.schemaDiscoveryPhase(
      { entities: ['订单'], physicalHints: ['channel_id=5'] },
      { history: [] }
    );

    ok(capturedSearchQuery.includes('订单'), '老签名 searchQuery 仍含 entities');
    ok(capturedSearchQuery.includes('channel_id=5'),
      '老签名 searchQuery 仍含 physicalHints(降级后不丢字段)');
  }

  // ============================================
  // case 4: plan 缺字段时不抛异常
  // ============================================
  console.log('\n[case 4] plan 缺字段兜底');
  {
    delete process.env.SCHEMA_SEARCH_INCLUDE_RAW;
    capturedSearchQuery = '';
    let threw = false;
    try {
      await engine.schemaDiscoveryPhase('查询', { entities: [] }, {});
    } catch (e) {
      threw = true;
    }
    ok(!threw, '空 plan.entities 不抛异常');
    ok(capturedSearchQuery.includes('查询'), "searchQuery 至少含 userQuery '查询'");
  }

  // ============================================
  // case 5: TOOL_LOOP_MODE 关闭时不调 toolLoop
  // ============================================
  console.log('\n[case 5] TOOL_LOOP_MODE 关闭');
  {
    process.env.FF_TOOL_LOOP_MODE = 'false';
    // 清掉 feature-flags 缓存,让新值生效
    delete require.cache[require.resolve(path.resolve(__dirname, '../../config/feature-flags'))];
    delete require.cache[require.resolve(path.resolve(__dirname, '../../src/core/agenticEngine'))];
    const ae2 = require(path.resolve(__dirname, '../../src/core/agenticEngine'));
    const engine2 = new ae2.AgenticNL2SQLEngine();

    let invoked = false;
    const origTL = toolLoop.executeToolLoop;
    toolLoop.executeToolLoop = async () => { invoked = true; return { tables: [] }; };

    const result = await engine2.schemaDiscoveryPhase('q', { entities: ['a'] }, {});
    ok(!invoked, 'TOOL_LOOP_MODE=false 时未调用 executeToolLoop');
    ok(result && result.toolExploration === null, 'toolExploration 返回 null');

    toolLoop.executeToolLoop = origTL;
    process.env.FF_TOOL_LOOP_MODE = 'true';
  }

  // 恢复
  toolLoop.executeToolLoop = origExecuteToolLoop;
  schemaTools.getLevel1Index = origGetLevel1Index;

  console.log(`\n===== 结果 pass=${pass} fail=${fail} =====`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
