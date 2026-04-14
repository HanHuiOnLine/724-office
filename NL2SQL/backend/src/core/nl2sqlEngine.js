/**
 * NL2SQL核心引擎模块
 * 
 * 实现自然语言到SQL的转换核心逻辑，包括：
 * 1. 意图识别 - 理解用户查询意图
 * 2. 澄清机制 - 信息不足时主动询问
 * 3. SQL生成 - 生成标准SQL语句
 * 4. SQL验证 - 安全性和语法检查
 * 5. 结果格式化 - 将结果转为自然语言
 */

// ============================================
// 导入依赖模块
// ============================================

// 导入配置模块
const config = require('./config');
// 导入日志模块
const logger = require('../utils/logger');
// 导入LLM服务模块
const llmService = require('./llmService');
// 导入Schema加载模块
const schemaLoader = require('./schemaLoader');
// 导入数据库模块
const database = require('./database');

// ============================================
// 实体解析
// ============================================

/**
 * 实体检索 - 尝试将模糊描述（如游戏名称）映射到具体ID
 * 
 * @param {string} entityName - 实体名称（如"青木"）
 * @param {string} entityType - 实体类型（如"game", "channel"）
 * @returns {Promise<Object>} {found: boolean, id?: string, name?: string}
 */
async function resolveEntity(entityName, entityType) {
  logger.info('尝试解析实体', { entityName, entityType });
  
  // 获取数据库连接
  const db = database.getConnection ? database.getConnection() : null;
  
  if (!db) {
    logger.warn('数据库连接不可用，使用模拟数据');
    // 模拟实体映射表，实际应从数据库查询
    const mockEntities = {
      '青木': { id: '30', name: '青木', type: 'game' },
      '王者荣耀': { id: '1', name: '王者荣耀', type: 'game' },
      '和平精英': { id: '2', name: '和平精英', type: 'game' }
    };
    
    const entity = mockEntities[entityName];
    if (entity && entity.type === entityType) {
      return {
        found: true,
        id: entity.id,
        name: entity.name,
        confidence: 0.9
      };
    }
    return { found: false };
  }
  
  try {
    // 根据实体类型查询不同的表
    let sql;
    if (entityType === 'game') {
      sql = `SELECT game_id as id, game_name as name FROM game_list WHERE game_name LIKE ? LIMIT 5`;
    } else if (entityType === 'channel') {
      sql = `SELECT channel_id as id, channel_name as name FROM channel_list WHERE channel_name LIKE ? LIMIT 5`;
    } else {
      return { found: false };
    }
    
    const results = await db.query(sql, [`%${entityName}%`]);
    
    if (results && results.length > 0) {
      // 如果精确匹配，返回第一个
      const exactMatch = results.find(r => r.name === entityName);
      if (exactMatch) {
        return {
          found: true,
          id: exactMatch.id,
          name: exactMatch.name,
          confidence: 1.0
        };
      }
      // 否则返回最相似的
      return {
        found: true,
        id: results[0].id,
        name: results[0].name,
        confidence: 0.7,
        alternatives: results.slice(1).map(r => ({ id: r.id, name: r.name }))
      };
    }
    
    return { found: false };
  } catch (error) {
    logger.error('实体解析失败:', error);
    return { found: false, error: error.message };
  }
}

// ============================================
// 实体解析辅助函数
// ============================================

/**
 * 从上下文中学习实体别名
 * 当用户在澄清中提供映射关系时（如"青木是游戏名称"），自动学习
 * @param {string} userId - 用户ID
 * @param {string} userQuery - 用户当前查询
 * @param {Object} intent - 当前意图
 * @param {Object} lastAssistantMsg - 上一条助手消息
 */
async function learnEntityAliasFromContext(userId, userQuery, intent, lastAssistantMsg) {
  try {
    // 检查是否有新的 filters 被识别（来自用户澄清）
    if (!intent.filters || intent.filters.length === 0) {
      return;
    }
    
    const longTermMemory = require('../memory/longTermMemory');
    
    for (const filter of intent.filters) {
      // 如果 filter 中有 original_name，说明是从用户输入解析的
      if (filter.original_name && filter.field && filter.value) {
        // 判断字段类型
        let fieldType = 'filter';
        if (filter.field === 'game_id') fieldType = 'game';
        else if (filter.field === 'channel_id') fieldType = 'channel';
        
        logger.info('[别名学习] 检测到实体映射，准备学习', {
          userId,
          userTerm: filter.original_name,
          schemaField: `${filter.field}=${filter.value}`,
          fieldType
        });
        
        // 对于 game_id 和 channel_id，直接存：游戏名 -> ID值
        // 这样更简洁，查询时直接取这个值作为 game_id
        if (filter.field === 'game_id' || filter.field === 'channel_id') {
          const result = await longTermMemory.learnFieldAlias(
            userId,
            filter.original_name,  // 用户的说法（如"青木"）
            filter.value,          // 直接存ID值（如"30"）
            fieldType
          );
          
          if (result) {
            logger.info('[别名学习] ✅ 实体映射学习成功（直接映射）', {
              userId,
              userTerm: filter.original_name,
              targetValue: filter.value,
              field: filter.field
            });
          }
        } else {
          // 其他字段类型，保持原来的逻辑
          const result = await longTermMemory.learnFieldAlias(
            userId,
            filter.original_name,
            filter.field,
            fieldType
          );
          
          if (result) {
            logger.info('[别名学习] ✅ 字段别名学习成功', {
              userId,
              userTerm: filter.original_name,
              schemaField: filter.field
            });
          }
        }
      }
    }
  } catch (error) {
    logger.error('[别名学习] 学习实体别名失败:', error);
  }
}

/**
 * 从意图中解析实体（游戏名、渠道名等）
 * 优先使用长期记忆中学习的别名，同时依赖LLM已识别的filters
 * @param {Object} intent - 意图对象（LLM已处理过）
 * @param {string} userQuery - 用户原始查询
 * @param {string} userId - 用户ID
 */
async function resolveEntitiesInIntent(intent, userQuery, userId) {
  try {
    // 注意：现在主要依赖LLM在意图识别阶段从上下文中理解映射
    // 这个函数只处理LLM没有识别到但需要补充的情况
    
    const longTermMemory = require('../memory/longTermMemory');
    
    // 1. 检查intent中是否已经有game_id filter（LLM已识别）
    const hasGameIdFilter = intent.filters?.some(f => f.field === 'game_id');
    
    if (hasGameIdFilter) {
      logger.debug('[实体解析] LLM已识别game_id，跳过实体解析');
      return;
    }
    
    // 2. 从长期记忆加载用户学习的字段别名
    if (userId) {
      try {
        const userPrefs = await longTermMemory.getUserPreferences(userId);
        const fieldAliases = userPrefs.filter(p => p.preference_type === 'field_alias');
        
        // 查找是否有游戏名称的映射
        for (const alias of fieldAliases) {
          const content = typeof alias.content === 'string' ? JSON.parse(alias.content) : alias.content;
          
          // 检查用户查询中是否包含这个别名
          if (content.user_term && userQuery.includes(content.user_term)) {
            // 支持两种存储格式：
            // 1. 双记录格式：青木 -> game_id, 青木_value -> 30
            // 2. 直接映射格式：青木 -> 30
            
            let gameId = null;
            
            // 尝试格式1：查找对应的值映射（如 青木_value -> 30）
            if (content.schema_field === 'game_id' || content.field_type === 'game') {
              const valueAlias = fieldAliases.find(a => {
                const vc = typeof a.content === 'string' ? JSON.parse(a.content) : a.content;
                return vc.user_term === `${content.user_term}_value`;
              });
              
              if (valueAlias) {
                const vc = typeof valueAlias.content === 'string' ? JSON.parse(valueAlias.content) : valueAlias.content;
                gameId = vc.schema_field;
              }
            }
            
            // 尝试格式2：直接映射（schema_field 是纯数字）
            if (!gameId && !isNaN(Number(content.schema_field))) {
              gameId = content.schema_field;
            }
            
            if (gameId) {
              logger.info(`[实体解析] ✅ 使用长期记忆映射: ${content.user_term} -> game_id=${gameId}`);
              
              if (!intent.filters) {
                intent.filters = [];
              }
              
              intent.filters.push({
                field: 'game_id',
                op: '=',
                value: gameId,
                original_name: content.user_term
              });
              
              return; // 找到一个就返回
            }
          }
        }
      } catch (e) {
        logger.debug('[实体解析] 加载用户别名失败:', e.message);
      }
    }
    
    // 3. 回退：尝试从硬编码列表解析（兜底）
    const knownGames = ['青木', '王者荣耀', '和平精英', '无限', '幻灵', '悟道', '星火', '曙光', '华夏'];
    
    for (const gameName of knownGames) {
      if (userQuery.includes(gameName)) {
        logger.info(`[实体解析] 从硬编码列表发现游戏: ${gameName}`);
        
        const entityResult = await resolveEntity(gameName, 'game');
        
        if (entityResult.found) {
          logger.info(`[实体解析] ✅ 成功解析: ${gameName} -> game_id=${entityResult.id}`);
          
          if (!intent.filters) {
            intent.filters = [];
          }
          
          intent.filters.push({
            field: 'game_id',
            op: '=',
            value: entityResult.id,
            original_name: gameName
          });
        }
        
        break;
      }
    }
    
  } catch (error) {
    logger.error('[实体解析] 解析失败:', error);
  }
}

