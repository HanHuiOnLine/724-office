/**
 * Phase 1 / 任务6 回归测试：summarizer 摘要二次赋值风险
 * 断言：当 llmService.simpleChat 返回超长字符串时，summarizeDialogue 不抛异常，
 *       并且返回的 summary 以 '...' 结尾（命中裁剪分支）。
 *
 * 运行：node backend/test/phase1/test-summarizer.js
 */

process.env.NODE_ENV = 'test';
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const assert = require('assert');
const path = require('path');

// mock llmService.simpleChat 返回超长字符串
const llmService = require(path.resolve(__dirname, '../../src/core/llmService'));
const originalSimpleChat = llmService.simpleChat;
llmService.simpleChat = async () => 'A'.repeat(20000);

const summarizer = require(path.resolve(__dirname, '../../src/memory/summarizer'));

(async () => {
  const fakeHistory = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `msg-${i}`.repeat(20)
  }));

  const result = await summarizer.summarizeDialogue(fakeHistory);
  assert.strictEqual(result.success, true, '摘要应成功');
  assert.ok(typeof result.summary === 'string', 'summary 应为字符串');
  assert.ok(result.summary.endsWith('...'), `summary 应被裁剪并以 '...' 结尾，实际: ${result.summary.slice(-10)}`);

  console.log('✅ test-summarizer: const→let 修复生效，裁剪分支未抛异常');

  llmService.simpleChat = originalSimpleChat;
  process.exit(0);
})().catch((err) => {
  console.error('❌ test-summarizer 失败:', err);
  process.exit(1);
});
