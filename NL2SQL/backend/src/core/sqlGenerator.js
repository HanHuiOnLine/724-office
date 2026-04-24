/**
 * NL2SQL SQL 生成模块（Phase 4 · 任务 A.3）
 *
 * 职责：
 * - 根据 intent 构建 Prompt 并调用 LLM 生成 SQL
 * - 候选表信号融合（向量 / 语义 / 关键词 / 显式 / 推断）由 `tableRanker` 统一打分
 * - LIMIT 强制注入（调用 `sqlLimit.ensureLimit`）
 * - Schema 业务映射提示（帮助 LLM 理解业务术语与表/字段的对应）
 *
 * 保留项（Phase 2 legacy，Phase 4 不清理）：
 * - `FF_UNIFIED_RANKER=false` 分支：回退到 Set + slice(0, 5)
 * - `FF_BUSINESS_SEMANTIC_LAYER=false` 分支：跳过语义层
 */

const config = require('./config');
const logger = require('../utils/logger');
const llmService = require('./llmService');
const schemaLoader = require('./schemaLoader');
const database = require('./database');
const safeLog = require('../utils/safeLog');
const { ensureLimit } = require('../utils/sqlLimit');
const tableRanker = require('./tableRanker');
const entityResolver = require('./entityResolver');

let semanticLayer = null;
try {
  semanticLayer = require('./semanticLayer');
} catch (e) {
  logger.warn('[NL2SQL] 语义层模块加载失败，将使用传统流程');
}

let featureFlags = null;
try {
  featureFlags = require('../../config/feature-flags');
} catch (e) {
  featureFlags = {
    isEnabled: () => false,
    shouldUseAgenticWorkflow: () => false,
    shouldUseLayeredSchema: () => false
  };
}

function parseJSONResponse(response) {
  return require('../utils/llmResponseParser').parseJSON(response, 'NL2SQLEngine');
}

// ============================================
// Schema 业务映射提示
// ============================================

function generateSchemaMappingHints(tableNames) {
  const hints = [];

  if (tableNames.some(t => t.includes('reg'))) {
    hints.push('- 注册时间 → tzpingtai_tz_sdk_log_pf_reg.create_time');
    hints.push('- 注册用户数 → COUNT(DISTINCT tzpingtai_tz_sdk_log_pf_reg.tz_account_id)');
  }

  if (tableNames.some(t => t.includes('login') || t.includes('act'))) {
    hints.push('- 登录时间 → tzpingtai_tz_sdk_log_pf_login.create_time');
    hints.push('- 登录用户数 → COUNT(DISTINCT tzpingtai_tz_sdk_log_pf_login.tz_account_id)');
  }

  if (tableNames.some(t => t.includes('order'))) {
    hints.push('- 充值金额/订单金额 → tzpingtai_tz_sdk_log_pf_order.real_amount');
    hints.push('- 累计充值 → SUM(tzpingtai_tz_sdk_log_pf_order.real_amount)');
    hints.push('- 付费用户数 → COUNT(DISTINCT tzpingtai_tz_sdk_log_pf_order.tz_account_id)');
  }

  if (tableNames.some(t => t.includes('chat'))) {
    hints.push('- 发言内容/聊天记录 → tzhlxxyi_log_game_user_chat.msg');
    hints.push('- 发言时间 → tzhlxxyi_log_game_user_chat.create_time');
  }

  if (hints.length === 0) return '';

  return `\nSchema业务映射提示:\n${hints.join('\n')}\n`;
}

// ============================================
// SQL 生成主流程
// ============================================