/**
 * 平台术语解析 - 从查询中识别"新平台"/"老平台"并映射到数据库标识
 * 
 * @param {Object} intent - 当前意图对象
 * @param {string} userQuery - 用户查询
 * @param {string} userId - 用户ID
 */
async function resolvePlatformInIntent(intent, userQuery, userId) {
  try {
    const queryLower = userQuery.toLowerCase();
    
    // 1. 从长期记忆加载用户学习的datasource映射
    if (userId) {
      try {
        const longTermMemory = require('../memory/longTermMemory');
        const userPrefs = await longTermMemory.getUserPreferences(userId);
        const fieldAliases = userPrefs.filter(p => p.preference_type === 'field_alias');
        
        // 查找datasource类型的映射
        for (const alias of fieldAliases) {
          const content = typeof alias.content === 'string' ? JSON.parse(alias.content) : alias.content;
          
          if (content.field_type === 'datasource' && content.user_term && content.schema_field) {
            // 检查用户查询中是否包含这个术语
            if (queryLower.includes(content.user_term.toLowerCase())) {
              logger.info(`[平台解析] ✅ 使用长期记忆映射: ${content.user_term} -> datasource=${content.schema_field}`);
              
              if (!intent.filters) {
                intent.filters = [];
              }
              
              // 检查是否已存在datasource filter
              const existingFilter = intent.filters.find(f => f.field === 'datasource');
              if (!existingFilter) {
                intent.filters.push({
                  field: 'datasource',
                  op: '=',
                  value: content.schema_field,
                  original_name: content.user_term
                });
              }
              return;
            }
          }
        }
      } catch (e) {
        logger.debug('[平台解析] 加载用户datasource映射失败:', e.message);
      }
    }
    
    // 2. 硬编码兜底：识别常见平台术语
    const platformMappings = [
      { term: '老平台', datasource: 'new_tzpingtaiold' },
      { term: '新平台', datasource: 'new_tzpingtai' }
    ];
    
    for (const mapping of platformMappings) {
      if (queryLower.includes(mapping.term)) {
        logger.info(`[平台解析] ✅ 使用硬编码映射: ${mapping.term} -> datasource=${mapping.datasource}`);
        
        if (!intent.filters) {
          intent.filters = [];
        }
        
        // 检查是否已存在datasource filter
        const existingFilter = intent.filters.find(f => f.field === 'datasource');
        if (!existingFilter) {
          intent.filters.push({
            field: 'datasource',
            op: '=',
            value: mapping.datasource,
            original_name: mapping.term
          });
        }
        return;
      }
    }
    
  } catch (error) {
    logger.error('[平台解析] 解析失败:', error);
  }
}

function getDialogueSummary(history = [], limit = 6) {
  if (!Array.isArray(history) || history.length === 0) {
    return '';
  }

  return history
    .slice(-limit)
    .map(item => {
      const roleLabel = item.role === 'user' ? '用户' : '助手';
      const typeLabel = item.type ? `(${item.type})` : '';
      return `${roleLabel}${typeLabel}: ${item.content}`;
    })
    .join('\n');
}

function isAffirmativeClarificationReply(text = '') {
  const normalized = String(text).replace(/\s+/g, '').trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  const exactMatches = new Set([
    '是', '是的', '对', '对的', '好的', '好', 'ok', 'okay',
    '确认', '确认了', '都确认', '都确认了', '按默认', '就按默认',
    '默认', '默认即可', '默认就行', '都按默认', '都可以', '都行', '没问题'
  ]);

  if (exactMatches.has(normalized)) {
    return true;
  }

  return /^(是啊?|对啊?|好的?|确认了?|都确认了?|按默认(即可|就行)?|默认(即可|就行)?|都按默认)$/.test(normalized);
}

function extractDefaultOptionsFromClarification(text = '') {
  if (!text) {
    return [];
  }

  const defaults = new Set();
  const defaultPattern = /([^\n：:，。,；;]+?)（默认）/g;
  let match;

  while ((match = defaultPattern.exec(text)) !== null) {
    const option = match[1]
      .replace(/^选项[:：]\s*/, '')
      .replace(/[，。；;:：]\s*$/, '')
      .trim();

    if (option) {
      defaults.add(option);
    }
  }

  return [...defaults];
}

function enrichIntentWithClarificationContext(intent, userQuery, history = []) {
  const lastAssistantMsg = [...history].reverse().find(item => item.role === 'assistant');

  if (!lastAssistantMsg || lastAssistantMsg.type !== 'clarify') {
    return intent;
  }

  const isAffirmative = isAffirmativeClarificationReply(userQuery);
  const confirmedDefaults = isAffirmative
    ? extractDefaultOptionsFromClarification(lastAssistantMsg.content)
    : [];
  const contextLines = [
    `上一轮澄清问题: ${lastAssistantMsg.content}`,
    isAffirmative
      ? '用户已明确确认沿用上一轮澄清问题中的默认选项或推荐选项。'
      : `用户针对上一轮澄清的补充回答: ${userQuery}`
  ];

  if (confirmedDefaults.length > 0) {
    contextLines.push(`本轮按默认确认的选项: ${confirmedDefaults.join('；')}`);
  }

  const extraContext = contextLines.join('\n');

  if (!intent.supplement_info) {
    intent.supplement_info = extraContext;
  } else if (!intent.supplement_info.includes(extraContext)) {
    intent.supplement_info += `\n${extraContext}`;
  }

  intent.clarification_context = {
    question: lastAssistantMsg.content,
    reply: userQuery,
    answerType: isAffirmative ? 'confirm_default' : 'supplement',
    confirmedDefaults,
    confirmedSlots: isAffirmative ? (lastAssistantMsg.metadata?.missingSlots || []) : []
  };

  return intent;
}

// ============================================
// 意图识别
// ============================================

/**
 * 分析用户查询意图（增强版：支持上下文理解和长期记忆）
 * 提取时间范围、维度、指标、筛选条件等
 * 
 * @param {string} userQuery - 用户的自然语言查询
 * @param {Array} history - 最近3-5轮对话历史（用于上下文理解）
 * @param {string} userId - 用户ID（用于读取长期记忆）
 * @returns {Promise<Object>} 意图分析结果
 */
