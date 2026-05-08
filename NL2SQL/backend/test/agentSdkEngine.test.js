/**
 * agentSdkEngine 单元测试
 *
 * 跑法:node test/agentSdkEngine.test.js
 * 不走 run-all.js,因为 SDK 已 mock,且本测试不依赖 LLM/SR DB
 *
 * 覆盖:
 *  - consumeSdkStream 正常路径(system/init → assistant/text → assistant/tool_use → result/success)
 *  - 返回结构:success/type='result'/sql/data._placeholder/executionTime/engineUsed/usage
 *  - onProgress 调用顺序:planning → generating → executing
 *  - SDK result/error 分支:返回 success=false, type='error', errorCode='SDK_RESULT_ERROR'
 *  - SDK 流提前结束(无 result):返回 errorCode='SDK_STREAM_INCOMPLETE'
 *  - 工具函数:extractSql / pickUsage
 */

const assert = require('assert');
const {
  __test__: { consumeSdkStream, extractSql, pickUsage, PLACEHOLDER_DATA },
} = require('../src/core/agentSdkEngine');

// ============================================
// 测试小工具
// ============================================

let passed = 0;
let failed = 0;

function ok(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(
      () => {
        passed++;
        console.log(`  ✅ ${name}`);
      },
      (err) => {
        failed++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${err.stack || err.message || err}`);
      }
    );
}

/**
 * 把一组 SDK 消息包成 AsyncIterable,模拟 query() 返回值
 */
function mockSession(messages) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < messages.length) {
            return { value: messages[i++], done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

// ============================================
// 测试用例
// ============================================

async function testHappyPath() {
  const progressCalls = [];
  const onProgress = (p) => progressCalls.push(p);

  const session = mockSession([
    {
      type: 'system',
      subtype: 'init',
      tools: ['mcp__schema-tools__search_tables', 'mcp__schema-tools__describe_table'],
      mcp_servers: [{ name: 'schema-tools', status: 'connected' }],
      model: 'claude-sonnet-4-6',
    },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'mcp__schema-tools__search_tables',
            input: { keyword: '注册', top_k: 5 },
          },
        ],
      },
    },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'mcp__schema-tools__describe_table',
            input: { table_name: 'pf_reg', compact: true },
          },
        ],
      },
    },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: '根据 search_tables 与 describe_table,以下 SQL 可查询用户注册数据:\n```sql\nSELECT user_id, create_time FROM pf_reg WHERE create_time >= "2026-01-01"\n```',
          },
        ],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      result:
        '根据 search_tables 与 describe_table,以下 SQL 可查询用户注册数据:\n```sql\nSELECT user_id, create_time FROM pf_reg WHERE create_time >= "2026-01-01"\n```',
      duration_ms: 1234,
      usage: {
        cache_creation_input_tokens: 3200,
        cache_read_input_tokens: 100,
        input_tokens: 50,
        output_tokens: 80,
      },
    },
  ]);

  const startTime = Date.now() - 5; // 保证 executionTime > 0
  const traceLog = [];
  const result = await consumeSdkStream(session, onProgress, { startTime, traceLog });

  assert.strictEqual(result.success, true, 'success 应为 true');
  assert.strictEqual(result.type, 'result', 'type 应为 result');
  assert.ok(
    /SELECT user_id/i.test(result.sql || ''),
    'sql 应抽到 SELECT 语句,实际:' + result.sql
  );
  assert.ok(typeof result.explanation === 'string' && result.explanation.length > 0,
    'explanation 应为非空字符串');
  assert.deepStrictEqual(result.selectedTables, ['pf_reg'],
    'selectedTables 应包含 describe_table 调用的表名');
  assert.strictEqual(result.data._placeholder, true, 'data 应为占位空表对象');
  assert.strictEqual(result.data.rowCount, 0, 'data.rowCount 应为 0');
  assert.ok(result.executionTime > 0, 'executionTime 应 > 0');
  assert.strictEqual(result.engineUsed, 'agent-sdk', 'engineUsed 应为 agent-sdk');
  assert.strictEqual(result.usage.cache_creation_input_tokens, 3200,
    'usage.cache_creation_input_tokens 应保留');

  // onProgress 调用序列:planning(init) → executing(tool_use × 2) → generating(text)
  const steps = progressCalls.map((p) => p.step);
  assert.strictEqual(steps[0], 'planning', '第一个 progress 应为 planning');
  assert.ok(steps.includes('executing'), '应有 executing 事件');
  assert.ok(steps.includes('generating'), '应有 generating 事件');
  // 数量校验:1 planning + 2 executing + 1 generating = 4
  assert.strictEqual(progressCalls.length, 4,
    `progress 调用次数应为 4,实际 ${progressCalls.length}`);

  // traceLog 校验:phase 应包含 planning / schema_discovery × 2 / generation
  const phases = traceLog.map((t) => t.phase);
  assert.deepStrictEqual(
    phases,
    ['planning', 'schema_discovery', 'schema_discovery', 'generation'],
    'traceLog phase 序列应为 planning/schema_discovery/schema_discovery/generation'
  );
}

async function testResultErrorPath() {
  const progressCalls = [];
  const onProgress = (p) => progressCalls.push(p);

  const session = mockSession([
    { type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'claude-sonnet-4-6' },
    {
      type: 'result',
      subtype: 'error_max_turns',
      error: { type: 'max_turns_exceeded', message: '达到 maxTurns 上限' },
    },
  ]);

  const result = await consumeSdkStream(session, onProgress, {
    startTime: Date.now(),
    traceLog: [],
  });

  assert.strictEqual(result.success, false, 'error 路径 success 应为 false');
  assert.strictEqual(result.type, 'error', 'type 应为 error');
  assert.strictEqual(result.errorCode, 'SDK_RESULT_ERROR', 'errorCode 应为 SDK_RESULT_ERROR');
  assert.ok(/maxTurns/i.test(result.error || ''), 'error 信息应保留');
  assert.strictEqual(result.engineUsed, 'agent-sdk', 'engineUsed 应为 agent-sdk');
}

async function testStreamIncomplete() {
  // 流结束但未收到 result 消息
  const session = mockSession([
    { type: 'system', subtype: 'init', tools: [], mcp_servers: [] },
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '半途而废的回复' }] },
    },
  ]);

  const result = await consumeSdkStream(session, null, {
    startTime: Date.now(),
    traceLog: [],
  });

  assert.strictEqual(result.success, false, '流不完整应 success=false');
  assert.strictEqual(result.errorCode, 'SDK_STREAM_INCOMPLETE',
    'errorCode 应为 SDK_STREAM_INCOMPLETE');
}

async function testOnProgressCallbackThrowSafe() {
  // onProgress 回调抛异常不应让流处理崩溃
  const session = mockSession([
    { type: 'system', subtype: 'init', tools: [], mcp_servers: [] },
    {
      type: 'result',
      subtype: 'success',
      result: '已完成',
      duration_ms: 100,
      usage: {},
    },
  ]);

  const onProgress = () => {
    throw new Error('故意抛错');
  };

  const result = await consumeSdkStream(session, onProgress, {
    startTime: Date.now(),
    traceLog: [],
  });

  assert.strictEqual(result.success, true, '回调抛错时主流程应仍成功');
}

async function testExtractSql() {
  // sql 标的优先
  assert.strictEqual(
    extractSql('回答如下:\n```sql\nSELECT 1\n```\n完毕'),
    'SELECT 1',
    '抽 sql fence 失败'
  );
  // 无标的但内容含 SELECT
  assert.strictEqual(
    extractSql('```\nSELECT name FROM t\n```'),
    'SELECT name FROM t',
    '抽匿名 fence 失败'
  );
  // 无 fence 应返回 null
  assert.strictEqual(extractSql('纯文本无 SQL'), null, '无 fence 应返回 null');
  // 非字符串入参
  assert.strictEqual(extractSql(null), null);
  assert.strictEqual(extractSql(undefined), null);
}

async function testPickUsage() {
  const u = pickUsage({
    cache_creation_input_tokens: 3000,
    cache_read_input_tokens: 200,
    input_tokens: 50,
    output_tokens: 100,
    extra_field_should_be_dropped: 999,
  });
  assert.strictEqual(u.cache_creation_input_tokens, 3000);
  assert.strictEqual(u.extra_field_should_be_dropped, undefined,
    '应只保留白名单字段');
  assert.strictEqual(pickUsage(null), null);
  assert.strictEqual(pickUsage(undefined), null);
}

async function testPlaceholderShape() {
  // 占位对象冻结后无法修改,确保不会被误改
  assert.deepStrictEqual(PLACEHOLDER_DATA, {
    columns: [],
    rows: [],
    rowCount: 0,
    truncated: false,
    _placeholder: true,
  });
  assert.ok(Object.isFrozen(PLACEHOLDER_DATA), 'PLACEHOLDER_DATA 应被冻结');
}

// ============================================
// 入口
// ============================================

(async () => {
  console.log('🧪 agentSdkEngine 单元测试');
  console.log('='.repeat(40));

  await ok('happy path: init → tool_use × 2 → text → success', testHappyPath);
  await ok('result/error 路径', testResultErrorPath);
  await ok('SDK 流不完整', testStreamIncomplete);
  await ok('onProgress 抛错不影响主流程', testOnProgressCallbackThrowSafe);
  await ok('extractSql 工具函数', testExtractSql);
  await ok('pickUsage 工具函数', testPickUsage);
  await ok('PLACEHOLDER_DATA 形态', testPlaceholderShape);

  console.log('='.repeat(40));
  console.log(`通过: ${passed}, 失败: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
