/**
 * 长期记忆管理模块 (Layer 2)
 * 
 * 负责用户长期记忆的提取、存储、检索和维护
 * 包括：查询模式、字段别名、常用指标/维度偏好
 * 
 * 筛选策略：
 * 1. 只存储成功的、置信度>0.7的查询
 * 2. 排除过于具体的一次性查询
 * 3. 高频模式(7天内≥2次)或高价值模板(维度≥2且指标≥1)才存储
 */

// ============================================
// 导入依赖模块
// ============================================

const database = require('../core/database');
const logger = require('../utils/logger');
const llmService = require('../core/llmService');
const config = require('../core/config');
const evaluation = require('../utils/evaluation');
const memoryQueue = require('./memoryQueue');

// ============================================
// 常量定义（从配置读取，可覆盖）
// ============================================

// 筛选阈值
const THRESHOLDS = {
  MIN_CONFIDENCE: config.longTermMemory?.thresholds?.minConfidence || 0.7,
  MIN_DIMENSIONS_FOR_TEMPLATE: config.longTermMemory?.thresholds?.minDimensionsForTemplate || 2,
  MIN_METRICS_FOR_TEMPLATE: config.longTermMemory?.thresholds?.minMetricsForTemplate || 1,
  RECENT_DAYS_FOR_FREQUENCY: config.longTermMemory?.thresholds?.recentDaysForFrequency || 7,
  MIN_FREQUENCY_FOR_SIMPLE: config.longTermMemory?.thresholds?.minFrequencyForSimple || 2
};

// 偏好类型
const PREFERENCE_TYPES = {
  QUERY_PATTERN: 'query_pattern',
  FIELD_ALIAS: 'field_alias',
  METRIC_PREFERENCE: 'metric_preference',
  DIMENSION_PREFERENCE: 'dimension_preference'
};

// ============================================
// LLM智能提炼（新增）
// ============================================

/**
 * 使用LLM智能分析查询价值
 * 判断哪些内容值得存入长期记忆，区分用户个人偏好和通用知识
 * 
 * @param {string} userQuery - 用户原始查询
 * @param {Object} intent - 意图分析结果
 * @param {string} userId - 用户ID
 * @returns {Promise<Object>} {shouldStore: boolean, preferences: Array, isPersonal: boolean}
 */