async function analyzeIntent(userQuery, history = [], userId = null) {
  // 记录开始分析日志
  logger.debug('开始分析用户意图', { query: userQuery, historyLength: history.length, userId });
  
  // 获取Schema摘要，帮助LLM理解数据结构
  const schemaSummary = schemaLoader.getSchemaSummary();
  
  // 构建对话上下文摘要
  let contextSummary = '';
  if (history.length > 0) {
    const recentHistory = history.slice(-5);
    contextSummary = `
对话上下文（最近${recentHistory.length}轮）:
${recentHistory.map((h, i) => `${h.role === 'user' ? '用户' : '助手'}: ${h.content}`).join('\n')}

重要：请结合上下文理解用户的当前查询。如果当前查询是对之前问题的补充或修正，请整合信息给出完整的意图。`;
  }
  
  // 获取用户长期记忆偏好
  let userPreferencesSummary = '';
  let similarQueriesSummary = '';
  
  if (userId) {
    try {
      const longTermMemory = require('../memory/longTermMemory');
      const userPreferences = await longTermMemory.getUserPreferencesForIntent(userId);
      
      if (userPreferences && (
        userPreferences.patterns.length > 0 ||
        userPreferences.aliases.length > 0 ||
        userPreferences.metrics.length > 0
      )) {
        userPreferencesSummary = `
## 该用户的历史偏好（用于理解用户习惯）

常用查询模式:
${userPreferences.patterns.slice(0, 3).map(p => 
  `- ${p.name}: ${p.dimensions?.slice(0, 3).join('+')}维度, ${p.metrics?.slice(0, 3).join('+')}指标`
).join('\n')}

字段别名映射（用户说法 → 实际值）:
${userPreferences.aliases.slice(0, 5).map(a => {
  // 游戏类型映射（双记录格式：青木 -> game_id, 青木_value -> 30）
  if (a.field_type === 'game') {
    // 查找对应的值映射（青木_value -> 30）
    const valueAlias = userPreferences.aliases.find(va => 
      va.user_term === `${a.user_term}_value` && !isNaN(Number(va.schema_field))
    );
    if (valueAlias) {
      return `- "${a.user_term}" 对应 game_id = ${valueAlias.schema_field}`;
    }
    return `- "${a.user_term}" 对应 game_id（值未知）`;
  }
  // 跳过值映射记录（已在上面处理）
  if (a.field_type === 'game_value') {
    return null;
  }
  // 数字型映射（直接存储ID值，如 华夏 -> 88）
  const isGameMapping = !isNaN(Number(a.schema_field));
  if (isGameMapping) {
    return `- "${a.user_term}" 对应 game_id = ${a.schema_field}`;
  }
  // 数据源类型映射（如新平台 → new_tzpingtai）
  if (a.field_type === 'datasource') {
    return `- "${a.user_term}" 对应数据库标识: ${a.schema_field}`;
  }
  return `- "${a.user_term}" → ${a.schema_field}`;
}).filter(Boolean).join('\n')}

重要：
1. 当用户提到上述游戏名称时，必须在 filters 中使用对应的 game_id，不要虚构其他字段如 database_identifier。
2. 当用户提到"新平台"或"老平台"时，直接使用对应的数据库标识（new_tzpingtai/new_tzpingtaiold），不要追问平台标识。
3. **强制规则**：如果"字段别名映射"中已包含某游戏名称对应的game_id，直接在filters中使用该game_id，置信度设为0.95，不要询问用户确认。

常用指标: ${userPreferences.metrics.slice(0, 5).join(', ')}
常用维度: ${userPreferences.dimensions.slice(0, 5).join(', ')}
`;
      }
      
      logger.info('[NL2SQL] ✅ 长期记忆已加载到意图识别', { 
        userId, 
        patternCount: userPreferences.patterns.length,
        aliasCount: userPreferences.aliases.length,
        metricCount: userPreferences.metrics.length,
        dimensionCount: userPreferences.dimensions.length
      });
    } catch (err) {
      logger.error('[NL2SQL] ❌ 加载用户长期记忆失败:', err);
    }
    
    // 检索相似历史查询（向量检索）
    if (config.embedding && config.embedding.enabled) {
      try {
        const vectorStore = require('../memory/vectorStore');
        const queryVector = await llmService.getEmbedding(userQuery);
        const similarQueries = await vectorStore.searchSimilarQueries(queryVector, 5);
        
        // 过滤当前用户的查询
        const userSimilarQueries = similarQueries.filter(q => 
          q.metadata?.user_id === userId
        );
        
        if (userSimilarQueries.length > 0) {
          similarQueriesSummary = `
## 相似历史查询参考
${userSimilarQueries.map((q, i) => 
  `${i+1}. "${q.text}" → 指标: ${q.metadata?.intent?.metrics?.join(', ') || '未知'}`
).join('\n')}
`;
        }
        
        logger.info('[NL2SQL] ✅ 相似历史查询检索完成', { 
          userId, 
          found: similarQueries.length,
          userQueries: userSimilarQueries.length,
          queries: userSimilarQueries.map(q => q.text.substring(0, 30))
        });
      } catch (err) {
        logger.error('[NL2SQL] ❌ 检索相似查询失败:', err);
      }
    }
  }
  
  // 构造系统提示词
  const systemPrompt = `你是一位有记忆的数据分析助手，负责理解用户的数据查询需求。

你的任务是维护一个**持久化的查询状态**，结合【对话历史】和【当前输入】，判断用户在：
- **补充信息**：完善之前的查询（如提供ID、修改时间范围）
- **更换需求**：放弃之前的查询，开始新查询（如"算了，查XX"）
- **全新查询**：与之前无关的独立查询

数据库Schema概览:
${schemaSummary}
${contextSummary}
${userPreferencesSummary}
${similarQueriesSummary}

请根据上述信息，更新查询状态并提取以下信息以JSON格式返回:
{
  "thought": "你的推理过程：1)用户想要什么数据 2)结合上下文理解了什么 3)如何解读当前查询",
  "time_range": {
    "type": "relative|absolute",
    "value": "最近7天|2024-01-01至2024-01-31"
  },
  "dimensions": ["维度1", "维度2"],
  "metrics": ["指标1", "指标2"],
  "filters": [{"field": "字段", "op": "=", "value": "值"}],
  "sort": {"by": "字段", "order": "desc"},
  "limit": 100,
  "confidence": 0.9,
  "isContextualQuery": false
}

重要规则:
1. **深度融合上下文**：如果用户说"那上个月呢？"、"加上游戏ID过滤"等，结合历史对话理解完整意图
2. **智能修正**：如果用户说"算了，查XX"、"不要流水了"，理解为用户想更换指标，不要保留旧指标
3. **isContextualQuery**: 如果当前查询依赖上下文才能理解（如"那上个月呢？"），设为true
4. **metrics字段**: 基于当前查询+上下文提到的具体指标识别
5. **利用历史偏好**：如果用户有历史偏好，优先使用其习惯的维度和指标组合
6. **直接使用已学习的映射**：如果"字段别名映射"中已包含游戏名称对应的game_id，直接在filters中使用，confidence设为0.95，不要生成澄清问题

## 字段别名参考（用户说法 → Schema字段映射）

**收入类指标：**
- 流水/收入/充值/销售额/营收/金额 → 指标：收入金额
- 订单数/订单量/成交量/付费笔数 → 指标：付费订单数

**用户类指标：**
- 用户数/注册用户数/新增用户 → 指标：注册用户数
- 活跃用户/DAU/日活/玩家数 → 指标：日活跃用户数
- 在线人数/同时在线/PCU → 指标：最高同时在线

**比率类指标：**
- 付费率/付费占比/充值率 → 指标：付费率
- 留存率/次日留存/7日留存 → 指标：留存率
- 转化率/转化占比 → 指标：转化率

**筛选字段：**
- 游戏/产品/应用 → 字段：game_id
- 渠道/平台/来源 → 字段：channel_id
- 区服/服务器 → 字段：server_id
- 日期/时间/天 → 字段：create_time 或 date

**重要：理解用户补充的业务知识**
- 用户可能在对话中补充业务术语映射（如"青木是游戏名称，对应game_id=30"）
- 用户可能说明特殊术语含义（如"新平台对应数据库new_tzpingtai"）
- 请从对话上下文中提取这些映射关系，并在后续查询中正确使用
- 如果用户提到"游戏ID 游戏名称"列表，请理解这是一个映射表，后续查询中遇到游戏名称时对应到正确的game_id

6. time_range: 识别时间范围，支持相对时间和绝对时间
7. dimensions: 识别分组维度（按什么维度查看，如按日期、按渠道）
8. filters: 识别筛选条件，如果用户提供了更精确的标识符（如ID），优先使用并自动关联之前的模糊描述
   - 特别重要：如果对话历史中有"游戏ID 游戏名称"的映射列表，遇到游戏名称时查找对应的game_id
9. confidence: 置信度（0-1），信息越完整置信度越高

只返回JSON，不要其他解释。`;

  // 构造用户提示词
  const userPrompt = userQuery;
  
  try {
    // 调用LLM进行意图识别
    const response = await llmService.simpleChat(userPrompt, systemPrompt);
    
    // 解析JSON响应
    const intent = parseJSONResponse(response);
    
    // 添加原始查询
    intent.original_query = userQuery;
    
    // 后处理：确保常见指标被正确识别
    const queryLower = userQuery.toLowerCase();
    const commonMetrics = {
      '流水': '收入金额',
      '收入': '收入金额',
      '金额': '收入金额',
      '销售额': '收入金额',
      '营收': '收入金额',
      '订单数': '付费订单数',
      '订单量': '付费订单数',
      '成交量': '付费订单数',
      '用户数': '注册用户数',
      '注册用户': '注册用户数',
      '活跃用户': '日活跃用户数',
      'dau': '日活跃用户数',
      '付费率': '付费率',
      '留存率': '留存率',
      '转化率': '转化率'
    };
    
    // 如果 metrics 为空或未识别，尝试从查询中提取
    if (!intent.metrics || intent.metrics.length === 0) {
      for (const [keyword, metric] of Object.entries(commonMetrics)) {
        if (queryLower.includes(keyword)) {
          intent.metrics = [metric];
          logger.info(`从查询中提取到指标: ${metric}`);
          break;
        }
      }
    }
    
    // 如果 time_range 为空，尝试识别常见时间表达
    if (!intent.time_range || !intent.time_range.value) {
      const timePatterns = [
        { pattern: /上个月|上月|最近一个月/, value: '最近1个月', type: 'relative' },
        { pattern: /最近7天|近7天|最近一周/, value: '最近7天', type: 'relative' },
        { pattern: /最近30天|近30天/, value: '最近30天', type: 'relative' },
        { pattern: /昨天|昨日/, value: '昨天', type: 'relative' },
        { pattern: /今天|今日/, value: '今天', type: 'relative' }
      ];
      
      for (const { pattern, value, type } of timePatterns) {
        if (pattern.test(queryLower)) {
          intent.time_range = { type, value };
          logger.info(`从查询中提取到时间范围: ${value}`);
          break;
        }
      }
    }
    
    // 实体解析：尝试从查询中提取游戏/渠道名称并解析为ID
    await resolveEntitiesInIntent(intent, userQuery, userId);
    
    // 平台术语识别：从查询或长期记忆中识别"新平台"/"老平台"
    await resolvePlatformInIntent(intent, userQuery, userId);
    
    logger.info('意图分析完成', { 
      query: userQuery,
      metrics: intent.metrics,
      timeRange: intent.time_range,
      confidence: intent.confidence 
    });
    return intent;
    
  } catch (error) {
    logger.error('意图分析失败:', error);
    // 返回默认意图
    return {
      original_query: userQuery,
      confidence: 0.3,
      error: error.message
    };
  }
}

