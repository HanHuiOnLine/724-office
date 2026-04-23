/**
 * Agentic NL2SQL引擎（Phase 4: Multi-step Reasoning & Recovery）
 * 
 * 核心功能：
 * 1. 整合前三个Phase，实现四阶段Agentic工作流
 * 2. 实现 Plan → Act → Observe 循环
 * 3. 支持自我修正和错误恢复
 * 
 * 四阶段流程：
 * - Phase 1: Planning + Tool-Augmented Schema Discovery
 * - Phase 2: Dynamic Intent Decomposition
 * - Phase 3: Clarification + Confirmation
 * - Phase 4: Generation + Verification + Recovery
 */

// ============================================
// 导入依赖模块
// ============================================

const llmService = require('./llmService');
const schemaTools = require('./schemaTools');
const schemaLoader = require('./schemaLoader');
const toolLoop = require('./toolLoop');
const queryDecomposer = require('./queryDecomposer');
const semanticLayer = require('./semanticLayer');
const clarificationEngine = require('./clarificationEngine');
const logger = require('../utils/logger');
const config = require('./config');
const featureFlags = require('../../config/feature-flags');

// ============================================
// 配置常量
// ============================================

/**
 * 最大重试次数
 */
const MAX_RETRIES = 3;

/**
 * 验证失败时的最大恢复尝试次数
 */
const MAX_RECOVERY_ATTEMPTS = 2;

// ============================================
// Agentic引擎主类
// ============================================

/**
 * Agentic NL2SQL引擎
 */
class AgenticNL2SQLEngine {
  constructor() {
    this.logger = logger;
  }
  
  /**
   * 处理查询（主入口）
   * 
   * @param {string} userQuery - 用户查询
   * @param {Object} context - 上下文信息
   * @param {Array} context.history - 对话历史
   * @param {string} context.userId - 用户ID
   * @param {string} context.sessionId - 会话ID
   * @param {Function} onProgress - 进度回调
   * @returns {Promise<Object>} 处理结果
   */
  async processQuery(userQuery, context = {}, onProgress = null) {
    const startTime = Date.now();
    const traceLog = [];
    
    logger.info('[AgenticEngine] 开始处理查询', {
      query: userQuery,
      sessionId: context.sessionId
    });
    
    try {
      // ============================================
      // Phase 1: Planning + Tool-Augmented Schema Discovery
      // ============================================
      sendProgress(onProgress, 'planning', '规划查询策略...');
      
      const plan = await this.planningPhase(userQuery, context);
      traceLog.push({ phase: 'planning', result: plan });
      
      // Schema发现（使用工具探索）
      const schemaContext = await this.schemaDiscoveryPhase(plan, context);
      traceLog.push({ phase: 'schema_discovery', result: schemaContext });
      
      // ============================================
      // Phase 2: Dynamic Intent Decomposition
      // ============================================
      sendProgress(onProgress, 'decomposing', '拆解查询意图...');
      
      const decomposition = await this.decompositionPhase(userQuery, plan, context);
      traceLog.push({ phase: 'decomposition', result: decomposition });
      
      // 基于分解结果检索表
      const tableResult = await queryDecomposer.retrieveTablesByDataUnits(decomposition);
      traceLog.push({ phase: 'table_retrieval', result: tableResult });
      
      // ============================================
      // Phase 3: Clarification + Confirmation
      // ============================================
      sendProgress(onProgress, 'clarifying', '检查是否需要澄清...');
      
      const clarificationResult = await this.clarificationPhase(decomposition, tableResult);
      traceLog.push({ phase: 'clarification', result: clarificationResult });
      
      // 如果需要澄清，返回澄清问题
      if (clarificationResult.needsClarification) {
        return {
          success: true,
          type: 'clarification',
          clarification: clarificationResult.clarification,
          decomposition,
          tableCandidates: tableResult.tableCandidates,
          traceLog,
          duration: Date.now() - startTime
        };
      }
      
      // ============================================
      // Phase 4: Generation + Verification + Recovery
      // ============================================
      sendProgress(onProgress, 'generating', '生成SQL...');
      
      let sqlResult = await this.generationPhase(
        decomposition, 
        tableResult, 
        schemaContext, 
        context
      );
      traceLog.push({ phase: 'generation', result: sqlResult });
      
      // 验证SQL
      sendProgress(onProgress, 'verifying', '验证SQL...');
      const verification = await this.verificationPhase(sqlResult);
      traceLog.push({ phase: 'verification', result: verification });
      
      // 如果验证失败，尝试恢复
      if (!verification.success) {
        logger.warn('[AgenticEngine] SQL验证失败，尝试恢复');
        
        sqlResult = await this.recoveryPhase(
          verification.error, 
          decomposition, 
          schemaContext,
          context
        );
        traceLog.push({ phase: 'recovery', result: sqlResult });
      }
      
      // 返回最终结果
      return {
        success: sqlResult.success,
        type: 'sql_result',
        sql: sqlResult.sql,
        explanation: sqlResult.explanation,
        selectedTables: sqlResult.selectedTables,
        decomposition,
        verification,
        traceLog,
        duration: Date.now() - startTime
      };
      
    } catch (error) {
      logger.error('[AgenticEngine] 查询处理失败:', error);
      
      return {
        success: false,
        type: 'error',
        error: error.message,
        traceLog,
        duration: Date.now() - startTime
      };
    }
  }
  
