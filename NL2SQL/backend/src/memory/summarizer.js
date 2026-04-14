/**
 * 对话摘要模块
 * 
 * 负责长对话历史的自动摘要和压缩
 * 将早期对话压缩为摘要，保留近期对话原文
 */

// ============================================
// 导入依赖模块
// ============================================

const llmService = require('../core/llmService');
const logger = require('../utils/logger');
const tokenBudget = require('../utils/tokenBudget');

// ============================================
// 常量定义
// ============================================

/**
 * 默认摘要配置
 */
const DEFAULT_SUMMARY_CONFIG = {
  // 触发摘要的对话轮数阈值
  triggerRounds: 8,
  // 保留的最近对话轮数（不参与摘要）
  preserveRecentRounds: 4,
  // 摘要的最大 Token 数
  maxSummaryTokens: 500,
  // 摘要更新间隔（轮数）
  updateInterval: 4,
  // 是否包含元数据（时间、用户ID等）
  includeMetadata: true
};

/**
 * 摘要缓存（内存中临时存储）
 * 键：sessionId，值：{ summary, lastUpdateRound, timestamp }
 */
const summaryCache = new Map();

/**
 * 摘要缓存过期时间（毫秒）
 */
const CACHE_EXPIRE_TIME = 30 * 60 * 1000; // 30 分钟

// ============================================
// 对话历史分割
// ============================================

/**
 * 分割对话历史为需要摘要的部分和保留的部分
 * 
 * @param {Array} history - 完整对话历史
 * @param {number} preserveRounds - 保留的最近轮数
 * @returns {Object} 分割结果
 */
function splitHistory(history, preserveRounds = 4) {
  if (!Array.isArray(history) || history.length === 0) {
    return {
      toSummarize: [],
      toPreserve: [],
      hasEnoughData: false
    };
  }
  
  // 计算需要保留的消息数（每轮包含 user + assistant）
  const preserveCount = preserveRounds * 2;
  
  // 如果历史不够长，不需要摘要
  if (history.length <= preserveCount) {
    return {
      toSummarize: [],
      toPreserve: history,
      hasEnoughData: false
    };
  }
  
  // 分割历史
  const toSummarize = history.slice(0, -preserveCount);
  const toPreserve = history.slice(-preserveCount);
  
  logger.debug('[Summarizer] 分割对话历史', {
    totalMessages: history.length,
    toSummarizeCount: toSummarize.length,
    toPreserveCount: toPreserve.length
  });
  
  return {
    toSummarize,
    toPreserve,
    hasEnoughData: true,
    summarizeRounds: toSummarize.length / 2
  };
}

// ============================================
// 摘要生成
// ============================================

/**
 * 生成对话摘要
 * 使用 LLM 将历史对话压缩为关键信息摘要
 * 
 * @param {Array} history - 需要摘要的对话历史
 * @param {Object} options - 配置选项
 * @returns {Promise<Object>} 摘要结果
 */
async function summarizeDialogue(history, options = {}) {
  const config = { ...DEFAULT_SUMMARY_CONFIG, ...options };
  
  if (!Array.isArray(history) || history.length === 0) {
    return {
      success: false,
      summary: '',
      error: '历史记录为空'
    };
  }
  
  // 构建对话文本
  const dialogueText = history.map(msg => {
    const role = msg.role === 'user' ? '用户' : '助手';
    const type = msg.type ? `(${msg.type})` : '';
    return `${role}${type}: ${msg.content}`;
  }).join('\n\n');
  
  // 构建系统提示词
  const systemPrompt = `你是一位对话摘要专家。请将以下对话历史压缩成简洁的摘要。

摘要要求：
1. 保留用户的查询意图和关键需求
2. 保留已确认的重要信息（如 game_id、时间范围等）
3. 保留用户的偏好设置和业务规则
4. 去除重复和冗余信息
5. 使用第三人称客观描述
6. 长度控制在 ${config.maxSummaryTokens} tokens 以内

输出格式：
- 查询主题：<主题>
- 已确认信息：<关键信息>
- 用户偏好：<偏好设置>
- 待解决问题：<如有>`;

  try {
    logger.info('[Summarizer] 开始生成对话摘要', {
      messageCount: history.length,
      estimatedTokens: tokenBudget.estimateTokens(dialogueText)
    });
    
    // 调用 LLM 生成摘要
    const summary = await llmService.simpleChat(dialogueText, systemPrompt);
    
    // 验证摘要长度
    const summaryTokens = tokenBudget.estimateTokens(summary);
    if (summaryTokens > config.maxSummaryTokens) {
      logger.warn('[Summarizer] 摘要超出长度限制，进行裁剪', {
        summaryTokens,
        maxTokens: config.maxSummaryTokens
      });
      // 简单裁剪（实际应该更智能）
      summary = summary.substring(0, config.maxSummaryTokens * 3) + '...';
    }
    
    logger.info('[Summarizer] 摘要生成完成', {
      summaryLength: summary.length,
      summaryTokens
    });
    
    return {
      success: true,
      summary: summary.trim(),
      originalMessageCount: history.length,
      summaryTokens,
      timestamp: Date.now()
    };
    
  } catch (error) {
    logger.error('[Summarizer] 生成摘要失败:', error);
    return {
      success: false,
      summary: '',
      error: error.message
    };
  }
}