/**
 * 合并历史意图和当前意图
 * 当用户回复是对之前澄清的补充时，将信息合并
 * 
 * @param {Object} historicalIntent - 历史意图（原始查询）
 * @param {Object} currentIntent - 当前意图（补充回答）
 * @param {string} supplementQuery - 补充回答文本
 * @returns {Promise<Object>} 合并后的意图
 */
async function mergeIntent(historicalIntent, currentIntent, supplementQuery) {
  logger.info('合并意图', { 
    historicalQuery: historicalIntent.original_query,
    historicalMetrics: historicalIntent.metrics,
    supplementQuery,
    currentMetrics: currentIntent.metrics 
  });
  
  // 以历史意图为基础
  const mergedIntent = { ...historicalIntent };
  
  // 关键：确保保留历史意图中的 metrics（如"流水"）
  // 补充回答通常只包含条件信息（如 game_id=30），不包含指标信息
  if (!mergedIntent.metrics || mergedIntent.metrics.length === 0) {
    logger.warn('历史意图缺少 metrics，尝试从补充回答推断');
    // 如果补充回答中有 metrics，使用补充回答的
    if (currentIntent.metrics && currentIntent.metrics.length > 0) {
      mergedIntent.metrics = currentIntent.metrics;
    }
  }
  
  // 如果当前意图识别出了新的 filters，进行补充
  if (currentIntent.filters && currentIntent.filters.length > 0) {
    mergedIntent.filters = [...(mergedIntent.filters || []), ...currentIntent.filters];
  }
  
  // 如果当前意图识别出了 time_range，但历史没有，则补充
  if (currentIntent.time_range && !mergedIntent.time_range) {
    mergedIntent.time_range = currentIntent.time_range;
  }
  
  // 添加补充信息到原始查询中，便于后续处理
  mergedIntent.supplement_info = supplementQuery;
  mergedIntent.confidence = 0.9; // 合并后提升置信度
  
  logger.info('意图合并完成', { 
    mergedMetrics: mergedIntent.metrics,
    mergedTimeRange: mergedIntent.time_range,
    mergedFilters: mergedIntent.filters
  });
  return mergedIntent;
}

/**
 * 使用LLM智能更新意图
 * 将"状态管理"交给LLM，而非硬代码合并
 * 
 * @param {Object} previousIntent - 上一次的意图JSON
 * @param {string} newQuery - 用户最新的话
 * @param {Array} history - 对话历史
 * @returns {Promise<Object>} 更新后的意图
 */
async function updateIntentWithLLM(previousIntent, newQuery, history) {
  logger.info('使用LLM更新意图', { 
    previousQuery: previousIntent.original_query,
    newQuery 
  });

  const schemaSummary = schemaLoader.getSchemaSummary();
  const dialogueSummary = getDialogueSummary(history, 6);

  const systemPrompt = `你是一位意图理解专家。你的任务是根据用户的新输入，更新当前的查询意图。

当前意图状态:
${JSON.stringify(previousIntent, null, 2)}

用户最新输入: "${newQuery}"

最近对话历史（重点参考，尤其是上一轮澄清问题与默认选项）:
${dialogueSummary || '无'}

数据库Schema概览:
${schemaSummary}

请分析：
1. 用户是在补充信息（如提供game_id），还是在修改需求（如换指标）？
2. 如果是补充：将新信息合并到当前意图
3. 如果是修改：用新需求替换相关字段
4. 如果是完全新的查询：创建新意图
5. 如果用户最新输入只是“是 / 对 / 都确认 / 按默认”等简短肯定答复，且上一轮助手在澄清问题中提供了默认或推荐选项，则视为用户确认采用这些默认/推荐选项，不要再次追问同一问题
6. 如果上一轮助手已经给出了具体候选表、字段、口径或默认值，必须结合上一轮澄清内容理解当前回复，不能把“是”“都确认”当成无意义的新查询

返回更新后的完整意图JSON:
{
  "thought": "推理过程：用户想做什么？是补充还是修改？",
  "time_range": {...},
  "dimensions": [...],
  "metrics": [...],
  "filters": [...],
  "sort": {...},
  "limit": 100,
  "confidence": 0.9,
  "updateType": "merge|replace|new"
}

updateType说明:
- merge: 用户补充信息（如"game_id=30"）
- replace: 用户修改部分需求（如"算了，查活跃人数"）
- new: 完全新的查询，与之前无关

只返回JSON，不要其他解释。`;

  try {
    const response = await llmService.simpleChat('', systemPrompt);
    const updatedIntent = parseJSONResponse(response);
    
    // 保留原始查询信息
    updatedIntent.original_query = newQuery;
    updatedIntent.previous_query = previousIntent.original_query;
    
    logger.info('意图更新完成', { 
      updateType: updatedIntent.updateType,
      metrics: updatedIntent.metrics,
      confidence: updatedIntent.confidence 
    });
    
    return updatedIntent;
  } catch (error) {
    logger.error('LLM意图更新失败，回退到手动合并:', error);
    // 回退到原来的合并逻辑
    return mergeIntent(previousIntent, { original_query: newQuery, confidence: 0.5 }, newQuery);
  }
}

/**
 * 检查意图是否完整
 * 判断是否需要向用户澄清
 * 
 * @param {Object} intent - 意图分析结果
 * @returns {Object} {complete: boolean, missing: Array}
 */
