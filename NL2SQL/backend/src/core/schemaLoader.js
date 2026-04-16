/**
 * Schema元数据加载模块
 * 
 * 负责加载和管理数据表的Schema信息，包括：
 * 1. 从JSON配置文件加载表结构定义
 * 2. 提供Schema查询和匹配接口
 * 3. 缓存Schema信息提高性能
 * 4. 验证SQL语句的表和字段
 */

// ============================================
// 导入依赖模块
// ============================================

// 导入Node.js内置的fs模块，用于文件系统操作
const fs = require('fs');
// 导入Node.js内置的path模块，用于路径处理
const path = require('path');
// 导入配置模块，获取Schema配置
const config = require('./config');
// 导入日志模块，记录加载日志
const logger = require('../utils/logger');
// 导入LLM服务，用于生成Embedding
const llmService = require('./llmService');
// 导入向量存储模块，用于存储Schema向量
const vectorStore = require('../memory/vectorStore');

// ============================================
// 模块状态
// ============================================

/**
 * Schema数据存储对象
 * 包含所有加载的表、字段、关系等信息
 */
let schemaData = {
  // 版本号
  version: '',
  // 表定义数组
  tables: [],
  // 表关系数组
  relationships: [],
  // 预定义指标数组
  metrics: [],
  // 维度定义数组
  dimensions: [],
  // 表名到表定义的映射，用于快速查找
  tableMap: new Map(),
  // 字段名到字段定义的映射
  fieldMap: new Map()
};

/**
 * 缓存时间戳
 * 用于判断缓存是否过期
 */
let cacheTimestamp = 0;

// ============================================
// Schema加载
// ============================================

/**
 * 加载Schema配置文件
 * 从JSON文件读取表结构定义并解析
 * 
 * @returns {Promise<void>}
 */
async function load() {
  // 记录开始加载日志
  logger.info('开始加载Schema元数据...');
  
  // 获取Schema配置文件路径
  const schemaPath = path.resolve(config.schema.configPath);
  
  // 检查配置文件是否存在
  if (!fs.existsSync(schemaPath)) {
    // 文件不存在，抛出错误
    throw new Error(`Schema配置文件不存在: ${schemaPath}`);
  }
  
  try {
    // 读取配置文件内容
    const content = fs.readFileSync(schemaPath, 'utf-8');
    // 解析JSON内容
    const data = JSON.parse(content);
    
    // 验证Schema数据格式
    validateSchema(data);
    
    // 更新Schema数据
    schemaData.version = data.version || '1.0';
    schemaData.tables = data.tables || [];
    schemaData.relationships = data.relationships || [];
    schemaData.metrics = data.metrics || [];
    schemaData.dimensions = data.dimensions || [];
    
    // 构建快速查找映射
    buildMaps();
    
    // 更新缓存时间戳
    cacheTimestamp = Date.now();
    
    // 如果启用了向量存储，将Schema信息向量化
    if (vectorStore.isInitialized()) {
      await vectorizeSchema();
    }
    
    // 记录加载成功日志
    logger.info('Schema元数据加载完成', {
      version: schemaData.version,
      tableCount: schemaData.tables.length,
      relationshipCount: schemaData.relationships.length,
      metricCount: schemaData.metrics.length
    });
    
  } catch (error) {
    // 记录加载失败日志
    logger.error('Schema加载失败:', error);
    throw error;
  }
}

/**
 * 验证Schema数据格式
 * 确保必要的字段存在且格式正确
 * 
 * @param {Object} data - Schema数据对象
 * @throws {Error} 验证失败时抛出错误
 */
function validateSchema(data) {
  // 检查tables字段是否存在且为数组
  if (!data.tables || !Array.isArray(data.tables)) {
    throw new Error('Schema缺少tables字段或格式不正确');
  }
  
  // 检查每个表的必要字段
  for (const table of data.tables) {
    // 表必须有name字段
    if (!table.name) {
      throw new Error('表定义缺少name字段');
    }
    // 表必须有fields字段且为数组
    if (!table.fields || !Array.isArray(table.fields)) {
      throw new Error(`表 ${table.name} 缺少fields字段或格式不正确`);
    }
    
    // 检查每个字段的必要字段
    for (const field of table.fields) {
      if (!field.name) {
        throw new Error(`表 ${table.name} 的字段定义缺少name字段`);
      }
    }
  }
}