/**
 * 增量更新摘要
 * 将新对话添加到现有摘要中
 * 
 * @param {string} existingSummary - 现有摘要
 * @param {Array} newHistory - 新增对话历史
 * @returns {Promise<Object>} 更新后的摘要
 */
async function incrementSummary(existingSummary, newHistory) {
  if (!existingSummary) {
    // 没有现有摘要，直接生成新摘要
    return summarizeDialogue(newHistory);
  }
  
  if (!Array.isArray(newHistory) || newHistory.length === 0) {
    return {
      success: true,
      summary: existingSummary,
      updated: false
    };
  }
  
  // 构建新增对话文本
  const newDialogueText = newHistory.map(msg => {
    const role = msg.role === 'user' ? '用户' : '助手';
    return `${role}: ${msg.content}`;
  }).join('\n\n');
  
  const systemPrompt = `请合并以下现有摘要和新增对话，生成更新后的摘要。

现有摘要：
${existingSummary}

新增对话：
${newDialogueText}

要求：
1. 整合新旧信息，去除重复
2. 保留所有关键决策和确认信息
3. 保持简洁，控制长度`;

  try {
    logger.debug('[Summarizer] 增量更新摘要');
    
    const updatedSummary = await llmService.simpleChat('', systemPrompt);
    
    return {
      success: true,
      summary: updatedSummary.trim(),
      updated: true,
      timestamp: Date.now()
    };
    
  } catch (error) {
    logger.error('[Summarizer] 增量更新摘要失败:', error);
    // 失败时返回原摘要
    return {
      success: true,
      summary: existingSummary,
      updated: false,
      error: error.message
    };
  }
}

// ============================================
// 历史压缩
// ============================================

/**
 * 压缩对话历史
 * 将长历史转换为摘要 + 近期对话的形式
 * 
 * @param {Array} history - 完整对话历史
 * @param {Object} options - 配置选项
 * @returns {Promise<Object>} 压缩结果
 */
async function compressHistory(history, options = {}) {
  const config = { ...DEFAULT_SUMMARY_CONFIG, ...options };
  
  // 分割历史
  const split = splitHistory(history, config.preserveRecentRounds);
  
  if (!split.hasEnoughData) {
    return {
      compressed: false,
      history: history,
      summary: null,
      reason: '历史记录不足，无需压缩'
    };
  }
  
  // 生成摘要
  const summaryResult = await summarizeDialogue(split.toSummarize, config);
  
  if (!summaryResult.success) {
    logger.warn('[Summarizer] 摘要生成失败，返回原始历史', {
      error: summaryResult.error
    });
    return {
      compressed: false,
      history: history,
      summary: null,
      reason: '摘要生成失败: ' + summaryResult.error
    };
  }
  
  // 构建压缩后的历史
  const compressedHistory = [
    {
      role: 'system',
      type: 'summary',
      content: `[对话摘要] ${summaryResult.summary}`,
      timestamp: Date.now()
    },
    ...split.toPreserve
  ];
  
  // 计算压缩效果
  const originalTokens = tokenBudget.estimateObjectTokens(history);
  const compressedTokens = tokenBudget.estimateObjectTokens(compressedHistory);
  const compressionRatio = (originalTokens - compressedTokens) / originalTokens;
  
  logger.info('[Summarizer] 历史压缩完成', {
    originalMessages: history.length,
    compressedMessages: compressedHistory.length,
    originalTokens,
    compressedTokens,
    compressionRatio: Math.round(compressionRatio * 100) + '%'
  });
  
  return {
    compressed: true,
    history: compressedHistory,
    summary: summaryResult.summary,
    originalHistory: history,
    stats: {
      originalMessages: history.length,
      compressedMessages: compressedHistory.length,
      originalTokens,
      compressedTokens,
      compressionRatio
    }
  };
}

