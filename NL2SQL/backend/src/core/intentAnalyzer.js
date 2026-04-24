/**
 * NL2SQL 意图分析模块（Phase 4 · 任务 A.1）
 *
 * 职责：
 * - 从用户自然语言查询识别意图（time_range / metrics / dimensions / filters / confidence）
 * - 上下文理解：结合对话历史和长期记忆理解当前轮
 * - 意图完整性检查 + 澄清问题生成
 *
 * 由 `nl2sqlEngine.processQuery` 编排调用；对外通过 `nl2sqlEngine.js` re-export，
 * 上游 `sseHandler` 等无需改动。
 */

const config = require('./config');
const logger = require('../utils/logger');
const llmService = require('./llmService');
const schemaLoader = require('./schemaLoader');
const database = require('./database');
const longTermMemory = require('../memory/longTermMemory');
const vectorStore = require('../memory/vectorStore');
const entityResolver = require('./entityResolver');

function parseJSONResponse(response) {
  return require('../utils/llmResponseParser').parseJSON(response, 'NL2SQLEngine');
}

// ============================================
// 相关表动态检索（意图识别阶段）
// ============================================

/**
 * 使用向量检索或关键词匹配，返回与查询最相关的表名
 */
async function getRelevantTablesForIntent(query, context = {}, topK = 10) {
  try {
    const relevantTables = await schemaLoader.searchRelevantTables(query, topK, context);
    if (relevantTables && relevantTables.length > 0) {
      logger.debug('[NL2SQL] 使用向量检索获取相关表', {
        query: query.substring(0, 50),
        tableCount: relevantTables.length,
        tables: relevantTables.map(t => t.name)
      });
      return relevantTables.map(t => `${t.name}(${t.name_cn || ''})`).join(', ');
    }
  } catch (error) {
    logger.warn('[NL2SQL] 向量检索表失败，回退到高频核心表:', error.message);
  }
  return getCoreHighFrequencyTables().join(', ');
}

function getCoreHighFrequencyTables() {
  return [
    'tzpingtai_tz_sdk_log_pf_reg(平台注册表)',
    'tzpingtai_tz_sdk_log_pf_login(平台登录表)',
    'tzpingtai_tz_sdk_log_pf_order(平台订单表)',
    'tzpingtai_tz_sdk_log_pf_act(平台活跃表)',
    'tzpingtai_tz_sdk_log_pf_first_order(平台首充日志表)',
    'new_tzpingtaiold.tzpingtaiold_tz_sdk_log_account_game_time(账号游戏时间)',
    'new_tzpingtaiold.tzpingtaiold_tz_sdk_log_role_game_time(角色游戏时间)',
    'tzqingmu_log_game_user_chat(游戏用户聊天表)',
    'tzqingmu_role(角色表)',
    'dwd_tzpingtai_game_reg(DWD注册表)',
    'dwd_tzpingtai_act(DWD活跃表)',
    'dwd_tzpingtai_order(DWD订单表)',
    'dwd_tzpingtai_retention(DWD留存表)'
  ];
}

// ============================================
// 对话摘要与澄清辅助
// ============================================

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

