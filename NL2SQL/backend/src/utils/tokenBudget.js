/**
 * Token 预算管理模块
 * 
 * 负责上下文 Token 的计算、预算控制和超限处理
 * 防止 LLM 上下文窗口溢出，确保系统稳定性
 */

// ============================================
// 导入依赖模块
// ============================================

const config = require('../core/config');
const logger = require('./logger');

// ============================================
// 常量定义
// ============================================

/**
 * Token 估算比率（字符数 -> Token 数）
 * 经验值：英文约 4 字符/Token，中文约 2 字符/Token
 * 保守估计使用 3.5 字符/Token
 */
const TOKEN_RATIO = 3.5;

/**
 * 默认上下文预算配置
 */
const DEFAULT_BUDGET_CONFIG = {
  // 最大上下文 Token 数（默认 128k 的 80%）
  maxContextTokens: 102400,
  // 为模型输出预留的 Token 数
  reservedOutputTokens: 8192,
  // 触发警告的阈值比例（0-1）
  warningThreshold: 0.8,
  // 触发压缩的阈值比例（0-1）
  compressionThreshold: 0.9,
  // 保留的最近对话轮数
  recentHistoryRounds: 5,
  // 系统提示词最大 Token 数
  maxSystemPromptTokens: 2048,
  // 检索片段最大 Token 数
  maxRetrievedChunksTokens: 4096
};

// ============================================
// Token 估算函数
// ============================================

/**
 * 估算文本的 Token 数
 * 使用基于字符数的简单估算，适用于快速预算检查
 * 
 * @param {string} text - 要估算的文本
 * @returns {number} 估算的 Token 数
 */
function estimateTokens(text) {
  if (!text || typeof text !== 'string') {
    return 0;
  }
  
  // 计算字符数（包括中文、英文、数字等）
  const charCount = text.length;
  
  // 估算 Token 数（向上取整）
  const estimatedTokens = Math.ceil(charCount / TOKEN_RATIO);
  
  return estimatedTokens;
}

/**
 * 批量估算多条文本的 Token 数
 * 
 * @param {Array<string>} texts - 文本数组
 * @returns {Array<number>} Token 数数组
 */
function estimateTokensBatch(texts) {
  if (!Array.isArray(texts)) {
    return [];
  }
  
  return texts.map(text => estimateTokens(text));
}

/**
 * 计算对象/数组的 Token 估算值（JSON 序列化后）
 * 
 * @param {Object|Array} data - 要估算的数据
 * @returns {number} 估算的 Token 数
 */
function estimateObjectTokens(data) {
  try {
    const jsonString = JSON.stringify(data);
    return estimateTokens(jsonString);
  } catch (error) {
    logger.warn('估算对象 Token 失败:', error.message);
    return 0;
  }
}

// ============================================
// 上下文预算计算
// ============================================

/**
 * 计算当前上下文的 Token 预算
 * 
 * @param {Object} context - 上下文对象
 * @param {string} context.systemPrompt - 系统提示词
 * @param {Array} context.history - 对话历史
 * @param {Array<string>} context.retrievedChunks - 检索到的知识片段
 * @param {Object} options - 配置选项
 * @returns {Object} 预算分析结果
 */
function calculateContextBudget(context, options = {}) {
  const budgetConfig = { ...DEFAULT_BUDGET_CONFIG, ...options };
  
  // 计算各部分 Token 数
  const systemPromptTokens = estimateTokens(context.systemPrompt || '');
  const historyTokens = estimateObjectTokens(context.history || []);
  const retrievedChunksTokens = estimateTokens(
    (context.retrievedChunks || []).join('\n')
  );
  
  // 计算总 Token 数
  const totalTokens = systemPromptTokens + historyTokens + retrievedChunksTokens;
  
  // 计算可用预算（扣除预留输出空间）
  const availableBudget = budgetConfig.maxContextTokens - budgetConfig.reservedOutputTokens;
  
  // 计算使用率
  const usageRatio = totalTokens / availableBudget;
  
  // 判断是否超过阈值
  const isWarning = usageRatio >= budgetConfig.warningThreshold;
  const isCritical = usageRatio >= budgetConfig.compressionThreshold;
  const isOverBudget = totalTokens > availableBudget;
  
  const result = {
    // 各部分 Token 数
    breakdown: {
      systemPrompt: systemPromptTokens,
      history: historyTokens,
      retrievedChunks: retrievedChunksTokens,
      total: totalTokens
    },
    // 预算信息
    budget: {
      maxContext: budgetConfig.maxContextTokens,
      reservedOutput: budgetConfig.reservedOutputTokens,
      available: availableBudget,
      usageRatio: Math.round(usageRatio * 100) / 100,
      remaining: Math.max(0, availableBudget - totalTokens)
    },
    // 状态标记
    status: {
      isWarning,
      isCritical,
      isOverBudget,
      canAddMore: !isCritical && !isOverBudget
    },
    // 建议
    suggestions: generateSuggestions({
      systemPromptTokens,
      historyTokens,
      retrievedChunksTokens,
      usageRatio,
      isWarning,
      isCritical,
      isOverBudget
    }, budgetConfig)
  };
  
  logger.debug('[TokenBudget] 预算计算完成', {
    totalTokens,
    usageRatio: result.budget.usageRatio,
    status: result.status
  });
  
  return result;
}