async function generateSQL(intent, history = [], userId = null) {
  logger.debug('开始生成SQL', { intent, userId });

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

  // ============================================
  // 【Phase 2】业务语义层匹配
  // ============================================
  let semanticLayerTables = [];
  let semanticTableObjects = [];
  let semanticLayerInfo = '';

  if (semanticLayer && featureFlags.isEnabled('BUSINESS_SEMANTIC_LAYER')) {
    try {
      const matchedConcepts = semanticLayer.matchConcepts(intent.original_query || '');

      const tableRecommendation = semanticLayer.recommendTables(matchedConcepts);
      semanticTableObjects = tableRecommendation.tables || [];
      semanticLayerTables = semanticTableObjects.map(t => t.tableName);

      if (matchedConcepts.length > 0) {
        semanticLayerInfo = '\n## 业务语义映射（重要）\n';
        for (const concept of matchedConcepts) {
          const mappings = concept.config?.mappings || {};
          if (mappings.datasource) {
            semanticLayerInfo += `- "${concept.name}" 对应数据库标识: ${mappings.datasource}\n`;
          }
          if (mappings.primary_table) {
            semanticLayerInfo += `- "${concept.name}" 推荐使用表: ${mappings.primary_table}\n`;
          }
          if (mappings.field) {
            semanticLayerInfo += `- "${concept.name}" 对应字段: ${mappings.field}\n`;
          }
        }

        logger.info('[SQL生成] 语义层匹配结果', {
          matchedConcepts: matchedConcepts.map(c => c.name),
          recommendedTables: semanticLayerTables
        });
      }
    } catch (e) {
      logger.warn('[SQL生成] 语义层处理失败:', e);
    }
  }

  // ============================================
  // 【Phase 2】表候选检索 + tableRanker 统一打分
  // ============================================
  const inferredTables = entityResolver.inferTablesFromQuery(intent.original_query);

  let tableNames;

  if (featureFlags.isEnabled('UNIFIED_RANKER')) {
    const raw = await schemaLoader.searchRelevantTables(
      intent.original_query,
      16,
      context,
      { returnRawSignals: true }
    );
    const rankResult = tableRanker.rank(intent.original_query, {
      vectorResults:  raw.vectorResults || [],
      semanticTables: semanticTableObjects,
      keywordMatches: [],
      inferredTables,
      explicitTables: raw.explicitTableNames || []
    }, { cap: 8 });
    tableNames = rankResult.selected;
    logger.info('[SQL生成] tableRanker 选表', {
      ...rankResult.debug,
      selected: tableNames,
      topScores: rankResult.ranked.slice(0, 5).map(r => ({
        name: r.name, score: Math.round(r.finalScore), core: r.isCore, src: r.sources
      }))
    });
  } else {
    const relevantTables = await schemaLoader.searchRelevantTables(
      intent.original_query,
      3,
      context
    );
    const allTableNames = new Set([
      ...relevantTables.map(t => t.name),
      ...inferredTables,
      ...semanticLayerTables
    ]);
    tableNames = [...allTableNames].slice(0, 5);
    logger.info('[SQL生成] legacy 选表(UNIFIED_RANKER=false)', { tableNames });
  }

  const schemaDetail = schemaLoader.getTableSchemaDetailCompact(tableNames, intent);

  const schemaMappingHints = generateSchemaMappingHints(tableNames);

  logger.debug('[SQL生成] Schema详细信息摘要', {
    tableCount: tableNames.length,
    ...safeLog.summarizePrompt(schemaDetail)
  });

  logger.debug('[SQL生成] Schema映射提示摘要', safeLog.summarizePrompt(schemaMappingHints));

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

  let fieldAliasesInfo = '';
  if (userId) {
    try {
      const allAliases = await database.getFieldAliases(userId);

      if (allAliases.length > 0) {
        const queryLower = (intent.original_query || '').toLowerCase();

        const exactHits = allAliases.filter(a => {
          const content = typeof a.content === 'string' ? JSON.parse(a.content) : a.content;
          return queryLower.includes((content.user_term || '').toLowerCase());
        });

        const intentFields = new Set(
          (intent.filters || []).map(f => f.field)
        );
        const exactIds = new Set(exactHits.map(a => a.id));
        const intentHits = allAliases.filter(a => {
          if (exactIds.has(a.id)) return false;
          const content = typeof a.content === 'string' ? JSON.parse(a.content) : a.content;
          return intentFields.has(content.schema_field) || intentFields.has(content.field_type);
        });

        const usedIds = new Set([...exactHits, ...intentHits].map(a => a.id));
        const highFreq = allAliases.filter(a => !usedIds.has(a.id)).slice(0, 5);

        const relevantAliases = [...exactHits, ...intentHits, ...highFreq].slice(0, 20);

        fieldAliasesInfo = '\n用户定义的字段别名（重要，必须遵守）:\n';
        for (const alias of relevantAliases) {
          const content = typeof alias.content === 'string' ? JSON.parse(alias.content) : alias.content;

          if (content.field_type === 'datasource') {
            fieldAliasesInfo += `- 当用户说"${content.user_term}"时，指的是数据库标识: ${content.schema_field}，SQL中必须使用 FROM ${content.schema_field}.表名\n`;
          }
          else if (!isNaN(Number(content.schema_field))) {
            fieldAliasesInfo += `- 当用户说"${content.user_term}"时，指的是 game_id = ${content.schema_field}，SQL中必须使用 WHERE game_id = ${content.schema_field}\n`;
          }
          else {
            fieldAliasesInfo += `- 当用户说"${content.user_term}"时，指的是字段: ${content.schema_field}\n`;
          }
        }
        logger.info('[SQL生成] 加载用户字段别名', {
          userId,
          totalAliases: allAliases.length,
          relevantAliases: relevantAliases.length,
          exactHits: exactHits.length
        });
      }
    } catch (e) {
      logger.debug('[SQL生成] 加载字段别名失败:', e.message);
    }
  }

  const systemPrompt = `你是一位SQL专家，负责将用户的查询需求转换为标准SQL语句。

可用表结构:
${schemaDetail}
${schemaMappingHints}${semanticLayerInfo}
预定义指标:
${metricsInfo}${clarifiedInfo}${fieldAliasesInfo}

SQL生成规则:
1. 只使用SELECT语句，禁止任何DML操作（UPDATE/DELETE/INSERT等）
2. 使用标准SQL语法，兼容MySQL
3. **表名和字段名必须使用上面"可用表结构"中提供的实际数据库名称（英文），禁止使用中文表名或字段名，禁止虚构表名（如orders、transactions等）**
4. 如果"收入金额"指标对应的表是tzpingtai_tz_sdk_log_pf_order，则必须使用这个表名，不能使用orders或其他别名
5. 时间字段使用适当的日期函数（DATE_FORMAT, DATE_SUB, CURDATE等）
6. **【硬性约束】LIMIT 必须存在**：
   - 每条 SQL 必须以 "LIMIT N" 结尾，N ≤ 1000
   - 即使是 COUNT / SUM / 聚合查询也必须带 LIMIT
   - 未指定条数时默认使用 "LIMIT 1000"
   - 反例（会被拒绝）：
     * SELECT COUNT(*) FROM tzpingtai_tz_sdk_log_pf_order;  ← 缺 LIMIT
     * SELECT * FROM t ORDER BY id DESC;                    ← 缺 LIMIT
7. 复杂的查询使用CTE（WITH子句）提高可读性
8. 添加适当的注释说明
9. **禁止使用 SELECT ***：必须根据需求明确列出所需的字段名，显式声明每个字段
10. **JOIN 策略**：默认使用 LEFT JOIN 以防止基础数据（如注册用户）丢失，除非用户明确要求交集（如"只查付费用户"）才使用 INNER JOIN
11. **日期口径标准**：
    - "今日"：CURDATE()
    - "昨日"：DATE_SUB(CURDATE(), INTERVAL 1 DAY)
    - "本周"：YEARWEEK(create_time) = YEARWEEK(CURDATE())
    - "上周"：YEARWEEK(create_time) = YEARWEEK(DATE_SUB(CURDATE(), INTERVAL 7 DAY))
    - "本月"：YEAR(create_time) = YEAR(CURDATE()) AND MONTH(create_time) = MONTH(CURDATE())
    - "上个月"（自然月）：YEAR(create_time) = YEAR(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) AND MONTH(create_time) = MONTH(DATE_SUB(CURDATE(), INTERVAL 1 MONTH))
    - "最近N天"：create_time >= DATE_SUB(CURDATE(), INTERVAL N DAY)

【P3】智能推理规则（基于Schema信息）：
- **表名推断**：根据"可用表结构"中的表描述和字段含义，智能推断用户查询对应的表
  - 例如：用户提到"注册时间"，应该使用"平台注册表"(tzpingtai_tz_sdk_log_pf_reg)的create_time字段
  - 例如：用户提到"充值/付费/订单"，应该使用"平台订单表"(tzpingtai_tz_sdk_log_pf_order)的real_amount字段
  - 例如：用户提到"登录"，应该使用"平台登录表"(tzpingtai_tz_sdk_log_pf_login)的create_time字段
  - 例如：用户提到"发言/聊天"，应该使用"游戏用户聊天表"(tzhlxxyi_log_game_user_chat)的msg字段
- **字段推断**：根据字段的中文名称(name_cn)和描述(description)，匹配用户查询中的业务术语
  - 例如：用户说"账号ID"，对应字段tz_account_id
  - 例如：用户说"角色ID"，对应字段role_id
  - 例如：用户说"充值金额"，对应字段real_amount
- **多表关联**：如果查询涉及多个表（如注册表+充值表），使用JOIN关联，关联字段通常是tz_account_id或game_id

【P3】严格约束 - 仅在无法推断时才询问：
- **禁止猜测 game_id**：如果用户提到游戏名称（如"华夏"、"青木"）但未提供 game_id，且长期记忆中也没有该映射，必须返回 needClarification
- **禁止猜测时间范围**：如果意图中 time_range 为空或不明确，必须返回 needClarification，禁止默认使用"昨天"或"最近7天"
- **禁止猜测状态值**：如果不确定status字段的具体值代表什么（如1=成功还是0=成功），必须返回 needClarification
- **指标冲突处理**：如果用户提到的术语在 预定义指标 中存在（如 ROI、留存率、付费率等），必须严格按照指标公式计算，禁止自行通过原始字段求和或推导
- **空结果预防**：如果查询涉及 WHERE 条件过滤字符串（如渠道名、游戏名、状态描述），请使用 LIKE '%...%' 模糊匹配，或在 thought 中说明由于不确定精确名称，采用了模糊匹配策略
- **filters 最高优先级**：intent.filters 是最高优先级的约束。即使 SQL 推理认为需要过滤 A，但如果 filters 中提供了针对 A 字段的具体值，必须以 filters 为准

【重要】基于Schema的推理示例：
- 用户问："注册时间在2025年的用户" → 使用 tzpingtai_tz_sdk_log_pf_reg 表的 create_time 字段
- 用户问："累计充值金额" → 使用 tzpingtai_tz_sdk_log_pf_order 表的 real_amount 字段，SUM聚合
- 用户问："3月1日登录的用户" → 使用 tzpingtai_tz_sdk_log_pf_login 表的 create_time 字段
- 用户问："游戏内发言" → 使用 tzhlxxyi_log_game_user_chat 表的 msg 字段

智能推断规则（仅在信息明确时）：
- 如果用户提供了精确的标识符（如ID），优先使用并自动关联之前的模糊描述（如名称），直接生成SQL
- 只有在**所有必要信息都已明确**且**无歧义**时，才生成SQL
- 如果有任何不确定，必须返回 needClarification，并在 missingSlots 中列出所有缺失项

意图中的 filters 字段（重要）：
- intent.filters 数组中包含了已解析的筛选条件，格式为 [{"field": "game_id", "op": "=", "value": "30"}]
- 这些 filters 是系统已经解析好的精确条件，必须在生成的SQL的WHERE子句中使用
- 例如：如果 filters 中有 {"field": "game_id", "op": "=", "value": "30"}，则SQL必须包含 WHERE game_id = 30

## 复杂逻辑处理指南（通用）
1. **活跃行为交叉过滤**：
   - 若需求为“A时间段活跃但B时间段不活跃”，统一使用 "EXISTS" 与 "NOT EXISTS" 结构，以确保主表数据不因 JOIN 而收缩。
2. **多行明细合并**：
   - 提取“最近 N 次发言/操作”时，SQL 示例参考：
     "GROUP_CONCAT(msg ORDER BY create_time DESC)" 并在外部通过子查询截取，或使用 "ROW_NUMBER() OVER(PARTITION BY ...)"。
3. **金字塔筛选原则**：
   - 第一层：通过注册表/游戏 ID 圈定基础人群（WHERE）。
   - 第二层：通过聚合表（订单表）进行度量过滤（HAVING 或 子查询）。
   - 第三层：通过行为表（登录表/聊天表）进行行为判定。


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
  "missingSlots": ["缺失的信息项，如: game_id", "time_range"],
  "suggestions": ["建议选项1: 具体值或说明", "建议选项2: 具体值或说明"]
}

suggestions 字段说明：
- 当缺失的信息有候选值时（如多个游戏ID匹配），提供具体选项帮助用户快速选择
- 例如："华夏正式服 ID: 101"、"华夏测试服 ID: 102"、"昨天"、"最近7天"

重要：missingSlots 只列出真正无法从Schema推断的信息：
- 如果不知道游戏ID，包含 "game_id"
- 如果时间不明确，包含 "time_range"
- 不要包含可以从Schema推断的表名或字段名（如table_name、field_name）`;

  const userPrompt = `请根据以下意图生成SQL:

${JSON.stringify(intent, null, 2)}

只返回JSON，不要其他解释。`;

  try {
    const response = await llmService.simpleChat(userPrompt, systemPrompt);

    const result = parseJSONResponse(response);

    if (result.needClarification) {
      logger.info('SQL生成需要用户澄清', { question: result.clarificationQuestion });
      return result;
    }

    if (result.sql) {
      const r = ensureLimit(result.sql, config.security.maxQueryRows);
      result.sql = r.sql;
      if (r.injected) {
        logger.info('[SQL生成] LIMIT 自动注入', { maxRows: config.security.maxQueryRows });
      }
    }

    logger.debug('SQL生成完成', { sql: result.sql });
    return result;

  } catch (error) {
    logger.error('SQL生成失败:', error);
    throw new Error('SQL生成失败: ' + error.message);
  }
}

module.exports = {
  generateSQL,
  generateSchemaMappingHints
};
