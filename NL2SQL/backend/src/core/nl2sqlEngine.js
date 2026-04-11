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
// 意图识别
// ============================================

/**
 * 分析用户查询意图（增强版：支持上下文理解）
 * 提取时间范围、维度、指标、筛选条件等
 * 
 * @param {string} userQuery - 用户的自然语言查询
 * @param {Array} history - 最近3-5轮对话历史（用于上下文理解）
 * @returns {Promise<Object>} 意图分析结果
 */
async function analyzeIntent(userQuery, history = []) {
  // 记录开始分析日志
  logger.debug('开始分析用户意图', { query: userQuery, historyLength: history.length });
  
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
  
  // 构造系统提示词
  const systemPrompt = `你是一位有记忆的数据分析助手，负责理解用户的数据查询需求。

你的任务是维护一个**持久化的查询状态**，结合【对话历史】和【当前输入】，判断用户在：
- **补充信息**：完善之前的查询（如提供ID、修改时间范围）
- **更换需求**：放弃之前的查询，开始新查询（如"算了，查XX"）
- **全新查询**：与之前无关的独立查询

数据库Schema概览:
${schemaSummary}
${contextSummary}

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

5. time_range: 识别时间范围，支持相对时间和绝对时间
6. dimensions: 识别分组维度（按什么维度查看，如按日期、按渠道）
7. filters: 识别筛选条件，如果用户提供了更精确的标识符（如ID），优先使用并自动关联之前的模糊描述
8. confidence: 置信度（0-1），信息越完整置信度越高

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

  const systemPrompt = `你是一位意图理解专家。你的任务是根据用户的新输入，更新当前的查询意图。

当前意图状态:
${JSON.stringify(previousIntent, null, 2)}

用户最新输入: "${newQuery}"

数据库Schema概览:
${schemaSummary}

请分析：
1. 用户是在补充信息（如提供game_id），还是在修改需求（如换指标）？
2. 如果是补充：将新信息合并到当前意图
3. 如果是修改：用新需求替换相关字段
4. 如果是完全新的查询：创建新意图

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
function checkIntentComplete(intent) {
  // 定义必要字段
  const requiredFields = ['time_range', 'metrics'];
  // 存储缺失的字段
  const missing = [];
  
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
  
  return {
    // 如果没有缺失字段且置信度足够，认为完整
    complete: missing.length === 0,
    // 返回缺失的字段列表
    missing: missing
  };
}

/**
 * 生成澄清问题
 * 根据缺失的信息生成询问用户的问题
 * 
 * @param {Object} intent - 意图分析结果
 * @param {Array} missing - 缺失的字段列表
 * @returns {Promise<string>} 澄清问题文本
 */
async function generateClarification(intent, missing) {
  // 构造提示词
  const prompt = `用户查询: "${intent.original_query}"

已识别的信息:
${JSON.stringify(intent, null, 2)}

缺失的信息: ${missing.join(', ')}

请生成一个友好的澄清问题，询问用户缺失的信息。问题应该：
1. 简洁明了
2. 提供选项帮助用户快速回答
3. 保持上下文连贯

直接返回问题文本，不要其他解释。`;

  try {
    // 调用LLM生成澄清问题
    const question = await llmService.simpleChat(prompt);
    logger.debug('生成澄清问题', { question });
    return question.trim();
  } catch (error) {
    logger.error('生成澄清问题失败:', error);
    // 返回默认澄清问题
    return '请提供更多查询细节，例如时间范围、关注的指标等。';
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
async function generateSQL(intent, history = []) {
  // 记录开始生成日志
  logger.debug('开始生成SQL', { intent });
  
  // 搜索相关表
  const relevantTables = await schemaLoader.searchRelevantTables(
    intent.original_query, 
    5
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
  
  // 从历史对话中提取已澄清的信息（如 game_id=30）
  let clarifiedInfo = '';
  if (history.length > 0) {
    // 提取用户确认过的关键信息
    const clarifications = history
      .filter(h => h.role === 'user' && (h.content.includes('id') || h.content.includes('是') || h.content.includes('对')))
      .slice(-3);
    if (clarifications.length > 0) {
      clarifiedInfo = '\n已确认的信息（来自历史对话）:\n' + 
        clarifications.map(h => `- ${h.content}`).join('\n');
    }
  }
  
  // 构造系统提示词
  const systemPrompt = `你是一位SQL专家，负责将用户的查询需求转换为标准SQL语句。

可用表结构:
${schemaDetail}

预定义指标:
${metricsInfo}${clarifiedInfo}

SQL生成规则:
1. 只使用SELECT语句，禁止任何DML操作（UPDATE/DELETE/INSERT等）
2. 使用标准SQL语法，兼容MySQL
3. **表名和字段名必须使用上面"可用表结构"中提供的实际数据库名称（英文），禁止使用中文表名或字段名，禁止虚构表名（如orders、transactions等）**
4. 如果"收入金额"指标对应的表是tzpingtai_tz_sdk_log_pf_order，则必须使用这个表名，不能使用orders或其他别名
5. 时间字段使用适当的日期函数（DATE_FORMAT, DATE_SUB, CURDATE等）
6. 添加LIMIT限制，默认不超过1000条
7. 复杂的查询使用CTE（WITH子句）提高可读性
8. 添加适当的注释说明

智能推断规则（重要）：
- 如果用户提供了更精确的标识符（如ID），优先使用并自动关联之前的模糊描述（如名称），直接生成SQL
- 只有在存在逻辑冲突或无法合理推断时，才需要询问用户确认
- 默认执行合理假设，不要事无巨细地确认
- 例如：用户说"青木的游戏id是30"，应直接使用game_id=30，无需再次确认是否忽略"青木"

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
  "thought": "为什么无法推断",
  "clarificationQuestion": "需要向用户确认的问题"
}`;

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
 * 完整的NL2SQL流程：意图识别 → 澄清 → SQL生成 → 执行 → 格式化
 * 
 * @param {string} userQuery - 用户查询
 * @param {string} sessionId - 会话ID
 * @param {Function} onProgress - 进度回调函数（可选）
 * @returns {Promise<Object>} 处理结果
 */
async function processQuery(userQuery, sessionId, onProgress = null) {
  // 记录开始处理日志
  logger.info('开始处理查询', { sessionId, query: userQuery });
  
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
    
    // ----------------------------------------
    // 步骤2: 意图识别（融合上下文）
    // ----------------------------------------
    sendProgress('analyzing', { message: '分析查询意图...' });
    
    // 获取最近5轮对话用于上下文理解
    const recentHistory = history.slice(-5);
    let intent = await analyzeIntent(userQuery, recentHistory);
    
    // 保存用户消息到会话
    await database.addMessage(sessionId, 'user', userQuery, 'text');
    
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
    }
    
    // ----------------------------------------
    // 步骤3: 检查是否需要澄清
    // ----------------------------------------
    const completeness = checkIntentComplete(intent);
    
    logger.info('意图完整性检查', {
      isComplete: completeness.complete,
      missing: completeness.missing,
      finalMetrics: intent.metrics,
      finalTimeRange: intent.time_range
    });
    
    if (!completeness.complete) {
      // 需要澄清，生成澄清问题
      sendProgress('clarifying', { message: '需要更多信息...' });
      const clarification = await generateClarification(intent, completeness.missing);
      
      // 保存澄清消息
      await database.addMessage(sessionId, 'assistant', clarification, 'clarify', {
        intent,
        missing: completeness.missing
      });
      
      return {
        success: true,
        type: 'clarify',
        message: clarification,
        intent,
        missing: completeness.missing
      };
    }
    
    // ----------------------------------------
    // 步骤4: 生成SQL（利用历史对话中已澄清的信息）
    // ----------------------------------------
    sendProgress('generating', { message: '生成SQL查询...' });
    const sqlResult = await generateSQL(intent, history);
    
    // 检查是否需要澄清（大模型无法确定某些信息）
    if (sqlResult.needClarification) {
      sendProgress('clarifying', { message: '需要确认信息...' });
      
      // 保存澄清消息
      await database.addMessage(sessionId, 'assistant', sqlResult.clarificationQuestion, 'clarify', {
        intent,
        clarificationType: 'schema_mismatch'
      });
      
      return {
        success: true,
        type: 'clarify',
        message: sqlResult.clarificationQuestion,
        intent,
        clarificationType: 'schema_mismatch'
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
