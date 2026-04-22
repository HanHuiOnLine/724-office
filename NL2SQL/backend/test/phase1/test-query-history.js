/**
 * Phase 1 / 任务2 回归测试：query_history 写入
 * 断言：
 *   1) createQueryHistory 返回自增 id
 *   2) markQueryHistorySuccess 写入 status/sql/time/row_count
 *   3) markQueryHistoryFailure 写入 status='failed' 与 error_message
 *
 * 运行：node backend/test/phase1/test-query-history.js
 *
 * 注意：脚本会写入 DB_PATH 指向的 SQLite，默认使用 backend/data/sessions.db
 */

const assert = require('assert');
const path = require('path');

process.env.NODE_ENV = 'test';
// 使用独立测试库，避免污染正式数据
process.env.DB_PATH = process.env.DB_PATH_TEST
  || path.resolve(__dirname, '../../data/sessions.test.db');

const database = require(path.resolve(__dirname, '../../src/core/database'));

(async () => {
  await database.initialize();

  // --- 成功路径 ---
  const okId = await database.createQueryHistory({
    sessionId: null,
    userId: 'phase1-test',
    naturalQuery: '测试：最近 7 天订单数'
  });
  assert.ok(okId, 'createQueryHistory 应返回 id');

  await database.markQueryHistorySuccess(okId, {
    generatedSql: 'SELECT 1',
    executionTime: 123,
    rowCount: 1,
    result: { columns: ['one'], sampleRows: [{ one: 1 }] }
  });
  const okRow = await database.queryOne(
    'SELECT status, generated_sql, execution_time, row_count, result FROM query_history WHERE id = ?',
    [okId]
  );
  assert.strictEqual(okRow.status, 'success');
  assert.strictEqual(okRow.generated_sql, 'SELECT 1');
  assert.strictEqual(okRow.execution_time, 123);
  assert.strictEqual(okRow.row_count, 1);
  assert.ok(okRow.result && JSON.parse(okRow.result).columns[0] === 'one');
  console.log('✅ case success: query_history 成功状态写入正确');

  // --- 失败路径 ---
  const failId = await database.createQueryHistory({
    sessionId: null,
    userId: 'phase1-test',
    naturalQuery: '测试：非法表名'
  });
  await database.markQueryHistoryFailure(failId, {
    generatedSql: 'SELECT * FROM not_exist_table',
    executionTime: 42,
    errorMessage: 'Table not_exist_table does not exist'
  });
  const failRow = await database.queryOne(
    'SELECT status, error_message, generated_sql FROM query_history WHERE id = ?',
    [failId]
  );
  assert.strictEqual(failRow.status, 'failed');
  assert.ok((failRow.error_message || '').includes('not_exist_table'));
  console.log('✅ case failure: query_history 失败状态写入正确');

  await database.close();
  console.log('🎉 test-query-history 全部通过');
  process.exit(0);
})().catch((err) => {
  console.error('❌ test-query-history 失败:', err);
  process.exit(1);
});
