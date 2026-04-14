/**
 * 上下文管理功能测试
 * 
 * 测试内容：
 * 1. Token 预算管理模块
 * 2. 对话摘要机制
 * 3. 向量存储元数据增强
 */

const tokenBudget = require('../src/utils/tokenBudget');
const summarizer = require('../src/memory/summarizer');
const vectorStore = require('../src/memory/vectorStore');

// ============================================
// 测试工具函数
// ============================================

function assert(condition, message) {
  if (!condition) {
    throw new Error(`测试失败: ${message}`);
  }
  console.log(`✅ ${message}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`测试失败: ${message}\n期望值: ${expected}\n实际值: ${actual}`);
  }
  console.log(`✅ ${message}`);
}

function assertGreaterThan(actual, threshold, message) {
  if (!(actual > threshold)) {
    throw new Error(`测试失败: ${message}\n期望值: > ${threshold}\n实际值: ${actual}`);
  }
  console.log(`✅ ${message}`);
}

// ============================================
// Token 预算管理测试
// ============================================

function testTokenEstimation() {
  console.log('\n📊 测试 Token 估算功能');
  
  // 测试空文本
  assertEqual(tokenBudget.estimateTokens(''), 0, '空文本应返回 0 Token');
  assertEqual(tokenBudget.estimateTokens(null), 0, 'null 应返回 0 Token');
  
  // 测试英文文本
  const englishText = 'Hello world, this is a test message.';
  const englishTokens = tokenBudget.estimateTokens(englishText);
  assertGreaterThan(englishTokens, 0, '英文文本应返回正数 Token');
  
  // 测试中文文本
  const chineseText = '你好世界，这是一条测试消息。';
  const chineseTokens = tokenBudget.estimateTokens(chineseText);
  assertGreaterThan(chineseTokens, 0, '中文文本应返回正数 Token');
  
  // 测试批量估算
  const texts = ['Hello', 'World', 'Test'];
  const batchTokens = tokenBudget.estimateTokensBatch(texts);
  assertEqual(batchTokens.length, 3, '批量估算应返回相同数量的结果');
  
  console.log('  Token 估算测试结果:');
  console.log(`    英文文本 (${englishText.length} 字符): ~${englishTokens} tokens`);
  console.log(`    中文文本 (${chineseText.length} 字符): ~${chineseTokens} tokens`);
}

function testContextBudget() {
  console.log('\n💰 测试上下文预算计算');
  
  const context = {
    systemPrompt: 'You are a helpful assistant. '.repeat(50),
    history: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' }
    ],
    retrievedChunks: ['This is a retrieved chunk of information.']
  };
  
  const budget = tokenBudget.calculateContextBudget(context);
  
  // 验证返回结构
  assert(budget.breakdown, '应返回 breakdown 对象');
  assert(budget.budget, '应返回 budget 对象');
  assert(budget.status, '应返回 status 对象');
  assert(budget.suggestions, '应返回 suggestions 数组');
  
  // 验证数值
  assertGreaterThan(budget.breakdown.total, 0, '总 Token 数应大于 0');
  assertGreaterThan(budget.budget.available, 0, '可用预算应大于 0');
  
  // 验证状态
  assert(typeof budget.status.isWarning === 'boolean', 'isWarning 应为布尔值');
  assert(typeof budget.status.isCritical === 'boolean', 'isCritical 应为布尔值');
  assert(typeof budget.status.isOverBudget === 'boolean', 'isOverBudget 应为布尔值');
  
  console.log('  预算计算结果:');
  console.log(`    总 Token: ${budget.breakdown.total}`);
  console.log(`    使用率: ${Math.round(budget.budget.usageRatio * 100)}%`);
  console.log(`    状态: ${budget.status.isOverBudget ? '超出预算' : budget.status.isCritical ? '临界' : budget.status.isWarning ? '警告' : '正常'}`);
}

function testHistoryTrimming() {
  console.log('\n✂️ 测试历史裁剪功能');
  
  // 创建测试历史 (40条 = 20轮)
  const history = [];
  for (let i = 0; i < 20; i++) {
    history.push({ role: 'user', content: `Message ${i}` });
    history.push({ role: 'assistant', content: `Response ${i}` });
  }
  
  // 测试不裁剪（历史不够长，保留15轮=30条，实际40条>30条，所以会裁剪）
  // 修正：40条消息 = 20轮，保留15轮=30条，40>30，所以会裁剪
  // 要测试不裁剪，需要历史 <= 保留轮数*2
  const shortHistory = [];
  for (let i = 0; i < 5; i++) {
    shortHistory.push({ role: 'user', content: `Message ${i}` });
    shortHistory.push({ role: 'assistant', content: `Response ${i}` });
  }
  const noTrim = tokenBudget.trimHistory(shortHistory, 10); // 10轮=20条，实际10条<20条
  assertEqual(noTrim.trimmed, false, '历史不足时不应裁剪');
  
  // 测试裁剪（40条消息，保留5轮=10条）
  const trimResult = tokenBudget.trimHistory(history, 5);
  assertEqual(trimResult.trimmed, true, '历史足够长时应裁剪');
  assertEqual(trimResult.history.length, 10, '应保留 10 条消息（5轮）');
  assertEqual(trimResult.removed.length, 30, '应移除 30 条消息');
  
  console.log(`  裁剪结果: 从 ${history.length} 条 -> ${trimResult.history.length} 条`);
}

// ============================================
// 对话摘要测试
// ============================================

function testHistorySplitting() {
  console.log('\n🔄 测试历史分割功能');
  
  // 创建测试历史
  const history = [];
  for (let i = 0; i < 10; i++) {
    history.push({ role: 'user', content: `Question ${i}` });
    history.push({ role: 'assistant', content: `Answer ${i}` });
  }
  
  // 测试分割
  const split = summarizer.splitHistory(history, 3);
  
  assertEqual(split.hasEnoughData, true, '应有足够数据分割');
  assertEqual(split.toPreserve.length, 6, '应保留 6 条消息（3轮）');
  assertEqual(split.toSummarize.length, 14, '应摘要 14 条消息（7轮）');
  
  console.log(`  分割结果: 摘要 ${split.toSummarize.length} 条, 保留 ${split.toPreserve.length} 条`);
}

function testCacheManagement() {
  console.log('\n💾 测试摘要缓存管理');
  
  const sessionId = 'test-session-123';
  const summary = 'This is a test summary.';
  
  // 测试缓存
  summarizer.cacheSummary(sessionId, summary, 10);
  
  // 测试获取缓存
  const cached = summarizer.getCachedSummary(sessionId);
  assert(cached !== null, '应能获取缓存的摘要');
  assertEqual(cached.summary, summary, '缓存的摘要应一致');
  assertEqual(cached.lastUpdateRound, 10, '缓存的轮数应一致');
  
  // 测试清除缓存
  summarizer.clearSessionCache(sessionId);
  const cleared = summarizer.getCachedSummary(sessionId);
  assertEqual(cleared, null, '清除后应无法获取缓存');
  
  console.log('  缓存管理测试通过');
}

// ============================================
// 向量存储元数据测试
// ============================================

function testImportanceCalculation() {
  console.log('\n⭐ 测试重要性评分计算');
  
  // 测试空意图
  const emptyScore = vectorStore.calculateImportance(null, true);
  assertGreaterThan(emptyScore, 0, '空意图应返回基础分');
  
  // 测试复杂意图
  const complexIntent = {
    dimensions: ['date', 'region', 'channel'],
    metrics: ['revenue', 'orders', 'users'],
    filters: [{ field: 'game_id', value: '30' }],
    confidence: 0.95,
    isContextualQuery: true
  };
  
  const complexScore = vectorStore.calculateImportance(complexIntent, true);
  const simpleScore = vectorStore.calculateImportance({ metrics: ['revenue'] }, true);
  
  assertGreaterThan(complexScore, simpleScore, '复杂意图应比简单意图得分高');
  assert(complexScore <= 1.0, '重要性评分不应超过 1.0');
  
  console.log(`  简单意图得分: ${simpleScore.toFixed(2)}`);
  console.log(`  复杂意图得分: ${complexScore.toFixed(2)}`);
}

function testQueryTypeClassification() {
  console.log('\n🏷️ 测试查询类型分类');
  
  const testCases = [
    { text: '什么是留存率？', expected: vectorStore.QUERY_TYPES.DEFINITION },
    { text: '对比昨天和今天的流水', expected: vectorStore.QUERY_TYPES.COMPARISON },
    { text: '最近7天的趋势', expected: vectorStore.QUERY_TYPES.TREND },
    { text: '是的', expected: vectorStore.QUERY_TYPES.CLARIFICATION },
    { text: '那上个月呢？', expected: vectorStore.QUERY_TYPES.FOLLOW_UP },
    { text: '查询游戏ID为30的流水收入', expected: vectorStore.QUERY_TYPES.DATA_QUERY }
  ];
  
  for (const testCase of testCases) {
    const type = vectorStore.classifyQueryType({}, testCase.text);
    console.log(`  "${testCase.text}" -> ${type}`);
  }
  
  console.log('  查询类型分类测试完成');
}

function testEnhancedMetadata() {
  console.log('\n📦 测试增强元数据构建');
  
  const baseMetadata = { user_id: 'user123', session_id: 'session456' };
  const intent = {
    dimensions: ['date'],
    metrics: ['revenue'],
    filters: [],
    confidence: 0.9
  };
  
  const enhanced = vectorStore.buildEnhancedMetadata(baseMetadata, {
    intent: intent,
    queryText: '查询昨天的流水',
    success: true,
    executionTime: 1500,
    resultCount: 100
  });
  
  // 验证基础信息
  assertEqual(enhanced.user_id, 'user123', '应保留基础元数据');
  assertEqual(enhanced.session_id, 'session456', '应保留基础元数据');
  
  // 验证增强字段
  assert(enhanced.timestamp > 0, '应有时间戳');
  assert(enhanced.importanceScore >= 0 && enhanced.importanceScore <= 1, '重要性评分应在 0-1 之间');
  assert(enhanced.queryType, '应有查询类型');
  assert(enhanced.complexity, '应有复杂度信息');
  assert(enhanced.execution, '应有执行信息');
  assert(enhanced.intentSummary, '应有意图摘要');
  
  console.log('  增强元数据字段:');
  console.log(`    importanceScore: ${enhanced.importanceScore}`);
  console.log(`    queryType: ${enhanced.queryType}`);
  console.log(`    complexity: ${JSON.stringify(enhanced.complexity)}`);
  console.log(`    execution: ${JSON.stringify(enhanced.execution)}`);
}

// ============================================
// 主测试函数
// ============================================

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         NL2SQL 上下文管理功能测试                          ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  
  let passed = 0;
  let failed = 0;
  
  const tests = [
    // Token 预算测试
    { name: 'Token 估算', fn: testTokenEstimation },
    { name: '上下文预算计算', fn: testContextBudget },
    { name: '历史裁剪', fn: testHistoryTrimming },
    
    // 对话摘要测试
    { name: '历史分割', fn: testHistorySplitting },
    { name: '缓存管理', fn: testCacheManagement },
    
    // 向量存储测试
    { name: '重要性评分', fn: testImportanceCalculation },
    { name: '查询类型分类', fn: testQueryTypeClassification },
    { name: '增强元数据', fn: testEnhancedMetadata }
  ];
  
  for (const test of tests) {
    try {
      await test.fn();
      passed++;
    } catch (error) {
      console.error(`\n❌ ${test.name} 测试失败:`);
      console.error(`   ${error.message}`);
      failed++;
    }
  }
  
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log(`║  测试结果: ${passed} 通过, ${failed} 失败                          ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
  
  process.exit(failed > 0 ? 1 : 0);
}

// 运行测试
runTests().catch(error => {
  console.error('测试运行失败:', error);
  process.exit(1);
});