async function analyzeWithLLM(userQuery, intent, userId) {
  // 如果禁用LLM分析，返回null让系统回退到逻辑判断
  if (!config.longTermMemory?.useLLMForExtraction) {
    return null;
  }
  
  try {
    const systemPrompt = `### Role
你是一位资深数据分析专家，负责审计 NL2SQL 系统的用户查询。你的任务是判断当前查询是否包含"知识增量"，以优化系统未来的意图识别（Intent Recognition）和实体解析（Entity Resolution）。

### Task
请分析用户的 userQuery 及其识别到的 intent 结构，判断其是否值得存入长期记忆，并按规定格式提取。

### 判定维度（按优先级排序）

1. **字段别名/映射 (field_alias)** - 最高优先级：
   - **游戏实体映射**：用户说明游戏名称与ID对应（例："青木是指 game_id=30"、"华夏对应 88"）。
     - 必须提取为：{ "user_term": "青木", "schema_field": "30", "field_type": "game" }
   - **数据源映射**：用户说明平台/数据源标识（例："新平台是 new_tzpingtai"、"老平台对应 new_tzpingtaiold"）。
     - 必须提取为：{ "user_term": "新平台", "schema_field": "new_tzpingtai", "field_type": "datasource" }
   - **字段别名**：用户为 Schema 字段起别名（例："营收就是指收入金额"）。
   - **记忆价值**：极高（直接影响实体解析）。
   - **注意**：只要用户明确声明了"A 对应 B"、"A 是 B"、"A 表示 B"，一律提取为 field_alias。

2. **分析习惯 (dimension_habit / metric_bundle)**：
   - 用户习惯查看的维度组合或特定指标（例："我习惯按渠道拆解流水"、"看 DAU 时必须带上 ROI"）。
   - **记忆价值**：高（用于补充缺省维度/指标）。
   - **触发信号**：用户明确说"我习惯..."、"以后都..."、"每次看XX都要..."

3. **业务逻辑定义 (filter_logic)** - 谨慎使用：
   - 用户定义的**通用**计算口径或过滤规则（例："统计流水时剔除测试账号"、"大区只看华东和华北"）。
   - **重要区分**：以下情况**不应**存为 filter_logic：
     - 某次查询中使用了特定表名（如"用 new_tzpingtai.tzpingtai_tz_sdk_log_pf_order 表"）→ 这是临时查询，不是通用规则
     - 某次查询中指定了特定 game_id（如"查 game_id=88 的数据"）→ 这是具体筛选，不是通用规则
   - **记忆价值**：仅当用户明确表达"以后都按这个规则"时才存储。

4. **通用/单次查询 (standard)**：
   - 任何人都会问的通用定义或无特殊偏好的单次取数（例："什么是 ROI"、"查一下去年的总利润"）。
   - **记忆价值**：低（无需存储，shouldStore: false）。

### Output JSON Format
{
  "shouldStore": boolean,      // 是否值得存入长期记忆
  "isPersonal": boolean,       // 是否为该用户特有的习惯/术语
  "confidence": float,         // 判断置信度 (0.0-1.0)，依据：用户表述的明确程度
  "reason": "推理路径：分析用户是否显式表达了某种映射、习惯或口径", 
  "extractedPreferences": [
    {
      "type": "field_alias|dimension_habit|metric_bundle|filter_logic",
      "content": {
        "user_term": "用户表达的词汇（如'青木'、'营收'）",
        "schema_field": "对应的数据库字段/指标名（如'game_id'、'收入金额'）",
        "mapping_value": "具体对应的值(如ID 30)，若无则不填",
        "logic": "逻辑描述（用于 filter_logic）",
        "associated_dimensions": ["关联维度数组（用于 metric_bundle）"]
      },
      "isPersonal": true
    }
  ]
}

### User Context
- 用户查询: "${userQuery}"
- 意图详情: 
  - 维度: ${JSON.stringify(intent.dimensions || [])}
  - 指标: ${JSON.stringify(intent.metrics || [])}
  - 过滤器: ${JSON.stringify(intent.filters || [])}
  - 时间范围: ${JSON.stringify(intent.time_range || {})}
  - 置信度: ${intent.confidence || 'unknown'}

### 判断准则（重要）

- **优先存储映射**：只要涉及"A 就是 B"、"A 代表 ID XX"、"XX 对应 game_id=YY"的表述，务必提取为 field_alias。
- **排除干扰**：如果查询只是普通的指标+维度组合（如"按天查流水"），除非用户带有"我习惯..."、"以后都..."等修饰词，否则 shouldStore 设为 false。
- **置信度评估**：
  - 0.9-1.0：用户明确声明习惯/映射（如"以后看XX都要..."、"XX就是YY"）
  - 0.7-0.8：用户暗示偏好，但不够明确
  - 0.5-0.6：可能是偏好，但不确定
  - <0.5：不应存储
- **单次查询不存**：包含具体时间（如"昨天"、"2024年1月"）且无习惯表达的查询，视为一次性查询。

### Examples
- **Case 1**: "青木是游戏名称，对应 game_id=30" 
  -> shouldStore: true, confidence: 0.95, type: field_alias, content: {"user_term": "青木", "schema_field": "30", "field_type": "game"}
  
- **Case 2**: "新平台的数据库标识是 new_tzpingtai，老平台是 new_tzpingtaiold"
  -> shouldStore: true, confidence: 0.95, type: field_alias, 提取两个偏好项:
     - {"user_term": "新平台", "schema_field": "new_tzpingtai", "field_type": "datasource"}
     - {"user_term": "老平台", "schema_field": "new_tzpingtaiold", "field_type": "datasource"}
  
- **Case 3**: "我想看上周的营收，按我们组习惯，营收里要剔除退款。" 
  -> shouldStore: true, confidence: 0.9, type: filter_logic, content: {"logic": "剔除退款订单", "field": "order_status", "op": "!=", "value": "refunded"}
  
- **Case 4**: "以后看转化率的时候，记得帮我带上'来源渠道'这个维度。" 
  -> shouldStore: true, confidence: 0.95, type: dimension_habit, content: {"user_term": "转化率", "associated_dimensions": ["来源渠道"]}
  
- **Case 5**: "什么是留存率？" 
  -> shouldStore: false, confidence: 0.1, reason: "通用知识查询，非个人偏好"
  
- **Case 6**: "查一下昨天的流水" 
  -> shouldStore: false, confidence: 0.2, reason: "单次查询，无习惯表达"
  
- **Case 7**: "华夏对应 game_id=88，悟道对应 game_id=66"
  -> shouldStore: true, confidence: 0.95, type: field_alias, 提取两个偏好项:
     - {"user_term": "华夏", "schema_field": "88", "field_type": "game"}
     - {"user_term": "悟道", "schema_field": "66", "field_type": "game"}

- **Case 8** (重要反例): 用户补充"用 new_tzpingtai.tzpingtai_tz_sdk_log_pf_order 表查 game_id=88 的数据"
  -> shouldStore: false, confidence: 0.3, reason: "这是单次查询的具体信息，不是通用规则。表名和特定game_id的组合是临时查询，不应存储为filter_logic"
  
- **Case 9** (重要反例): 用户提供了游戏ID映射表（如 Markdown 表格），但当前查询因缺少表名而需要澄清
  -> 即使查询不完整，也应该提取游戏映射为 field_alias，因为映射本身是高价值知识`;

    logger.info('[长期记忆] LLM智能分析提示词已更新', { userId });

    const response = await llmService.simpleChat('', systemPrompt);
    const result = parseJSONResponse(response);
    
    logger.info('[长期记忆] LLM智能分析结果', { 
      userId,
      shouldStore: result.shouldStore,
      isPersonal: result.isPersonal,
      reason: result.reason,
      preferenceCount: result.extractedPreferences?.length || 0
    });
    
    return result;
    
  } catch (error) {
    logger.error('[长期记忆] LLM分析失败，回退到逻辑判断:', error);
    return null; // 回退到逻辑判断
  }
}

