/**
 * 向量化和记忆系统评估模块
 * 
 * 提供向量化质量评估和历史记忆命中率统计功能
 * 设计原则：非侵入式，不影响主业务流程
 */

// ============================================
// 导入依赖模块
// ============================================

const logger = require('./logger');
const config = require('../core/config');

// ============================================
// 评估配置
// ============================================

const EVAL_CONFIG = {
  // 是否启用评估功能
  enabled: process.env.EVALUATION_ENABLED === 'true' || false,
  // 是否记录运行时统计
  trackStats: process.env.EVALUATION_TRACK_STATS === 'true' || false,
  // 相似度阈值
  thresholds: {
    highSimilarity: 0.8,
    mediumSimilarity: 0.5,
    highQuality: 0.8,
    mediumQuality: 0.5
  }
};

// ============================================
// 运行时统计（内存中）
// ============================================

const runtimeStats = {
  // 向量检索统计
  vectorSearch: {
    schema: { searches: 0, hits: 0 },
    query: { searches: 0, hits: 0 },
    distanceDistribution: {
      veryClose: 0,    // < 0.3
      close: 0,        // 0.3 - 0.5
      moderate: 0,     // 0.5 - 0.7
      far: 0           // > 0.7
    }
  },
  // 长期记忆统计
  longTermMemory: {
    totalQueries: 0,
    memoryHitCount: 0,
    byType: {
      field_alias: { hits: 0, misses: 0 },
      query_pattern: { hits: 0, misses: 0 },
      metric_preference: { hits: 0, misses: 0 },
      dimension_preference: { hits: 0, misses: 0 }
    }
  }
};

// ============================================
// 统计记录函数（轻量级，失败不影响主流程）
// ============================================

/**
 * 记录向量搜索统计
 * @param {string} type - 搜索类型（schema/query）
 * @param {Array} results - 搜索结果
 */
function recordVectorSearch(type, results) {
  if (!EVAL_CONFIG.trackStats) return;
  
  try {
    const hasResults = results && results.length > 0;
    
    if (type === 'schema') {
      runtimeStats.vectorSearch.schema.searches++;
      if (hasResults) runtimeStats.vectorSearch.schema.hits++;
    } else {
      runtimeStats.vectorSearch.query.searches++;
      if (hasResults) runtimeStats.vectorSearch.query.hits++;
    }
    
    // 记录距离分布
    if (hasResults && results[0].distance !== undefined) {
      const dist = results[0].distance;
      if (dist < 0.3) runtimeStats.vectorSearch.distanceDistribution.veryClose++;
      else if (dist < 0.5) runtimeStats.vectorSearch.distanceDistribution.close++;
      else if (dist < 0.7) runtimeStats.vectorSearch.distanceDistribution.moderate++;
      else runtimeStats.vectorSearch.distanceDistribution.far++;
    }
  } catch (e) {
    // 静默失败，不影响主流程
  }
}

/**
 * 记录长期记忆命中统计
 * @param {string} type - 记忆类型
 * @param {boolean} hit - 是否命中
 */
function recordMemoryHit(type, hit) {
  if (!EVAL_CONFIG.trackStats) return;
  
  try {
    runtimeStats.longTermMemory.totalQueries++;
    if (hit) {
      runtimeStats.longTermMemory.memoryHitCount++;
    }
    
    if (runtimeStats.longTermMemory.byType[type]) {
      if (hit) {
        runtimeStats.longTermMemory.byType[type].hits++;
      } else {
        runtimeStats.longTermMemory.byType[type].misses++;
      }
    }
  } catch (e) {
    // 静默失败
  }
}

// ============================================
// 向量化质量评估
// ============================================

/**
 * 计算余弦相似度
 * @param {Array<number>} vec1 - 向量1
 * @param {Array<number>} vec2 - 向量2
 * @returns {number} 相似度 (0-1)
 */
