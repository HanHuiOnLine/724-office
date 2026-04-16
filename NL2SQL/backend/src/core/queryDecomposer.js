/**
 * 查询分解器模块（Phase 2: Dynamic Intent Decomposition）
 * 
 * 核心功能：
 * 1. 将复杂查询拆解为可独立检索的"数据需求单元"（Data Units）
 * 2. 不预设子意图类型，适应任意复杂查询
 * 3. 为每个数据单元独立检索相关表
 */

// ============================================
// 导入依赖模块
// ============================================

const llmService = require('./llmService');
const schemaLoader = require('./schemaLoader');
const semanticLayer = require('./semanticLayer');
const logger = require('../utils/logger');
const config = require('./config');

// ============================================
// 查询分解器核心函数
// ============================================

/**
 * 动态拆解查询
 * 
 * 将复杂查询拆解为数据需求单元（Data Units）：
 * - 每个单元代表一个独立的数据需求
 * - 单元类型由LLM动态确定，不预设固定类型
 * - 每个单元独立检索相关表
 * 
 * @param {string} userQuery - 用户查询
 * @param {Object} context - 上下文信息
 * @param {Array} context.history - 对话历史
 * @param {string} context.userId - 用户ID
 * @returns {Promise<Object>} 分解结果
 */
async function decomposeQueryDynamically(userQuery, context = {}) {
  logger.debug('[QueryDecomposer] 开始动态查询分解', { query: userQuery });
  
  const startTime = Date.now();
  
  try {
    // 构建分解Prompt
    const decompositionPrompt = buildDecompositionPrompt(userQuery, context);
    
    // 调用LLM进行分解
    const response = await llmService.simpleChat('', decompositionPrompt);
    
    // 解析分解结果
    const decomposition = parseDecomposition(response, userQuery);
    
    // 验证分解结果
    const validatedDecomposition = validateDecomposition(decomposition);
    
    logger.info('[QueryDecomposer] 查询分解完成', {
      unitCount: validatedDecomposition.dataUnits.length,
      primaryEntity: validatedDecomposition.primaryEntity,
      duration: Date.now() - startTime
    });
    
    return validatedDecomposition;
    
  } catch (error) {
    logger.error('[QueryDecomposer] 查询分解失败:', error);
    
    // 返回基础分解结果
    return createFallbackDecomposition(userQuery);
  }
}

/**
 * 构建分解Prompt
 * 
 * @param {string} userQuery - 用户查询
 * @param {Object} context - 上下文信息
 * @returns {string} 分解Prompt
 */
function buildDecompositionPrompt(userQuery, context) {
  // 获取业务关键词映射（用于提示LLM）
  const businessKeywords = schemaLoader.getBusinessKeywordMappings();
  const keywordList = Object.keys(businessKeywords).slice(0, 20).join(', ');
  
  return `你是一位数据分析专家，负责将复杂的自然语言查询拆解为独立的数据需求单元。

## 任务
分析以下用户查询，将其拆解为多个数据需求单元（Data Units）。

## 用户查询
"${userQuery}"

## 分析要求
1. 识别查询中的主要数据实体（如"玩家"、"订单"、"角色"等）
2. 识别每个筛选条件或数据需求
3. 将复杂查询拆解为可独立处理的单元
4. 每个单元应该有明确的类型和描述

## 常见的单元类型（仅供参考，可根据实际情况调整）
- 基础属性筛选：game_id、平台、渠道等维度筛选
- 时间范围筛选：注册时间、登录时间等时间条件
- 聚合指标筛选：累计充值、总消费等聚合条件
- 行为序列筛选：特定日期的行为模式（如"3月1日登录但3月2-3日未登录"）
- 输出字段需求：需要返回的字段列表

## 业务关键词参考
${keywordList}

## 输出格式
请按以下JSON格式输出（不要输出其他内容）：

{
  "thought": "分析过程：这个查询涉及哪些数据维度？需要哪些表？",
  "primaryEntity": "主要数据实体（如：玩家）",
  "dataUnits": [
    {
      "id": "unit_1",
      "type": "单元类型",
      "description": "单元描述",
      "keywords": ["关键词1", "关键词2"],
      "filters": [
        {"field": "字段名", "operator": "操作符", "value": "值"}
      ],
      "timeRange": {
        "start": "开始时间",
        "end": "结束时间",
        "field": "时间字段"
      },
      "metric": "指标名称（如果是指标单元）",
      "operator": "比较操作符（如 >=）",
      "value": "比较值",
      "behavior": {
        "type": "行为类型",
        "date": "日期",
        "condition": "条件描述"
      },
      "outputFields": ["字段1", "字段2"]
    }
  ],
  "estimatedComplexity": "low|medium|high",
  "requiresJoin": true/false,
  "potentialRisks": ["潜在风险或歧义"]
}`;
}

