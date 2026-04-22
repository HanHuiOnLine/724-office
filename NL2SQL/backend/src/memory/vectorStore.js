/**
 * 向量存储模块
 * 
 * 基于LanceDB实现向量存储和语义检索，用于：
 * 1. 存储Schema信息的向量表示
 * 2. 存储查询历史的向量表示
 * 3. 语义相似度搜索
 */

// ============================================
// 导入依赖模块
// ============================================

// 导入LanceDB客户端
const lancedb = require('vectordb');
// 导入配置模块
const config = require('../core/config');
// 导入日志模块
const logger = require('../utils/logger');
// 【Phase 2】表作用域推断工具(从本文件迁出,供 tableRanker 共用)
const { inferScopeSubtype } = require('../utils/tableScope');
// 导入评估模块（用于运行时统计）
const evaluation = require('../utils/evaluation');
// 导入 crypto 用于计算 Hash
const crypto = require('crypto');

// ============================================
// 元数据增强工具函数
// ============================================

/**
 * 查询类型枚举
 */
const QUERY_TYPES = {
  DATA_QUERY: 'data_query',      // 数据查询
  DEFINITION: 'definition',      // 定义/解释查询
  COMPARISON: 'comparison',      // 对比查询
  TREND: 'trend',                // 趋势查询
  CLARIFICATION: 'clarification', // 澄清回复
  FOLLOW_UP: 'follow_up',        // 跟进查询
  NEW_TOPIC: 'new_topic'         // 新话题
};

/**
 * 计算查询重要性评分
 * 基于意图的复杂度、成功状态等因素
 * 
 * @param {Object} intent - 查询意图
 * @param {boolean} success - 查询是否成功
 * @returns {number} 重要性评分 (0-1)
 */
function calculateImportance(intent, success = true) {
  let score = 0.5; // 基础分
  
  if (!intent) return score;
  
  // 成功查询加分
  if (success) score += 0.1;
  
  // 多维度查询更有价值
  if (intent.dimensions && intent.dimensions.length > 0) {
    score += Math.min(intent.dimensions.length * 0.05, 0.15);
  }
  
  // 多指标查询更有价值
  if (intent.metrics && intent.metrics.length > 0) {
    score += Math.min(intent.metrics.length * 0.05, 0.15);
  }
  
  // 有筛选条件的查询更具体，更有价值
  if (intent.filters && intent.filters.length > 0) {
    score += Math.min(intent.filters.length * 0.03, 0.1);
  }
  
  // 高置信度查询加分
  if (intent.confidence && intent.confidence > 0.8) {
    score += 0.1;
  }
  
  // 上下文查询（需要理解上下文的）更有学习价值
  if (intent.isContextualQuery) {
    score += 0.05;
  }
  
  return Math.min(score, 1.0);
}

/**
 * 分类查询类型
 * 
 * @param {Object} intent - 查询意图
 * @param {string} queryText - 查询文本
 * @returns {string} 查询类型
 */
function classifyQueryType(intent, queryText) {
  if (!intent || !queryText) return QUERY_TYPES.DATA_QUERY;
  
  const text = queryText.toLowerCase();
  
  // 澄清回复
  if (intent.clarification_context || text.length < 20) {
    return QUERY_TYPES.CLARIFICATION;
  }
  
  // 定义/解释查询
  if (text.includes('什么') || text.includes('定义') || text.includes('意思') || 
      text.includes('explain') || text.includes('what is')) {
    return QUERY_TYPES.DEFINITION;
  }
  
  // 对比查询
  if (text.includes('对比') || text.includes('比较') || text.includes('vs') || 
      text.includes('versus') || text.includes('compare')) {
    return QUERY_TYPES.COMPARISON;
  }
  
  // 趋势查询
  if (text.includes('趋势') || text.includes('走势') || text.includes('变化') || 
      text.includes('trend') || text.includes('over time')) {
    return QUERY_TYPES.TREND;
  }
  
  // 跟进查询（依赖上下文）
  if (intent.isContextualQuery || text.startsWith('那') || text.startsWith('还有')) {
    return QUERY_TYPES.FOLLOW_UP;
  }
  
  // 新话题（长查询且置信度高）
  if (queryText.length > 30 && intent.confidence > 0.7) {
    return QUERY_TYPES.NEW_TOPIC;
  }
  
  return QUERY_TYPES.DATA_QUERY;
}

