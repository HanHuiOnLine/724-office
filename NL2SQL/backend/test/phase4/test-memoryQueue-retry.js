/**
 * Phase 4 · 任务 C.2 单测:memoryQueue 指数退避重试
 *
 * 覆盖:
 *   - operation 抛错 N 次(N < MAX_RETRIES)后成功 → metrics.retried 递增、succeeded 计数
 *   - 重试间隔逐步增大(100 / 400 / 1600ms)
 *
 * 运行:node backend/test/phase4/test-memoryQueue-retry.js
 * 零外部依赖(database 可能 require 失败,但 retry 逻辑不依赖 database)。
 */

const path = require('path');
process.env.LOG_LEVEL = 'error';     // 静音 warn/info

const memoryQueue = require(path.resolve(__dirname, '../../src/memory/memoryQueue'));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

async function main() {
  console.log('\n[导出]');
  ok(typeof memoryQueue.enqueueMemoryStore === 'function', 'enqueueMemoryStore');
  ok(typeof memoryQueue.getQueueMetrics === 'function', 'getQueueMetrics');
  ok(typeof memoryQueue.waitForComplete === 'function', 'waitForComplete');

  const baseMetrics = memoryQueue.getQueueMetrics();
  console.log('  基线 metrics:', JSON.stringify(baseMetrics));

  // ----------------------------------------
  // Case 1:前 2 次抛错,第 3 次成功 → retried+=2, succeeded+=1
  // ----------------------------------------
  console.log('\n[前2次失败第3次成功]');
  let attempts = 0;
  const mkOp = () => () => {
    attempts++;
    if (attempts < 3) {
      return Promise.reject(new Error(`fail attempt ${attempts}`));
    }
    return Promise.resolve({ ok: true });
  };

  const start = Date.now();
  memoryQueue.enqueueMemoryStore(mkOp(), {
    type: 'query_pattern', userId: 'u_retry', meta: { test: 1 }
  });

  const done = await memoryQueue.waitForComplete(30000);
  const elapsed = Date.now() - start;

  ok(done === true, `waitForComplete 在超时前完成 (${elapsed}ms)`);
  ok(attempts === 3, `operation 被调用 3 次 (实际 ${attempts})`);
  // 100 + 400 = 500ms 最小退避
  ok(elapsed >= 400, `总耗时 >= 400ms (指数退避生效,实际 ${elapsed}ms)`);

  const m = memoryQueue.getQueueMetrics();
  ok(m.retried >= baseMetrics.retried + 2, `retried 递增至少 2 (${baseMetrics.retried} → ${m.retried})`);
  ok(m.succeeded === baseMetrics.succeeded + 1, `succeeded 递增 1 (${baseMetrics.succeeded} → ${m.succeeded})`);
  ok(m.deadLettered === baseMetrics.deadLettered, 'deadLettered 未变(未进入死信)');

  // ----------------------------------------
  // Case 2:一次就成功 → retried 不变
  // ----------------------------------------
  console.log('\n[一次成功]');
  const m1 = memoryQueue.getQueueMetrics();
  memoryQueue.enqueueMemoryStore(
    () => Promise.resolve('ok'),
    { type: 'metric_preference', userId: 'u_good' }
  );
  await memoryQueue.waitForComplete(5000);
  const m2 = memoryQueue.getQueueMetrics();
  ok(m2.succeeded === m1.succeeded + 1, 'succeeded +1');
  ok(m2.retried === m1.retried, 'retried 不变(无重试)');

  console.log('\n--------');
  console.log(`结果: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(err => {
  console.error('测试异常:', err);
  process.exit(2);
});
