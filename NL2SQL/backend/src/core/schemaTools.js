/**
 * Schema工具层模块（Phase 1: Tool-Augmented Schema Discovery）
 * 
 * 提供LLM可调用的Schema探索工具，实现"按需索取"而非"一次性灌输"
 * 
 * 核心工具：
 * 1. search_tables(keyword) - 根据关键词搜索相关表
 * 2. describe_table(tableName) - 获取指定表的详细字段信息
 * 3. search_knowledge(concept) - 查询业务概念的定义和映射
 * 4. peek_table(tableName, limit) - 查看表的前N行样例数据
 */

// ============================================
// 导入依赖模块
// ============================================

const schemaLoader = require('./schemaLoader');
const logger = require('../utils/logger');
const config = require('./config');

// ============================================
// Level 1 索引缓存
// ============================================

/**
 * Level 1索引缓存
 * 仅包含表名+业务注释，用于初步筛选
 */
let level1IndexCache = null;
let level1IndexTimestamp = 0;

// ============================================
// 工具定义
// ============================================

/**
 * 工具定义（OpenAI Function Calling格式）
 * 用于告知LLM可用的工具和参数
 */
const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_tables',
      description: '根据关键词搜索相关的数据库表。返回表的名称、中文描述和相关性分数。适用于：1)不知道具体表名时查找表 2)根据业务术语定位表',
      parameters: {
        type: 'object',
        properties: {
          keyword: {
            type: 'string',
            description: '搜索关键词，可以是中文业务术语（如"注册"、"充值"）或表名片段（如"pf_order"）'
          },
          top_k: {
            type: 'integer',
            description: '返回结果数量，默认5个',
            default: 5
          }
        },
        required: ['keyword']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'describe_table',
      description: '获取指定表的详细字段信息，包括字段名、类型、中文描述、是否主键、外键关系等。适用于：1)确定要使用某表后获取完整结构 2)验证字段是否存在',
      parameters: {
        type: 'object',
        properties: {
          table_name: {
            type: 'string',
            description: '表名（英文）'
          },
          compact: {
            type: 'boolean',
            description: '是否返回精简版（仅关键字段），默认true',
            default: true
          }
        },
        required: ['table_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: '查询业务概念的定义和映射关系。例如：查询"老平台"对应的数据库标识、查询"累计充值"应该使用哪个表。适用于：1)理解业务术语 2)获取数据源映射',
      parameters: {
        type: 'object',
        properties: {
          concept: {
            type: 'string',
            description: '业务概念名称，如"老平台"、"累计充值"、"新用户"等'
          }
        },
        required: ['concept']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'peek_table',
      description: '查看数据库表的前N行样例数据（不执行，仅返回结构信息）。适用于：1)验证表是否有数据 2)了解数据格式',
      parameters: {
        type: 'object',
        properties: {
          table_name: {
            type: 'string',
            description: '表名（英文）'
          },
          limit: {
            type: 'integer',
            description: '返回行数，默认3，最大10',
            default: 3
          }
        },
        required: ['table_name']
      }
    }
  }
];

// ============================================
// Level 1 索引管理
// ============================================

/**
 * 生成Level 1索引（极简版）
 * 仅包含表名+业务注释，用于初步筛选
 * 
 * @returns {Array} Level 1索引数组
 */
function generateLevel1Index() {
  const allTables = schemaLoader.getAllTables();
  
  return allTables.map(table => ({
    name: table.name,
    name_cn: table.name_cn || '',
    description: (table.description || '').substring(0, 100), // 限制描述长度
    scope: inferTableScope(table.name),
    data_type: inferTableDataType(table.name)
  }));
}

/**
 * 获取Level 1索引（带缓存）
 * 
 * @param {boolean} forceRefresh - 是否强制刷新
 * @returns {Array} Level 1索引数组
 */