/**
 * 生成优化建议
 * 
 * @param {Object} params - 参数
 * @param {Object} config - 预算配置
 * @returns {Array<string>} 建议列表
 */
function generateSuggestions(params, config) {
  const suggestions = [];
  
  if (params.isOverBudget) {
    suggestions.push('上下文已超出预算，必须压缩或裁剪');
    suggestions.push(`建议：将历史对话压缩至最近 ${config.recentHistoryRounds} 轮`);
  } else if (params.isCritical) {
    suggestions.push('上下文接近临界值，建议立即压缩');
    if (params.retrievedChunksTokens > config.maxRetrievedChunksTokens * 0.5) {
      suggestions.push('建议：减少检索片段数量或长度');
    }
  } else if (params.isWarning) {
    suggestions.push('上下文使用率较高，注意监控');
  }
  
  if (params.systemPromptTokens > config.maxSystemPromptTokens) {
    suggestions.push('系统提示词过长，建议精简');
  }
  
  if (params.historyTokens > params.retrievedChunksTokens * 2) {
    suggestions.push('历史对话占比较大，可考虑摘要压缩');
  }
  
  return suggestions;
}

// ============================================
// 上下文裁剪与压缩
// ============================================

/**
 * 裁剪对话历史，保留最近 N 轮
 * 
 * @param {Array} history - 对话历史
 * @param {number} keepRounds - 保留的轮数
 * @returns {Object} 裁剪结果
 */
function trimHistory(history, keepRounds = 5) {
  if (!Array.isArray(history) || history.length <= keepRounds * 2) {
    return {
      trimmed: false,
      history: history,
      removed: []
    };
  }
  
  // 保留最近 keepRounds 轮（每轮包含 user + assistant）
  const keepCount = keepRounds * 2;
  const removed = history.slice(0, -keepCount);
  const kept = history.slice(-keepCount);
  
  logger.info('[TokenBudget] 裁剪历史对话', {
    originalLength: history.length,
    keptLength: kept.length,
    removedCount: removed.length
  });
  
  return {
    trimmed: true,
    history: kept,
    removed: removed,
    keptRounds: keepRounds
  };
}

/**
 * 智能压缩检索片段
 * 根据相关性保留最重要的片段
 * 
 * @param {Array<Object>} chunks - 检索片段数组（带分数）
 * @param {number} maxTokens - 最大 Token 数限制
 * @returns {Object} 压缩结果
 */
function compressRetrievedChunks(chunks, maxTokens = 4096) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return {
      compressed: false,
      chunks: chunks,
      removed: []
    };
  }
  
  // 按相关性分数排序（假设分数越高越相关）
  const sortedChunks = [...chunks].sort((a, b) => (b.score || 0) - (a.score || 0));
  
  const keptChunks = [];
  const removedChunks = [];
  let currentTokens = 0;
  
  for (const chunk of sortedChunks) {
    const chunkTokens = estimateTokens(chunk.text || chunk.content || '');
    
    if (currentTokens + chunkTokens <= maxTokens) {
      keptChunks.push(chunk);
      currentTokens += chunkTokens;
    } else {
      removedChunks.push(chunk);
    }
  }
  
  if (removedChunks.length > 0) {
    logger.info('[TokenBudget] 压缩检索片段', {
      originalCount: chunks.length,
      keptCount: keptChunks.length,
      removedCount: removedChunks.length,
      totalTokens: currentTokens
    });
  }
  
  return {
    compressed: removedChunks.length > 0,
    chunks: keptChunks,
    removed: removedChunks,
    totalTokens: currentTokens
  };
}