function extractDefaultOptionsFromClarification(clarificationMsg) {
  if (!clarificationMsg) {
    return [];
  }
  if (clarificationMsg.metadata?.defaultOptions &&
      Array.isArray(clarificationMsg.metadata.defaultOptions)) {
    logger.debug('[澄清解析] 使用结构化默认选项', {
      count: clarificationMsg.metadata.defaultOptions.length
    });
    return clarificationMsg.metadata.defaultOptions.map(opt => opt.label || opt.value);
  }
  const text = clarificationMsg.content || '';
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
    ? extractDefaultOptionsFromClarification(lastAssistantMsg)
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
 */
async function analyzeIntent(userQuery, history = [], userId = null) {
  logger.debug('开始分析用户意图', { query: userQuery, historyLength: history.length, userId });

  const tableList = await getRelevantTablesForIntent(userQuery, {}, 10);

  let contextSummary = '';
  if (history.length > 0) {
    const recentHistory = history.slice(-5);
    contextSummary = `
对话上下文（最近${recentHistory.length}轮）:
${recentHistory.map((h, i) => `${h.role === 'user' ? '用户' : '助手'}: ${h.content}`).join('\n')}

重要：请结合上下文理解用户的当前查询。如果当前查询是对之前问题的补充或修正，请整合信息给出完整的意图。`;
  }

  let userPreferencesSummary = '';
  let similarQueriesSummary = '';

  if (userId) {
    try {
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
${(() => {
  const queryLower = userQuery.toLowerCase();

  const relevantAliases = userPreferences.aliases.filter(a =>
    queryLower.includes(a.user_term.toLowerCase())
  );

  const gameAliases = userPreferences.aliases.filter(a =>
    a.field_type === 'game' || a.field_type === 'game_value' ||
    (!isNaN(Number(a.schema_field)) && a.schema_field.length <= 3)
  );

  const prioritizedAliases = [...relevantAliases];
  for (const alias of gameAliases) {
    if (!prioritizedAliases.find(a => a.user_term === alias.user_term)) {
      prioritizedAliases.push(alias);
    }
  }

  const remaining = userPreferences.aliases.filter(a =>
    !prioritizedAliases.find(p => p.user_term === a.user_term)
  );
  const allAliases = [...prioritizedAliases, ...remaining].slice(0, 15);

  return allAliases.map(a => {
    if (a.field_type === 'game') {
      if (!isNaN(Number(a.schema_field))) {
        return `- "${a.user_term}" 对应 game_id = ${a.schema_field}`;
      }
      const valueAlias = userPreferences.aliases.find(va =>
        va.user_term === `${a.user_term}_value` && !isNaN(Number(va.schema_field))
      );
      if (valueAlias) {
        return `- "${a.user_term}" 对应 game_id = ${valueAlias.schema_field}`;
      }
      return `- "${a.user_term}" 对应 game_id（值未知）`;
    }
    if (a.field_type === 'game_value') {
      return null;
    }
    const isGameMapping = !isNaN(Number(a.schema_field)) && a.schema_field.length <= 3;
    if (isGameMapping) {
      return `- "${a.user_term}" 对应 game_id = ${a.schema_field}`;
    }
    if (a.field_type === 'datasource') {
      return `- "${a.user_term}" 对应数据库标识: ${a.schema_field}`;
    }
    return `- "${a.user_term}" → ${a.schema_field}`;
  }).filter(Boolean).join('\n');
})()}

重要：
1. 当用户提到上述游戏名称时，必须在 filters 中使用对应的 game_id，不要虚构其他字段如 database_identifier。
2. 当用户提到"新平台"或"老平台"时，直接使用对应的数据库标识（new_tzpingtai/new_tzpingtaiold），不要追问平台标识。
3. **强制规则**：如果"字段别名映射"中已包含某游戏名称对应的game_id，直接在filters中使用该game_id，置信度设为0.95，不要询问用户确认。

常用指标: ${userPreferences.metrics.slice(0, 5).join(', ')}
常用维度: ${userPreferences.dimensions.slice(0, 5).join(', ')}
`;

        logger.debug('[NL2SQL] 用户偏好摘要内容', {
          userId,
          preferencesSummary: userPreferencesSummary
        });
      }

      logger.info('[NL2SQL] ✅ 长期记忆已加载到意图识别', {
        userId,
        patternCount: userPreferences.patterns.length,
        aliasCount: userPreferences.aliases.length,
        metricCount: userPreferences.metrics.length,
        dimensionCount: userPreferences.dimensions.length,
        allAliases: userPreferences.aliases.map(a => ({
          user_term: a.user_term,
          schema_field: a.schema_field,
          field_type: a.field_type
        }))
      });
    } catch (err) {
      logger.error('[NL2SQL] ❌ 加载用户长期记忆失败:', err);
    }

    if (config.embedding && config.embedding.enabled) {
      try {
        const queryVector = await llmService.getEmbedding(userQuery);
        const similarQueries = await vectorStore.searchSimilarQueries(queryVector, 5);

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

  const systemPrompt = `你是一位有记忆的数据分析助手，负责理解用户的数据查询需求。

你的任务是维护一个**持久化的查询状态**，结合【对话历史】和【当前输入】，判断用户在：
- **补充信息**：完善之前的查询（如提供ID、修改时间范围）
- **更换需求**：放弃之前的查询，开始新查询（如"算了，查XX"）
- **全新查询**：与之前无关的独立查询

【可用表名列表】（仅参考，无需深入解析表结构）:
${tableList}
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

  const userPrompt = userQuery;

  try {
    const response = await llmService.simpleChat(userPrompt, systemPrompt);
    const intent = parseJSONResponse(response);

    intent.original_query = userQuery;

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

    if (!intent.metrics || intent.metrics.length === 0) {
      for (const [keyword, metric] of Object.entries(commonMetrics)) {
        if (queryLower.includes(keyword)) {
          intent.metrics = [metric];
          logger.info(`从查询中提取到指标: ${metric}`);
          break;
        }
      }
    }

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

    await entityResolver.resolveEntitiesInIntent(intent, userQuery, userId);
    await entityResolver.resolvePlatformInIntent(intent, userQuery, userId);

    logger.info('意图分析完成', {
      query: userQuery,
      metrics: intent.metrics,
      timeRange: intent.time_range,
      confidence: intent.confidence
    });
    return intent;

  } catch (error) {
    logger.error('意图分析失败:', error);
    return {
      original_query: userQuery,
      confidence: 0.3,
      error: error.message
    };
  }
}

// ============================================
// 意图合并与更新
// ============================================

async function mergeIntent(historicalIntent, currentIntent, supplementQuery) {
  logger.info('合并意图', {
    historicalQuery: historicalIntent.original_query,
    historicalMetrics: historicalIntent.metrics,
    supplementQuery,
    currentMetrics: currentIntent.metrics
  });

  const mergedIntent = { ...historicalIntent };

  if (!mergedIntent.metrics || mergedIntent.metrics.length === 0) {
    logger.warn('历史意图缺少 metrics，尝试从补充回答推断');
    if (currentIntent.metrics && currentIntent.metrics.length > 0) {
      mergedIntent.metrics = currentIntent.metrics;
    }
  }

  if (currentIntent.filters && currentIntent.filters.length > 0) {
    mergedIntent.filters = [...(mergedIntent.filters || []), ...currentIntent.filters];
  }

  if (currentIntent.time_range && !mergedIntent.time_range) {
    mergedIntent.time_range = currentIntent.time_range;
  }

  mergedIntent.supplement_info = supplementQuery;
  mergedIntent.confidence = 0.9;

  logger.info('意图合并完成', {
    mergedMetrics: mergedIntent.metrics,
    mergedTimeRange: mergedIntent.time_range,
    mergedFilters: mergedIntent.filters
  });
  return mergedIntent;
}

async function updateIntentWithLLM(previousIntent, newQuery, history) {
  logger.info('使用LLM更新意图', {
    previousQuery: previousIntent.original_query,
    newQuery
  });

  const context = {};
  if (previousIntent.filters) {
    const gameIdFilter = previousIntent.filters.find(f => f.field === 'game_id');
    if (gameIdFilter) context.gameId = gameIdFilter.value;
    const dsFilter = previousIntent.filters.find(f => f.field === 'datasource');
    if (dsFilter) context.datasource = dsFilter.value;
  }
  const tableList = await getRelevantTablesForIntent(newQuery, context, 10);

  const dialogueSummary = getDialogueSummary(history, 6);

  const essentialIntent = {
    original_query: previousIntent.original_query,
    time_range: previousIntent.time_range,
    dimensions: previousIntent.dimensions,
    metrics: previousIntent.metrics,
    filters: previousIntent.filters,
    sort: previousIntent.sort,
    limit: previousIntent.limit,
    confidence: previousIntent.confidence,
    thought: previousIntent.thought
  };

  logger.debug('previousIntent大小诊断', {
    originalSize: JSON.stringify(previousIntent).length,
    essentialSize: JSON.stringify(essentialIntent).length
  });

  const systemPrompt = `你是一位意图理解专家。你的任务是根据用户的新输入，更新当前的查询意图。

当前意图状态:
${JSON.stringify(essentialIntent, null, 2)}

用户最新输入: "${newQuery}"

最近对话历史（重点参考，尤其是上一轮澄清问题与默认选项）:
${dialogueSummary || '无'}

【可用表名列表】（仅参考，无需深入解析表结构）:
${tableList}

请分析：
1. 用户是在补充信息（如提供game_id），还是在修改需求（如换指标）？
2. 如果是补充：将新信息合并到当前意图
3. 如果是修改：用新需求替换相关字段
4. 如果是完全新的查询：创建新意图
5. 如果用户最新输入只是"是 / 对 / 都确认 / 按默认"等简短肯定答复，且上一轮助手在澄清问题中提供了默认或推荐选项，则视为用户确认采用这些默认/推荐选项，不要再次追问同一问题
6. 如果上一轮助手已经给出了具体候选表、字段、口径或默认值，必须结合上一轮澄清内容理解当前回复，不能把"是""都确认"当成无意义的新查询

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
    return mergeIntent(previousIntent, { original_query: newQuery, confidence: 0.5 }, newQuery);
  }
}

// ============================================
// 意图完整性检查 + 澄清问题生成
// ============================================

function checkIntentComplete(intent, history = []) {
  const requiredFields = ['time_range', 'metrics'];
  const missing = [];
  const pendingConfirmations = [];

  for (const field of requiredFields) {
    if (!intent[field] ||
        (Array.isArray(intent[field]) && intent[field].length === 0)) {
      missing.push(field);
    }
  }

  if (intent.confidence < 0.7) {
    missing.push('confidence');
  }

  const clarificationContext = intent.clarification_context;
  const skipPendingConfirmationCheck = clarificationContext?.answerType === 'confirm_default' &&
    Array.isArray(clarificationContext?.confirmedSlots) &&
    clarificationContext.confirmedSlots.length > 0;

  const lastAssistantMsg = [...history].reverse().find(h => h.role === 'assistant');
  if (!skipPendingConfirmationCheck && lastAssistantMsg?.type === 'clarify' && lastAssistantMsg?.metadata?.missingSlots) {
    const lastMissingSlots = lastAssistantMsg.metadata.missingSlots;

    for (const slot of lastMissingSlots) {
      let isResolved = false;

      switch (slot) {
        case 'game_id':
          isResolved = intent.filters?.some(f => f.field === 'game_id');
          break;
        case 'table_name':
          isResolved = true;
          break;
        case 'time_range':
          isResolved = !!intent.time_range;
          break;
        case 'metrics':
          isResolved = intent.metrics?.length > 0;
          break;
        default:
          isResolved = intent.filters?.some(f => f.field === slot);
          if (!isResolved && intent.original_query) {
            const queryLower = intent.original_query.toLowerCase();
            if (queryLower.includes(slot.toLowerCase()) ||
                queryLower.includes(slot.replace('_', '').toLowerCase())) {
              isResolved = true;
            }
          }
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

    if (pendingConfirmations.length > 0) {
      missing.push(...pendingConfirmations.filter(m => !missing.includes(m)));
    }
  }

  return {
    complete: missing.length === 0,
    missing: missing,
    pendingConfirmations: pendingConfirmations
  };
}

async function generateClarification(intent, missing) {
  const prompt = `用户查询: "${intent.original_query}"

已识别的信息:
${JSON.stringify(intent, null, 2)}

缺失的信息: ${missing.join(', ')}

请生成一个友好的澄清问题，询问用户缺失的信息。同时，请分析需要用户确认的具体槽位（slots）。

要求：
1. 问题应该简洁明了，提供选项帮助用户快速回答
2. 为每个 slot 提供候选选项，并标记哪个是默认值（如果有合理默认值）
3. 必须返回JSON格式，包含澄清问题和结构化槽位信息

返回格式：
{
  "question": "澄清问题文本",
  "missingSlots": ["slot1", "slot2"],
  "slotDescriptions": {
    "slot1": "该槽位的简要说明"
  },
  "defaultOptions": [
    { "slot": "slot1", "value": "默认值", "label": "显示标签" }
  ]
}

注意：
- missingSlots 必须包含所有需要用户确认的业务槽位
- defaultOptions 用于标记推荐的默认选项，方便用户快速确认
- 如果用户回复"是""确认""按默认"等，系统将自动采用 defaultOptions 中的值`;

  try {
    const response = await llmService.simpleChat(prompt);
    const result = parseJSONResponse(response);

    logger.debug('生成澄清问题', {
      question: result.question,
      missingSlots: result.missingSlots,
      defaultOptions: result.defaultOptions
    });

    return {
      question: result.question || response.trim(),
      missingSlots: result.missingSlots || missing,
      slotDescriptions: result.slotDescriptions || {},
      defaultOptions: result.defaultOptions || []
    };
  } catch (error) {
    logger.error('生成澄清问题失败:', error);
    return {
      question: '请提供更多查询细节，例如时间范围、关注的指标等。',
      missingSlots: missing,
      slotDescriptions: {},
      defaultOptions: []
    };
  }
}

module.exports = {
  analyzeIntent,
  updateIntentWithLLM,
  checkIntentComplete,
  generateClarification,
  mergeIntent,
  enrichIntentWithClarificationContext,
  getRelevantTablesForIntent,
  getCoreHighFrequencyTables,
  getDialogueSummary,
  isAffirmativeClarificationReply,
  extractDefaultOptionsFromClarification
};