/**
 * 解析LLM返回的JSON
 */
function parseJSONResponse(response) {
  return require('../utils/llmResponseParser').parseJSON(response, 'LongTermMemory');
}

// ============================================
// 筛选判断函数
// ============================================

/**
 * 判断查询是否过于具体（一次性查询）
 * @param {Object} intent - 意图分析结果
 * @returns {boolean} 是否过于具体
 */
function isTooSpecific(intent) {
  // 条件列表
  const conditions = [
    // 1. 有具体数值型 filters（如 game_id=30）
    intent.filters && intent.filters.length > 0 &&
      intent.filters.some(f => f.value && !isNaN(Number(f.value))),
    // 2. 有绝对时间范围
    intent.time_range && intent.time_range.type === 'absolute',
    // 3. 简单查询（维度+指标都≤1）
    (!intent.dimensions || intent.dimensions.length <= 1) &&
      (!intent.metrics || intent.metrics.length <= 1)
  ].filter(Boolean).length;

  // 任意 2 个条件满足即过滤（原来需要全部 3 个）
  if (conditions >= 2) {
    logger.debug('查询过于具体，不存储到长期记忆', {
      filters: intent.filters,
      timeRange: intent.time_range
    });
    return true;
  }

  return false;
}

/**
 * 评估存储价值
 * @param {string} userId - 用户ID
 * @param {Object} intent - 意图分析结果
 * @returns {Promise<Object>} {shouldStore: boolean, reason: string}
 */
async function evaluateStorageValue(userId, intent) {
  // 1. 高价值模板：维度≥2且指标≥1
  const dimensions = intent.dimensions || [];
  const metrics = intent.metrics || [];
  
  if (dimensions.length >= THRESHOLDS.MIN_DIMENSIONS_FOR_TEMPLATE &&
      metrics.length >= THRESHOLDS.MIN_METRICS_FOR_TEMPLATE) {
    return { 
      shouldStore: true, 
      reason: 'high_value_template',
      type: PREFERENCE_TYPES.QUERY_PATTERN
    };
  }
  
  // 2. 检查是否是高频模式（7天内相似查询≥2次）
  const recentCount = await database.getRecentPatternCount(
    userId, 
    PREFERENCE_TYPES.QUERY_PATTERN,
    THRESHOLDS.RECENT_DAYS_FOR_FREQUENCY
  );
  
  if (recentCount >= THRESHOLDS.MIN_FREQUENCY_FOR_SIMPLE) {
    return { 
      shouldStore: true, 
      reason: 'recurring_pattern',
      count: recentCount,
      type: PREFERENCE_TYPES.QUERY_PATTERN
    };
  }
  
  // 3. 简单查询但有一定价值（至少1维度或1指标）
  if (dimensions.length >= 1 || metrics.length >= 1) {
    // 简单查询需要更高频率才存储，这里先返回需要观察
    return { 
      shouldStore: false, 
      reason: 'simple_query_needs_more_frequency',
      type: PREFERENCE_TYPES.QUERY_PATTERN
    };
  }
  
  return { 
    shouldStore: false, 
    reason: 'low_value_query' 
  };
}

// ============================================
// 核心功能：偏好提取与存储
// ============================================

/**
 * 从查询意图中提取用户偏好（带智能筛选）
 * @param {string} userId - 用户ID
 * @param {Object} intent - 意图分析结果
 * @param {string} originalQuery - 原始查询
 * @param {Object} options - 可选参数
 *   - success: 查询是否成功
 *   - confidence: 意图置信度
 * @returns {Promise<Object>} {stored: boolean, reason: string, preferences: Array}
 */