function calculateCosineSimilarity(vec1, vec2) {
  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;
  
  for (let i = 0; i < vec1.length; i++) {
    dotProduct += vec1[i] * vec2[i];
    norm1 += vec1[i] * vec1[i];
    norm2 += vec2[i] * vec2[i];
  }
  
  const similarity = dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
  return isNaN(similarity) ? 0 : similarity;
}

/**
 * 评估Schema向量化质量
 * 需要传入 llmService 用于生成向量
 * 
 * @param {Object} llmService - LLM服务实例
 * @param {Object} vectorStore - 向量存储实例
 * @param {Array} testQueries - 测试查询列表
 * @returns {Promise<Object>} 评估结果
 */
async function evaluateSchemaVectorQuality(llmService, vectorStore, testQueries) {
  if (!EVAL_CONFIG.enabled) {
    return { error: '评估功能未启用' };
  }
  
  logger.info('[评估] 开始Schema向量化质量评估', { testCount: testQueries.length });
  
  const results = {
    total: testQueries.length,
    correct: 0,
    partial: 0,
    incorrect: 0,
    details: []
  };
  
  for (const test of testQueries) {
    try {
      // 生成查询向量
      const queryVector = await llmService.getEmbedding(test.query);
      
      // 【优化】使用智能搜索（带查询意图识别和重排序）
      const searchResults = await vectorStore.searchSchemaSmart(queryVector, test.query, 10);
      
      // 【调试日志】记录搜索结果
      logger.info('[评估-调试] 向量搜索结果', {
        query: test.query,
        resultCount: searchResults.length,
        top5Results: searchResults.slice(0, 5).map(r => ({
          text: r.text?.substring(0, 100),
          table: r.metadata?.table_name || r.metadata?.table,
          distance: r._distance || r.distance
        }))
      });
      
      // 评估结果 - 从表级向量元数据中提取表名
      // 新的表级向量元数据使用 metadata.name
      const retrievedTables = searchResults
        .map(r => r.metadata?.name || r.metadata?.table_name || r.metadata?.table)
        .filter(Boolean);
      
      // 【调试日志】记录表名提取结果
      logger.info('[评估-调试] 提取的表名', {
        query: test.query,
        expectedTables: test.expectedTables,
        retrievedTables: retrievedTables,
        matchStatus: test.expectedTables.map(et => ({
          table: et,
          found: retrievedTables.includes(et),
          position: retrievedTables.indexOf(et)
        }))
      });
      
      const expectedSet = new Set(test.expectedTables);
      const retrievedSet = new Set(retrievedTables);
      
      // 计算命中情况
      const hits = [...expectedSet].filter(t => retrievedSet.has(t)).length;
      const precision = retrievedSet.size > 0 ? hits / retrievedSet.size : 0;
      const recall = expectedSet.size > 0 ? hits / expectedSet.size : 0;
      const f1Score = (precision + recall) > 0 ? 2 * (precision * recall) / (precision + recall) : 0;
      
      const detail = {
        query: test.query,
        expected: test.expectedTables,
        retrieved: retrievedTables.slice(0, 5),
        precision: Math.round(precision * 100) / 100,
        recall: Math.round(recall * 100) / 100,
        f1Score: Math.round(f1Score * 100) / 100,
        top1Correct: expectedSet.has(retrievedTables[0])
      };
      
      results.details.push(detail);
      
      if (recall >= EVAL_CONFIG.thresholds.highQuality) {
        results.correct++;
      } else if (recall >= EVAL_CONFIG.thresholds.mediumQuality) {
        results.partial++;
      } else {
        results.incorrect++;
      }
    } catch (error) {
      logger.error('[评估] 测试用例执行失败:', error);
      results.details.push({
        query: test.query,
        error: error.message
      });
      results.incorrect++;
    }
  }
  
  // 计算整体指标
  results.accuracy = results.total > 0 ? Math.round((results.correct / results.total) * 100) / 100 : 0;
  results.avgPrecision = results.details.length > 0 
    ? Math.round(results.details.reduce((sum, d) => sum + (d.precision || 0), 0) / results.details.length * 100) / 100 
    : 0;
  results.avgRecall = results.details.length > 0 
    ? Math.round(results.details.reduce((sum, d) => sum + (d.recall || 0), 0) / results.details.length * 100) / 100 
    : 0;
  results.avgF1 = results.details.length > 0 
    ? Math.round(results.details.reduce((sum, d) => sum + (d.f1Score || 0), 0) / results.details.length * 100) / 100 
    : 0;
  
  logger.info('[评估] Schema向量化质量评估完成', { 
    accuracy: results.accuracy,
    avgF1: results.avgF1
  });
  
  return results;
}