  // ============================================
  // Phase 1: Planning
  // ============================================
  
  /**
   * 规划阶段
   */
  async planningPhase(userQuery, context) {
    logger.debug('[AgenticEngine] Phase 1: Planning');
    
    const planningPrompt = `分析以下查询，制定执行计划：

查询: "${userQuery}"

请输出：
1. 需要查询哪些数据实体？
2. 涉及哪些筛选条件？
3. 需要哪些聚合或计算？
4. 潜在的风险点（如歧义、缺失信息）

返回JSON格式：
{
  "entities": ["玩家", "充值记录"],
  "filters": [{"field": "game_id", "value": "67"}],
  "aggregations": ["累计充值"],
  "risks": ["老平台需要确认数据源"],
  "estimatedComplexity": "high"
}`;
    
    try {
      const response = await llmService.simpleChat('', planningPrompt);
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      logger.warn('[AgenticEngine] 规划解析失败，使用默认计划');
    }
    
    // 返回默认计划
    return {
      entities: [],
      filters: [],
      aggregations: [],
      risks: [],
      estimatedComplexity: 'medium'
    };
  }
  
  /**
   * Schema发现阶段
   */
  async schemaDiscoveryPhase(plan, context) {
    logger.debug('[AgenticEngine] Phase 1: Schema Discovery');
    
    // 使用工具循环探索Schema
    const entities = plan.entities || [];
    const searchQuery = entities.join(' ');
    
    // 获取Level 1索引
    const level1Index = schemaTools.getLevel1Index();
    
    // 如果有工具循环功能，使用工具探索
    if (featureFlags.isEnabled('TOOL_LOOP_MODE')) {
      const toolResult = await toolLoop.executeToolLoop(searchQuery, {
        history: context.history || [],
        userId: context.userId,
        useLevel1Index: true
      });
      
      return {
        level1Index,
        toolExploration: toolResult
      };
    }
    
    // 否则使用传统方式
    return {
      level1Index,
      toolExploration: null
    };
  }
  
  // ============================================
  // Phase 2: Decomposition
  // ============================================
  
  /**
   * 分解阶段
   */
  async decompositionPhase(userQuery, plan, context) {
    logger.debug('[AgenticEngine] Phase 2: Decomposition');
    
    // 使用动态意图拆解
    if (featureFlags.isEnabled('DYNAMIC_INTENT_DECOMPOSITION')) {
      return await queryDecomposer.decomposeQueryDynamically(userQuery, context);
    }
    
    // 返回简单分解
    return {
      originalQuery: userQuery,
      primaryEntity: plan.entities?.[0] || '未知',
      dataUnits: [
        {
          id: 'unit_1',
          type: '整体查询',
          description: userQuery
        }
      ],
      estimatedComplexity: plan.estimatedComplexity || 'medium'
    };
  }
  
  // ============================================
  // Phase 3: Clarification
  // ============================================
  
