/**
 * Phase 1 / 任务4 回归测试：SSE 异步错误反馈链路
 * 覆盖：
 *   1) hasActiveConnection 在无连接时返回 false
 *   2) pushError 在无连接时不抛异常（静默记录警告）
 *   3) handleQuery 在无连接时返回 null（不再 throw）
 *
 * 运行：node backend/test/phase1/test-sse-error-feedback.js
 */

const assert = require('assert');
const path = require('path');

process.env.NODE_ENV = 'test';

const sseHandler = require(path.resolve(__dirname, '../../src/core/sseHandler'));

(async () => {
  // --- case 1 ---
  assert.strictEqual(sseHandler.hasActiveConnection('no-such-session'), false,
    '无连接时 hasActiveConnection 应返回 false');
  console.log('✅ case 1: hasActiveConnection 未连接时返回 false');

  // --- case 2 ---
  let threw = false;
  try {
    sseHandler.pushError('no-such-session', 'boom');
  } catch (e) {
    threw = true;
  }
  assert.strictEqual(threw, false, 'pushError 在无连接时不应抛错');
  console.log('✅ case 2: pushError 无连接时静默处理');

  // --- case 3 ---
  const result = await sseHandler.handleQuery('no-such-session', 'test query');
  assert.strictEqual(result, null, 'handleQuery 无连接时应返回 null 而非 throw');
  console.log('✅ case 3: handleQuery 无连接时返回 null，不再 throw');

  console.log('🎉 test-sse-error-feedback 全部通过');
  process.exit(0);
})().catch((err) => {
  console.error('❌ test-sse-error-feedback 失败:', err);
  process.exit(1);
});
