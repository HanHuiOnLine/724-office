/**
 * Phase 4 · 任务 C.2 单测:memoryQueue 死信持久化
 *
 * 覆盖:
 *   - operation 永远抛错 → 重试 MAX_RETRIES 次后写入 memory_failed_queue
 *   - metrics.deadLettered 递增
 *   - 死信表中可以读到 operation_type / user_id / payload / last_error / retry_count
 *
 * 运行:node backend/test/phase4/test-memoryQueue-deadletter.js
 * 依赖:临时 sqlite(通过 DB_PATH env)。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP_DB = path.join(os.tmpdir(), `nl2sql-phase4-mq-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
try { fs.unlinkSync(TMP_DB); } catch (e) {}

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

async function main() {
  const database = require(path.resolve(__dirname, '../../src/core/database'));
  await database.initialize();

  // database 先就绪,再 require memoryQueue(它会 eager require database)
  const memoryQueue = require(path.resolve(__dirname, '../../src/memory/memoryQueue'));

  console.log('\n[永远失败 → 写入死信]');
  const baseM = memoryQueue.getQueueMetrics();

  let attempts = 0;
  memoryQueue.enqueueMemoryStore(
    () => {
      attempts++;
      return Promise.reject(new Error('永远失败'));
    },
    { type: 'query_pattern', userId: 'u_dead', meta: { foo: 'bar', when: 12345 } }
  );

  const started = Date.now();
  await memoryQueue.waitForComplete(30000);
  const elapsed = Date.now() - started;

  // 4 次调用 = 1 次首发 + 3 次重试(MAX_RETRIES=3)
  ok(attempts === 4, `operation 被调用 4 次 (1+3 重试,实际 ${attempts})`);
  // 总耗时 >= 100 + 400 + 1600 = 2100ms
  ok(elapsed >= 2000, `总耗时 >= 2000ms (实际 ${elapsed}ms)`);

  const m = memoryQueue.getQueueMetrics();
  ok(m.deadLettered === baseM.deadLettered + 1,
    `deadLettered +1 (${baseM.deadLettered} → ${m.deadLettered})`);
  ok(m.retried >= baseM.retried + 3, `retried 递增至少 3 (${baseM.retried} → ${m.retried})`);
  ok(m.succeeded === baseM.succeeded, 'succeeded 不变(操作未成功)');

  console.log('\n[死信表读取]');
  const pending = await database.listPendingMemoryFailed();
  ok(pending.length === 1, `死信表有 1 条记录 (实际 ${pending.length})`);
  const rec = pending[0];
  ok(rec.operation_type === 'query_pattern', `operation_type == query_pattern`);
  ok(rec.user_id === 'u_dead', `user_id == u_dead`);
  ok(rec.last_error === '永远失败', `last_error 保留原始错误`);
  ok(rec.retry_count === 3, `retry_count == 3 (MAX_RETRIES)`);
  ok(rec.status === 'pending', `status == pending`);
  ok(typeof rec.payload === 'string' && rec.payload.includes('foo'),
    `payload 含 meta 字段 (实际前 50 字: ${rec.payload.slice(0, 50)})`);

  console.log('\n--------');
  console.log(`结果: ${pass} passed, ${fail} failed`);

  await database.close();
  try { fs.unlinkSync(TMP_DB); } catch (e) {}

  if (fail > 0) process.exit(1);
}

main().catch(err => {
  console.error('测试异常:', err);
  process.exit(2);
});