/**
 * 构建快速查找映射
 * 创建表名和字段名的映射，加速查询
 */
function buildMaps() {
  // 清空现有映射
  schemaData.tableMap.clear();
  schemaData.fieldMap.clear();
  
  // 遍历所有表，构建表名映射
  for (const table of schemaData.tables) {
    // 以表名为key，表定义为value
    schemaData.tableMap.set(table.name, table);
    
    // 同时存储中文名映射（如果有）
    if (table.name_cn) {
      schemaData.tableMap.set(table.name_cn, table);
    }
    
    // 遍历表的所有字段，构建字段映射
    for (const field of table.fields) {
      // 构造唯一字段标识：表名.字段名
      const fieldKey = `${table.name}.${field.name}`;
      schemaData.fieldMap.set(fieldKey, field);
      
      // 同时存储中文名映射
      if (field.name_cn) {
        const fieldKeyCn = `${table.name}.${field.name_cn}`;
        schemaData.fieldMap.set(fieldKeyCn, field);
      }
    }
  }
}

/**
 * 【优化】将Schema信息向量化并存储 - 表级表征版本
 * 
 * 核心改进：
 * 1. 从"字段级向量"改为"表级向量"，每个表只生成一个向量
 * 2. 表级文本浓缩核心业务含义，包含强动作特征词
 * 3. 添加 scope 和 data_type 元数据标签用于过滤
 * 
 * 原理：只要表找对了，LLM 能根据字段描述自动对齐语义
 */
async function vectorizeSchema() {
  // 检查是否强制重新向量化
  const shouldRevectorize = config.schema.revectorize;
  
  // 如果不强制重新向量化，检查是否已有向量数据
  if (!shouldRevectorize) {
    const hasExistingVectors = await vectorStore.hasSchemaVectors();
    if (hasExistingVectors) {
      logger.info('Schema向量已存在，跳过向量化（如需强制重新向量化，请设置 SCHEMA_REVECTORIZE=true）');
      return;
    }
  } else {
    logger.info('强制重新向量化模式已启用');
    await vectorStore.clearSchemaVectors();
  }
  
  // 记录开始向量化日志
  logger.info('开始将Schema向量化（表级表征模式）...');
  
  try {
    logger.info(`准备向量化 ${schemaData.tables.length} 个表级表征（增量更新模式）`);
    
    // 统计信息
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    
    // 遍历所有表，使用增量更新
    for (const table of schemaData.tables) {
      try {
        // 【核心】生成表级表征文本
        const tableRepresentation = buildTableRepresentation(table);
        
        // 获取Embedding向量
        const embedding = await llmService.getEmbedding(tableRepresentation.text);
        
        // 【优化】使用增量更新替代全量重建
        const result = await vectorStore.upsertSchemaVector(
          table.name,
          tableRepresentation.text,
          embedding,
          {
            type: 'table',
            name: table.name,
            name_cn: table.name_cn,
            scope: tableRepresentation.scope,
            data_type: tableRepresentation.dataType,
            key_features: tableRepresentation.keyFeatures
          }
        );
        
        if (result.updated) {
          updatedCount++;
        } else if (result.reason === 'no_change') {
          skippedCount++;
        }
        
      } catch (error) {
        logger.error(`表 ${table.name} 向量化失败:`, error);
        errorCount++;
        // 继续处理下一个表
      }
    }
    
    logger.info('Schema表级向量化完成（增量更新）', { 
      tableCount: schemaData.tables.length,
      updated: updatedCount,
      skipped: skippedCount,
      errors: errorCount
    });
    
  } catch (error) {
    logger.error('Schema向量化失败:', error);
    // 向量化失败不影响主流程
  }
}

/**
 * 【新增】构建表级表征文本
 * 
 * 将表的核心业务含义浓缩为一段文本，包含：
 * - 域标签（平台/游戏/报表）
 * - 表名和中文名
 * - 数据源类型（原始日志/聚合报表）
 * - 核心业务功能描述
 * - 强动作特征词（用于提升检索区分度）
 * 
 * @param {Object} table - 表定义对象
 * @returns {Object} 表级表征 { text, scope, dataType, keyFeatures }
 */
