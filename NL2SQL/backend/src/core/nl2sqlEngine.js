/**
 * NL2SQL 核心引擎 —— 编排入口（Phase 4 · 任务 A.6）
 *
 * Phase 4 按职责拆分成 5 个子模块：
 * - `intentAnalyzer`：意图识别 / 澄清 / 上下文合并
 * - `entityResolver`：实体 ID 映射 / 平台识别 / 别名学习
 * - `sqlGenerator`：Prompt 构建 / LLM 生成 SQL / LIMIT 注入
 * - `sqlExecutor`：SQL 验证 / 执行 / 脱敏
 * - `resultFormatter`：自然语言总结
 *
 * 本文件保留 `processQuery` 主编排流程（含 Phase 1-3 审计埋点 / RLS 改写），
 * 以及 `NL2SQLError` 类。对外 `module.exports` 契约与 Phase 3 一致，
 * 上游 `sseHandler` / `agenticEngine` 无需改动。
 */

// ============================================
// 依赖
// ============================================

const config = require('./config');
const logger = require('../utils/logger');
const llmService = require('./llmService');
const schemaLoader = require('./schemaLoader');
const database = require('./database');
const tokenBudget = require('../utils/tokenBudget');
const safeLog = require('../utils/safeLog');
const sqlRewriter = require('../utils/sqlRewriter');
const summarizer = require('../memory/summarizer');
const longTermMemory = require('../memory/longTermMemory');
const vectorStore = require('../memory/vectorStore');

// Phase 4 拆分出的子模块
const intentAnalyzer = require('./intentAnalyzer');
const entityResolver = require('./entityResolver');
const sqlGenerator = require('./sqlGenerator');
const sqlExecutor = require('./sqlExecutor');
const resultFormatter = require('./resultFormatter');
const { summarizeResultForAudit } = require('./auditHelper');

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

// ============================================
// 错误类
// ============================================

class NL2SQLError extends Error {
  constructor(type, message, details = {}, isRecoverable = false) {
    super(message);
    this.name = 'NL2SQLError';
    this.type = type;
    this.details = details;
    this.isRecoverable = isRecoverable;
    this.timestamp = new Date().toISOString();

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, NL2SQLError);
    }
  }

  toLogObject() {
    return {
      errorType: this.type,
      message: this.message,
      details: this.details,
      isRecoverable: this.isRecoverable,
      timestamp: this.timestamp,
      stack: this.stack
    };
  }

  static entityResolution(entityName, entityType, reason) {
    return new NL2SQLError(
      'ENTITY_RESOLUTION',
      `无法解析实体: ${entityName}`,
      { entityName, entityType, reason },
      true
    );
  }

  static sqlValidation(sql, reason) {
    return new NL2SQLError(
      'VALIDATION',
      `SQL验证失败: ${reason}`,
      { sql, reason },
      false
    );
  }

  static sqlGeneration(intent, reason) {
    return new NL2SQLError(
      'SQL_GENERATION',
      `SQL生成失败: ${reason}`,
      { intent, reason },
      true
    );
  }
}

// ============================================
// 主流程编排
// ============================================

/**
 * 处理用户查询的主流程
 * 意图识别 → 澄清 → SQL 生成 → 验证 → RLS 改写 → 执行 → 脱敏 → 格式化 → 审计
 *
 * @param {string} userQuery - 用户查询
 * @param {string} sessionId - 会话ID
 * @param {Function} onProgress - 进度回调函数（可选）
 * @param {string} userId - 用户ID（用于长期记忆）
 * @param {Object} [context={}] - 请求上下文(Phase 3 · T1,含 userRole/tenantId/requestSource/requestIp)
 */