async function extractAndStorePreferences(userId, intent, originalQuery, options = {}) {
  logger.info('[长期记忆] 开始提取用户偏好', { 
    userId, 
    query: originalQuery.substring(0, 50),
    success: options.success,
    confidence: options.confidence || intent.confidence
  });
  
  try {
    // 1. 前置过滤：查询必须成功
    if (!options.success) {
      logger.info('[长期记忆] ❌ 拒绝存储：查询未成功', { userId });
      return { stored: false, reason: 'query_failed', preferences: [] };
    }
    
    // 2. 前置过滤：置信度必须足够
    const confidence = options.confidence || intent.confidence || 0;
    if (confidence < THRESHOLDS.MIN_CONFIDENCE) {
      logger.info('[长期记忆] ❌ 拒绝存储：置信度不足', { 
        userId, 
        confidence: confidence.toFixed(2),
        threshold: THRESHOLDS.MIN_CONFIDENCE 
      });
      return { stored: false, reason: 'low_confidence', preferences: [] };
    }
    
    // 3. 排除过于具体的查询（一次性）
    if (isTooSpecific(intent)) {
      logger.info('[长期记忆] ❌ 拒绝存储：查询过于具体（一次性）', { 
        userId,
        filters: intent.filters,
        timeRange: intent.time_range
      });
      return { stored: false, reason: 'too_specific', preferences: [] };
    }
    
    logger.info('[长期记忆] ✅ 通过前置筛选', { 
      userId,
      dimensions: intent.dimensions,
      metrics: intent.metrics
    });
    
    const storedPreferences = [];

    // 4. 尝试使用LLM智能分析（如果启用）
    let llmAnalysis = null;
    let storageDecision = null;
    if (config.longTermMemory?.useLLMForExtraction) {
      logger.info('[长期记忆] 开始LLM智能分析', { userId });
      llmAnalysis = await analyzeWithLLM(originalQuery, intent, userId);
    }
    
    // 5. 根据LLM分析结果或逻辑判断进行存储
    if (llmAnalysis) {
      // 使用LLM的判断结果
      logger.info('[长期记忆] 使用LLM分析结果', { 
        userId,
        shouldStore: llmAnalysis.shouldStore,
        isPersonal: llmAnalysis.isPersonal,
        reason: llmAnalysis.reason
      });
      
      if (!llmAnalysis.shouldStore) {
        return { 
          stored: false, 
          reason: `llm_rejected: ${llmAnalysis.reason}`, 
          preferences: [],
          isPersonal: llmAnalysis.isPersonal
        };
      }
      
      // 存储LLM提取的偏好
      if (llmAnalysis.extractedPreferences) {
        for (const pref of llmAnalysis.extractedPreferences) {
          // 只存储个人偏好，通用知识不存储
          if (pref.isPersonal !== false) {
            const stored = await storeLLMExtractedPreference(userId, pref, originalQuery);
            if (stored) {
              storedPreferences.push(stored);
            }
          } else {
            logger.info('[长期记忆] 跳过通用知识存储', { 
              userId, 
              type: pref.type 
            });
          }
        }
      }
    } else {
      // 回退到逻辑判断
      logger.info('[长期记忆] 使用逻辑判断进行存储评估', { userId });

      storageDecision = await evaluateStorageValue(userId, intent);
      logger.info('[长期记忆] 存储价值评估结果', { 
        userId,
        shouldStore: storageDecision.shouldStore,
        reason: storageDecision.reason
      });
      
      if (storageDecision.shouldStore) {
        memoryQueue.enqueueMemoryStore(
          () => storeQueryPattern(userId, intent, originalQuery),
          {
            type: 'query_pattern',
            userId,
            meta: {
              query: (originalQuery || '').slice(0, 200),
              metrics: intent.metrics,
              dimensions: intent.dimensions,
              timestamp: Date.now()
            }
          }
        );
        logger.info('[长期记忆] 查询模式已入队（异步存储）', { userId });
      }
    }

    // 5. 提取并存储指标偏好（仅在逻辑判断路径且决定存储时）
    // LLM 路径已在上面处理了偏好提取，无需重复存储 metric/dimension
    if (!llmAnalysis && storageDecision?.shouldStore) {
      if (intent.metrics && intent.metrics.length > 0) {
        logger.info('[长期记忆] 指标偏好已入队（异步存储）', {
          userId,
          metrics: intent.metrics
        });
        for (const metric of intent.metrics) {
          memoryQueue.enqueueMemoryStore(
            () => storeMetricPreference(userId, metric, originalQuery),
            {
              type: 'metric_preference',
              userId,
              meta: {
                metric,
                query: (originalQuery || '').slice(0, 200),
                timestamp: Date.now()
              }
            }
          );
        }
      }

      // 6. 提取并存储维度偏好（异步）
      if (intent.dimensions && intent.dimensions.length > 0) {
        logger.info('[长期记忆] 维度偏好已入队（异步存储）', {
          userId,
          dimensions: intent.dimensions
        });
        for (const dimension of intent.dimensions) {
          memoryQueue.enqueueMemoryStore(
            () => storeDimensionPreference(userId, dimension, originalQuery),
            {
              type: 'dimension_preference',
              userId,
              meta: {
                dimension,
                query: (originalQuery || '').slice(0, 200),
                timestamp: Date.now()
              }
            }
          );
        }
      }
    }
    
    // 确定返回的reason
    const finalReason = llmAnalysis 
      ? `llm: ${llmAnalysis.reason}` 
      : storageDecision?.reason || 'unknown';
    
    logger.info('[长期记忆] 用户偏好提取完成', { 
      userId, 
      storedCount: storedPreferences.length,
      reason: finalReason,
      isPersonal: llmAnalysis?.isPersonal
    });
    
    return { 
      stored: storedPreferences.length > 0, 
      reason: finalReason,
      preferences: storedPreferences,
      isPersonal: llmAnalysis?.isPersonal
    };
    
  } catch (error) {
    logger.error('[长期记忆] 提取用户偏好失败:', error);
    return { stored: false, reason: 'error', error: error.message, preferences: [] };
  }
}

/**
 * 存储LLM提取的偏好
 * @param {string} userId - 用户ID
 * @param {Object} pref - LLM提取的偏好对象
 * @param {string} originalQuery - 原始查询
 * @returns {Promise<Object|null>} 存储的偏好记录
 */