/**
 * 触发上下文压缩
 * 根据预算情况自动选择合适的压缩策略
 * 
 * @param {Object} context - 上下文对象
 * @param {Object} budgetResult - 预算计算结果
 * @returns {Object} 压缩后的上下文
 */
function triggerCompression(context, budgetResult) {
  const { status, breakdown, suggestions } = budgetResult;
  
  logger.info('[TokenBudget] 触发上下文压缩', {
    status: status,
    totalTokens: breakdown.total
  });
  
  let compressedContext = { ...context };
  const compressionActions = [];
  
  // 策略 1: 如果历史对话占比大，进行裁剪
  if (breakdown.history > breakdown.retrievedChunks) {
    const trimResult = trimHistory(context.history, 5);
    if (trimResult.trimmed) {
      compressedContext.history = trimResult.history;
      compressionActions.push(`裁剪历史对话: 保留最近 ${trimResult.keptRounds} 轮`);
    }
  }
  
  // 策略 2: 压缩检索片段
  if (context.retrievedChunks && context.retrievedChunks.length > 0) {
    const compressResult = compressRetrievedChunks(
      context.retrievedChunks,
      DEFAULT_BUDGET_CONFIG.maxRetrievedChunksTokens
    );
    if (compressResult.compressed) {
      compressedContext.retrievedChunks = compressResult.chunks;
      compressionActions.push(`压缩检索片段: 保留 ${compressResult.keptCount} 个`);
    }
  }
  
  // 策略 3: 如果仍然超限，进一步裁剪历史
  if (status.isOverBudget && compressedContext.history.length > 2) {
    const aggressiveTrim = trimHistory(compressedContext.history, 2);
    if (aggressiveTrim.trimmed) {
      compressedContext.history = aggressiveTrim.history;
      compressionActions.push('进一步裁剪历史: 保留最近 2 轮');
    }
  }
  
  // 重新计算预算
  const newBudget = calculateContextBudget(compressedContext);
  
  logger.info('[TokenBudget] 压缩完成', {
    actions: compressionActions,
    newTotalTokens: newBudget.breakdown.total,
    newUsageRatio: newBudget.budget.usageRatio
  });
  
  return {
    context: compressedContext,
    actions: compressionActions,
    before: budgetResult,
    after: newBudget,
    success: !newBudget.status.isOverBudget
  };
}

// ============================================
// 快捷检查函数
// ============================================

/**
 * 快速检查上下文是否安全（未超限）
 * 
 * @param {Object} context - 上下文对象
 * @returns {boolean} 是否安全
 */
function isContextSafe(context) {
  const budget = calculateContextBudget(context);
  return !budget.status.isOverBudget && !budget.status.isCritical;
}

/**
 * 获取上下文状态摘要
 * 
 * @param {Object} context - 上下文对象
 * @returns {string} 状态描述
 */
function getContextStatusSummary(context) {
  const budget = calculateContextBudget(context);
  const { status, budget: budgetInfo } = budget;
  
  if (status.isOverBudget) {
    return `超出预算: ${budgetInfo.total} / ${budgetInfo.available} tokens (${Math.round(budgetInfo.usageRatio * 100)}%)`;
  } else if (status.isCritical) {
    return `临界状态: ${budgetInfo.total} / ${budgetInfo.available} tokens (${Math.round(budgetInfo.usageRatio * 100)}%)`;
  } else if (status.isWarning) {
    return `警告: ${budgetInfo.total} / ${budgetInfo.available} tokens (${Math.round(budgetInfo.usageRatio * 100)}%)`;
  } else {
    return `正常: ${budgetInfo.total} / ${budgetInfo.available} tokens (${Math.round(budgetInfo.usageRatio * 100)}%)`;
  }
}

// ============================================
// 导出模块
// ============================================

module.exports = {
  // Token 估算
  estimateTokens,
  estimateTokensBatch,
  estimateObjectTokens,
  
  // 预算计算
  calculateContextBudget,
  
  // 裁剪与压缩
  trimHistory,
  compressRetrievedChunks,
  triggerCompression,
  
  // 快捷检查
  isContextSafe,
  getContextStatusSummary,
  
  // 配置常量
  DEFAULT_BUDGET_CONFIG
};
