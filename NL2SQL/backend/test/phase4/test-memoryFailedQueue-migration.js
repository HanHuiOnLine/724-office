/**
 * Phase 4 · 任务 C.1 单测:memory_failed_queue 表迁移 + 3 个 helper
 *
 * 覆盖:
 *   - ensureMemoryFailedQueueTable 幂等(首次 CREATE,第二次 no-op)
 *   - addMemoryFailedOperation 插入成功,返回 lastID
 *   - listPendingMemoryFailed 能读出 pending 记录
 *   - updateMemoryFailedStatus 更新 status / retry_count / last_error
 *
 * 运行:node backend/test/phase4/test-memoryFailedQueue-migration.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP_DB = path.join(os.tmpdir(), `nl2sql-phase4-dead-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'warn';

try { fs.unlinkSync(TMP_DB); } catch (e) {}

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

async function main() {
  const database = require(path.resolve(__dirname, '../../src/core/database'));

  console.log('\n[初始化 + 迁移]');
  await database.initialize();
  ok(true, 'initialize() 未抛异常');

  const cols = await database.query(`PRAGMA table_info(memory_failed_queue)`);
  const names = cols.map(c => c.name).sort();
  const expected = [
    'first_failed_at', 'id', 'last_error', 'last_tried_at',
    'operation_type', 'payload', 'retry_count', 'status', 'updated_at', 'user_id'
  ];
  ok(JSON.stringify(names) === JSON.stringify(expected),
    `列集合 == 预期: ${names.join(',')}`);

  const indices = await database.query(`PRAGMA index_list(memory_failed_queue)`);
  const indexNames = indices.map(i => i.name);
  ok(indexNames.includes('idx_memory_dead_status'), 'status 索引存在');
  ok(indexNames.includes('idx_memory_dead_user'),   'user 索引存在');

  console.log('\n[idempotent]');
  await database.ensureMemoryFailedQueueTable();
  ok(true, '第二次调用 ensureMemoryFailedQueueTable 无异常(idempotent)');
  const colsAgain = await database.query(`PRAGMA table_info(memory_failed_queue)`);
  ok(colsAgain.length === cols.length, '二次迁移后列数不变');

  console.log('\n[addMemoryFailedOperation]');
  const id1 = await database.addMemoryFailedOperation({
    operationType: 'query_pattern',
    userId: 'u1',
    payload: { foo: 1 },
    lastError: 'test error',
    retryCount: 3
  });
  ok(typeof id1 === 'number' && id1 > 0, `返回有效 lastID (${id1})`);

  const id2 = await database.addMemoryFailedOperation({
    operationType: 'metric_preference',
    userId: 'u2',
    payload: JSON.stringify({ metric: '收入' }),
    lastError: 'db timeout',
    retryCount: 3
  });
  ok(id2 > id1, 'id2 > id1');

  console.log('\n[listPendingMemoryFailed]');
  const pending = await database.listPendingMemoryFailed(10);
  ok(Array.isArray(pending), '返回数组');
  ok(pending.length === 2, `pending 记录 2 条 (实际 ${pending.length})`);
  ok(pending[0].operation_type === 'query_pattern', '按 first_failed_at asc 排序');

  // payload 透传
  const payload1 = pending.find(p => p.id === id1);
  ok(payload1 && typeof payload1.payload === 'string' && payload1.payload.includes('foo'),
    'payload 序列化后可读');
  ok(payload1.retry_count === 3, 'retry_count 写入正确');
  ok(payload1.last_error === 'test error', 'last_error 写入正确');
  ok(payload1.status === 'pending', '默认 status=pending');

  console.log('\n[updateMemoryFailedStatus]');
  await database.updateMemoryFailedStatus(id1, { status: 'reviewed', lastError: 'new err' });
  const after = await database.queryOne(
    `SELECT status, last_error, last_tried_at FROM memory_failed_queue WHERE id = ?`,
    [id1]
  );
  ok(after.status === 'reviewed', 'status 更新为 reviewed');
  ok(after.last_error === 'new err', 'last_error 更新');
  ok(after.last_tried_at !== null, 'last_tried_at 被自动填充');

  // 更新 retry_count
  await database.updateMemoryFailedStatus(id2, { retryCount: 5 });
  const after2 = await database.queryOne(
    `SELECT retry_count FROM memory_failed_queue WHERE id = ?`, [id2]
  );
  ok(after2.retry_count === 5, 'retry_count 更新为 5');

  // pending 列表应只剩 id2(id1 已 reviewed)
  const stillPending = await database.listPendingMemoryFailed();
  ok(stillPending.length === 1 && stillPending[0].id === id2,
    'reviewed 记录不再出现在 pending');

  console.log('\n--------');
  console.log(`结果: ${pass} passed, ${fail} failed`);

  // 清理
  await database.close();
  try { fs.unlinkSync(TMP_DB); } catch (e) {}

  if (fail > 0) process.exit(1);
}

main().catch(err => {
  console.error('测试异常:', err);
  process.exit(2);
});