function checkIntentComplete(intent, history = []) {
  // 定义必要字段
  const requiredFields = ['time_range', 'metrics'];
  // 存储缺失的字段
  const missing = [];
  // 【P2】待确认项检查
  const pendingConfirmations = [];
  
  // 检查每个必要字段
  for (const field of requiredFields) {
    if (!intent[field] || 
        (Array.isArray(intent[field]) && intent[field].length === 0)) {
      missing.push(field);
    }
  }
  
  // 检查置信度
  if (intent.confidence < 0.7) {
    missing.push('confidence');
  }
  
  // 【P2】检查上一轮是否有待确认项
  const clarificationContext = intent.clarification_context;
  const skipPendingConfirmationCheck = clarificationContext?.answerType === 'confirm_default' &&
    Array.isArray(clarificationContext?.confirmedSlots) &&
    clarificationContext.confirmedSlots.length > 0;

  const lastAssistantMsg = [...history].reverse().find(h => h.role === 'assistant');
  if (!skipPendingConfirmationCheck && lastAssistantMsg?.type === 'clarify' && lastAssistantMsg?.metadata?.missingSlots) {
    const lastMissingSlots = lastAssistantMsg.metadata.missingSlots;
    
    // 检查这些待确认项是否在当前意图中已解决
    for (const slot of lastMissingSlots) {
      let isResolved = false;
      
      switch (slot) {
        case 'game_id':
          isResolved = intent.filters?.some(f => f.field === 'game_id');
          break;
        case 'table_name':
          // 如果SQL生成阶段没报错，认为表名已解决
          isResolved = true; // 由SQL生成阶段判断
          break;
        case 'time_range':
          isResolved = !!intent.time_range;
          break;
        case 'metrics':
          isResolved = intent.metrics?.length > 0;
          break;
        default:
          // 【修复】其他字段检查filters，支持动态槽位如 platform_identifier
          isResolved = intent.filters?.some(f => f.field === slot);
          // 如果filters中没有，检查是否在原始查询或补充信息中提到了
          if (!isResolved && intent.original_query) {
            const queryLower = intent.original_query.toLowerCase();
            // 简单的启发式检查：如果槽位名在查询中被提及，认为已解决
            if (queryLower.includes(slot.toLowerCase()) || 
                queryLower.includes(slot.replace('_', '').toLowerCase())) {
              isResolved = true;
            }
          }
          // 检查补充信息中是否包含该槽位
          if (!isResolved && intent.supplement_info) {
            const supplementLower = intent.supplement_info.toLowerCase();
            if (supplementLower.includes(slot.toLowerCase()) ||
                supplementLower.includes(slot.replace('_', '').toLowerCase())) {
              isResolved = true;
            }
          }
      }
      
      if (!isResolved) {
        pendingConfirmations.push(slot);
      }
    }
    
    // 如果有待确认项未解决，加入missing
    if (pendingConfirmations.length > 0) {
      missing.push(...pendingConfirmations.filter(m => !missing.includes(m)));
    }
  }
  
  return {
    // 如果没有缺失字段且置信度足够，认为完整
    complete: missing.length === 0,
    // 返回缺失的字段列表
    missing: missing,
    // 【P2】返回待确认项详情
    pendingConfirmations: pendingConfirmations
  };
}

/**
 * 生成澄清问题
 * 根据缺失的信息生成询问用户的问题
 * 
 * @param {Object} intent - 意图分析结果
 * @param {Array} missing - 缺失的字段列表
 * @returns {Promise<Object>} {question: string, missingSlots: Array}
 */
async function generateClarification(intent, missing) {
  // 构造提示词
  const prompt = `用户查询: "${intent.original_query}"

已识别的信息:
${JSON.stringify(intent, null, 2)}

缺失的信息: ${missing.join(', ')}

请生成一个友好的澄清问题，询问用户缺失的信息。同时，请分析需要用户确认的具体槽位（slots）。

要求：
1. 问题应该简洁明了，提供选项帮助用户快速回答
2. 保持上下文连贯
3. 必须返回JSON格式，包含澄清问题和结构化槽位信息

返回格式：
{
  "question": "澄清问题文本",
  "missingSlots": ["slot1", "slot2"],
  "slotDescriptions": {
    "slot1": "该槽位的简要说明"
  }
}

注意：missingSlots 必须包含所有需要用户确认的业务槽位，例如：
- 如果需要game_id，包含 "game_id"
- 如果需要平台信息，包含 "platform" 或 "platform_identifier"
- 如果需要时间范围确认，包含 "time_range"`;

  try {
    // 调用LLM生成澄清问题
    const response = await llmService.simpleChat(prompt);
    const result = parseJSONResponse(response);
    
    logger.debug('生成澄清问题', { 
      question: result.question,
      missingSlots: result.missingSlots 
    });
    
    return {
      question: result.question || response.trim(),
      missingSlots: result.missingSlots || missing,
      slotDescriptions: result.slotDescriptions || {}
    };
  } catch (error) {
    logger.error('生成澄清问题失败:', error);
    // 返回默认澄清问题
    return {
      question: '请提供更多查询细节，例如时间范围、关注的指标等。',
      missingSlots: missing,
      slotDescriptions: {}
    };
  }
}

// ============================================
// SQL生成
// ============================================

/**
 * 生成SQL查询语句
 * 根据意图分析结果和Schema信息生成SQL
 * 
 * @param {Object} intent - 意图分析结果
 * @param {Array} history - 对话历史（用于获取已澄清的信息）
 * @returns {Promise<Object>} {sql: string, explanation: string}
 */