/**
 * 融合摘要和近期历史
 * 用于构建最终发送给 LLM 的上下文
 * 
 * @param {string} summary - 摘要文本
 * @param {Array} recentHistory - 近期对话历史
 * @returns {Array} 融合后的历史
 */
function mergeWithSummary(summary, recentHistory) {
  if (!summary) {
    return recentHistory;
  }
  
  const merged = [
    {
      role: 'system',
      type: 'summary',
      content: `[历史对话摘要] ${summary}`,
      timestamp: Date.now()
    },
    {
      role: 'system',
      type: 'divider',
      content: '--- 以下是最新对话 ---',
      timestamp: Date.now()
    },
    ...recentHistory
  ];
  
  return merged;
}

// ============================================
// 摘要缓存管理
// ============================================

/**
 * 获取缓存的摘要
 * 
 * @param {string} sessionId - 会话ID
 * @returns {Object|null} 缓存的摘要信息
 */
function getCachedSummary(sessionId) {
  const cached = summaryCache.get(sessionId);
  
  if (!cached) {
    return null;
  }
  
  // 检查是否过期
  if (Date.now() - cached.timestamp > CACHE_EXPIRE_TIME) {
    summaryCache.delete(sessionId);
    return null;
  }
  
  return cached;
}

/**
 * 缓存摘要
 * 
 * @param {string} sessionId - 会话ID
 * @param {string} summary - 摘要内容
 * @param {number} lastUpdateRound - 最后更新的轮数
 */
function cacheSummary(sessionId, summary, lastUpdateRound) {
  summaryCache.set(sessionId, {
    summary,
    lastUpdateRound,
    timestamp: Date.now()
  });
  
  logger.debug('[Summarizer] 摘要已缓存', { sessionId, lastUpdateRound });
}

/**
 * 清除过期缓存
 */
function cleanExpiredCache() {
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [sessionId, cached] of summaryCache.entries()) {
    if (now - cached.timestamp > CACHE_EXPIRE_TIME) {
      summaryCache.delete(sessionId);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    logger.debug('[Summarizer] 清理过期缓存', { cleanedCount });
  }
}

/**
 * 清除指定会话的缓存
 * 
 * @param {string} sessionId - 会话ID
 */
function clearSessionCache(sessionId) {
  summaryCache.delete(sessionId);
  logger.debug('[Summarizer] 清除会话缓存', { sessionId });
}

// ============================================
// 智能压缩入口
// ============================================

/**
 * 智能压缩对话历史（带缓存）
 * 根据会话ID管理摘要缓存，避免重复生成
 * 
 * @param {string} sessionId - 会话ID
 * @param {Array} history - 对话历史
 * @param {Object} options - 配置选项
 * @returns {Promise<Object>} 压缩结果
 */
async function smartCompressHistory(sessionId, history, options = {}) {
  const config = { ...DEFAULT_SUMMARY_CONFIG, ...options };
  
  // 清理过期缓存
  cleanExpiredCache();
  
  // 检查是否需要压缩
  const currentRounds = Math.floor(history.length / 2);
  if (currentRounds < config.triggerRounds) {
    return {
      compressed: false,
      history: history,
      reason: `当前 ${currentRounds} 轮，未达到触发阈值 ${config.triggerRounds}`
    };
  }
  
  // 检查缓存
  const cached = getCachedSummary(sessionId);
  
  if (cached && currentRounds - cached.lastUpdateRound < config.updateInterval) {
    // 使用缓存的摘要，只更新近期历史
    const split = splitHistory(history, config.preserveRecentRounds);
    const mergedHistory = mergeWithSummary(cached.summary, split.toPreserve);
    
    return {
      compressed: true,
      history: mergedHistory,
      summary: cached.summary,
      fromCache: true,
      reason: '使用缓存摘要'
    };
  }
  
  // 生成新摘要
  const result = await compressHistory(history, config);
  
  if (result.compressed) {
    // 更新缓存
    cacheSummary(sessionId, result.summary, currentRounds);
  }
  
  return result;
}

// ============================================
// 导出模块
// ============================================

module.exports = {
  // 摘要生成
  summarizeDialogue,
  incrementSummary,
  
  // 历史压缩
  compressHistory,
  smartCompressHistory,
  splitHistory,
  mergeWithSummary,
  
  // 缓存管理
  getCachedSummary,
  cacheSummary,
  clearSessionCache,
  cleanExpiredCache,
  
  // 配置
  DEFAULT_SUMMARY_CONFIG
};