function getLevel1Index(forceRefresh = false) {
  const now = Date.now();
  const cacheExpireTime = config.schema.cacheExpireTime || 3600000; // 默认1小时
  
  // 如果不强制刷新且缓存有效，返回缓存
  if (!forceRefresh && level1IndexCache && (now - level1IndexTimestamp) < cacheExpireTime) {
    return level1IndexCache;
  }
  
  // 生成新索引
  level1IndexCache = generateLevel1Index();
  level1IndexTimestamp = now;
  
  logger.debug('[SchemaTools] Level 1索引已生成', {
    tableCount: level1IndexCache.length,
    cacheTimestamp: level1IndexTimestamp
  });
  
  return level1IndexCache;
}

/**
 * 推断表的域标签（scope）
 * 
 * @param {string} tableName - 表名
 * @returns {string} 域标签
 */
function inferTableScope(tableName) {
  if (tableName.includes('tzpingtai') || tableName.includes('pf_')) {
    return 'platform';
  }
  if (tableName.startsWith('new_tz')) {
    const gameMatch = tableName.match(/new_tz(\w+)/);
    if (gameMatch) {
      return `game_${gameMatch[1]}`;
    }
  }
  if (tableName.includes('report') || tableName.includes('dwd_')) {
    return 'report';
  }
  return 'unknown';
}

/**
 * 推断表的数据类型
 * 
 * @param {string} tableName - 表名
 * @returns {string} 数据类型
 */
function inferTableDataType(tableName) {
  if (tableName.includes('report') || tableName.includes('dwd_') || tableName.includes('analysis')) {
    return 'aggregated_report';
  }
  if (tableName.includes('dim_') || tableName.includes('dict')) {
    return 'dimension_table';
  }
  return 'raw_log';
}

// ============================================
// 工具实现
// ============================================

/**
 * 工具1: search_tables - 根据关键词搜索相关表
 * 
 * @param {Object} args - 工具参数
 * @param {string} args.keyword - 搜索关键词
 * @param {number} args.top_k - 返回结果数量
 * @returns {Promise<Object>} 搜索结果
 */
async function tool_search_tables(args) {
  const { keyword, top_k = 5 } = args;
  
  logger.debug('[SchemaTools] search_tables调用', { keyword, top_k });
  
  try {
    // 使用schemaLoader的searchRelevantTables进行语义搜索
    const tables = await schemaLoader.searchRelevantTables(keyword, top_k);
    
    // 格式化返回结果
    const results = tables.map(table => ({
      name: table.name,
      name_cn: table.name_cn || '',
      description: (table.description || '').substring(0, 100),
      scope: inferTableScope(table.name),
      data_type: inferTableDataType(table.name)
    }));
    
    return {
      success: true,
      count: results.length,
      tables: results
    };
  } catch (error) {
    logger.error('[SchemaTools] search_tables失败:', error);
    return {
      success: false,
      error: error.message,
      tables: []
    };
  }
}

/**
 * 工具2: describe_table - 获取表详情
 * 
 * @param {Object} args - 工具参数
 * @param {string} args.table_name - 表名
 * @param {boolean} args.compact - 是否返回精简版
 * @returns {Promise<Object>} 表详情
 */
async function tool_describe_table(args) {
  const { table_name, compact = true } = args;
  
  logger.debug('[SchemaTools] describe_table调用', { table_name, compact });
  
  try {
    const table = schemaLoader.getTable(table_name);
    
    if (!table) {
      return {
        success: false,
        error: `表 "${table_name}" 不存在`,
        table: null
      };
    }
    
    // 根据compact参数选择输出格式
    let schemaDetail;
    if (compact) {
      schemaDetail = schemaLoader.getTableSchemaDetailCompact([table_name]);
    } else {
      schemaDetail = schemaLoader.getTableSchemaDetail([table_name]);
    }
    
    return {
      success: true,
      table_name: table.name,
      name_cn: table.name_cn || '',
      description: table.description || '',
      field_count: table.fields?.length || 0,
      schema_detail: schemaDetail
    };
  } catch (error) {
    logger.error('[SchemaTools] describe_table失败:', error);
    return {
      success: false,
      error: error.message,
      table: null
    };
  }
}

/**
 * 工具3: search_knowledge - 查询业务知识库
 * 
 * @param {Object} args - 工具参数
 * @param {string} args.concept - 业务概念名称
 * @returns {Promise<Object>} 知识查询结果
 */