  /**
   * 澄清阶段
   */
  async clarificationPhase(decomposition, tableResult) {
    logger.debug('[AgenticEngine] Phase 3: Clarification');
    
    // 检查是否需要澄清
    const checkResult = clarificationEngine.checkClarificationNeeded(
      decomposition,
      tableResult.tableCandidates,
      0.8 // 默认置信度
    );
    
    if (!checkResult.needsClarification) {
      return { needsClarification: false };
    }
    
    // 如果启用了澄清引擎，生成澄清问题
    if (featureFlags.isEnabled('CLARIFICATION_ENGINE')) {
      const clarification = await clarificationEngine.generateClarification(
        decomposition,
        tableResult.tableCandidates,
        checkResult.topTrigger
      );
      
      return {
        needsClarification: true,
        clarification,
        trigger: checkResult.topTrigger
      };
    }
    
    // 澄清引擎未启用，返回需要澄清但不生成问题
    return {
      needsClarification: true,
      clarification: null,
      trigger: checkResult.topTrigger
    };
  }
  
  // ============================================
  // Phase 4: Generation, Verification, Recovery
  // ============================================
  
  /**
   * SQL生成阶段
   */
  async generationPhase(decomposition, tableResult, schemaContext, context) {
    logger.debug('[AgenticEngine] Phase 4: Generation');

    // 【Phase 2】信任上游 queryDecomposer 已完成 tableRanker 排序+核心保护
    // 不再 slice(0, 5),空值降级到 schemaLoader 兜底
    let selectedTables = tableResult.recommendedTables || [];
    if (selectedTables.length === 0) {
      logger.warn('[AgenticEngine] recommendedTables 为空,降级走 schemaLoader 兜底');
      try {
        const fallback = await schemaLoader.searchRelevantTables(
          decomposition?.originalQuery || '',
          8
        );
        selectedTables = (fallback || []).map(t => t.name);
      } catch (e) {
        logger.warn('[AgenticEngine] schemaLoader 兜底失败', e);
      }
    }

    // 获取表的详细Schema
    const schemaDetail = schemaLoader.getLevel2Detail(selectedTables, { compact: true });
    
    // 构建SQL生成Prompt
    const sqlPrompt = this.buildSQLPrompt(decomposition, schemaDetail, context);
    
    try {
      const response = await llmService.simpleChat('', sqlPrompt);
      
      // 解析SQL
      const sqlResult = this.parseSQLResponse(response);
      sqlResult.selectedTables = selectedTables;
      
      return sqlResult;
    } catch (error) {
      return {
        success: false,
        error: error.message,
        sql: null
      };
    }
  }
  
  /**
   * 构建SQL生成Prompt
   *
   * 注入当前时间 / 最近对话 / 澄清记录 / 结构化 dataUnits,
   * 让 LLM 不再默认 2024,且能拿到上一轮已给出的物理约束(typeid/int_key*)。
   *
   * 回退:PROMPT_INJECT_NOW=false -> buildSQLPromptLegacy
   */
  buildSQLPrompt(decomposition, schemaDetail, context = {}) {
    if (process.env.PROMPT_INJECT_NOW === 'false') {
      return this.buildSQLPromptLegacy(decomposition, schemaDetail);
    }

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    // trimHistory 返回 { trimmed, history, removed };取 .history
    const tokenBudget = require('../utils/tokenBudget');
    const trimmed = tokenBudget.trimHistory(context.history || [], 3);
    const trimmedHistory = Array.isArray(trimmed) ? trimmed : (trimmed?.history || []);
    const recentHistory = trimmedHistory
      .filter(m => m && m.role === 'user' && typeof m.content === 'string')
      .map(m => `- user: ${m.content}`)
      .join('\n');

    const clarifications = (decomposition?.clarificationHistory || [])
      .slice(-5)
      .map(h => `Q: ${h.question || ''}\nA: ${h.answer || ''}`)
      .join('\n\n');

    const dataUnitLines = (decomposition?.dataUnits || [])
      .map(formatUnitVerbose)
      .join('\n');

    return `基于以下信息,生成 SQL 查询语句。

## 当前时间
${now}(所有相对时间/缺省年份以此为锚点)

## 查询需求(原文)
${decomposition?.originalQuery || ''}

## 对话上下文(最近 3 轮 user 消息)
${recentHistory || '(无)'}

## 澄清记录
${clarifications || '(无)'}

## 数据需求单元
${dataUnitLines || '(无)'}

## 可用表结构
${schemaDetail}

## 生成要求
1. 符合 MySQL 语法
2. 时间字段格式 YYYY-MM-DD HH:mm:ss
3. 用户给出的 typeid / int_key* 等物理约束必须落到 WHERE
4. 用户需求缺省年份时,使用"当前时间"的年份
5. 输出 JSON: { "sql": "...", "explanation": "...", "selectedTables": [...] }
`;
  }