function buildTableRepresentation(table) {
  const tableName = table.name;
  const tableCnName = table.name_cn || '';
  const description = table.description || '';
  
  // 1. 确定 scope（域标签）
  let scope = 'unknown';
  if (tableName.includes('tzpingtai') || tableName.includes('pf_')) {
    scope = 'platform';
  } else if (tableName.startsWith('new_tz')) {
    // 提取游戏名，如 new_tzqingmu → game_qingmu
    const gameMatch = tableName.match(/new_tz(\w+)/);
    if (gameMatch) {
      scope = `game_${gameMatch[1]}`;
    }
  } else if (tableName.includes('report') || tableName.includes('dwd_')) {
    scope = 'report';
  }
  
  // 2. 确定 data_type（数据源类型）
  let dataType = 'raw_log';
  if (tableName.includes('report') || tableName.includes('dwd_') || tableName.includes('analysis')) {
    dataType = 'aggregated_report';
  } else if (tableName.includes('dim_') || tableName.includes('dict')) {
    dataType = 'dimension_table';
  }
  
  // 3. 提取核心特征词（基于表名、描述和关键字段）
  const keyFeatures = extractKeyFeatures(table);
  
  // 4. 构建表级表征文本
  // 格式：[域:xxx] 表名:xxx (中文名) 类型:xxx 功能:xxx 核心特征:xxx
  const text = `[域:${scope}] 表名:${tableName} (${tableCnName}) 类型:${dataType} 功能:${description} 核心特征:${keyFeatures.join('、')}`;
  
  return {
    text: text,
    scope: scope,
    dataType: dataType,
    keyFeatures: keyFeatures
  };
}

/**
 * 【新增】提取表的核心特征词
 * 
 * 基于表名、描述和关键字段，提取强动作特征词
 * 用于提升向量检索的区分度
 * 
 * @param {Object} table - 表定义对象
 * @returns {Array<string>} 特征词数组
 */
function extractKeyFeatures(table) {
  const features = new Set();
  const tableName = table.name.toLowerCase();
  const description = (table.description || '').toLowerCase();
  const nameCn = (table.name_cn || '').toLowerCase();
  
  // 1. 基于表名的特征词映射
  const nameFeatureMap = {
    // 注册相关
    'reg': ['注册', '新增', '首入', 'signup'],
    'register': ['注册', '新增', '首入'],
    // 登录相关
    'login': ['登录', '活跃', '在线', 'dau'],
    // 付费相关
    'order': ['付费', '订单', '流水', '成交', 'payment'],
    'pay': ['付费', '充值', '支付'],
    // 创角相关
    'create_role': ['创角', '角色创建', 'create_role'],
    'role': ['角色', '创角'],
    // 首单相关
    'first_order': ['首单', '首充', '首次付费'],
    // 活跃相关
    'act': ['活跃', 'dau', 'mau', '在线'],
    'active': ['活跃', '在线'],
    // 按钮点击
    'button': ['点击', '按钮', '埋点'],
    // 聊天相关
    'chat': ['聊天', '发言', '消息'],
    // 留存相关
    'retain': ['留存', 'retention'],
    // 在线时长
    'online_time': ['在线时长', '时长'],
    // 等级相关
    'level': ['等级', '升级', 'level_up'],
    // 任务相关
    'task': ['任务', 'mission'],
    // 商店相关
    'shop': ['商店', '购买', '商城']
  };
  
  // 匹配表名特征词
  for (const [pattern, words] of Object.entries(nameFeatureMap)) {
    if (tableName.includes(pattern)) {
      words.forEach(w => features.add(w));
    }
  }
  
  // 2. 基于描述的特征词
  const descKeywords = ['注册', '登录', '付费', '充值', '订单', '创角', '活跃', '留存', 
                       '点击', '聊天', '等级', '任务', '商店', '时长', 'dau', '新增'];
  for (const kw of descKeywords) {
    if (description.includes(kw) || nameCn.includes(kw)) {
      features.add(kw);
    }
  }
  
  // 3. 基于关键字段的特征词
  const fieldKeywords = {
    'channel_id': '渠道',
    'game_id': '游戏',
    'role_id': '角色',
    'tz_account_id': '账号',
    'create_time': '时间',
    'real_amount': '实际金额',
    'price': '价格'
  };
  
  for (const field of table.fields || []) {
    const fieldName = field.name.toLowerCase();
    const fieldCn = (field.name_cn || '').toLowerCase();
    
    for (const [pattern, word] of Object.entries(fieldKeywords)) {
      if (fieldName.includes(pattern) || fieldCn.includes(word)) {
        features.add(word);
      }
    }
  }
  
  // 返回前8个特征词（避免过多稀释权重）
  return Array.from(features).slice(0, 8);
}