/**
 * 构建增强的元数据对象
 * 
 * @param {Object} baseMetadata - 基础元数据
 * @param {Object} options - 增强选项
 * @returns {Object} 增强后的元数据
 */
function buildEnhancedMetadata(baseMetadata, options = {}) {
  const {
    intent = null,
    queryText = '',
    success = true,
    executionTime = 0,
    resultCount = 0
  } = options;
  
  // 计算重要性
  const importanceScore = calculateImportance(intent, success);
  
  // 分类查询类型
  const queryType = classifyQueryType(intent, queryText);
  
  // 构建增强元数据
  const enhancedMetadata = {
    // 基础信息
    ...baseMetadata,
    
    // 时间戳（毫秒）
    timestamp: Date.now(),
    
    // 重要性评分 (0-1)
    importanceScore: Math.round(importanceScore * 100) / 100,
    
    // 查询类型
    queryType: queryType,
    
    // 查询复杂度（基于维度、指标、筛选器数量）
    complexity: {
      dimensions: intent?.dimensions?.length || 0,
      metrics: intent?.metrics?.length || 0,
      filters: intent?.filters?.length || 0,
      total: (intent?.dimensions?.length || 0) + 
             (intent?.metrics?.length || 0) + 
             (intent?.filters?.length || 0)
    },
    
    // 执行信息
    execution: {
      success: success,
      executionTime: executionTime,
      resultCount: resultCount
    },
    
    // 意图摘要（如果存在）
    intentSummary: intent ? {
      metrics: intent.metrics || [],
      dimensions: intent.dimensions || [],
      timeRange: intent.time_range || null,
      confidence: intent.confidence || 0
    } : null
  };
  
  return enhancedMetadata;
}

// ============================================
// 模块状态
// ============================================

/**
 * LanceDB连接实例
 */
let db = null;

/**
 * Schema向量表
 */
let schemaTable = null;

/**
 * 查询历史向量表
 */
let queryTable = null;

/**
 * 初始化状态标志
 */
let initialized = false;

// ============================================
// 初始化
// ============================================

/**
 * 初始化向量数据库
 * 连接LanceDB并创建必要的表
 * 
 * @returns {Promise<void>}
 */
async function initialize() {
  // 如果已经初始化，直接返回
  if (initialized) {
    return;
  }
  
  try {
    // 记录开始初始化日志
    logger.info('正在初始化LanceDB向量数据库...');
    
    // 连接到LanceDB数据库
    // connect参数是数据库目录路径
    db = await lancedb.connect(config.vectorDb.path);
    
    // 初始化或打开Schema表
    await initSchemaTable();
    
    // 初始化或打开查询历史表
    await initQueryTable();
    
    // 标记初始化完成
    initialized = true;
    
    logger.info('LanceDB向量数据库初始化完成');
    
  } catch (error) {
    logger.error('LanceDB初始化失败:', error);
    // 初始化失败不阻止应用启动，记录警告
    logger.warn('向量数据库未初始化，语义搜索功能将不可用');
  }
}

/**
 * 初始化Schema向量表
 * 如果表不存在则创建
 */
async function initSchemaTable() {
  try {
    // 尝试打开已存在的表
    schemaTable = await db.openTable('schema_vectors');
    logger.debug('已打开schema_vectors表');
  } catch (error) {
    // 表不存在，需要创建
    logger.info('创建schema_vectors表...');
    
    // 创建初始数据（用于定义表结构）
    const initialData = [{
      // 唯一标识
      id: 'init',
      // 文本内容
      text: '初始化数据',
      // 向量（使用零向量作为占位）
      vector: new Array(config.embedding.dimension).fill(0),
      // 元数据（JSON字符串）
      metadata: JSON.stringify({ type: 'init' }),
      // 创建时间
      created_at: Date.now()
    }];
    
    // 创建表
    schemaTable = await db.createTable('schema_vectors', initialData);
    logger.info('schema_vectors表创建完成');
  }
}

/**
 * 初始化查询历史向量表
 * 如果表不存在则创建
 */
async function initQueryTable() {
  try {
    // 尝试打开已存在的表
    queryTable = await db.openTable('query_vectors');
    logger.debug('已打开query_vectors表');
  } catch (error) {
    // 表不存在，需要创建
    logger.info('创建query_vectors表...');
    
    // 创建初始数据
    const initialData = [{
      id: 'init',
      text: '初始化数据',
      vector: new Array(config.embedding.dimension).fill(0),
      metadata: JSON.stringify({ type: 'init' }),
      created_at: Date.now()
    }];
    
    // 创建表
    queryTable = await db.createTable('query_vectors', initialData);
    logger.info('query_vectors表创建完成');
  }
}