/**
 * 解析分解结果
 * 
 * @param {string} response - LLM响应
 * @param {string} originalQuery - 原始查询
 * @returns {Object} 分解结果对象
 */
function parseDecomposition(response, originalQuery) {
  try {
    // 尝试提取JSON
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      
      return {
        originalQuery,
        thought: parsed.thought || '',
        primaryEntity: parsed.primaryEntity || '未知',
        dataUnits: parsed.dataUnits || [],
        estimatedComplexity: parsed.estimatedComplexity || 'medium',
        requiresJoin: parsed.requiresJoin || false,
        potentialRisks: parsed.potentialRisks || []
      };
    }
  } catch (error) {
    logger.warn('[QueryDecomposer] JSON解析失败:', error);
  }
  
  // 解析失败，返回基础分解
  return createFallbackDecomposition(originalQuery);
}

/**
 * 验证分解结果
 * 
 * @param {Object} decomposition - 分解结果
 * @returns {Object} 验证后的分解结果
 */
function validateDecomposition(decomposition) {
  // 确保必要的字段存在
  decomposition.originalQuery = decomposition.originalQuery || '';
  decomposition.thought = decomposition.thought || '';
  decomposition.primaryEntity = decomposition.primaryEntity || '未知';
  decomposition.dataUnits = decomposition.dataUnits || [];
  decomposition.estimatedComplexity = decomposition.estimatedComplexity || 'medium';
  decomposition.requiresJoin = decomposition.requiresJoin || false;
  decomposition.potentialRisks = decomposition.potentialRisks || [];
  
  // 验证每个数据单元
  for (const unit of decomposition.dataUnits) {
    unit.id = unit.id || `unit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    unit.type = unit.type || '未知类型';
    unit.description = unit.description || '';
    unit.keywords = unit.keywords || [];
  }
  
  return decomposition;
}

/**
 * 创建基础分解结果（兜底）
 * 
 * @param {string} originalQuery - 原始查询
 * @returns {Object} 基础分解结果
 */
function createFallbackDecomposition(originalQuery) {
  return {
    originalQuery,
    thought: '无法分解，将整体处理',
    primaryEntity: '未知',
    dataUnits: [
      {
        id: 'unit_1',
        type: '整体查询',
        description: originalQuery,
        keywords: extractKeywords(originalQuery)
      }
    ],
    estimatedComplexity: 'medium',
    requiresJoin: false,
    potentialRisks: ['无法拆解复杂查询，可能导致表检索不准确']
  };
}

/**
 * 提取关键词
 * 
 * @param {string} text - 文本
 * @returns {Array<string>} 关键词数组
 */
function extractKeywords(text) {
  // 提取中文词汇（2-4个字符）
  const chineseWords = text.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
  
  // 提取英文词汇
  const englishWords = text.match(/[a-zA-Z]{2,}/gi) || [];
  
  // 提取数字
  const numbers = text.match(/\d+/g) || [];
  
  return [...new Set([...chineseWords, ...englishWords, ...numbers])].slice(0, 10);
}

// ============================================
// 基于分解结果的表检索
// ============================================

/**
 * 基于数据单元检索相关表
 * 
 * @param {Object} decomposition - 分解结果
 * @param {number} topKPerUnit - 每个单元返回的表数量
 * @returns {Promise<Object>} 表检索结果
 */
async function retrieveTablesByDataUnits(decomposition, topKPerUnit = 3) {
  logger.debug('[QueryDecomposer] 基于数据单元检索表');
  
  const tableCandidates = new Map(); // 表名 -> { units: [], score: 0 }
  
  // 为每个数据单元检索相关表
  for (const unit of decomposition.dataUnits) {
    // 构建单元的搜索文本
    const searchQuery = buildUnitSearchQuery(unit);
    
    // 检索相关表
    const tables = await schemaLoader.searchRelevantTables(searchQuery, topKPerUnit);
    
    // 合并表候选
    for (const table of tables) {
      if (!tableCandidates.has(table.name)) {
        tableCandidates.set(table.name, {
          table: table,
          units: [],
          score: 0
        });
      }
      
      const candidate = tableCandidates.get(table.name);
      candidate.units.push(unit.id);
      candidate.score += 1;
    }
  }
  
  // 排序并返回
  const sortedCandidates = Array.from(tableCandidates.values())
    .sort((a, b) => b.score - a.score);
  
  logger.info('[QueryDecomposer] 表检索完成', {
    unitCount: decomposition.dataUnits.length,
    tableCount: sortedCandidates.length
  });
  
  return {
    decomposition,
    tableCandidates: sortedCandidates,
    recommendedTables: sortedCandidates.slice(0, 5).map(c => c.table.name)
  };
}

/**
 * 构建数据单元的搜索查询
 * 
 * @param {Object} unit - 数据单元
 * @returns {string} 搜索查询
 */
function buildUnitSearchQuery(unit) {
  const parts = [];
  
  // 添加关键词
  if (unit.keywords && unit.keywords.length > 0) {
    parts.push(...unit.keywords);
  }
  
  // 添加描述
  if (unit.description) {
    parts.push(unit.description);
  }
  
  // 添加指标
  if (unit.metric) {
    parts.push(unit.metric);
  }
  
  // 添加行为类型
  if (unit.behavior?.type) {
    parts.push(unit.behavior.type);
  }
  
  return parts.join(' ');
}

// ============================================
// 表候选合并策略
// ============================================

/**
 * 合并和排序表候选
 * 
 * 策略：
 * 1. 覆盖多数据单元的表优先（Join友好）
 * 2. 按置信度排序
 * 3. 保留Top-5候选表
 * 
 * @param {Array} tableCandidates - 表候选列表
 * @param {Object} decomposition - 分解结果
 * @returns {Object} 合并后的表推荐
 */
function mergeTableCandidates(tableCandidates, decomposition) {
  // 计算覆盖率分数
  const totalUnits = decomposition.dataUnits.length;
  
  const scoredCandidates = tableCandidates.map(candidate => {
    // 覆盖率分数：覆盖的数据单元比例
    const coverageScore = candidate.units.length / totalUnits;
    
    // 频率分数：被检索到的次数
    const frequencyScore = candidate.score / totalUnits;
    
    // 综合分数
    const finalScore = coverageScore * 0.6 + frequencyScore * 0.4;
    
    return {
      ...candidate,
      coverageScore,
      frequencyScore,
      finalScore
    };
  });
  
  // 按综合分数排序
  scoredCandidates.sort((a, b) => b.finalScore - a.finalScore);
  
  return {
    tables: scoredCandidates.slice(0, 5),
    analysis: {
      totalUnits,
      totalCandidates: tableCandidates.length,
      topCoverage: scoredCandidates[0]?.coverageScore || 0,
      topScore: scoredCandidates[0]?.finalScore || 0
    }
  };
}

// ============================================
// 导出模块
// ============================================

module.exports = {
  // 核心函数
  decomposeQueryDynamically,
  retrieveTablesByDataUnits,
  mergeTableCandidates,
  
  // 辅助函数
  buildDecompositionPrompt,
  parseDecomposition,
  validateDecomposition,
  createFallbackDecomposition,
  extractKeywords,
  buildUnitSearchQuery
};