  /**
   * 旧版 buildSQLPrompt(供 PROMPT_INJECT_NOW=false 回退)
   */
  buildSQLPromptLegacy(decomposition, schemaDetail) {
    return `基于以下信息，生成SQL查询语句。

## 查询需求
${decomposition.originalQuery}

## 数据需求单元
${decomposition.dataUnits?.map(u => `- ${u.type}: ${u.description}`).join('\n') || '无'}

## 可用表结构
${schemaDetail}

## 输出要求
1. 生成符合MySQL语法的SQL语句
2. 注意时间字段的格式
3. 使用正确的表名和字段名

## 输出格式
{
  "sql": "SELECT ...",
  "explanation": "SQL说明",
  "selectedTables": ["表名1", "表名2"]
}`;
  }
  
  /**
   * 解析SQL响应
   */
  parseSQLResponse(response) {
    const { parseJSON, extractSQL } = require('../utils/llmResponseParser');
    try {
      const parsed = parseJSON(response, 'AgenticEngine');
      return {
        success: true,
        sql: parsed.sql || '',
        explanation: parsed.explanation || '',
        selectedTables: parsed.selectedTables || []
      };
    } catch (e) {
      // 尝试直接提取SQL
      const sql = extractSQL(response);
      if (sql) {
        return {
          success: true,
          sql,
          explanation: '',
          selectedTables: []
        };
      }
    }

    return {
      success: false,
      error: '无法解析SQL',
      sql: null
    };
  }
  
  /**
   * 验证阶段
   */
  async verificationPhase(sqlResult) {
    logger.debug('[AgenticEngine] Phase 4: Verification');
    
    if (!sqlResult.success || !sqlResult.sql) {
      return {
        success: false,
        error: 'SQL生成失败'
      };
    }
    
    const checks = [];
    
    // 检查1：基本语法检查（简单关键字检查）
    const sql = sqlResult.sql.toUpperCase();
    const hasSelect = sql.includes('SELECT');
    const hasFrom = sql.includes('FROM');
    
    checks.push({
      type: 'basic_syntax',
      passed: hasSelect && hasFrom,
      message: hasSelect && hasFrom ? '基本语法正确' : '缺少SELECT或FROM关键字'
    });
    
    // 检查2：禁止的关键字
    const forbiddenKeywords = ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'ALTER', 'TRUNCATE'];
    const hasForbidden = forbiddenKeywords.some(kw => {
      const regex = new RegExp(`\\b${kw}\\b`, 'i');
      return regex.test(sqlResult.sql);
    });
    
    checks.push({
      type: 'security',
      passed: !hasForbidden,
      message: hasForbidden ? 'SQL包含禁止的操作' : '安全检查通过'
    });
    
    // 检查3：表存在性
    const tableNames = this.extractTableNames(sqlResult.sql);
    const tableChecks = tableNames.map(tableName => {
      const exists = schemaLoader.tableExists(tableName);
      return {
        type: 'table_exists',
        table: tableName,
        passed: exists
      };
    });
    
    checks.push(...tableChecks);
    
    // 汇总结果
    const allPassed = checks.every(c => c.passed);
    