// ============================================
// Schema向量操作
// ============================================

/**
 * 添加Schema向量
 * 将表和字段的描述向量化并存储
 * 
 * @param {Array<string>} texts - 文本数组
 * @param {Array<Array<number>>} vectors - 向量数组
 * @param {Array<Object>} metadataList - 元数据数组
 */
async function addSchemaVectors(texts, vectors, metadataList) {
  // 检查是否初始化
  if (!initialized || !schemaTable) {
    logger.warn('向量数据库未初始化，跳过添加Schema向量');
    return;
  }
  
  try {
    // 构造数据记录
    const records = texts.map((text, index) => ({
      // 生成唯一ID
      id: `schema_${Date.now()}_${index}`,
      // 文本内容
      text: text,
      // 向量
      vector: vectors[index],
      // 元数据转为JSON字符串
      metadata: JSON.stringify(metadataList[index]),
      // 创建时间
      created_at: Date.now()
    }));
    
    // 添加到表中
    await schemaTable.add(records);
    
    logger.debug(`添加了 ${records.length} 个Schema向量`);
    
  } catch (error) {
    logger.error('添加Schema向量失败:', error);
    throw error;
  }
}

/**
 * 搜索Schema向量
 * 根据查询向量搜索相似的Schema信息
 * 
 * @param {Array<number>} queryVector - 查询向量
 * @param {number} topK - 返回结果数量
 * @param {Object} filters - 可选的过滤条件 { scope, data_type }
 * @returns {Promise<Array>} 搜索结果
 */
async function searchSchema(queryVector, topK = 5, filters = {}) {
  // 检查是否初始化
  if (!initialized || !schemaTable) {
    logger.warn('向量数据库未初始化，返回空结果');
    return [];
  }
  
  try {
    // 构建查询
    let searchQuery = schemaTable.search(queryVector);
    
    // 【新增】应用元数据过滤
    if (filters.scope || filters.data_type) {
      const conditions = [];
      if (filters.scope) {
        conditions.push(`metadata.scope = '${filters.scope}'`);
      }
      if (filters.data_type) {
        conditions.push(`metadata.data_type = '${filters.data_type}'`);
      }
      // 注意：LanceDB 的 where 条件语法可能需要根据实际版本调整
      // 这里使用简化实现，实际过滤在应用层处理
    }
    
    // 执行向量搜索
    const results = await searchQuery.limit(topK * 2).execute(); // 搜索更多用于后过滤
    
    // 解析结果
    let parsedResults = results.map(row => ({
      text: row.text,
      distance: row._distance,
      metadata: JSON.parse(row.metadata || '{}')
    }));
    
    // 【新增】应用过滤条件（应用层过滤作为临时方案）
    if (filters.scope) {
      parsedResults = parsedResults.filter(r => r.metadata.scope === filters.scope);
    }
    if (filters.data_type) {
      parsedResults = parsedResults.filter(r => r.metadata.data_type === filters.data_type);
    }
    if (filters.exclude_data_type) {
      parsedResults = parsedResults.filter(r => r.metadata.data_type !== filters.exclude_data_type);
    }
    
    // 限制返回数量
    parsedResults = parsedResults.slice(0, topK);
    
    // 记录统计
    evaluation.recordVectorSearch('schema', parsedResults);
    
    return parsedResults;
    
  } catch (error) {
    logger.error('搜索Schema向量失败:', error);
    return [];
  }
}

/**
 * 【新增】智能搜索Schema向量（带查询意图识别）
 * 
 * 根据查询文本自动识别意图，应用相应的过滤策略：
 * - 未提及具体游戏时，优先返回 platform 表
 * - 提及游戏时，返回对应游戏表 + platform 表
 * - 降低 aggregated_report 类型表的排名
 * 
 * @param {Array<number>} queryVector - 查询向量
 * @param {string} queryText - 原始查询文本（用于意图识别）
 * @param {number} topK - 返回结果数量
 * @returns {Promise<Array>} 搜索结果
 */
