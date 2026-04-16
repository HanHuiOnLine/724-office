/**
 * 业务语义层模块（Phase 2: Business Semantic Layer）
 * 
 * 核心功能：
 * 1. 建立业务概念到物理表/字段的映射
 * 2. 解决"老平台"、"累计充值"等业务语义识别问题
 * 3. 支持别名识别和模糊匹配
 */

// ============================================
// 导入依赖模块
// ============================================

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../core/config');

// ============================================
// 模块状态
// ============================================

/**
 * 语义层配置数据
 */
let semanticConfig = {
  version: '',
  concepts: {},
  query_patterns: {},
  field_mappings: {},
  datasource_mappings: {}
};

/**
 * 是否已初始化
 */
let initialized = false;

// ============================================
// 初始化函数
// ============================================

/**
 * 加载语义层配置
 * 
 * @param {string} configPath - 配置文件路径
 */
function load(configPath = null) {
  const defaultPath = path.resolve(config.schema.configPath, '../business-semantic-layer.json');
  const filePath = configPath || defaultPath;
  
  try {
    if (!fs.existsSync(filePath)) {
      logger.warn('[SemanticLayer] 配置文件不存在，使用内置配置', { path: filePath });
      loadBuiltinConfig();
      return;
    }
    
    const content = fs.readFileSync(filePath, 'utf-8');
    semanticConfig = JSON.parse(content);
    initialized = true;
    
    logger.info('[SemanticLayer] 配置加载完成', {
      version: semanticConfig.version,
      conceptCount: Object.keys(semanticConfig.concepts || {}).length,
      patternCount: Object.keys(semanticConfig.query_patterns || {}).length
    });
    
  } catch (error) {
    logger.error('[SemanticLayer] 配置加载失败:', error);
    loadBuiltinConfig();
  }
}

/**
 * 加载内置配置（兜底）
 */
function loadBuiltinConfig() {
  semanticConfig = {
    version: 'builtin-1.0.0',
    concepts: {
      '老平台': {
        aliases: ['旧平台', '老版本'],
        description: '老平台数据',
        mappings: { datasource: 'new_tzpingtaiold' }
      },
      '新平台': {
        aliases: ['新系统'],
        description: '新平台数据',
        mappings: { datasource: 'new_tzpingtai' }
      },
      '注册': {
        aliases: ['新增', '首入'],
        description: '用户注册',
        mappings: { primary_table: 'tzpingtai_tz_sdk_log_pf_reg' }
      },
      '充值': {
        aliases: ['付费', '订单'],
        description: '玩家充值',
        mappings: { primary_table: 'tzpingtai_tz_sdk_log_pf_order' }
      },
      '登录': {
        aliases: ['活跃', '在线'],
        description: '用户登录',
        mappings: { platform_table: 'tzpingtai_tz_sdk_log_pf_login' }
      }
    },
    query_patterns: {},
    field_mappings: {},
    datasource_mappings: {}
  };
  
  initialized = true;
  logger.info('[SemanticLayer] 已加载内置配置');
}

/**
 * 检查是否已初始化
 */
function isInitialized() {
  return initialized;
}

// ============================================
// 核心函数：业务概念匹配
// ============================================

/**
 * 匹配查询中的业务概念
 * 
 * @param {string} userQuery - 用户查询
 * @returns {Array} 匹配到的概念列表
 */
function matchConcepts(userQuery) {
  if (!initialized) {
    load();
  }
  
  const matched = [];
  const queryLower = userQuery.toLowerCase();
  
  for (const [name, conceptConfig] of Object.entries(semanticConfig.concepts)) {
    const matchResult = matchSingleConcept(name, conceptConfig, queryLower);
    
    if (matchResult.score > 0) {
      matched.push({
        name,
        score: matchResult.score,
        matchType: matchResult.matchType,
        matchedTerm: matchResult.matchedTerm,
        config: conceptConfig
      });
    }
  }
  
  // 按分数排序
  matched.sort((a, b) => b.score - a.score);
  
  if (matched.length > 0) {
    logger.debug('[SemanticLayer] 匹配到业务概念', {
      query: userQuery,
      matched: matched.map(m => ({ name: m.name, score: m.score }))
    });
  }
  
  return matched;
}

/**
 * 匹配单个概念
 * 
 * @param {string} conceptName - 概念名称
 * @param {Object} conceptConfig - 概念配置
 * @param {string} queryLower - 小写的查询文本
 * @returns {Object} 匹配结果
 */