async function storeLLMExtractedPreference(userId, pref, originalQuery) {
  try {
    switch (pref.type) {
      case 'query_pattern':
        return await storeQueryPattern(userId, pref.content, originalQuery);
      
      case 'field_alias':
        // 特殊处理：如果 schema_field 是伪字段（如 database_identifier），直接存用户术语->值
        const isPseudoField = ['database_identifier', 'platform_type', 'datasource'].includes(pref.content.schema_field);
        
        if (isPseudoField && pref.content.mapping_value) {
          // 直接存：用户术语 -> 实际值（如 新平台 -> new_tzpingtai）
          const directResult = await learnFieldAlias(
            userId,
            pref.content.user_term,
            pref.content.mapping_value,
            pref.content.field_type || 'datasource'
          );
          logger.info('[长期记忆] ✅ 数据源映射已存储（直接）', {
            userId,
            userTerm: pref.content.user_term,
            targetValue: pref.content.mapping_value,
            skippedPseudoField: pref.content.schema_field
          });
          return directResult;
        }
        
        // 正常字段别名映射（如 青木 -> game_id）
        const aliasResult = await learnFieldAlias(
          userId,
          pref.content.user_term,
          pref.content.schema_field,
          pref.content.field_type || 'metric'
        );
        // 如果存在 mapping_value（如 game_id=30），同时存储值映射
        if (aliasResult && pref.content.mapping_value) {
          await learnFieldAlias(
            userId,
            `${pref.content.user_term}_value`,
            String(pref.content.mapping_value),
            `${pref.content.field_type || 'game'}_value`
          );
          logger.info('[长期记忆] ✅ 实体值映射已存储', {
            userId,
            entity: pref.content.user_term,
            field: pref.content.schema_field,
            value: pref.content.mapping_value
          });
        }
        return aliasResult;
      
      case 'metric_preference':
      case 'metric_bundle':
        return await storeMetricPreference(userId, pref.content.field_name || pref.content.metric, originalQuery);
      
      case 'dimension_preference':
      case 'dimension_habit':
        // 支持关联维度的习惯存储（如 "看转化率时带上来源渠道"）
        const dimensionName = pref.content.field_name || pref.content.dimension || pref.content.user_term;
        const dimResult = await storeDimensionPreference(userId, dimensionName, originalQuery);
        // 如果有关联维度信息，额外存储为查询模式
        if (dimResult && pref.content.associated_dimensions && pref.content.associated_dimensions.length > 0) {
          await storeQueryPattern(userId, {
            name: `维度习惯: ${dimensionName}`,
            dimensions: pref.content.associated_dimensions,
            trigger_metric: dimensionName,
            sample_query: originalQuery
          }, originalQuery);
          logger.info('[长期记忆] ✅ 维度关联习惯已存储', {
            userId,
            trigger: dimensionName,
            associated: pref.content.associated_dimensions
          });
        }
        return dimResult;
      
      case 'entity_mapping':
        // 存储实体映射（如 青木 -> game_id=30）
        const entityResult = await learnFieldAlias(
          userId,
          pref.content.entity || pref.content.user_term,
          pref.content.field || 'game_id',
          pref.content.field_type || 'game'
        );
        // 同时存储值映射
        if (entityResult && pref.content.value) {
          await learnFieldAlias(
            userId,
            `${pref.content.entity || pref.content.user_term}_value`,
            String(pref.content.value),
            `${pref.content.field_type || 'game'}_value`
          );
        }
        return entityResult;
      
      case 'filter_logic':
        // 存储过滤逻辑作为查询模式的一部分
        logger.info('[长期记忆] 存储过滤逻辑偏好', { userId, filter: pref.content });
        return await storeQueryPattern(userId, {
          name: `过滤逻辑: ${pref.description || '自定义'}`,
          filter_logic: pref.content,
          sample_query: originalQuery
        }, originalQuery);
      
      default:
        logger.warn('[长期记忆] 未知的偏好类型', { type: pref.type });
        return null;
    }
  } catch (error) {
    logger.error('[长期记忆] 存储LLM提取偏好失败:', error);
    return null;
  }
}

/**
 * 存储查询模式
 * @param {string} userId - 用户ID
 * @param {Object} intent - 意图分析结果
 * @param {string} originalQuery - 原始查询
 * @returns {Promise<Object|null>} 存储的偏好记录
 */
async function storeQueryPattern(userId, intent, originalQuery) {
  try {
    // 生成模式名称（基于维度和指标）
    const dimensions = intent.dimensions || [];
    const metrics = intent.metrics || [];
    const patternName = generatePatternName(dimensions, metrics, intent.time_range);
    
    // 检查是否已存在相同模式
    const existing = await database.findExistingPreference(
      userId, 
      PREFERENCE_TYPES.QUERY_PATTERN, 
      patternName
    );
    
    if (existing) {
      // 更新使用次数
      await database.updatePreferenceUsage(existing.id);
      logger.debug('更新查询模式使用次数', { patternId: existing.id });
      return { ...existing, action: 'updated' };
    }
    
    // 创建新模式
    const pattern = {
      name: patternName,
      dimensions: dimensions,
      metrics: metrics,
      default_time_range: intent.time_range || null,
      filter_pattern: intent.filters || null,
      sample_query: originalQuery
    };
    
    const result = await database.addUserPreference(
      userId,
      PREFERENCE_TYPES.QUERY_PATTERN,
      pattern
    );
    
    logger.debug('存储查询模式', { userId, patternName });
    return { ...result, action: 'created' };
    
  } catch (error) {
    logger.error('存储查询模式失败:', error);
    return null;
  }
}