async function searchSchemaSmart(queryVector, queryText, topK = 5) {
  // 检查是否初始化
  if (!initialized || !schemaTable) {
    logger.warn('向量数据库未初始化，返回空结果');
    return [];
  }

  try {
    // 1. 意图识别：检测是否提到具体游戏（使用动态游戏名索引）
    let mentionedGame = null;
    try {
      const schemaLoader = require('../core/schemaLoader');
      const gameNameIndex = schemaLoader.getGameNameIndex ? schemaLoader.getGameNameIndex() : null;
      if (gameNameIndex && gameNameIndex.size > 0) {
        const queryLower = queryText.toLowerCase();
        for (const [gameName, info] of gameNameIndex) {
          if (queryLower.includes(gameName.toLowerCase())) {
            mentionedGame = { name: gameName, ...info };
            break;
          }
        }
      }
    } catch (_) {
      // schemaLoader 未就绪时忽略
    }
    // 兜底：硬编码关键词（向后兼容）
    if (!mentionedGame) {
      const gameKeywords = ['青木', '无限', '星火', '幻灵', 'tzqingmu', 'tzwuxian', 'tzxinghuo'];
      const matched = gameKeywords.find(game => queryText.toLowerCase().includes(game.toLowerCase()));
      if (matched) {
        mentionedGame = { name: matched };
      }
    }

    // 2. 执行向量搜索（获取更多结果用于重排序）
    const results = await schemaTable
      .search(queryVector)
      .limit(topK * 3)
      .execute();

    // 3. 解析结果
    let parsedResults = results.map(row => ({
      text: row.text,
      distance: row._distance,
      metadata: JSON.parse(row.metadata || '{}')
    }));

    // 4. 智能重排序
    parsedResults = parsedResults.map(result => {
      let priorityScore = 0;
      const metadata = result.metadata;
      const tableName = metadata.name || '';

      // 运行时推断 scope 子类型（在 REVECTORIZE 前使用表名模式匹配）
      const runtimeScope = inferScopeSubtype(tableName, metadata.scope);

      // 策略1：如果提到了具体游戏，该游戏表优先级最高
      if (mentionedGame) {
        const gameName = mentionedGame.name.replace('tz', '');
        const prefix = mentionedGame.prefix || '';
        if ((metadata.scope && metadata.scope.includes(gameName)) ||
            (prefix && tableName.includes(prefix))) {
          priorityScore += 100;
        }
      }

      // 策略2：分层平台权重（替代统一 +50）
      if (!mentionedGame) {
        switch (runtimeScope) {
          case 'platform_core':   priorityScore += 80; break;  // SDK 核心表
          case 'platform_other':  priorityScore += 50; break;  // 平台其他
          case 'report':          priorityScore += 40; break;  // DWD 报表
          case 'platform_newdb':  priorityScore += 20; break;  // 新平台库
          case 'platform_olddb':  priorityScore += 10; break;  // 老平台库
          default:
            if (runtimeScope.startsWith('game_')) {
              priorityScore -= 30;  // 游戏表主动降权（未指定游戏时）
            }
        }
      }

      // 策略3：原始日志表优先级高于聚合报表
      if (metadata.data_type === 'raw_log') {
        priorityScore += 30;
      } else if (metadata.data_type === 'aggregated_report') {
        priorityScore -= 20; // 降低报表优先级
      }

      // 策略4：向量距离越小越好（归一化到 0-20 分）
      const distanceScore = Math.max(0, (1 - result.distance) * 20);
      priorityScore += distanceScore;

      return {
        ...result,
        priorityScore: priorityScore
      };
    });

    // 5. 按优先级分数排序
    parsedResults.sort((a, b) => b.priorityScore - a.priorityScore);

    // 6. 限制返回数量
    const finalResults = parsedResults.slice(0, topK);

    logger.debug('[VectorStore] 智能搜索结果', {
      query: queryText.substring(0, 50),
      mentionedGame: mentionedGame ? mentionedGame.name : 'none',
      topResults: finalResults.map(r => ({
        name: r.metadata.name,
        scope: r.metadata.scope,
        score: r.priorityScore.toFixed(2)
      }))
    });

    // 7. 记录统计
    evaluation.recordVectorSearch('schema', finalResults);

    return finalResults;

  } catch (error) {
    logger.error('智能搜索Schema向量失败:', error);
    // 失败时回退到普通搜索
    return searchSchema(queryVector, topK);
  }
}