async function generateSQL(intent, history = [], userId = null) {
  // 记录开始生成日志
  logger.debug('开始生成SQL', { intent, userId });
  
  // 从intent中提取game_id和datasource信息
  const context = {};
  if (intent.filters) {
    const gameIdFilter = intent.filters.find(f => f.field === 'game_id');
    if (gameIdFilter) {
      context.gameId = gameIdFilter.value;
    }
    
    const datasourceFilter = intent.filters.find(f => f.field === 'datasource');
    if (datasourceFilter) {
      context.datasource = datasourceFilter.value;
    }
  }
  
  // 搜索相关表（传入上下文进行智能匹配）
  const relevantTables = await schemaLoader.searchRelevantTables(
    intent.original_query, 
    5,
    context
  );
  
  // 获取相关表的详细Schema
  const tableNames = relevantTables.map(t => t.name);
  const schemaDetail = schemaLoader.getTableSchemaDetail(tableNames);
  
  // 获取指标定义（包含表名、字段名、聚合方式等完整信息）
  const metricsInfo = intent.metrics.map(m => {
    const metricDef = schemaLoader.getMetric(m);
    if (metricDef) {
      return `${m}: ${metricDef.description || metricDef.definition}
   - 表名: ${metricDef.table}
   - 字段名: ${metricDef.field}
   - 聚合方式: ${metricDef.aggregation}`;
    }
    return m;
  }).join('\n');
  
  let clarifiedInfo = '';
  if (history.length > 0) {
    const clarificationPairs = [];

    for (let i = 0; i < history.length - 1; i++) {
      const current = history[i];
      const next = history[i + 1];

      if (current.role === 'assistant' && current.type === 'clarify' && next?.role === 'user') {
        clarificationPairs.push({
          question: current.content,
          answer: next.content
        });
      }
    }

    const pairLines = clarificationPairs.slice(-3).map(item =>
      `- 助手澄清: ${item.question}\n  用户回复: ${item.answer}`
    );

    const standaloneClarifications = history
      .filter(h => h.role === 'user' && (
        h.content.includes('id') ||
        h.content.includes('是') ||
        h.content.includes('对') ||
        h.content.includes('确认') ||
        h.content.includes('默认')
      ))
      .slice(-3)
      .map(h => `- 用户补充: ${h.content}`);

    const clarificationLines = [...pairLines, ...standaloneClarifications];

    if (clarificationLines.length > 0) {
      clarifiedInfo = '\n已确认的信息（来自历史对话）:\n' + clarificationLines.join('\n');
    }
  }

  if (intent.clarification_context?.answerType === 'confirm_default' && intent.clarification_context.confirmedDefaults?.length > 0) {
    clarifiedInfo += `\n本轮用户确认采用上一轮默认选项:\n- ${intent.clarification_context.confirmedDefaults.join('\n- ')}`;
  }
  
  // 从长期记忆加载用户学习的字段别名
  let fieldAliasesInfo = '';
  if (userId) {
    try {
      const longTermMemory = require('../memory/longTermMemory');
      const userPrefs = await longTermMemory.getUserPreferences(userId);
      const fieldAliases = userPrefs.filter(p => p.preference_type === 'field_alias');
      
      if (fieldAliases.length > 0) {
        fieldAliasesInfo = '\n用户定义的字段别名（重要，必须遵守）:\n';
        for (const alias of fieldAliases) {
          const content = typeof alias.content === 'string' ? JSON.parse(alias.content) : alias.content;
          
          // 数据源类型映射（如新平台 → new_tzpingtai）
          if (content.field_type === 'datasource') {
            fieldAliasesInfo += `- 当用户说"${content.user_term}"时，指的是数据库标识: ${content.schema_field}，SQL中必须使用 FROM ${content.schema_field}.表名\n`;
          }
          // 游戏ID映射（值是纯数字）
          else if (!isNaN(Number(content.schema_field))) {
            fieldAliasesInfo += `- 当用户说"${content.user_term}"时，指的是 game_id = ${content.schema_field}，SQL中必须使用 WHERE game_id = ${content.schema_field}\n`;
          }
          // 其他字段映射
          else {
            fieldAliasesInfo += `- 当用户说"${content.user_term}"时，指的是字段: ${content.schema_field}\n`;
          }
        }
        logger.info('[SQL生成] 加载用户字段别名', { 
          userId, 
          aliasCount: fieldAliases.length 
        });
      }
    } catch (e) {
      logger.debug('[SQL生成] 加载字段别名失败:', e.message);
    }
  }
  
  // 构造系统提示词
  const systemPrompt = `你是一位SQL专家，负责将用户的查询需求转换为标准SQL语句。

可用表结构:
${schemaDetail}

预定义指标:
${metricsInfo}${clarifiedInfo}${fieldAliasesInfo}

SQL生成规则:
1. 只使用SELECT语句，禁止任何DML操作（UPDATE/DELETE/INSERT等）
2. 使用标准SQL语法，兼容MySQL
3. **表名和字段名必须使用上面"可用表结构"中提供的实际数据库名称（英文），禁止使用中文表名或字段名，禁止虚构表名（如orders、transactions等）**
4. 如果"收入金额"指标对应的表是tzpingtai_tz_sdk_log_pf_order，则必须使用这个表名，不能使用orders或其他别名
5. 时间字段使用适当的日期函数（DATE_FORMAT, DATE_SUB, CURDATE等）
6. 添加LIMIT限制，默认不超过1000条
7. 复杂的查询使用CTE（WITH子句）提高可读性
8. 添加适当的注释说明

【P3】严格约束 - 禁止越权猜测（重要）：
- **禁止猜测表名**：如果意图中没有明确指定表名，且无法从指标定义中确定，必须返回 needClarification，禁止随意选择表
- **禁止猜测 game_id**：如果用户提到游戏名称（如"华夏"、"青木"）但未提供 game_id，且长期记忆中也没有该映射，必须返回 needClarification，禁止猜测ID值
- **禁止猜测时间范围**：如果意图中 time_range 为空或不明确，必须返回 needClarification，禁止默认使用"昨天"或"最近7天"
- **禁止猜测字段含义**：如果不确定某个字段的业务含义（如status字段的具体值代表什么），必须返回 needClarification

智能推断规则（仅在信息明确时）：
- 如果用户提供了精确的标识符（如ID），优先使用并自动关联之前的模糊描述（如名称），直接生成SQL
- 只有在**所有必要信息都已明确**且**无歧义**时，才生成SQL
- 如果有任何不确定，必须返回 needClarification，并在 missingSlots 中列出所有缺失项

意图中的 filters 字段（重要）：
- intent.filters 数组中包含了已解析的筛选条件，格式为 [{"field": "game_id", "op": "=", "value": "30"}]
- 这些 filters 是系统已经解析好的精确条件，必须在生成的SQL的WHERE子句中使用
- 例如：如果 filters 中有 {"field": "game_id", "op": "=", "value": "30"}，则SQL必须包含 WHERE game_id = 30

## Few-Shot 示例

**示例 1 - 补充回答直接执行：**
对话历史：
- 用户：青木上个月流水
- 助手：请提供青木的游戏ID
- 用户：id 是 30

你的输出：
{
  "thought": "用户之前询问青木的流水，现在提供了 game_id=30，信息已完整，可以直接生成SQL查询青木游戏上个月的收入数据",
  "sql": "SELECT DATE_FORMAT(create_time, '%Y-%m-%d') as date, SUM(amount) as revenue FROM tzpingtai_tz_sdk_log_pf_order WHERE game_id = 30 AND create_time >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH) GROUP BY date ORDER BY date LIMIT 1000",
  "explanation": "查询青木游戏（game_id=30）最近一个月的每日流水收入"
}

**示例 2 - 用户更换指标：**
对话历史：
- 用户：查下昨天的流水
- 用户：算了，查活跃人数吧

你的输出：
{
  "thought": "用户说'算了，查活跃人数'，明确表示要更换指标，放弃之前的流水查询，应该查询昨天的活跃用户数",
  "sql": "SELECT COUNT(DISTINCT user_id) as dau FROM user_login_log WHERE DATE(login_time) = DATE_SUB(CURDATE(), INTERVAL 1 DAY) LIMIT 1000",
  "explanation": "查询昨天的日活跃用户数（DAU）"
}

**示例 3 - 上下文理解：**
对话历史：
- 用户：王者荣耀最近7天的数据
- 用户：那流水呢？

你的输出：
{
  "thought": "用户之前询问王者荣耀的数据，现在问'那流水呢'，结合上下文理解为查询王者荣耀最近7天的流水收入",
  "sql": "SELECT DATE_FORMAT(create_time, '%Y-%m-%d') as date, SUM(amount) as revenue FROM tzpingtai_tz_sdk_log_pf_order WHERE game_id = 1 AND create_time >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) GROUP BY date ORDER BY date LIMIT 1000",
  "explanation": "查询王者荣耀（game_id=1）最近7天的每日流水收入"
}

返回格式（信息明确时）:
{
  "thought": "推理过程：1)用户想要什么 2)Schema如何支持 3)如何构建SQL",
  "sql": "生成的SQL语句",
  "explanation": "这段SQL的作用说明"
}

返回格式（确实无法推断时）:
{
  "needClarification": true,
  "thought": "为什么无法推断，具体缺哪些信息",
  "clarificationQuestion": "需要向用户确认的问题",
  "missingSlots": ["缺失的信息项，如: game_id", "table_name", "time_range"]
}

重要：missingSlots 必须列出所有缺失的关键信息项，用于后续部分回答校验。例如：
- 如果不知道用哪个表，包含 "table_name"
- 如果不知道游戏ID，包含 "game_id"  
- 如果时间不明确，包含 "time_range"`;

  // 构造用户提示词
  const userPrompt = `请根据以下意图生成SQL:

${JSON.stringify(intent, null, 2)}

只返回JSON，不要其他解释。`;

  try {
    // 调用LLM生成SQL
    const response = await llmService.simpleChat(userPrompt, systemPrompt);
    
    // 解析JSON响应
    const result = parseJSONResponse(response);
    
    // 如果需要澄清，直接返回
    if (result.needClarification) {
      logger.info('SQL生成需要用户澄清', { question: result.clarificationQuestion });
      return result;
    }
    
    // 添加LIMIT如果缺失
    if (result.sql && !result.sql.toUpperCase().includes('LIMIT')) {
      result.sql += ` LIMIT ${config.security.maxQueryRows}`;
    }
    
    logger.debug('SQL生成完成', { sql: result.sql });
    return result;
    
  } catch (error) {
    logger.error('SQL生成失败:', error);
    throw new Error('SQL生成失败: ' + error.message);
  }
}

/**
 * 验证SQL安全性
 * 检查SQL是否符合安全规则
 * 
 * @param {string} sql - SQL语句
 * @returns {Object} {valid: boolean, error?: string}
 */
function validateSQL(sql) {
  // 使用schemaLoader的验证功能
  const validation = schemaLoader.validateSQL(sql);
  
  if (!validation.valid) {
    return validation;
  }
  
  // 额外检查：确保是SELECT语句
  // 移除注释和多余空白后再检查
  let cleanedSQL = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')  // 移除 /* */ 注释
    .replace(/--.*$/gm, '')             // 移除 -- 行注释
    .replace(/^\s*\n/gm, '')            // 移除空行
    .trim()
    .toUpperCase();
  
  // 支持的查询类型：SELECT 或 WITH (CTE)
  const allowedPrefixes = ['SELECT', 'WITH'];
  const hasValidPrefix = allowedPrefixes.some(prefix => cleanedSQL.startsWith(prefix));
  
  if (!hasValidPrefix) {
    return {
      valid: false,
      error: '只支持SELECT查询'
    };
  }
  
  // 检查是否有LIMIT
  if (!cleanedSQL.includes('LIMIT')) {
    return {
      valid: false,
      error: 'SQL必须包含LIMIT限制'
    };
  }
  
  return { valid: true };
}