// ============================================
// Schema查询接口
// ============================================

/**
 * 获取所有表定义
 * @returns {Array} 表定义数组
 */
function getAllTables() {
  return schemaData.tables;
}

/**
 * 根据表名获取表定义
 * @param {string} tableName - 表名（支持英文名或中文名）
 * @returns {Object|null} 表定义对象，不存在返回null
 */
function getTable(tableName) {
  return schemaData.tableMap.get(tableName) || null;
}

/**
 * 根据表名和字段名获取字段定义
 * @param {string} tableName - 表名
 * @param {string} fieldName - 字段名（支持英文名或中文名）
 * @returns {Object|null} 字段定义对象，不存在返回null
 */
function getField(tableName, fieldName) {
  const fieldKey = `${tableName}.${fieldName}`;
  return schemaData.fieldMap.get(fieldKey) || null;
}

/**
 * 获取表的所有字段
 * @param {string} tableName - 表名
 * @returns {Array} 字段定义数组，表不存在返回空数组
 */
function getTableFields(tableName) {
  const table = getTable(tableName);
  return table ? table.fields : [];
}

/**
 * 获取所有指标定义
 * @returns {Array} 指标定义数组
 */
function getAllMetrics() {
  return schemaData.metrics;
}

/**
 * 根据名称获取指标定义
 * @param {string} metricName - 指标名称
 * @returns {Object|null} 指标定义对象
 */
function getMetric(metricName) {
  return schemaData.metrics.find(m => 
    m.name === metricName || m.name_cn === metricName
  ) || null;
}

/**
 * 获取所有维度定义
 * @returns {Array} 维度定义数组
 */
function getAllDimensions() {
  return schemaData.dimensions;
}

/**
 * 获取表之间的关系
 * @param {string} fromTable - 起始表名
 * @param {string} toTable - 目标表名
 * @returns {Object|null} 关系定义对象
 */
function getRelationship(fromTable, toTable) {
  return schemaData.relationships.find(r => 
    (r.from.startsWith(fromTable) && r.to.startsWith(toTable)) ||
    (r.from.startsWith(toTable) && r.to.startsWith(fromTable))
  ) || null;
}

/**
 * 获取表的所有关联表
 * @param {string} tableName - 表名
 * @returns {Array} 关联表名数组
 */
function getRelatedTables(tableName) {
  const related = [];
  for (const rel of schemaData.relationships) {
    if (rel.from.startsWith(tableName)) {
      related.push(rel.to.split('.')[0]);
    } else if (rel.to.startsWith(tableName)) {
      related.push(rel.from.split('.')[0]);
    }
  }
  // 去重并返回
  return [...new Set(related)];
}

// ============================================
// Schema匹配功能
// ============================================

/**
 * 根据game_id推断平台类型
 * @param {string|number} gameId - 游戏ID
 * @returns {string|null} - 平台类型: 'old'|'new'|null
 */
function inferPlatformByGameId(gameId) {
  const oldPlatformGameIds = ['8', '9', '66', '67'];
  if (oldPlatformGameIds.includes(String(gameId))) {
    return 'old';
  }
  return 'new';
}

function extractExplicitTableNames(query = '') {
  if (!query || typeof query !== 'string') {
    return [];
  }

  return schemaData.tables
    .map(table => table.name)
    .filter(tableName => query.includes(tableName));
}

/**
 * 搜索相关表（增强版：支持根据game_id和datasource智能匹配）
 * 根据查询文本和上下文信息，返回可能相关的表
 * 
 * @param {string} query - 查询文本
 * @param {number} topK - 返回结果数量
 * @param {Object} context - 上下文信息（可选）
 * @param {string} context.gameId - 游戏ID
 * @param {string} context.datasource - 数据源标识（如 new_tzpingtaiold）
 * @returns {Promise<Array>} 相关表列表
 */