/**
 * 评估查询历史向量化质量
 * 测试相似查询的召回能力
 * 
 * @param {Object} llmService - LLM服务实例
 * @param {Array} testPairs - 相似查询对
 * @returns {Promise<Object>} 评估结果
 */
async function evaluateQueryVectorQuality(llmService, testPairs) {
  if (!EVAL_CONFIG.enabled) {
    return { error: '评估功能未启用' };
  }
  
  logger.info('[评估] 开始查询历史向量化质量评估', { testCount: testPairs.length });
  
  const results = {
    total: testPairs.length,
    highSimilarity: 0,
    mediumSimilarity: 0,
    lowSimilarity: 0,
    details: []
  };
  
  for (const pair of testPairs) {
    try {
      // 生成两个查询的向量
      const [vec1, vec2] = await Promise.all([
        llmService.getEmbedding(pair.query1),
        llmService.getEmbedding(pair.query2)
      ]);
      
      // 计算余弦相似度
      const similarity = calculateCosineSimilarity(vec1, vec2);
      
      const detail = {
        query1: pair.query1,
        query2: pair.query2,
        expectedSimilarity: pair.expectedSimilarity,
        actualSimilarity: Math.round(similarity * 100) / 100,
        error: Math.abs(similarity - pair.expectedSimilarity)
      };
      
      results.details.push(detail);
      
      if (similarity > EVAL_CONFIG.thresholds.highSimilarity) results.highSimilarity++;
      else if (similarity > EVAL_CONFIG.thresholds.mediumSimilarity) results.mediumSimilarity++;
      else results.lowSimilarity++;
    } catch (error) {
      logger.error('[评估] 相似度计算失败:', error);
      results.details.push({
        query1: pair.query1,
        query2: pair.query2,
        error: error.message
      });
    }
  }
  
  // 计算平均误差
  const validDetails = results.details.filter(d => !d.error);
  results.avgError = validDetails.length > 0 
    ? Math.round(validDetails.reduce((sum, d) => sum + d.error, 0) / validDetails.length * 100) / 100 
    : 0;
  
  logger.info('[评估] 查询历史向量化质量评估完成', { avgError: results.avgError });
  
  return results;
}

// ============================================
// 历史记忆命中率统计
// ============================================

/**
 * 获取向量检索命中率统计
 * @returns {Object} 统计结果
 */
function getVectorSearchStats() {
  const stats = runtimeStats.vectorSearch;
  
  return {
    schema: {
      searches: stats.schema.searches,
      hits: stats.schema.hits,
      hitRate: stats.schema.searches > 0
        ? Math.round((stats.schema.hits / stats.schema.searches) * 1000) / 10
        : 0
    },
    query: {
      searches: stats.query.searches,
      hits: stats.query.hits,
      hitRate: stats.query.searches > 0
        ? Math.round((stats.query.hits / stats.query.searches) * 1000) / 10
        : 0
    },
    distanceDistribution: stats.distanceDistribution
  };
}

/**
 * 获取长期记忆命中率统计
 * @returns {Object} 统计结果
 */
function getLongTermMemoryStats() {
  const stats = runtimeStats.longTermMemory;
  const totalQueries = stats.totalQueries;
  const totalHits = stats.memoryHitCount;
  
  return {
    overall: {
      hitRate: totalQueries > 0 ? Math.round((totalHits / totalQueries) * 1000) / 10 : 0,
      totalQueries,
      totalHits,
      totalMisses: totalQueries - totalHits
    },
    byType: Object.entries(stats.byType).map(([type, typeStats]) => ({
      type,
      hitRate: (typeStats.hits + typeStats.misses) > 0 
        ? Math.round((typeStats.hits / (typeStats.hits + typeStats.misses)) * 1000) / 10 
        : 0,
      hits: typeStats.hits,
      misses: typeStats.misses
    }))
  };
}