async function tool_search_knowledge(args) {
  const { concept } = args;
  
  logger.debug('[SchemaTools] search_knowledge调用', { concept });
  
  try {
    // 预定义的业务知识库（后续可扩展为配置文件）
    const businessKnowledge = getBusinessKnowledge();
    
    // 匹配业务概念
    const result = matchBusinessConcept(concept, businessKnowledge);
    
    return result;
  } catch (error) {
    logger.error('[SchemaTools] search_knowledge失败:', error);
    return {
      success: false,
      error: error.message,
      concept: concept,
      mappings: null
    };
  }
}

/**
 * 工具4: peek_table - 查看表样例数据
 * 注意：此工具返回结构信息而非实际数据（安全考虑）
 * 
 * @param {Object} args - 工具参数
 * @param {string} args.table_name - 表名
 * @param {number} args.limit - 返回行数
 * @returns {Promise<Object>} 表结构预览
 */
async function tool_peek_table(args) {
  const { table_name, limit = 3 } = args;
  
  // 限制最大行数
  const safeLimit = Math.min(limit, 10);
  
  logger.debug('[SchemaTools] peek_table调用', { table_name, limit: safeLimit });
  
  try {
    const table = schemaLoader.getTable(table_name);
    
    if (!table) {
      return {
        success: false,
        error: `表 "${table_name}" 不存在`,
        preview: null
      };
    }
    
    // 返回字段结构预览（安全考虑：不返回实际数据）
    const fields = table.fields?.slice(0, 10).map(field => ({
      name: field.name,
      type: field.type,
      name_cn: field.name_cn || '',
      description: (field.description || '').substring(0, 50),
      is_primary: field.is_primary || false,
      foreign_key: field.foreign_key || null
    })) || [];
    
    return {
      success: true,
      table_name: table.name,
      name_cn: table.name_cn || '',
      field_count: table.fields?.length || 0,
      sample_fields: fields,
      note: '出于安全考虑，仅返回表结构预览，不返回实际数据'
    };
  } catch (error) {
    logger.error('[SchemaTools] peek_table失败:', error);
    return {
      success: false,
      error: error.message,
      preview: null
    };
  }
}

// ============================================
// 业务知识库
// ============================================

/**
 * 获取业务知识库
 * 后续可扩展为从配置文件加载
 * 
 * @returns {Object} 业务知识库
 */
function getBusinessKnowledge() {
  return {
    // 平台相关概念
    '老平台': {
      aliases: ['旧平台', '老版本', '旧版本'],
      description: '指平台标识为 old 的数据，对应 new_tzpingtaiold 数据库',
      mappings: {
        datasource: 'new_tzpingtaiold',
        platform_field: 'platform_type',
        platform_value: ['1', '2', 'old']
      }
    },
    '新平台': {
      aliases: ['tzpingtai', '新系统'],
      description: '指平台标识为 new 的数据',
      mappings: {
        datasource: 'new_tzpingtai',
        platform_field: 'platform_type',
        platform_value: ['0', 'new']
      }
    },
    // 充值相关概念
    '累计充值': {
      aliases: ['累计付费', '总充值', '总付费'],
      description: '玩家累计充值金额',
      mappings: {
        primary_table: 'tzpingtai_tz_sdk_log_pf_order',
        aggregation: 'SUM(real_amount)',
        field: 'real_amount'
      }
    },
    '充值': {
      aliases: ['付费', '订单', '流水'],
      description: '玩家充值付费行为',
      mappings: {
        primary_table: 'tzpingtai_tz_sdk_log_pf_order',
        key_fields: ['tz_account_id', 'game_id', 'real_amount', 'create_time']
      }
    },
    // 注册相关概念
    '注册': {
      aliases: ['新增', '首入', 'signup'],
      description: '用户在平台的注册行为',
      mappings: {
        primary_table: 'tzpingtai_tz_sdk_log_pf_reg',
        key_fields: ['create_time', 'tz_account_id', 'game_id']
      }
    },
    // 登录相关概念
    '登录': {
      aliases: ['活跃', '在线', 'login', 'active'],
      description: '用户登录行为',
      mappings: {
        platform_table: 'tzpingtai_tz_sdk_log_pf_login',
        game_table: 'tzpingtai_tz_sdk_log_game_act'
      }
    },
    // 聊天相关概念
    '聊天': {
      aliases: ['发言', '消息', 'chat'],
      description: '玩家游戏内聊天发言记录',
      mappings: {
        primary_table: 'tzqingmu_log_game_user_chat',
        key_fields: ['role_id', 'content', 'create_time']
      }
    },
    // 角色相关概念
    '创角': {
      aliases: ['创建角色', '新建角色', 'create_role'],
      description: '玩家创建游戏角色',
      mappings: {
        primary_table: 'tzqingmu_role',
        key_fields: ['role_id', 'role_name', 'create_time']
      }
    }
  };
}