async function searchRelevantTables(query, topK = 5, context = {}) {
  let enhancedQuery = query;
  const explicitTableNames = extractExplicitTableNames(query);
  
  // 根据上下文增强查询文本
  if (context) {
    const { gameId, datasource } = context;
    
    // 如果有明确的datasource，添加到查询中
    if (datasource) {
      enhancedQuery += ` ${datasource}`;
    }
    
    // 如果有gameId，推断平台类型并增强查询
    if (gameId) {
      const platformType = inferPlatformByGameId(gameId);
      if (platformType === 'old') {
        enhancedQuery += ' 老平台 new_tzpingtaiold';
      } else {
        enhancedQuery += ' 新平台 new_tzpingtai';
      }
    }
  }
  
  // 如果向量存储已初始化，使用语义搜索
  if (vectorStore.isInitialized()) {
    try {
      // 获取查询文本的Embedding
      const queryEmbedding = await llmService.getEmbedding(enhancedQuery);
      
      // 【优化】使用智能搜索（带查询意图识别和重排序）
      const results = await vectorStore.searchSchemaSmart(queryEmbedding, enhancedQuery, topK * 2);
      
      // 提取表名并去重
      let tableNames = [...new Set([
        ...explicitTableNames,
        ...results
          .filter(r => r.metadata.type === 'table')
          .map(r => r.metadata.name)
      ])];
      
      // 如果有datasource上下文，优先匹配对应数据库的表
      if (context?.datasource) {
        const prioritized = [];
        const others = [];
        
        for (const name of tableNames) {
          if (name.startsWith(context.datasource)) {
            prioritized.push(name);
          } else {
            others.push(name);
          }
        }
        
        // 优先返回匹配datasource的表
        tableNames = [...prioritized, ...others];
      }
      
      // 如果有gameId且推断为老平台，优先匹配new_tzpingtaiold的表
      if (context?.gameId && !context?.datasource) {
        const platformType = inferPlatformByGameId(context.gameId);
        const prioritized = [];
        const others = [];
        
        for (const name of tableNames) {
          const isOldPlatformTable = name.startsWith('new_tzpingtaiold');
          const isNewPlatformTable = name.startsWith('new_tzpingtai') && !name.startsWith('new_tzpingtaiold');
          
          if (platformType === 'old' && isOldPlatformTable) {
            prioritized.push(name);
          } else if (platformType === 'new' && isNewPlatformTable) {
            prioritized.push(name);
          } else {
            others.push(name);
          }
        }
        
        tableNames = [...prioritized, ...others];
      }
      
      // 获取完整的表定义并限制数量
      return tableNames.slice(0, topK).map(name => getTable(name)).filter(Boolean);
    } catch (error) {
      logger.error('语义搜索表失败:', error);
      // 语义搜索失败，回退到关键词匹配
    }
  }
  
  // 回退：使用关键词匹配
  return keywordMatchTables(enhancedQuery, explicitTableNames);
}

/**
 * 关键词匹配表
 * 简单的关键词匹配实现
 * 
 * @param {string} query - 查询文本
 * @returns {Array} 匹配的表列表
 */
function keywordMatchTables(query, explicitTableNames = []) {
  // 转换为小写进行不区分大小写的匹配
  const lowerQuery = query.toLowerCase();
  // 提取查询中的关键词（简单分词）
  const keywords = lowerQuery.split(/\s+/);
  
  // 存储匹配结果和分数
  const matches = [];
  
  for (const table of schemaData.tables) {
    let score = 0;
    const searchText = `
      ${table.name} 
      ${table.name_cn || ''} 
      ${table.description || ''}
      ${table.fields.map(f => f.name_cn || f.name).join(' ')}
    `.toLowerCase();
    
    // 计算匹配分数
    for (const keyword of keywords) {
      if (searchText.includes(keyword)) {
        score += 1;
        // 表名完全匹配给予更高分数
        if (table.name.toLowerCase() === keyword || 
            (table.name_cn && table.name_cn.includes(keyword))) {
          score += 2;
        }
      }
    }
    
    // 分数大于0表示有匹配
    if (score > 0) {
      matches.push({ table, score });
    }
  }
  
  // 按分数降序排序并返回表定义
  const orderedTableNames = [
    ...explicitTableNames,
    ...matches
      .sort((a, b) => b.score - a.score)
      .map(m => m.table.name)
  ];

  return [...new Set(orderedTableNames)]
    .slice(0, 5)
    .map(name => getTable(name))
    .filter(Boolean);
}

// ============================================
// SQL验证功能
// ============================================

/**
 * 验证SQL语句的安全性
 * 检查是否包含禁止的操作和未授权的表
 * 
 * @param {string} sql - SQL语句
 * @returns {Object} 验证结果 {valid: boolean, error?: string}
 */
