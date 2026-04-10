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
 * 将Schema信息向量化并存储
 * 用于语义检索匹配相关表和字段
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
  logger.info('开始将Schema向量化...');
  
  try {
    // 准备要向量化的文本数组
    const texts = [];
    const metadata = [];
    
    // 遍历所有表，构造描述文本
    for (const table of schemaData.tables) {
      // 构造表的描述文本
      const tableText = `
表名: ${table.name}
中文名: ${table.name_cn || ''}
描述: ${table.description || ''}
字段: ${table.fields.map(f => f.name_cn || f.name).join(', ')}
      `.trim();
      
      texts.push(tableText);
      metadata.push({
        type: 'table',
        name: table.name,
        name_cn: table.name_cn
      });
      
      // 遍历表的字段，构造字段描述文本
      for (const field of table.fields) {
        const fieldText = `
字段: ${table.name}.${field.name}
中文名: ${field.name_cn || ''}
类型: ${field.type}
描述: ${field.description || ''}
所属表: ${table.name_cn || table.name}
        `.trim();
        
        texts.push(fieldText);
        metadata.push({
          type: 'field',
          table: table.name,
          name: field.name,
          name_cn: field.name_cn
        });
      }
    }
    
    // 分批获取Embedding向量，避免单次请求过大导致超时
    const batchSize = 20; // 每批20个文本，平衡速度和稳定性
    const allEmbeddings = [];
    
    for (let i = 0; i < texts.length; i += batchSize) {
      const batchTexts = texts.slice(i, i + batchSize);
      const batchMetadata = metadata.slice(i, i + batchSize);
      
      logger.debug(`正在处理第 ${i / batchSize + 1} 批 Embedding，共 ${batchTexts.length} 个文本`);
      
      try {
        const batchEmbeddings = await llmService.getEmbedding(batchTexts);
        allEmbeddings.push(...batchEmbeddings);
      } catch (error) {
        logger.error(`第 ${i / batchSize + 1} 批 Embedding 失败:`, error);
        // 继续处理下一批，不中断整个流程
      }
    }
    
    // 存储到向量数据库
    if (allEmbeddings.length > 0) {
      await vectorStore.addSchemaVectors(
        texts.slice(0, allEmbeddings.length), 
        allEmbeddings, 
        metadata.slice(0, allEmbeddings.length)
      );
    }
    
    logger.info('Schema向量化完成', { count: texts.length });
    
  } catch (error) {
    logger.error('Schema向量化失败:', error);
    // 向量化失败不影响主流程，继续运行
  }
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
 * 搜索相关表
 * 根据查询文本，返回可能相关的表
 * 
 * @param {string} query - 查询文本
 * @param {number} topK - 返回结果数量
 * @returns {Promise<Array>} 相关表列表
 */
async function searchRelevantTables(query, topK = 5) {
  // 如果向量存储已初始化，使用语义搜索
  if (vectorStore.isInitialized()) {
    try {
      // 获取查询文本的Embedding
      const queryEmbedding = await llmService.getEmbedding(query);
      // 在向量数据库中搜索
      const results = await vectorStore.searchSchema(queryEmbedding, topK);
      
      // 提取表名并去重
      const tableNames = [...new Set(
        results
          .filter(r => r.metadata.type === 'table')
          .map(r => r.metadata.name)
      )];
      
      // 获取完整的表定义
      return tableNames.map(name => getTable(name)).filter(Boolean);
    } catch (error) {
      logger.error('语义搜索表失败:', error);
      // 语义搜索失败，回退到关键词匹配
    }
  }
  
  // 回退：使用关键词匹配
  return keywordMatchTables(query);
}

/**
 * 关键词匹配表
 * 简单的关键词匹配实现
 * 
 * @param {string} query - 查询文本
 * @returns {Array} 匹配的表列表
 */
function keywordMatchTables(query) {
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
  return matches
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(m => m.table);
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
  // 缓存检查
  isCacheExpired
};