/**
 * 生成模式名称
 * @param {Array} dimensions - 维度列表
 * @param {Array} metrics - 指标列表
 * @param {Object} timeRange - 时间范围
 * @returns {string} 模式名称
 */
function generatePatternName(dimensions, metrics, timeRange) {
  const dimStr = dimensions.slice(0, 2).join('+');
  const metricStr = metrics.slice(0, 2).join('+');
  const timeStr = timeRange ? timeRange.value || timeRange.type : '';
  
  if (timeStr) {
    return `${timeStr}_${dimStr}_${metricStr}`;
  }
  return `${dimStr}_${metricStr}`;
}

/**
 * 存储指标偏好
 * @param {string} userId - 用户ID
 * @param {string} metric - 指标名称
 * @param {string} originalQuery - 原始查询
 * @returns {Promise<Object|null>} 存储的偏好记录
 */
async function storeMetricPreference(userId, metric, originalQuery) {
  try {
    // 检查是否已存在
    const existing = await database.findExistingPreference(
      userId,
      PREFERENCE_TYPES.METRIC_PREFERENCE,
      metric
    );
    
    if (existing) {
      await database.updatePreferenceUsage(existing.id);
      return { ...existing, action: 'updated' };
    }
    
    const content = {
      field_name: metric,
      last_query: originalQuery
    };
    
    const result = await database.addUserPreference(
      userId,
      PREFERENCE_TYPES.METRIC_PREFERENCE,
      content
    );
    
    return { ...result, action: 'created' };
    
  } catch (error) {
    logger.error('存储指标偏好失败:', error);
    return null;
  }
}

/**
 * 存储维度偏好
 * @param {string} userId - 用户ID
 * @param {string} dimension - 维度名称
 * @param {string} originalQuery - 原始查询
 * @returns {Promise<Object|null>} 存储的偏好记录
 */
async function storeDimensionPreference(userId, dimension, originalQuery) {
  try {
    // 检查是否已存在
    const existing = await database.findExistingPreference(
      userId,
      PREFERENCE_TYPES.DIMENSION_PREFERENCE,
      dimension
    );
    
    if (existing) {
      await database.updatePreferenceUsage(existing.id);
      return { ...existing, action: 'updated' };
    }
    
    const content = {
      field_name: dimension,
      last_query: originalQuery
    };
    
    const result = await database.addUserPreference(
      userId,
      PREFERENCE_TYPES.DIMENSION_PREFERENCE,
      content
    );
    
    return { ...result, action: 'created' };
    
  } catch (error) {
    logger.error('存储维度偏好失败:', error);
    return null;
  }
}

// ============================================
// 字段别名学习
// ============================================

/**
 * 学习字段别名映射
 * 当用户用非标准说法查询时，记录映射关系
 * @param {string} userId - 用户ID
 * @param {string} userTerm - 用户的说法
 * @param {string} schemaField - 对应的Schema字段
 * @param {string} fieldType - 字段类型：metric|dimension|filter
 * @returns {Promise<Object|null>} 存储的别名记录
 */
async function learnFieldAlias(userId, userTerm, schemaField, fieldType = 'metric') {
  try {
    if (!userTerm || !schemaField) {
      return null;
    }
    
    // 如果用户术语和Schema字段相同，不需要学习
    if (userTerm === schemaField) {
      return null;
    }
    
    // 检查是否已存在（使用更强的去重逻辑）
    const existing = await database.findExistingPreference(
      userId,
      PREFERENCE_TYPES.FIELD_ALIAS,
      userTerm
    );
    
    if (existing) {
      // 验证映射是否一致
      if (existing.content.schema_field === schemaField) {
        // 映射一致，更新使用次数
        await database.updatePreferenceUsage(existing.id);
        logger.debug('字段别名已存在，更新使用次数', { 
          userId, 
          userTerm, 
          schemaField,
          usageCount: existing.content.usage_count 
        });
        return { ...existing, action: 'updated' };
      } else {
        // 映射冲突，记录警告
        logger.warn('字段别名映射冲突', {
          userId,
          userTerm,
          existing: existing.content.schema_field,
          new: schemaField
        });
        // 冲突时不创建新记录，返回已有记录
        return { ...existing, action: 'conflict' };
      }
    }
    
    // 二次检查：确保没有重复记录（处理可能的并发或历史数据问题）
    const allAliases = await database.getUserPreferences(userId, PREFERENCE_TYPES.FIELD_ALIAS);
    const duplicate = allAliases.find(alias => 
      alias.content?.user_term === userTerm && 
      alias.content?.schema_field === schemaField
    );
    
    if (duplicate) {
      logger.warn('发现重复字段别名记录，更新使用次数', { 
        userId, 
        userTerm, 
        existingId: duplicate.id 
      });
      await database.updatePreferenceUsage(duplicate.id);
      return { ...duplicate, action: 'updated' };
    }
    
    const content = {
      user_term: userTerm,
      schema_field: schemaField,
      field_type: fieldType,
      confidence: 0.8  // 初始置信度
    };
    
    const result = await database.addUserPreference(
      userId,
      PREFERENCE_TYPES.FIELD_ALIAS,
      content
    );
    
    logger.info('学习字段别名', { userId, userTerm, schemaField });
    return { ...result, action: 'created' };
    
  } catch (error) {
    logger.error('学习字段别名失败:', error);
    return null;
  }
}