function validateSQL(sql) {
  // 转换为大写进行关键字检查
  const upperSQL = sql.toUpperCase();
  
  // 检查禁止的关键字
  for (const keyword of config.security.forbiddenKeywords) {
    // 使用正则表达式匹配完整单词
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    if (regex.test(sql)) {
      return {
        valid: false,
        error: `SQL包含禁止的操作: ${keyword}`
      };
    }
  }
  
  // 如果配置了白名单，检查表名
  if (config.security.allowedTables.length > 0) {
    // 提取SQL中的表名（简化实现，实际可能需要更复杂的解析）
    const tableMatches = sql.match(/FROM\s+(\w+)|JOIN\s+(\w+)/gi) || [];
    
    for (const match of tableMatches) {
      // 提取表名
      const tableName = match.replace(/FROM\s+|JOIN\s+/i, '').trim();
      // 检查表是否在白名单中
      if (!config.security.allowedTables.includes(tableName)) {
        return {
          valid: false,
          error: `无权访问表: ${tableName}`
        };
      }
    }
  }
  
  // 验证通过
  return { valid: true };
}

/**
 * 获取Schema摘要信息
 * 用于构造LLM Prompt时提供Schema概览
 * 
 * @returns {string} Schema摘要文本
 */
function getSchemaSummary() {
  const lines = [];
  lines.push(`数据库版本: ${schemaData.version}`);
  lines.push(`表数量: ${schemaData.tables.length}`);
  lines.push('');
  
  // 列出所有表
  lines.push('可用表:');
  for (const table of schemaData.tables) {
    const fieldCount = table.fields.length;
    lines.push(`- ${table.name} (${table.name_cn || ''}): ${table.description || ''} (${fieldCount}个字段)`);
  }
  
  return lines.join('\n');
}

/**
 * 获取指定表的详细Schema
 * 用于构造LLM Prompt时提供表结构详情
 * 
 * @param {Array<string>} tableNames - 表名数组
 * @returns {string} 表结构详情文本
 */
function getTableSchemaDetail(tableNames) {
  const lines = [];
  
  for (const tableName of tableNames) {
    const table = getTable(tableName);
    if (!table) continue;
    
    lines.push(`\n表: ${table.name}`);
    if (table.name_cn) {
      lines.push(`中文名: ${table.name_cn}`);
    }
    if (table.description) {
      lines.push(`描述: ${table.description}`);
    }
    
    lines.push('字段:');
    for (const field of table.fields) {
      let fieldDesc = `  - ${field.name} (${field.type})`;
      if (field.name_cn) {
        fieldDesc += ` ${field.name_cn}`;
      }
      if (field.description) {
        fieldDesc += `: ${field.description}`;
      }
      if (field.is_primary) {
        fieldDesc += ' [主键]';
      }
      if (field.foreign_key) {
        fieldDesc += ` [外键->${field.foreign_key}]`;
      }
      lines.push(fieldDesc);
    }
  }
  
  return lines.join('\n');
}

/**
 * 【优化】获取精简版表Schema详细信息
 * 相比 getTableSchemaDetail，此函数：
 * 1. 只输出关键字段（主键、外键、时间字段、与意图相关的字段）
 * 2. 移除冗余的字段描述
 * 3. 使用更紧凑的格式
 * 
 * @param {Array<string>} tableNames - 表名数组
 * @param {Object} intent - 查询意图，用于字段过滤
 * @returns {string} 精简版Schema描述
 */