/**
 * 获取完整评估报告
 * @returns {Object} 完整统计报告
 */
function getFullStatsReport() {
  return {
    vectorSearch: getVectorSearchStats(),
    longTermMemory: getLongTermMemoryStats(),
    generatedAt: new Date().toISOString(),
    config: {
      enabled: EVAL_CONFIG.enabled,
      trackStats: EVAL_CONFIG.trackStats
    }
  };
}

/**
 * 重置统计数据
 */
function resetStats() {
  runtimeStats.vectorSearch.schema = { searches: 0, hits: 0 };
  runtimeStats.vectorSearch.query = { searches: 0, hits: 0 };
  runtimeStats.vectorSearch.distanceDistribution = {
    veryClose: 0,
    close: 0,
    moderate: 0,
    far: 0
  };
  
  runtimeStats.longTermMemory.totalQueries = 0;
  runtimeStats.longTermMemory.memoryHitCount = 0;
  Object.keys(runtimeStats.longTermMemory.byType).forEach(type => {
    runtimeStats.longTermMemory.byType[type] = { hits: 0, misses: 0 };
  });
  
  logger.info('[评估] 统计数据已重置');
}

// ============================================
// 测试数据集
// ============================================

/**
 * 默认Schema测试集
 * 基于实际Schema设计，包含平台注册、登录、活跃、订单等表
 */
const DEFAULT_SCHEMA_TEST_QUERIES = [
  { query: "昨天渠道520的新注册用户有多少", expectedTables: ["tzpingtai_tz_sdk_log_pf_reg"] },
  { query: "青木的付费金额统计", expectedTables: ["tzpingtai_tz_sdk_log_pf_order"] },
  { query: "青木最近7天的DAU", expectedTables: ["tzpingtai_tz_sdk_log_pf_act"] },
  { query: "各渠道的登录用户数", expectedTables: ["tzpingtai_tz_sdk_log_pf_login"] },
  { query: "游戏的创角数据", expectedTables: ["tzpingtai_tz_sdk_log_game_create_role"] },
  { query: "平台首单统计", expectedTables: ["tzpingtai_tz_sdk_log_pf_first_order"] },
  { query: "用户活跃趋势", expectedTables: ["tzpingtai_tz_sdk_log_pf_act"] },
  { query: "按钮点击分析", expectedTables: ["tzpingtai_tz_sdk_log_button"] }
];

/**
 * 默认查询相似度测试对
 */
const DEFAULT_QUERY_SIMILARITY_PAIRS = [
  { query1: "昨天收入多少", query2: "昨日的营收数据", expectedSimilarity: 0.9 },
  { query1: "按渠道看DAU", query2: "各渠道的日活跃用户", expectedSimilarity: 0.85 },
  { query1: "收入统计", query2: "用户留存", expectedSimilarity: 0.2 },
  { query1: "最近7天的流水", query2: "过去一周的营收", expectedSimilarity: 0.9 },
  { query1: "查询游戏数据", query2: "查看游戏信息", expectedSimilarity: 0.8 }
];

// ============================================
// 导出模块
// ============================================

module.exports = {
  // 配置
  EVAL_CONFIG,
  
  // 统计记录（运行时调用）
  recordVectorSearch,
  recordMemoryHit,
  
  // 质量评估（手动触发）
  evaluateSchemaVectorQuality,
  evaluateQueryVectorQuality,
  calculateCosineSimilarity,
  
  // 统计查询
  getVectorSearchStats,
  getLongTermMemoryStats,
  getFullStatsReport,
  resetStats,
  
  // 测试数据集
  DEFAULT_SCHEMA_TEST_QUERIES,
  DEFAULT_QUERY_SIMILARITY_PAIRS
};