/**
 * 匹配业务概念
 * 
 * @param {string} concept - 用户输入的概念
 * @param {Object} knowledge - 业务知识库
 * @returns {Object} 匹配结果
 */
function matchBusinessConcept(concept, knowledge) {
  const conceptLower = concept.toLowerCase();
  
  // 1. 精确匹配
  if (knowledge[concept]) {
    return {
      success: true,
      concept: concept,
      matched: true,
      match_type: 'exact',
      ...knowledge[concept]
    };
  }
  
  // 2. 别名匹配
  for (const [key, value] of Object.entries(knowledge)) {
    if (value.aliases && value.aliases.some(alias => 
      alias.toLowerCase() === conceptLower || 
      conceptLower.includes(alias.toLowerCase())
    )) {
      return {
        success: true,
        concept: concept,
        matched_key: key,
        match_type: 'alias',
        ...value
      };
    }
  }
  
  // 3. 模糊匹配
  for (const [key, value] of Object.entries(knowledge)) {
    if (key.includes(concept) || concept.includes(key)) {
      return {
        success: true,
        concept: concept,
        matched_key: key,
        match_type: 'fuzzy',
        confidence: 0.7,
        ...value
      };
    }
  }
  
  // 4. 未匹配到
  return {
    success: false,
    concept: concept,
    matched: false,
    message: `未找到概念 "${concept}" 的定义，可能需要手动指定表名`,
    suggestion: `尝试使用 search_tables 工具搜索相关表`
  };
}

// ============================================
// 工具调度器
// ============================================

/**
 * 工具调度器映射
 */
const TOOL_EXECUTORS = {
  'search_tables': tool_search_tables,
  'describe_table': tool_describe_table,
  'search_knowledge': tool_search_knowledge,
  'peek_table': tool_peek_table
};

/**
 * 执行工具调用
 * 
 * @param {string} toolName - 工具名称
 * @param {Object} args - 工具参数
 * @returns {Promise<Object>} 执行结果
 */
async function executeTool(toolName, args) {
  const executor = TOOL_EXECUTORS[toolName];
  
  if (!executor) {
    return {
      success: false,
      error: `未知的工具: ${toolName}`,
      available_tools: Object.keys(TOOL_EXECUTORS)
    };
  }
  
  return await executor(args);
}

/**
 * 解析LLM的工具调用请求
 * 
 * @param {Object} llmResponse - LLM响应对象
 * @returns {Array} 工具调用数组
 */
function parseToolCalls(llmResponse) {
  const toolCalls = [];
  
  // OpenAI格式：response.choices[0].message.tool_calls
  const message = llmResponse.choices?.[0]?.message;
  
  if (message?.tool_calls) {
    for (const toolCall of message.tool_calls) {
      toolCalls.push({
        id: toolCall.id,
        name: toolCall.function?.name,
        args: JSON.parse(toolCall.function?.arguments || '{}')
      });
    }
  }
  
  return toolCalls;
}

// ============================================
// 导出模块
// ============================================

module.exports = {
  // 工具定义
  TOOL_DEFINITIONS,
  
  // Level 1索引
  getLevel1Index,
  generateLevel1Index,
  
  // 工具执行
  executeTool,
  parseToolCalls,
  
  // 单独的工具函数
  tool_search_tables,
  tool_describe_table,
  tool_search_knowledge,
  tool_peek_table,
  
  // 辅助函数
  getBusinessKnowledge,
  matchBusinessConcept,
  inferTableScope,
  inferTableDataType
};