function getTableSchemaDetailCompact(tableNames, intent = {}) {
  const lines = [];
  
  // 从意图中提取关键词用于字段匹配
  const intentKeywords = extractIntentKeywords(intent);
  
  // 关键字段白名单（始终保留）
  const criticalFields = ['create_time', 'tz_account_id', 'game_id', 'role_id', 'channel_id'];
  
  for (const tableName of tableNames) {
    const table = getTable(tableName);
    if (!table) continue;
    
    // 紧凑的表头格式：表名(中文名) - 描述
    let tableHeader = `表: ${table.name}`;
    if (table.name_cn) {
      tableHeader += ` (${table.name_cn})`;
    }
    lines.push(tableHeader);
    
    // 精简字段列表
    const fieldLines = [];
    for (const field of table.fields) {
      // 判断是否为关键字段
      const isCritical = criticalFields.includes(field.name) || 
                         field.is_primary || 
                         field.foreign_key;
      
      // 判断是否与意图相关
      const isRelevant = intentKeywords.some(kw => 
        field.name.includes(kw) || 
        (field.name_cn && field.name_cn.includes(kw))
      );
      
      // 只保留关键字段或相关字段
      if (!isCritical && !isRelevant) continue;
      
      // 紧凑的字段格式：字段名(类型) 中文名 [标记]
      let fieldDesc = `  ${field.name}(${field.type})`;
      if (field.name_cn) {
        fieldDesc += ` ${field.name_cn}`;
      }
      
      // 添加关键标记
      const tags = [];
      if (field.is_primary) tags.push('主键');
      if (field.foreign_key) tags.push(`外键:${field.foreign_key}`);
      if (field.name === 'create_time') tags.push('分区键');
      
      if (tags.length > 0) {
        fieldDesc += ` [${tags.join(',')}]`;
      }
      
      fieldLines.push(fieldDesc);
    }
    
    if (fieldLines.length > 0) {
      lines.push('字段:');
      lines.push(...fieldLines);
    }
    
    lines.push(''); // 表之间空行
  }
  
  return lines.join('\n');
}

/**
 * 从意图中提取关键词
 * @param {Object} intent - 查询意图
 * @returns {Array<string>} 关键词数组
 */
function extractIntentKeywords(intent) {
  const keywords = [];
  
  if (!intent) return keywords;
  
  // 从原始查询中提取
  if (intent.original_query) {
    // 提取中文业务术语（2-4个字符的词）
    const matches = intent.original_query.match(/[\u4e00-\u9fa5]{2,4}/g);
    if (matches) keywords.push(...matches);
  }
  
  // 从指标中提取
  if (intent.metrics && Array.isArray(intent.metrics)) {
    intent.metrics.forEach(m => {
      if (m.includes('_')) {
        keywords.push(...m.split('_'));
      } else {
        keywords.push(m);
      }
    });
  }
  
  // 从维度中提取
  if (intent.dimensions && Array.isArray(intent.dimensions)) {
    intent.dimensions.forEach(d => keywords.push(d));
  }
  
  return [...new Set(keywords)]; // 去重
}

// ============================================
// 缓存管理
// ============================================

/**
 * 检查缓存是否过期
 * @returns {boolean} 是否过期
 */
function isCacheExpired() {
  // 如果未启用缓存，视为过期
  if (!config.schema.enableCache) {
    return true;
  }
  
  // 计算缓存年龄
  const age = Date.now() - cacheTimestamp;
  // 如果超过过期时间，视为过期
  return age > config.schema.cacheExpireTime;
}

/**
 * 重新加载Schema
 * 清除缓存并重新加载
 */
async function reload() {
  logger.info('重新加载Schema...');
  await load();
}

/**
 * 获取业务关键词到表的映射
 * 从表的描述、中文名和字段信息中构建关键词映射
 * 
 * @returns {Object} 业务关键词映射表 { keyword: [tableNames] }
 */
function getBusinessKeywordMappings() {
  const mappings = {};
  
  // 预定义的业务关键词模式
  const keywordPatterns = [
    // 注册相关
    { keywords: ['注册', '新增用户', '新用户', 'signup', 'register'], tables: [] },
    // 登录相关
    { keywords: ['登录', '登陆', '活跃', '在线', 'dau', 'login', 'active'], tables: [] },
    // 充值/付费相关
    { keywords: ['充值', '付费', '订单', '流水', '收入', '金额', 'payment', 'order', 'revenue'], tables: [] },
    // 角色相关
    { keywords: ['创角', '角色', '创建角色', 'role', 'character'], tables: [] },
    // 聊天相关
    { keywords: ['发言', '聊天', '消息', 'chat', 'message'], tables: [] }
  ];
  
  // 为每个表分析其描述和字段，归类到关键词
  for (const table of schemaData.tables) {
    const searchText = `
      ${table.name} 
      ${table.name_cn || ''} 
      ${table.description || ''}
      ${table.fields.map(f => `${f.name_cn || ''} ${f.description || ''}`).join(' ')}
    `.toLowerCase();
    
    for (const pattern of keywordPatterns) {
      for (const keyword of pattern.keywords) {
        if (searchText.includes(keyword.toLowerCase())) {
          if (!mappings[keyword]) {
            mappings[keyword] = [];
          }
          if (!mappings[keyword].includes(table.name)) {
            mappings[keyword].push(table.name);
          }
          // 同时添加到同义词
          for (const syn of pattern.keywords) {
            if (syn !== keyword) {
              if (!mappings[syn]) {
                mappings[syn] = [];
              }
              if (!mappings[syn].includes(table.name)) {
                mappings[syn].push(table.name);
              }
            }
          }
          break;
        }
      }
    }
  }
  
  logger.debug('[SchemaLoader] 业务关键词映射构建完成', {
    keywordCount: Object.keys(mappings).length
  });
  
  return mappings;
}