// ============================================
// 查询执行
// ============================================

/**
 * 执行SQL查询
 * 连接数据源执行查询并返回结果
 * 
 * @param {string} sql - SQL语句
 * @returns {Promise<Object>} 查询结果
 */
async function executeQuery(sql) {
  // 记录开始执行日志
  logger.info('执行SQL查询', { sql: sql.substring(0, 100) + '...' });
  
  // 记录开始时间
  const startTime = Date.now();
  
  // 检查是否为dryRun模式（只生成SQL不执行）
  if (config.security.dryRun) {
    logger.info('DryRun模式：跳过实际查询执行');
    return {
      success: true,
      data: {
        columns: [],
        rows: [],
        rowCount: 0,
        dryRun: true,
        message: 'DryRun模式：SQL未实际执行'
      },
      executionTime: 0,
      sql,
      dryRun: true
    };
  }
  
  try {
    // TODO: 这里需要实现实际的数据源连接和查询
    // 目前使用模拟数据演示
    
    // 模拟查询延迟
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // 模拟返回结果
    const mockResult = {
      columns: ['region', 'sales_amount', 'order_count'],
      rows: [
        { region: '北京', sales_amount: 150000, order_count: 320 },
        { region: '上海', sales_amount: 180000, order_count: 410 },
        { region: '广州', sales_amount: 120000, order_count: 280 }
      ],
      rowCount: 3
    };
    
    // 计算执行耗时
    const executionTime = Date.now() - startTime;
    
    logger.info('查询执行完成', { 
      rowCount: mockResult.rowCount, 
      executionTime 
    });
    
    return {
      success: true,
      data: mockResult,
      executionTime,
      sql
    };
    
  } catch (error) {
    logger.error('查询执行失败:', error);
    return {
      success: false,
      error: error.message,
      executionTime: Date.now() - startTime,
      sql
    };
  }
}

// ============================================
// 结果格式化
// ============================================

/**
 * 格式化查询结果
 * 将查询结果转换为自然语言描述
 * 
 * @param {Object} result - 查询结果
 * @param {string} originalQuery - 原始用户查询
 * @returns {Promise<string>} 格式化后的回复
 */
async function formatResult(result, originalQuery) {
  // 如果查询失败，返回错误信息
  if (!result.success) {
    return `查询失败: ${result.error}`;
  }
  
  // 构造提示词
  const prompt = `用户查询: "${originalQuery}"

查询结果:
- 返回行数: ${result.data.rowCount}
- 执行耗时: ${result.executionTime}ms
- 数据样例:
${JSON.stringify(result.data.rows.slice(0, 5), null, 2)}

请用自然语言总结查询结果，包括:
1. 关键数据点
2. 任何明显的趋势或异常
3. 是否需要进一步分析

保持简洁友好。`;

  try {
    // 调用LLM生成回复
    const response = await llmService.simpleChat(prompt);
    return response.trim();
  } catch (error) {
    logger.error('格式化结果失败:', error);
    // 返回基础回复
    return `查询完成，返回 ${result.data.rowCount} 条数据，耗时 ${result.executionTime}ms。`;
  }
}

// ============================================
// 主流程
// ============================================

/**
 * 处理用户查询的主流程
 * 完整的NL2SQL流程：意图识别 → 澄清 → SQL生成 → 执行 → 格式化 → 记忆存储
 * 
 * @param {string} userQuery - 用户查询
 * @param {string} sessionId - 会话ID
 * @param {Function} onProgress - 进度回调函数（可选）
 * @param {string} userId - 用户ID（用于长期记忆）
 * @returns {Promise<Object>} 处理结果
 */