function matchSingleConcept(conceptName, conceptConfig, queryLower) {
  // 1. 精确匹配
  if (queryLower.includes(conceptName.toLowerCase())) {
    return {
      score: 1.0,
      matchType: 'exact',
      matchedTerm: conceptName
    };
  }
  
  // 2. 别名匹配
  if (conceptConfig.aliases) {
    for (const alias of conceptConfig.aliases) {
      if (queryLower.includes(alias.toLowerCase())) {
        return {
          score: 0.9,
          matchType: 'alias',
          matchedTerm: alias
        };
      }
    }
  }
  
  // 3. 模糊匹配（包含关键词的一部分）
  const conceptKeywords = extractKeywords(conceptName);
  const queryKeywords = extractKeywords(queryLower);
  const overlap = conceptKeywords.filter(k => queryKeywords.includes(k));
  
  if (overlap.length > 0) {
    return {
      score: 0.6,
      matchType: 'fuzzy',
      matchedTerm: overlap[0]
    };
  }
  
  return { score: 0, matchType: null, matchedTerm: null };
}

/**
 * 提取关键词
 * 
 * @param {string} text - 文本
 * @returns {Array<string>} 关键词数组
 */
function extractKeywords(text) {
  const chineseWords = text.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
  const englishWords = text.match(/[a-zA-Z]{2,}/gi) || [];
  return [...chineseWords, ...englishWords];
}

// ============================================
// 核心函数：表推荐
// ============================================

/**
 * 基于匹配到的概念推荐表
 * 
 * @param {Array} matchedConcepts - 匹配到的概念列表
 * @returns {Object} 表推荐结果
 */
function recommendTables(matchedConcepts) {
  const recommendations = new Map();
  
  for (const concept of matchedConcepts) {
    const mappings = concept.config.mappings || {};
    
    // 处理主表
    if (mappings.primary_table) {
      addTableRecommendation(recommendations, mappings.primary_table, {
        reason: concept.name,
        priority: concept.config.priority || 3,
        matchType: concept.matchType,
        score: concept.score
      });
    }
    
    // 处理平台表
    if (mappings.platform_table) {
      addTableRecommendation(recommendations, mappings.platform_table, {
        reason: concept.name,
        priority: concept.config.priority || 3,
        matchType: concept.matchType,
        score: concept.score
      });
    }
    
    // 处理游戏表
    if (mappings.game_table) {
      addTableRecommendation(recommendations, mappings.game_table, {
        reason: concept.name,
        priority: concept.config.priority || 3,
        matchType: concept.matchType,
        score: concept.score
      });
    }
    
    // 处理备选表
    if (mappings.fallback_table) {
      addTableRecommendation(recommendations, mappings.fallback_table, {
        reason: `${concept.name}（备选）`,
        priority: (concept.config.priority || 3) + 1, // 降低优先级
        matchType: 'fallback',
        score: concept.score * 0.8
      });
    }
  }
  
  // 转换为数组并排序
  const sortedRecommendations = Array.from(recommendations.entries())
    .map(([tableName, info]) => ({
      tableName,
      ...info
    }))
    .sort((a, b) => {
      // 先按优先级排序，再按分数排序
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return b.score - a.score;
    });
  
  return {
    tables: sortedRecommendations,
    analysis: {
      conceptCount: matchedConcepts.length,
      tableCount: sortedRecommendations.length
    }
  };
}

/**
 * 添加表推荐
 * 
 * @param {Map} recommendations - 推荐表Map
 * @param {string} tableName - 表名
 * @param {Object} info - 推荐信息
 */
function addTableRecommendation(recommendations, tableName, info) {
  if (!recommendations.has(tableName)) {
    recommendations.set(tableName, {
      reasons: [],
      priority: info.priority,
      score: 0,
      matchTypes: []
    });
  }
  
  const existing = recommendations.get(tableName);
  existing.reasons.push(info.reason);
  existing.score = Math.max(existing.score, info.score);
  existing.matchTypes.push(info.matchType);
  existing.priority = Math.min(existing.priority, info.priority);
}

// ============================================
// 核心函数：数据源映射
// ============================================

/**
 * 获取数据源映射
 * 
 * @param {string} conceptName - 概念名称
 * @returns {Object|null} 数据源映射
 */