// ============================================
// 澄清轮即时学习（新增）
// ============================================

/**
 * 从用户文本中提取并学习映射关系
 * 专门处理澄清轮中的业务字典/映射表声明
 * 
 * 支持格式：
 * 1. Markdown表格：| 游戏ID | 游戏名称 | ...
 * 2. 键值对：新平台：new_tzpingtai / 新平台对应 new_tzpingtai
 * 3. 显式声明：华夏对应 game_id=88 / 青木是游戏名称，game_id=30
 * 
 * @param {string} userId - 用户ID
 * @param {string} text - 用户输入文本
 * @returns {Promise<Object>} { learned: Array, errors: Array }
 */
async function extractMappingsFromText(userId, text) {
  const learned = [];
  const errors = [];
  
  try {
    logger.info('[即时学习] 开始从文本提取映射', { userId, textLength: text?.length });
    
    if (!text || text.length < 10) {
      return { learned, errors };
    }
    
    // 1. 提取游戏ID映射（Markdown表格格式）
    const gameTableMatches = text.match(/\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|/g);
    if (gameTableMatches) {
      logger.info('[即时学习] 检测到游戏ID表格', { count: gameTableMatches.length });
      
      for (const match of gameTableMatches) {
        const parts = match.split('|').map(s => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
          const gameId = parts[0];
          const gameName = parts[1];
          
          // 验证 gameId 是纯数字
          if (/^\d+$/.test(gameId) && gameName.length > 0 && gameName.length < 50) {
            try {
              const result = await learnFieldAlias(userId, gameName, gameId, 'game');
              if (result) {
                learned.push({
                  type: 'game_mapping',
                  userTerm: gameName,
                  value: gameId,
                  action: result.action
                });
                logger.info('[即时学习] ✅ 游戏映射学习成功', { gameName, gameId });
              }
            } catch (e) {
              errors.push({ type: 'game_mapping', error: e.message });
            }
          }
        }
      }
    }
    
    // 2. 提取平台/数据源映射（键值对格式）
    const platformPatterns = [
      // 新平台：new_tzpingtai / 新平台对应 new_tzpingtai / 新平台的数据库标识是 new_tzpingtai
      /新平台[:：]\s*([a-zA-Z_][a-zA-Z0-9_]*)/i,
      /新平台(?:对应|的数据库标识是|数据库标识是)[:：]?\s*([a-zA-Z_][a-zA-Z0-9_]*)/i,
      // 老平台：new_tzpingtaiold / 老平台对应 new_tzpingtaiold
      /老平台[:：]\s*([a-zA-Z_][a-zA-Z0-9_]*)/i,
      /老平台(?:对应|的数据库标识是|数据库标识是)[:：]?\s*([a-zA-Z_][a-zA-Z0-9_]*)/i
    ];
    
    for (const pattern of platformPatterns) {
      const match = text.match(pattern);
      if (match) {
        const platformName = match[0].includes('新平台') ? '新平台' : '老平台';
        const dbIdentifier = match[1];
        
        try {
          const result = await learnFieldAlias(userId, platformName, dbIdentifier, 'datasource');
          if (result) {
            learned.push({
              type: 'datasource_mapping',
              userTerm: platformName,
              value: dbIdentifier,
              action: result.action
            });
            logger.info('[即时学习] ✅ 数据源映射学习成功', { platformName, dbIdentifier });
          }
        } catch (e) {
          errors.push({ type: 'datasource_mapping', error: e.message });
        }
        break; // 只匹配第一个
      }
    }
    
    // 3. 提取显式声明的 game_id 映射（如"华夏对应 game_id=88"）
    const explicitGamePatterns = [
      /([^，。\s]{2,20})\s*[:：]?(?:对应|是|表示|为)\s*game_id[=:]?\s*(\d+)/gi,
      /game_id[=:]?\s*(\d+)\s*[:：]?(?:对应|是|表示|为)\s*([^，。\s]{2,20})/gi
    ];
    
    for (const pattern of explicitGamePatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const gameName = match[1] || match[2];
        const gameId = match[2] || match[1];
        
        if (gameName && /^\d+$/.test(gameId)) {
          try {
            const result = await learnFieldAlias(userId, gameName.trim(), gameId, 'game');
            if (result) {
              learned.push({
                type: 'explicit_game_mapping',
                userTerm: gameName.trim(),
                value: gameId,
                action: result.action
              });
              logger.info('[即时学习] ✅ 显式游戏映射学习成功', { gameName: gameName.trim(), gameId });
            }
          } catch (e) {
            errors.push({ type: 'explicit_game_mapping', error: e.message });
          }
        }
      }
    }
    
    logger.info('[即时学习] 提取完成', { 
      userId, 
      learnedCount: learned.length, 
      errorCount: errors.length,
      types: learned.map(l => l.type)
    });
    
  } catch (error) {
    logger.error('[即时学习] 提取映射失败:', error);
    errors.push({ type: 'general', error: error.message });
  }
  
  return { learned, errors };
}