async function processQuery(userQuery, sessionId, onProgress = null, userId = null) {
  // 记录开始处理日志
  logger.info('开始处理查询', { sessionId, userId, query: userQuery });
  
  // 发送进度更新
  const sendProgress = (step, data) => {
    if (onProgress) {
      onProgress({ step, ...data });
    }
  };
  
  try {
    // ----------------------------------------
    // 步骤1: 获取会话历史
    // ----------------------------------------
    sendProgress('loading_history', { message: '加载会话历史...' });
    const history = await database.getSessionMessages(sessionId, 10);
    
    // 如果没有传入userId，尝试从会话中获取
    if (!userId) {
      const session = await database.getSession(sessionId);
      userId = session?.user_id || 'anonymous';
    }
    
    // ----------------------------------------
    // 步骤2: 意图识别（融合上下文和长期记忆）
    // ----------------------------------------
    sendProgress('analyzing', { message: '分析查询意图...' });
    
    // 获取最近5轮对话用于上下文理解
    const recentHistory = history.slice(-5);
    let intent = await analyzeIntent(userQuery, recentHistory, userId);
    
    // 保存用户消息到会话
    await database.addMessage(sessionId, 'user', userQuery, 'text');
    const historyWithCurrentUser = [...history, {
      role: 'user',
      content: userQuery,
      type: 'text'
    }];
    
    // ----------------------------------------
    // 步骤2.5: 检查是否是上下文查询，使用LLM智能更新意图
    // ----------------------------------------
    const lastAssistantMsg = [...history].reverse().find(h => h.role === 'assistant');
    
    logger.info('检查上下文查询', {
      lastAssistantRole: lastAssistantMsg?.role,
      lastAssistantType: lastAssistantMsg?.type,
      currentIntentMetrics: intent.metrics,
      currentIntentConfidence: intent.confidence,
      isContextualQuery: intent.isContextualQuery,
      hasHistoricalIntent: !!lastAssistantMsg?.metadata?.intent
    });
    
    // 判断是否为上下文依赖型查询
    const isContextualQuery = intent.isContextualQuery || 
                              (lastAssistantMsg && lastAssistantMsg.type === 'clarify') ||
                              (intent.confidence < 0.5 && history.length > 0);
    
    if (isContextualQuery && lastAssistantMsg?.metadata?.intent) {
      logger.info('检测到上下文查询，使用LLM更新意图', { 
        currentQuery: userQuery,
        previousIntent: lastAssistantMsg.metadata.intent.original_query,
        reason: intent.isContextualQuery ? 'LLM标记为上下文查询' : 
                (lastAssistantMsg.type === 'clarify' ? '上一轮是澄清' : '置信度低')
      });
      
      const previousIntent = lastAssistantMsg.metadata.intent;
      intent = await updateIntentWithLLM(previousIntent, userQuery, recentHistory);
      
      logger.info('意图更新后', {
        updateType: intent.updateType,
        mergedMetrics: intent.metrics,
        mergedTimeRange: intent.time_range,
        mergedConfidence: intent.confidence
      });
      
      // 学习字段别名：如果用户在澄清中提供了实体映射，记录下来
      await learnEntityAliasFromContext(userId, userQuery, intent, lastAssistantMsg);
    }

    intent = enrichIntentWithClarificationContext(intent, userQuery, history);
    
    // ----------------------------------------
    // 步骤3: 检查是否需要澄清
    // ----------------------------------------
    const completeness = checkIntentComplete(intent, historyWithCurrentUser);
    
    logger.info('意图完整性检查', {
      isComplete: completeness.complete,
      missing: completeness.missing,
      pendingConfirmations: completeness.pendingConfirmations,
      finalMetrics: intent.metrics,
      finalTimeRange: intent.time_range
    });
    
    if (!completeness.complete) {
      // 【新增】澄清轮即时学习：从用户输入中提取映射关系
      // 即使用户输入导致需要澄清，也可能包含高价值的业务映射声明
      if (userId) {
        try {
          const longTermMemory = require('../memory/longTermMemory');
          const extractionResult = await longTermMemory.extractMappingsFromText(userId, userQuery);
          
          if (extractionResult.learned.length > 0) {
            logger.info('[NL2SQL] ✅ 澄清轮即时学习成功', {
              userId,
              learnedCount: extractionResult.learned.length,
              mappings: extractionResult.learned.map(l => `${l.userTerm}->${l.value}`)
            });
          }
        } catch (learnError) {
          logger.error('[NL2SQL] 澄清轮即时学习失败:', learnError);
          // 学习失败不影响主流程，继续澄清
        }
      }
      
      // 需要澄清，生成澄清问题
      sendProgress('clarifying', { message: '需要更多信息...' });
      const clarificationResult = await generateClarification(intent, completeness.missing);
      
      // 保存澄清消息
      await database.addMessage(sessionId, 'assistant', clarificationResult.question, 'clarify', {
        intent,
        missingSlots: clarificationResult.missingSlots || completeness.missing
      });
      
      return {
        success: true,
        type: 'clarify',
        message: clarificationResult.question,
        intent,
        missingSlots: clarificationResult.missingSlots || completeness.missing
      };
    }
    
    // ----------------------------------------
    // 步骤4: 生成SQL（利用历史对话中已澄清的信息和长期记忆）
    // ----------------------------------------
    sendProgress('generating', { message: '生成SQL查询...' });
    const sqlResult = await generateSQL(intent, historyWithCurrentUser, userId);
    
    // 检查是否需要澄清（大模型无法确定某些信息）
    if (sqlResult.needClarification) {
      sendProgress('clarifying', { message: '需要确认信息...' });
      
      // 【P1】部分回答校验：检查上一轮是否也有 missingSlots
      const lastAssistantMsg = [...history].reverse().find(h => h.role === 'assistant');
      const isDefaultConfirmation = intent.clarification_context?.answerType === 'confirm_default';
      const lastMissingSlots = isDefaultConfirmation ? [] : (lastAssistantMsg?.metadata?.missingSlots || []);
      const currentMissingSlots = sqlResult.missingSlots || [];
      
      // 计算已回答和仍缺失的
      const answeredSlots = lastMissingSlots.filter(slot => !currentMissingSlots.includes(slot));
      const stillMissingSlots = currentMissingSlots;
      
      if (answeredSlots.length > 0 && stillMissingSlots.length > 0) {
        // 部分回答：用户答了一些，但还有没答的
        logger.info('[部分回答校验] 用户部分回答，继续追问剩余项', {
          answered: answeredSlots,
          stillMissing: stillMissingSlots
        });
        
        const partialClarification = `已收到：${answeredSlots.join('、')}。\n还需要确认：${stillMissingSlots.join('、')}。\n\n${sqlResult.clarificationQuestion}`;
        
        // 保存澄清消息（带 missingSlots 用于下一轮校验）
        await database.addMessage(sessionId, 'assistant', partialClarification, 'clarify', {
          intent,
          clarificationType: 'partial_answer',
          missingSlots: stillMissingSlots,
          answeredSlots: answeredSlots
        });
        
        return {
          success: true,
          type: 'clarify',
          message: partialClarification,
          intent,
          clarificationType: 'partial_answer',
          missingSlots: stillMissingSlots,
          answeredSlots: answeredSlots
        };
      }
      
      // 保存澄清消息（带 missingSlots）
      await database.addMessage(sessionId, 'assistant', sqlResult.clarificationQuestion, 'clarify', {
        intent,
        clarificationType: 'schema_mismatch',
        missingSlots: currentMissingSlots
      });
      
      return {
        success: true,
        type: 'clarify',
        message: sqlResult.clarificationQuestion,
        intent,
        clarificationType: 'schema_mismatch',
        missingSlots: currentMissingSlots
      };
    }
    
    // ----------------------------------------
    // 步骤5: 验证SQL
    // ----------------------------------------
    sendProgress('validating', { message: '验证查询安全性...' });
    const validation = validateSQL(sqlResult.sql);
    
    if (!validation.valid) {
      // SQL验证失败
      const errorMsg = `SQL验证失败: ${validation.error}`;
      await database.addMessage(sessionId, 'assistant', errorMsg, 'error');
      
      return {
        success: false,
        type: 'error',
        message: errorMsg,
        sql: sqlResult.sql
      };
    }
    
    // ----------------------------------------
    // 步骤6: 执行查询
    // ----------------------------------------
    sendProgress('executing', { message: '执行查询...' });
    const queryResult = await executeQuery(sqlResult.sql);
    
    // ----------------------------------------
    // 步骤7: 格式化结果
    // ----------------------------------------
    sendProgress('formatting', { message: '整理查询结果...' });
    const formattedResponse = await formatResult(queryResult, userQuery);
    
    // 保存助手回复
    await database.addMessage(sessionId, 'assistant', formattedResponse, 'result', {
      sql: sqlResult.sql,
      explanation: sqlResult.explanation,
      result: queryResult
    });
    
    // ----------------------------------------
    // 步骤8: 存储查询向量（用于相似查询推荐）
    // ----------------------------------------
    if (config.embedding && config.embedding.enabled && userId) {
      const vectorStore = require('../memory/vectorStore');
      
      // 异步存储查询向量，不等待结果
      (async () => {
        try {
          // 获取查询向量
          const queryVector = await llmService.getEmbedding(userQuery);
          
          // 存储到向量库
          await vectorStore.addQueryVector(
            `query_${Date.now()}_${userId}`,
            userQuery,
            queryVector,
            {
              user_id: userId,
              session_id: sessionId,
              intent: {
                metrics: intent.metrics,
                dimensions: intent.dimensions,
                time_range: intent.time_range
              },
              sql: sqlResult.sql,
              success: queryResult.success,
              timestamp: Date.now()
            }
          );
          
          logger.debug('查询向量已存储', { userId, query: userQuery.substring(0, 50) });
        } catch (err) {
          logger.error('存储查询向量失败:', err);
        }
      })();
    }
    
    // ----------------------------------------
    // 步骤9: 提取并存储长期记忆（异步，不阻塞响应）
    // ----------------------------------------
    logger.info('[NL2SQL] 准备触发长期记忆存储', { 
      userId, 
      hasIntent: !!intent,
      intentConfidence: intent?.confidence,
      querySuccess: queryResult.success
    });
    
    // 注意：暂时允许anonymous用户存储，后续有登录系统后可限制
    if (userId && intent) {
      const longTermMemory = require('../memory/longTermMemory');
      
      logger.info('[NL2SQL] 开始异步提取长期记忆', { userId, query: userQuery.substring(0, 30) });
      
      // 异步提取偏好，不等待结果
      longTermMemory.extractAndStorePreferences(userId, intent, userQuery, {
        success: queryResult.success,
        confidence: intent.confidence || 0.5
      }).then(result => {
        if (result.stored) {
          logger.info('[NL2SQL] ✅ 长期记忆存储成功', { 
            userId, 
            storedCount: result.preferences.length,
            reason: result.reason,
            isPersonal: result.isPersonal,
            preferenceTypes: result.preferences.map(p => p.preference_type || p.type)
          });
        } else {
          logger.info('[NL2SQL] ⚠️ 长期记忆未存储', { 
            userId, 
            reason: result.reason,
            confidence: intent.confidence
          });
        }
      }).catch(err => {
        logger.error('[NL2SQL] ❌ 长期记忆存储失败:', err);
      });
    } else {
      logger.info('[NL2SQL] 跳过长期记忆存储', { 
        userId, 
        hasIntent: !!intent
      });
    }
    
    // 返回最终结果
    return {
      success: true,
      type: 'result',
      message: formattedResponse,
      sql: sqlResult.sql,
      explanation: sqlResult.explanation,
      data: queryResult.data,
      executionTime: queryResult.executionTime
    };
    
  } catch (error) {
    logger.error('处理查询失败:', error);
    
    // 保存错误消息
    const errorMsg = `处理失败: ${error.message}`;
    await database.addMessage(sessionId, 'assistant', errorMsg, 'error');
    
    return {
      success: false,
      type: 'error',
      message: errorMsg
    };
  }
}

// ============================================
// 辅助函数
// ============================================

/**
 * 解析LLM返回的JSON响应
 * 处理可能的格式问题
 * 
 * @param {string} response - LLM响应文本
 * @returns {Object} 解析后的JSON对象
 */
function parseJSONResponse(response) {
  try {
    // 尝试直接解析
    return JSON.parse(response);
  } catch (e) {
    // 如果失败，尝试提取JSON代码块
    const jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1]);
    }
    
    // 尝试提取花括号内容
    const braceMatch = response.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      return JSON.parse(braceMatch[0]);
    }
    
    // 都失败，抛出错误
    throw new Error('无法解析JSON响应: ' + response.substring(0, 100));
  }
}

// ============================================
// 导出模块
// ============================================

module.exports = {
  // 核心流程
  processQuery,
  // 子功能（可用于单独调用）
  analyzeIntent,
  checkIntentComplete,
  generateClarification,
  generateSQL,
  validateSQL,
  executeQuery,
  formatResult,
  // 新增功能
  updateIntentWithLLM,
  resolveEntity
};