async function processQuery(userQuery, sessionId, onProgress = null, userId = null, context = {}) {
  if (!userId && context && context.userId) {
    userId = context.userId;
  }
  logger.info('开始处理查询', {
    sessionId,
    userId,
    tenantId: context && context.tenantId,
    query: safeLog.summarizePrompt(userQuery)
  });

  const traceId = `${sessionId}_${Date.now()}`;
  logger.startTrace(traceId, 'NL2SQL查询处理', {
    sessionId,
    userId,
    query: userQuery,
    timestamp: new Date().toISOString()
  });

  const sendProgress = (step, data) => {
    if (onProgress) {
      onProgress({ step, ...data });
    }
  };

  // 【Phase 3 · T3c】带入 context 审计字段
  const historyId = await database.createQueryHistory({
    sessionId,
    userId: userId || 'anonymous',
    naturalQuery: userQuery,
    userRole:      context && context.userRole,
    tenantId:      context && context.tenantId,
    requestSource: context && context.requestSource,
    requestIp:     context && context.requestIp
  });

  try {
    // ----------------------------------------
    // 步骤1: 获取会话历史
    // ----------------------------------------
    sendProgress('loading_history', { message: '加载会话历史...' });
    logger.traceStep(traceId, '加载会话历史', { sessionId }, 'start');

    let history = await database.getSessionMessages(sessionId, 20);
    logger.traceStep(traceId, '加载会话历史', { historyLength: history.length }, 'success');

    if (!userId) {
      const session = await database.getSession(sessionId);
      userId = session?.user_id || 'anonymous';
    }

    // ----------------------------------------
    // 步骤1.5: 对话历史压缩（如果过长）
    // ----------------------------------------
    const historyRounds = Math.floor(history.length / 2);
    if (historyRounds >= 8) {
      sendProgress('compressing_history', { message: '压缩对话历史...' });
      logger.traceStep(traceId, '对话历史压缩', { originalRounds: historyRounds }, 'start');

      logger.info('[NL2SQL] 对话历史较长，触发智能压缩', {
        sessionId,
        originalRounds: historyRounds
      });

      const compressResult = await summarizer.smartCompressHistory(sessionId, history, {
        triggerRounds: 8,
        preserveRecentRounds: 4
      });

      if (compressResult.compressed) {
        history = compressResult.history;
        logger.traceStep(traceId, '对话历史压缩', {
          compressed: compressResult.compressed,
          fromCache: compressResult.fromCache,
          stats: compressResult.stats
        }, 'success');
        logger.info('[NL2SQL] 对话历史压缩完成', {
          sessionId,
          compressed: compressResult.compressed,
          fromCache: compressResult.fromCache,
          stats: compressResult.stats
        });
      }
    }

    // ----------------------------------------
    // 步骤2: Token 预算检查
    // ----------------------------------------
    sendProgress('checking_budget', { message: '检查上下文预算...' });
    logger.traceStep(traceId, 'Token预算检查', {}, 'start');

    const schemaSummary = schemaLoader.getSchemaSummary();

    const budgetContext = {
      systemPrompt: schemaSummary + '\n' + (userQuery || ''),
      history: history,
      retrievedChunks: []
    };

    const budgetCheck = tokenBudget.calculateContextBudget(budgetContext);

    logger.traceStep(traceId, 'Token预算检查', {
      totalTokens: budgetCheck.breakdown.total,
      usageRatio: budgetCheck.budget.usageRatio,
      status: budgetCheck.status
    }, 'success');

    logger.info('[NL2SQL] Token 预算检查', {
      sessionId,
      totalTokens: budgetCheck.breakdown.total,
      usageRatio: budgetCheck.budget.usageRatio,
      status: budgetCheck.status
    });

    if (budgetCheck.status.isOverBudget || budgetCheck.status.isCritical) {
      logger.warn('[NL2SQL] 上下文超出预算，触发紧急压缩', {
        sessionId,
        totalTokens: budgetCheck.breakdown.total,
        suggestions: budgetCheck.suggestions
      });

      const compressionResult = tokenBudget.triggerCompression(budgetContext, budgetCheck);

      if (compressionResult.success) {
        history = compressionResult.context.history;
        logger.info('[NL2SQL] 紧急压缩完成', {
          sessionId,
          actions: compressionResult.actions,
          newTotalTokens: compressionResult.after.breakdown.total
        });
      }
    }

    // ----------------------------------------
    // 步骤3: 意图识别（融合上下文和长期记忆）
    // ----------------------------------------
    sendProgress('analyzing', { message: '分析查询意图...' });

    const recentHistory = history.slice(-5);
    logger.traceStep(traceId, '意图识别', { query: userQuery, historyLength: recentHistory.length }, 'start');

    let intent = await intentAnalyzer.analyzeIntent(userQuery, recentHistory, userId);

    logger.traceStep(traceId, '意图识别', {
      intent: {
        metrics: intent.metrics,
        timeRange: intent.time_range,
        dimensions: intent.dimensions,
        filters: intent.filters,
        confidence: intent.confidence,
        thought: intent.thought?.substring(0, 200) + '...'
      }
    }, 'success');

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

    logger.traceStep(traceId, '上下文查询检查', {
      lastAssistantType: lastAssistantMsg?.type,
      isContextualQuery: intent.isContextualQuery,
      hasHistoricalIntent: !!lastAssistantMsg?.metadata?.intent
    }, 'start');

    logger.info('检查上下文查询', {
      lastAssistantRole: lastAssistantMsg?.role,
      lastAssistantType: lastAssistantMsg?.type,
      currentIntentMetrics: intent.metrics,
      currentIntentConfidence: intent.confidence,
      isContextualQuery: intent.isContextualQuery,
      hasHistoricalIntent: !!lastAssistantMsg?.metadata?.intent
    });

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
      intent = await intentAnalyzer.updateIntentWithLLM(previousIntent, userQuery, recentHistory);

      logger.traceStep(traceId, '意图更新', {
        updateType: intent.updateType,
        previousQuery: previousIntent.original_query,
        newMetrics: intent.metrics,
        newTimeRange: intent.time_range,
        newConfidence: intent.confidence
      }, 'success');

      logger.info('意图更新后', {
        updateType: intent.updateType,
        mergedMetrics: intent.metrics,
        mergedTimeRange: intent.time_range,
        mergedConfidence: intent.confidence
      });

      await entityResolver.learnEntityAliasFromContext(userId, userQuery, intent, lastAssistantMsg);
    } else {
      logger.traceStep(traceId, '上下文查询检查', { isContextualQuery: false }, 'success');
    }

    intent = intentAnalyzer.enrichIntentWithClarificationContext(intent, userQuery, history);

    // ----------------------------------------
    // 步骤3: 检查是否需要澄清
    // ----------------------------------------
    logger.traceStep(traceId, '意图完整性检查', {}, 'start');
    const completeness = intentAnalyzer.checkIntentComplete(intent, historyWithCurrentUser);

    logger.traceStep(traceId, '意图完整性检查', {
      isComplete: completeness.complete,
      missing: completeness.missing,
      pendingConfirmations: completeness.pendingConfirmations
    }, completeness.complete ? 'success' : 'start');

    logger.info('意图完整性检查', {
      isComplete: completeness.complete,
      missing: completeness.missing,
      pendingConfirmations: completeness.pendingConfirmations,
      finalMetrics: intent.metrics,
      finalTimeRange: intent.time_range
    });

    if (!completeness.complete) {
      if (userId) {
        try {
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
        }
      }

      sendProgress('clarifying', { message: '需要更多信息...' });
      logger.traceStep(traceId, '生成澄清问题', { missing: completeness.missing }, 'start');

      const clarificationResult = await intentAnalyzer.generateClarification(intent, completeness.missing);

      logger.traceStep(traceId, '生成澄清问题', {
        question: clarificationResult.question?.substring(0, 100),
        missingSlots: clarificationResult.missingSlots
      }, 'success');

      await database.addMessage(sessionId, 'assistant', clarificationResult.question, 'clarify', {
        intent,
        missingSlots: clarificationResult.missingSlots || completeness.missing,
        defaultOptions: clarificationResult.defaultOptions || []
      });

      logger.endTrace(traceId, {
        type: 'clarify',
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
    // 步骤4: 生成SQL
    // ----------------------------------------
    sendProgress('generating', { message: '生成SQL查询...' });
    logger.traceStep(traceId, 'SQL生成', { intent: { metrics: intent.metrics, filters: intent.filters } }, 'start');

    const sqlResult = await sqlGenerator.generateSQL(intent, historyWithCurrentUser, userId);

    logger.traceStep(traceId, 'SQL生成', {
      needClarification: sqlResult.needClarification,
      sql: sqlResult.sql?.substring(0, 200) + '...',
      explanation: sqlResult.explanation?.substring(0, 100)
    }, sqlResult.needClarification ? 'start' : 'success');

    if (sqlResult.needClarification) {
      sendProgress('clarifying', { message: '需要确认信息...' });

      // 【P1】部分回答校验
      const lastAssistantMsg2 = [...history].reverse().find(h => h.role === 'assistant');
      const isDefaultConfirmation = intent.clarification_context?.answerType === 'confirm_default';
      const lastMissingSlots = isDefaultConfirmation ? [] : (lastAssistantMsg2?.metadata?.missingSlots || []);
      const currentMissingSlots = sqlResult.missingSlots || [];

      const answeredSlots = lastMissingSlots.filter(slot => !currentMissingSlots.includes(slot));
      const stillMissingSlots = currentMissingSlots;

      if (answeredSlots.length > 0 && stillMissingSlots.length > 0) {
        logger.info('[部分回答校验] 用户部分回答，继续追问剩余项', {
          answered: answeredSlots,
          stillMissing: stillMissingSlots
        });

        const partialClarification = `已收到：${answeredSlots.join('、')}。\n还需要确认：${stillMissingSlots.join('、')}。\n\n${sqlResult.clarificationQuestion}`;

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

      await database.addMessage(sessionId, 'assistant', sqlResult.clarificationQuestion, 'clarify', {
        intent,
        clarificationType: 'schema_mismatch',
        missingSlots: currentMissingSlots
      });

      logger.endTrace(traceId, {
        type: 'clarify',
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
    logger.traceStep(traceId, 'SQL验证', { sql: sqlResult.sql?.substring(0, 100) }, 'start');

    const validation = sqlExecutor.validateSQL(sqlResult.sql);

    if (!validation.valid) {
      logger.traceStep(traceId, 'SQL验证', { error: validation.error }, 'error');
      const errorMsg = `SQL验证失败: ${validation.error}`;
      await database.addMessage(sessionId, 'assistant', errorMsg, 'error');

      logger.endTrace(traceId, {
        type: 'error',
        error: validation.error
      });

      return {
        success: false,
        type: 'error',
        message: errorMsg,
        sql: sqlResult.sql
      };
    }

    logger.traceStep(traceId, 'SQL验证', { valid: true }, 'success');

    // ----------------------------------------
    // 【Phase 3 · T3b】行级权限 SQL 改写
    // ----------------------------------------
    let finalSql = sqlResult.sql;
    if (
      featureFlags.isEnabled('RLS_ENFORCEMENT') &&
      config.security.rls &&
      config.security.rls.enabled
    ) {
      const rlsResult = sqlRewriter.injectTenantFilter(
        finalSql,
        config.security.rls.tableTenantMap,
        context && context.tenantId
      );
      if (rlsResult.refused) {
        const rlsErr = `RLS_REWRITE_FAILED: ${rlsResult.reason}`;
        logger.error('[RLS] SQL 改写被拒绝,中止执行', { reason: rlsResult.reason, sessionId });
        logger.traceStep(traceId, 'RLS改写', { refused: true, reason: rlsResult.reason }, 'error');
        await database.addMessage(sessionId, 'assistant', rlsErr, 'error');
        logger.endTrace(traceId, { type: 'error', error: rlsErr });
        return {
          success: false,
          type: 'error',
          message: rlsErr,
          errorCode: 'RLS_REWRITE_FAILED',
          sql: sqlResult.sql
        };
      }
      finalSql = rlsResult.sql;
      if (rlsResult.applied && rlsResult.applied.length > 0) {
        context.rlsApplied = rlsResult.applied;
        logger.info('[RLS] 已注入租户过滤条件', {
          appliedTables: rlsResult.applied,
          tenantId: context.tenantId
        });
      }
    }

    // ----------------------------------------
    // 步骤6: 执行查询
    // ----------------------------------------
    sendProgress('executing', { message: '执行查询...' });
    logger.traceStep(traceId, '执行查询', { sql: finalSql?.substring(0, 100) }, 'start');

    const queryResult = await sqlExecutor.executeQuery(finalSql);

    logger.traceStep(traceId, '执行查询', {
      success: queryResult.success,
      rowCount: queryResult.data?.rowCount,
      executionTime: queryResult.executionTime
    }, queryResult.success ? 'success' : 'error');

    // 【Phase 3 · T3c】query_history 终态写入
    if (queryResult.success) {
      await database.markQueryHistorySuccess(historyId, {
        generatedSql: sqlResult.sql,
        executionTime: queryResult.executionTime,
        rowCount: queryResult.data?.rowCount || 0,
        // 【批次 D1】审计存摘要（不再落业务行）
        result: summarizeResultForAudit(queryResult.data),
        fallbackUsed: !!(context && context.fallbackUsed),
        rlsApplied:    context && context.rlsApplied
      });
    } else {
      await database.markQueryHistoryFailure(historyId, {
        generatedSql: sqlResult.sql,
        executionTime: queryResult.executionTime,
        errorMessage: queryResult.error,
        errorCode:    queryResult.errorCode || 'SR_EXEC_ERROR',
        fallbackUsed: !!(context && context.fallbackUsed),
        rlsApplied:   context && context.rlsApplied
      });
    }

    // ----------------------------------------
    // 步骤7: 格式化结果
    // ----------------------------------------
    sendProgress('formatting', { message: '整理查询结果...' });
    logger.traceStep(traceId, '格式化结果', { rowCount: queryResult.data?.rowCount }, 'start');

    const formattedResponse = await resultFormatter.formatResult(queryResult, userQuery);

    logger.traceStep(traceId, '格式化结果', { response: formattedResponse?.substring(0, 100) }, 'success');

    await database.addMessage(sessionId, 'assistant', formattedResponse, 'result', {
      sql: sqlResult.sql,
      explanation: sqlResult.explanation,
      result: queryResult
    });

    // ----------------------------------------
    // 步骤8: 存储查询向量
    // ----------------------------------------
    if (config.embedding && config.embedding.enabled && userId) {
      (async () => {
        try {
          const queryVector = await llmService.getEmbedding(userQuery);

          const baseMetadata = {
            user_id: userId,
            session_id: sessionId,
            query_text: userQuery,
            sql: sqlResult.sql
          };

          const enhancedMetadata = vectorStore.buildEnhancedMetadata(
            baseMetadata,
            {
              intent: intent,
              queryText: userQuery,
              success: queryResult.success,
              executionTime: queryResult.executionTime,
              resultCount: queryResult.data?.rowCount || 0
            }
          );

          await vectorStore.addQueryVector(
            `query_${Date.now()}_${userId}`,
            userQuery,
            queryVector,
            enhancedMetadata
          );

          logger.debug('查询向量已存储（带增强元数据）', {
            userId,
            query: userQuery.substring(0, 50),
            importanceScore: enhancedMetadata.importanceScore,
            queryType: enhancedMetadata.queryType
          });
        } catch (err) {
          logger.error('存储查询向量失败:', err);
        }
      })();
    }

    // ----------------------------------------
    // 步骤9: 提取并存储长期记忆
    // ----------------------------------------
    logger.info('[NL2SQL] 准备触发长期记忆存储', {
      userId,
      hasIntent: !!intent,
      intentConfidence: intent?.confidence,
      querySuccess: queryResult.success
    });

    if (userId && intent) {
      logger.info('[NL2SQL] 开始异步提取长期记忆', { userId, query: userQuery.substring(0, 30) });

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

    logger.endTrace(traceId, {
      type: 'result',
      sql: sqlResult.sql,
      rowCount: queryResult.data?.rowCount,
      executionTime: queryResult.executionTime
    });

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
    logger.traceStep(traceId, '处理查询', { error: error.message }, 'error');

    logger.endTrace(traceId, {
      type: 'error',
      error: error.message,
      stack: error.stack
    });

    await database.markQueryHistoryFailure(historyId, {
      generatedSql: null,
      executionTime: null,
      errorMessage: error.message,
      errorCode: error.code || 'PIPELINE_ERROR',
      fallbackUsed: !!(context && context.fallbackUsed),
      rlsApplied:   context && context.rlsApplied
    });

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
// 导出（契约冻结：与 Phase 3 一致）
// ============================================

module.exports = {
  // 核心流程
  processQuery,
  // 子功能 re-export（Phase 4 拆分后从子模块转发）
  analyzeIntent:         intentAnalyzer.analyzeIntent,
  checkIntentComplete:   intentAnalyzer.checkIntentComplete,
  generateClarification: intentAnalyzer.generateClarification,
  updateIntentWithLLM:   intentAnalyzer.updateIntentWithLLM,
  resolveEntity:         entityResolver.resolveEntity,
  generateSQL:           sqlGenerator.generateSQL,
  validateSQL:           sqlExecutor.validateSQL,
  executeQuery:          sqlExecutor.executeQuery,
  formatResult:          resultFormatter.formatResult,
  // 错误类
  NL2SQLError
};