    return {
      success: allPassed,
      checks,
      error: allPassed ? null : this.summarizeErrors(checks)
    };
  }
  
  /**
   * 从SQL中提取表名
   */
  extractTableNames(sql) {
    const matches = sql.match(/(?:FROM|JOIN)\s+(\w+)/gi) || [];
    return matches.map(m => m.replace(/(?:FROM|JOIN)\s+/i, '')).filter(Boolean);
  }
  
  /**
   * 汇总错误
   */
  summarizeErrors(checks) {
    const failedChecks = checks.filter(c => !c.passed);
    return failedChecks.map(c => c.message || c.type).join('; ');
  }
  
  /**
   * 恢复阶段
   */
  async recoveryPhase(error, decomposition, schemaContext, context) {
    logger.debug('[AgenticEngine] Phase 4: Recovery');
    
    // 分类错误
    const errorType = this.classifyError(error);
    
    switch (errorType) {
      case 'TABLE_NOT_FOUND':
        return await this.handleTableNotFound(error, decomposition, context);
        
      case 'SYNTAX_ERROR':
        return await this.handleSyntaxError(error, decomposition, context);
        
      default:
        return {
          success: false,
          error: `无法自动恢复: ${error}`,
          sql: null
        };
    }
  }
  
  /**
   * 分类错误
   */
  classifyError(error) {
    const errorMsg = (error?.message || error || '').toString();
    
    if (/Table .* doesn't exist|Unknown table/i.test(errorMsg)) {
      return 'TABLE_NOT_FOUND';
    }
    
    if (/Syntax error|Parse error/i.test(errorMsg)) {
      return 'SYNTAX_ERROR';
    }
    
    return 'UNKNOWN';
  }
  
  /**
   * 处理表不存在错误
   */
  async handleTableNotFound(error, decomposition, context) {
    logger.info('[AgenticEngine] 尝试处理表不存在错误');
    
    // 提取缺失的表名
    const match = (error?.message || '').match(/Table '([^']+)'/);
    const missingTable = match ? match[1] : null;
    
    if (!missingTable) {
      return { success: false, error: '无法识别缺失的表' };
    }
    
    // 搜索替代表
    const alternatives = await schemaLoader.searchRelevantTables(missingTable, 3);
    
    if (alternatives.length === 0) {
      return { success: false, error: '无法找到替代表' };
    }
    
    // 返回替代表信息
    return {
      success: true,
      sql: null,
      needsRegeneration: true,
      alternativeTables: alternatives.map(t => t.name),
      message: `原表 "${missingTable}" 不存在，建议使用: ${alternatives.map(t => t.name).join(', ')}`
    };
  }
  
  /**
   * 处理语法错误
   */
  async handleSyntaxError(error, decomposition, context) {
    logger.info('[AgenticEngine] 尝试处理语法错误');
    
    // 请求LLM修正
    const fixPrompt = `以下SQL存在语法错误，请修正：

错误信息: ${error}

原始查询需求: ${decomposition?.originalQuery}

请重新生成正确的SQL，返回JSON格式：
{
  "sql": "修正后的SQL",
  "explanation": "修正说明"
}`;
    
    try {
      const response = await llmService.simpleChat('', fixPrompt);
      return this.parseSQLResponse(response);
    } catch (e) {
      return { success: false, error: '语法修正失败' };
    }
  }
  
  /**
   * 应用用户澄清回答
   */
  async applyClarification(decomposition, clarification, userAnswer) {
    return clarificationEngine.applyClarificationResult(decomposition, clarification, userAnswer);
  }
}

// ============================================
// 辅助函数
// ============================================

/**
 * 发送进度更新
 */
function sendProgress(onProgress, step, message) {
  if (onProgress) {
    onProgress({ step, message });
  }
}

/**
 * 把一个 dataUnit 序列化为多行文本,尽量保留 filters / timeRange / metric / outputFields
 * 所有字段 optional,缺失则跳过对应行
 */
function formatUnitVerbose(u) {
  if (!u) return '';
  const lines = [`- [${u.type || '?'}] ${u.description || ''}`];
  if (Array.isArray(u.filters) && u.filters.length) {
    const parts = u.filters.map(f => {
      if (!f) return '';
      return `${f.field ?? '?'}${f.operator ?? '='}${f.value ?? ''}`;
    }).filter(Boolean);
    if (parts.length) lines.push(`  filters: ${parts.join(', ')}`);
  }
  if (u.timeRange && (u.timeRange.start || u.timeRange.end)) {
    lines.push(`  timeRange: ${u.timeRange.start || '?'} ~ ${u.timeRange.end || '?'} on ${u.timeRange.field || '?'}`);
  }
  if (u.metric) {
    lines.push(`  metric: ${u.metric} ${u.operator || ''} ${u.value ?? ''}`.trim());
  }
  if (Array.isArray(u.outputFields) && u.outputFields.length) {
    lines.push(`  outputFields: ${u.outputFields.join(', ')}`);
  }
  return lines.join('\n');
}

// ============================================
// 导出模块
// ============================================

module.exports = {
  AgenticNL2SQLEngine,
  
  // 便捷函数
  processQuery: async (userQuery, context, onProgress) => {
    const engine = new AgenticNL2SQLEngine();
    return engine.processQuery(userQuery, context, onProgress);
  },
  
  // 配置
  MAX_RETRIES,
  MAX_RECOVERY_ATTEMPTS
};
