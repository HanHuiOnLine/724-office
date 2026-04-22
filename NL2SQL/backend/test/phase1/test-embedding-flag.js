/**
 * Phase 1 / 任务3 回归测试：Embedding 开关策略
 * 断言 config.embedding.enabled 能被 EMBEDDING_ENABLED 正确切换
 *
 * 运行：node backend/test/phase1/test-embedding-flag.js
 */

const assert = require('assert');
const path = require('path');

function reloadConfig() {
  const configPath = path.resolve(__dirname, '../../src/core/config');
  delete require.cache[require.resolve(configPath)];
  return require(configPath);
}

(async () => {
  // case A: 默认启用
  delete process.env.EMBEDDING_ENABLED;
  let config = reloadConfig();
  assert.strictEqual(config.embedding.enabled, true, '未设置环境变量时应默认启用');
  console.log('✅ case A: EMBEDDING_ENABLED 默认为 true');

  // case B: 显式关闭
  process.env.EMBEDDING_ENABLED = 'false';
  config = reloadConfig();
  assert.strictEqual(config.embedding.enabled, false, 'EMBEDDING_ENABLED=false 时应禁用');
  console.log('✅ case B: EMBEDDING_ENABLED=false 生效');

  // case C: 显式开启
  process.env.EMBEDDING_ENABLED = 'true';
  config = reloadConfig();
  assert.strictEqual(config.embedding.enabled, true, 'EMBEDDING_ENABLED=true 时应启用');
  console.log('✅ case C: EMBEDDING_ENABLED=true 生效');

  // case D: 维度可被环境变量覆盖
  process.env.EMBEDDING_DIMENSION = '768';
  config = reloadConfig();
  assert.strictEqual(config.embedding.dimension, 768, '维度应被 EMBEDDING_DIMENSION 覆盖');
  console.log('✅ case D: EMBEDDING_DIMENSION=768 生效');

  console.log('🎉 test-embedding-flag 全部通过');
  process.exit(0);
})().catch((err) => {
  console.error('❌ test-embedding-flag 失败:', err);
  process.exit(1);
});