/**
 * 从表名推断 scope 子类型
 * @deprecated 已迁移至 backend/src/utils/tableScope.js,此处仅保留以兼容本文件内部其他引用。
 *             新代码请从 utils/tableScope 导入。
 */
// inferScopeSubtype 已从 utils/tableScope require,无需在此重复定义

// ============================================
// 查询历史向量操作
// ============================================

/**
 * 添加查询历史向量
 * 将用户的自然语言查询向量化存储
 * 
 * @param {string} queryId - 查询ID
 * @param {string} queryText - 查询文本
 * @param {Array<number>} vector - 查询向量
 * @param {Object} metadata - 元数据
 */
async function addQueryVector(queryId, queryText, vector, metadata) {
  // 检查是否初始化
  if (!initialized || !queryTable) {
    logger.warn('向量数据库未初始化，跳过添加查询向量');
    return;
  }
  
  try {
    // 构造数据记录
    const record = {
      id: queryId,
      text: queryText,
      vector: vector,
      metadata: JSON.stringify(metadata),
      created_at: Date.now()
    };
    
    // 添加到表中
    await queryTable.add([record]);
    
    logger.debug(`添加查询向量: ${queryId}`);
    
  } catch (error) {
    logger.error('添加查询向量失败:', error);
    throw error;
  }
}

/**
 * 搜索相似查询
 * 根据查询向量搜索历史相似查询
 * 
 * @param {Array<number>} queryVector - 查询向量
 * @param {number} topK - 返回结果数量
 * @returns {Promise<Array>} 搜索结果
 */
async function searchSimilarQueries(queryVector, topK = 5) {
  // 检查是否初始化
  if (!initialized || !queryTable) {
    logger.warn('向量数据库未初始化，返回空结果');
    return [];
  }
  
  try {
    // 执行向量搜索
    const results = await queryTable
      .search(queryVector)
      .limit(topK)
      .execute();
    
    // 解析结果
    const parsedResults = results.map(row => ({
      id: row.id,
      text: row.text,
      distance: row._distance,
      metadata: JSON.parse(row.metadata || '{}')
    }));
    
    // 记录统计
    evaluation.recordVectorSearch('query', parsedResults);
    
    return parsedResults;
    
  } catch (error) {
    logger.error('搜索相似查询失败:', error);
    return [];
  }
}

// ============================================
// 通用操作
// ============================================

/**
 * 删除向量
 * 
 * @param {string} tableName - 表名（schema_vectors 或 query_vectors）
 * @param {string} id - 记录ID
 */
async function deleteVector(tableName, id) {
  if (!initialized) {
    return;
  }
  
  try {
    // 获取对应的表
    const table = tableName === 'schema' ? schemaTable : queryTable;
    if (!table) return;
    
    // LanceDB目前不直接支持删除，这里记录日志
    logger.debug(`删除向量: ${tableName}.${id}`);
    
  } catch (error) {
    logger.error('删除向量失败:', error);
  }
}

/**
 * 获取表统计信息
 * 
 * @returns {Promise<Object>} 统计信息
 */
async function getStats() {
  if (!initialized) {
    return {
      initialized: false,
      schemaCount: 0,
      queryCount: 0
    };
  }
  
  try {
    // 获取Schema表数量
    const schemaCount = schemaTable ? await schemaTable.countRows() : 0;
    // 获取查询表数量
    const queryCount = queryTable ? await queryTable.countRows() : 0;
    
    return {
      initialized: true,
      schemaCount: Math.max(0, schemaCount - 1), // 减去初始化记录
      queryCount: Math.max(0, queryCount - 1)
    };
    
  } catch (error) {
    logger.error('获取向量统计失败:', error);
    return {
      initialized: true,
      schemaCount: 0,
      queryCount: 0,
      error: error.message
    };
  }
}

// ============================================
// 状态检查
// ============================================

/**
 * 检查是否已初始化
 * @returns {boolean} 初始化状态
 */
function isInitialized() {
  return initialized;
}

/**
 * 检查Schema向量是否已存在（排除初始化记录）
 * @returns {Promise<boolean>} 是否存在有效的Schema向量
 */
async function hasSchemaVectors() {
  if (!initialized || !schemaTable) {
    return false;
  }
  
  try {
    const count = await schemaTable.countRows();
    // 如果数量大于1，说明有除初始化记录外的有效数据
    return count > 1;
  } catch (error) {
    logger.error('检查Schema向量存在性失败:', error);
    return false;
  }
}