// ============================================
// 【Phase 1 新增】分层Schema加载接口
// ============================================

/**
 * 获取Level 1索引（极简版）
 * 仅包含表名+业务注释，用于初步筛选
 * 
 * @returns {Array} Level 1索引数组
 */
function getLevel1Index() {
  return schemaData.tables.map(table => ({
    name: table.name,
    name_cn: table.name_cn || '',
    description: (table.description || '').substring(0, 100),
    field_count: table.fields?.length || 0
  }));
}

/**
 * 获取Level 2详情（按需加载）
 * 根据表名数组获取详细的Schema信息
 * 
 * @param {Array<string>} tableNames - 表名数组
 * @param {Object} options - 选项
 * @param {boolean} options.compact - 是否使用精简版
 * @returns {string} Schema详情文本
 */
function getLevel2Detail(tableNames, options = {}) {
  const { compact = true } = options;
  
  if (!tableNames || tableNames.length === 0) {
    return '';
  }
  
  // 过滤掉不存在的表
  const validTableNames = tableNames.filter(name => schemaData.tableMap.has(name));
  
  if (compact) {
    return getTableSchemaDetailCompact(validTableNames);
  } else {
    return getTableSchemaDetail(validTableNames);
  }
}

/**
 * 构建工具增强型Prompt（Level 1索引）
 * 用于替代原有的全量Schema Prompt
 * 
 * @param {string} userQuery - 用户查询
 * @returns {string} 工具增强型Prompt
 */
function buildToolAugmentedPrompt(userQuery) {
  const level1Index = getLevel1Index();
  
  // 格式化为简洁的表列表
  const tableList = level1Index.map(t => 
    `- ${t.name} (${t.name_cn}): ${t.description}`
  ).join('\n');
  
  return `你是一位数据分析专家，负责将自然语言查询转换为SQL。

## 可用表列表（Level 1索引）
以下是数据库中所有可用的表，仅包含表名和简要描述：

${tableList}

## 工作方式
1. 首先分析用户查询，确定需要哪些表
2. 如果不确定某个表的结构，可以使用工具获取详情
3. 确认所有需要的表后，生成SQL

## 当前查询
"${userQuery}"

请先思考需要哪些表，然后决定是否需要获取表的详细信息。`;
}

/**
 * 检查表是否存在
 * 
 * @param {string} tableName - 表名
 * @returns {boolean} 是否存在
 */
function tableExists(tableName) {
  return schemaData.tableMap.has(tableName);
}

/**
 * 批量获取表定义
 * 
 * @param {Array<string>} tableNames - 表名数组
 * @returns {Array} 表定义数组
 */
function getTables(tableNames) {
  return tableNames
    .map(name => schemaData.tableMap.get(name))
    .filter(Boolean);
}

// ============================================
// 导出模块
// ============================================

module.exports = {
  // 加载和初始化
  load,
  reload,
  // 查询接口
  getAllTables,
  getTable,
  getField,
  getTableFields,
  getAllMetrics,
  getMetric,
  getAllDimensions,
  getRelationship,
  getRelatedTables,
  // 搜索和匹配
  searchRelevantTables,
  keywordMatchTables,
  // 验证
  validateSQL,
  // Schema摘要
  getSchemaSummary,
  getTableSchemaDetail,
  getTableSchemaDetailCompact,  // 【优化】精简版Schema输出
  // 业务关键词映射
  getBusinessKeywordMappings,
  // 缓存检查
  isCacheExpired,
  // 【Phase 1 新增】分层Schema加载
  getLevel1Index,
  getLevel2Detail,
  buildToolAugmentedPrompt,
  tableExists,
  getTables
};