// ============================================
// 偏好检索（用于意图识别增强）
// ============================================

/**
 * 获取用户的查询偏好（用于意图识别增强）
 * @param {string} userId - 用户ID
 * @returns {Promise<Object>} 用户偏好汇总
 */
async function getUserPreferencesForIntent(userId) {
  try {
    // 获取各类偏好
    const [patterns, aliases, metrics, dimensions] = await Promise.all([
      database.getTopQueryPatterns(userId, 5),
      database.getFieldAliases(userId),
      database.getUserPreferences(userId, PREFERENCE_TYPES.METRIC_PREFERENCE, 10),
      database.getUserPreferences(userId, PREFERENCE_TYPES.DIMENSION_PREFERENCE, 10)
    ]);
    
    // 记录统计
    evaluation.recordMemoryHit('field_alias', aliases.length > 0);
    evaluation.recordMemoryHit('query_pattern', patterns.length > 0);
    evaluation.recordMemoryHit('metric_preference', metrics.length > 0);
    evaluation.recordMemoryHit('dimension_preference', dimensions.length > 0);
    
    // 提取常用指标和维度名称列表
    const metricNames = metrics.map(m => m.content?.field_name).filter(Boolean);
    const dimensionNames = dimensions.map(d => d.content?.field_name).filter(Boolean);
    
    return {
      patterns: patterns.map(p => p.content),
      aliases: aliases.map(a => a.content),
      metrics: metricNames,
      dimensions: dimensionNames,
      raw: {
        patterns,
        aliases,
        metrics,
        dimensions
      }
    };
    
  } catch (error) {
    logger.error('获取用户偏好失败:', error);
    return {
      patterns: [],
      aliases: [],
      metrics: [],
      dimensions: []
    };
  }
}

/**
 * 查找相似查询模板
 * @param {string} userId - 用户ID
 * @param {Object} currentIntent - 当前意图
 * @returns {Promise<Array>} 相似模板列表
 */
async function findSimilarTemplates(userId, currentIntent) {
  try {
    const patterns = await database.getTopQueryPatterns(userId, 20);
    
    // 计算相似度分数
    const scoredPatterns = patterns.map(pattern => {
      const content = pattern.content || {};
      let score = 0;
      
      // 维度匹配
      const patternDims = content.dimensions || [];
      const currentDims = currentIntent.dimensions || [];
      const dimOverlap = patternDims.filter(d => currentDims.includes(d)).length;
      score += dimOverlap * 2;
      
      // 指标匹配
      const patternMetrics = content.metrics || [];
      const currentMetrics = currentIntent.metrics || [];
      const metricOverlap = patternMetrics.filter(m => currentMetrics.includes(m)).length;
      score += metricOverlap * 3;
      
      // 时间范围匹配
      if (content.default_time_range && currentIntent.time_range) {
        if (content.default_time_range.type === currentIntent.time_range.type) {
          score += 1;
        }
      }
      
      // 使用频率加权
      score += Math.log(pattern.usage_count + 1);
      
      return { ...pattern, similarityScore: score };
    });
    
    // 按相似度排序，返回前5个
    return scoredPatterns
      .sort((a, b) => b.similarityScore - a.similarityScore)
      .slice(0, 5);
      
  } catch (error) {
    logger.error('查找相似模板失败:', error);
    return [];
  }
}

// ============================================
// 手动管理接口
// ============================================

/**
 * 手动存储查询模板
 * @param {string} userId - 用户ID
 * @param {Object} template - 模板对象
 * @returns {Promise<Object>} 存储的模板
 */
async function storeQueryTemplate(userId, template) {
  try {
    const content = {
      name: template.name || '自定义模板',
      dimensions: template.dimensions || [],
      metrics: template.metrics || [],
      default_time_range: template.default_time_range || null,
      filter_pattern: template.filter_pattern || null,
      is_manual: true
    };
    
    const result = await database.addUserPreference(
      userId,
      PREFERENCE_TYPES.QUERY_PATTERN,
      content
    );
    
    logger.info('手动存储查询模板', { userId, templateName: content.name });
    return result;
    
  } catch (error) {
    logger.error('手动存储查询模板失败:', error);
    throw error;
  }
}

/**
 * 删除用户偏好
 * @param {number} preferenceId - 偏好记录ID
 * @returns {Promise<boolean>} 是否删除成功
 */
async function deletePreference(preferenceId) {
  return await database.deleteUserPreference(preferenceId);
}

// ============================================
// 导出模块
// ============================================

module.exports = {
  // 核心功能
  extractAndStorePreferences,
  learnFieldAlias,
  storeQueryTemplate,
  
  // 澄清轮即时学习（新增）
  extractMappingsFromText,
  
  // 检索功能
  getUserPreferencesForIntent,
  findSimilarTemplates,
  
  // 管理功能
  deletePreference,
  
  // 常量
  PREFERENCE_TYPES,
  THRESHOLDS
};