/**
 * 清空Schema向量表（用于重新向量化）
 */
async function clearSchemaVectors() {
  if (!initialized || !schemaTable) {
    return;
  }
  
  try {
    // LanceDB 目前不直接支持删除，通过重新创建表来实现清空
    // 注意：这里只是记录，实际重新向量化时会覆盖
    logger.info('准备重新向量化Schema，将覆盖现有向量数据');
  } catch (error) {
    logger.error('清空Schema向量失败:', error);
  }
}

// ============================================
// 增量更新（新增）
// ============================================

/**
 * 根据表名查找已存在的Schema向量
 * 
 * @param {string} tableName - 表名
 * @returns {Promise<Object|null>} 已存在的记录
 */
async function findSchemaByTableName(tableName) {
  if (!initialized || !schemaTable) {
    return null;
  }
  
  try {
    // 使用 LanceDB 的过滤功能查找
    // 注意：这里使用简化实现，实际可能需要根据 LanceDB 版本调整
    const results = await schemaTable
      .search(new Array(config.embedding.dimension).fill(0))
      .limit(1000)
      .execute();
    
    // 在结果中查找匹配的表名
    for (const row of results) {
      const metadata = JSON.parse(row.metadata || '{}');
      if (metadata.name === tableName && !metadata._deleted) {
        return {
          id: row.id,
          text: row.text,
          vector: row.vector,
          metadata: metadata
        };
      }
    }
    
    return null;
  } catch (error) {
    logger.error('查找Schema向量失败:', error);
    return null;
  }
}

/**
 * 标记Schema向量为已删除（软删除）
 * 
 * @param {string} id - 记录ID
 */
async function markSchemaAsDeleted(id) {
  // LanceDB 不支持直接更新，这里记录日志
  // 实际清理在定期维护任务中处理
  logger.debug('[VectorStore] 标记Schema向量为删除', { id });
}

/**
 * 增量更新Schema向量
 * 根据内容Hash判断是否需要更新，避免不必要的Embedding调用
 * 
 * @param {string} tableName - 表名
 * @param {string} text - 表描述文本
 * @param {Array<number>} vector - 向量
 * @param {Object} metadata - 元数据
 * @returns {Promise<Object>} 更新结果 { updated: boolean, reason: string }
 */
async function upsertSchemaVector(tableName, text, vector, metadata) {
  if (!initialized || !schemaTable) {
    return { updated: false, reason: 'not_initialized' };
  }
  
  try {
    // 计算内容Hash
    const contentHash = crypto.createHash('md5').update(text).digest('hex');
    
    // 检查是否存在且未变更
    const existing = await findSchemaByTableName(tableName);
    if (existing && existing.metadata.hash === contentHash) {
      logger.debug('[VectorStore] Schema向量未变更，跳过更新', {
        tableName,
        hash: contentHash
      });
      return { updated: false, reason: 'no_change' };
    }
    
    // 如果存在旧记录，标记为删除
    if (existing) {
      await markSchemaAsDeleted(existing.id);
      logger.debug('[VectorStore] 标记旧向量为删除', {
        tableName,
        oldId: existing.id
      });
    }
    
    // 添加新向量
    const newMetadata = {
      ...metadata,
      hash: contentHash,
      updated_at: Date.now(),
      _deleted: false
    };
    
    await addSchemaVectors([text], [vector], [newMetadata]);
    
    logger.info('[VectorStore] Schema向量已更新', {
      tableName,
      hash: contentHash,
      isUpdate: !!existing
    });
    
    return {
      updated: true,
      reason: existing ? 'content_changed' : 'new_table'
    };
    
  } catch (error) {
    logger.error('[VectorStore] 增量更新Schema向量失败:', error);
    return { updated: false, reason: 'error', error: error.message };
  }
}

// ============================================
// 导出模块
// ============================================

module.exports = {
  // 初始化
  initialize,
  isInitialized,
  // Schema操作
  addSchemaVectors,
  searchSchema,
  searchSchemaSmart,  // 【新增】智能搜索
  hasSchemaVectors,
  clearSchemaVectors,
  upsertSchemaVector,  // 【新增】增量更新
  // 查询历史操作
  addQueryVector,
  searchSimilarQueries,
  // 通用操作
  deleteVector,
  getStats,
  // 元数据增强工具
  calculateImportance,
  classifyQueryType,
  buildEnhancedMetadata,
  QUERY_TYPES
};