function getDatasourceMapping(conceptName) {
  if (!initialized) {
    load();
  }
  
  const concept = semanticConfig.concepts[conceptName];
  if (!concept) {
    // 尝试别名匹配
    for (const [name, config] of Object.entries(semanticConfig.concepts)) {
      if (config.aliases && config.aliases.includes(conceptName)) {
        return config.mappings?.datasource || null;
      }
    }
    return null;
  }
  
  return concept.mappings?.datasource || null;
}

/**
 * 根据查询推断数据源
 * 
 * @param {string} userQuery - 用户查询
 * @returns {Object} 数据源推断结果
 */
function inferDatasource(userQuery) {
  const matchedConcepts = matchConcepts(userQuery);
  
  for (const concept of matchedConcepts) {
    const datasource = concept.config.mappings?.datasource;
    if (datasource) {
      return {
        datasource,
        concept: concept.name,
        confidence: concept.score
      };
    }
  }
  
  return {
    datasource: null,
    concept: null,
    confidence: 0
  };
}

// ============================================
// 核心函数：字段值映射
// ============================================

/**
 * 获取字段值映射
 * 
 * @param {string} fieldName - 字段名
 * @param {string} userTerm - 用户使用的术语
 * @returns {Object|null} 字段值映射
 */
function getFieldValueMapping(fieldName, userTerm) {
  if (!initialized) {
    load();
  }
  
  const fieldMapping = semanticConfig.field_mappings?.[fieldName];
  if (!fieldMapping || !fieldMapping.common_values) {
    return null;
  }
  
  // 精确匹配
  if (fieldMapping.common_values[userTerm]) {
    return {
      field: fieldName,
      userTerm,
      value: fieldMapping.common_values[userTerm],
      matchType: 'exact'
    };
  }
  
  // 模糊匹配
  for (const [term, value] of Object.entries(fieldMapping.common_values)) {
    if (userTerm.includes(term) || term.includes(userTerm)) {
      return {
        field: fieldName,
        userTerm,
        matchedTerm: term,
        value,
        matchType: 'fuzzy'
      };
    }
  }
  
  return null;
}

/**
 * 解析查询中的game_id
 * 
 * @param {string} userQuery - 用户查询
 * @returns {Object|null} game_id映射结果
 */
function parseGameId(userQuery) {
  // 常见的游戏名称映射
  const gameIdMappings = {
    '青木': '30',
    '华夏': '88',
    '游戏67': '67',
    '游戏8': '8',
    '游戏9': '9',
    '游戏66': '66'
  };
  
  for (const [gameName, gameId] of Object.entries(gameIdMappings)) {
    if (userQuery.includes(gameName)) {
      return {
        gameName,
        gameId,
        matchType: 'exact'
      };
    }
  }
  
  // 尝试从语义配置中获取
  return getFieldValueMapping('game_id', userQuery);
}

// ============================================
// 查询模式匹配
// ============================================

/**
 * 匹配查询模式
 * 
 * @param {string} userQuery - 用户查询
 * @returns {Object|null} 匹配到的查询模式
 */
function matchQueryPattern(userQuery) {
  if (!initialized) {
    load();
  }
  
  const matchedConcepts = matchConcepts(userQuery);
  const conceptNames = matchedConcepts.map(c => c.name);
  
  for (const [patternName, patternConfig] of Object.entries(semanticConfig.query_patterns || {})) {
    const requiredConcepts = patternConfig.required_concepts || [];
    const optionalConcepts = patternConfig.optional_concepts || [];
    
    // 检查是否满足必要概念
    const hasRequired = requiredConcepts.every(c => conceptNames.includes(c));
    
    if (hasRequired) {
      // 计算匹配分数
      const matchedOptional = optionalConcepts.filter(c => conceptNames.includes(c));
      const score = requiredConcepts.length > 0 
        ? (matchedOptional.length + requiredConcepts.length) / (optionalConcepts.length + requiredConcepts.length)
        : matchedOptional.length / Math.max(optionalConcepts.length, 1);
      
      return {
        pattern: patternName,
        config: patternConfig,
        score,
        matchedRequired: requiredConcepts,
        matchedOptional
      };
    }
  }
  
  return null;
}

// ============================================
// 导出模块
// ============================================

module.exports = {
  // 初始化
  load,
  isInitialized,
  
  // 核心功能
  matchConcepts,
  recommendTables,
  inferDatasource,
  getDatasourceMapping,
  getFieldValueMapping,
  parseGameId,
  matchQueryPattern,
  
  // 辅助函数
  extractKeywords
};
