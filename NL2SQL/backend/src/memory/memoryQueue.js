/**
 * 异步记忆存储队列模块
 * 
 * 将记忆存储操作异步化，避免阻塞主流程
 * 提升高并发场景下的系统性能
 */

const logger = require('../utils/logger');

// ============================================
// 队列状态
// ============================================

/**
 * 记忆存储队列
 */
const memoryQueue = [];

/**
 * 是否正在处理队列
 */
let isProcessing = false;

/**
 * 队列处理间隔（毫秒）
 */
const PROCESS_INTERVAL = 100;

/**
 * 批量处理大小
 */
const BATCH_SIZE = 5;

// ============================================
// 核心功能
// ============================================

/**
 * 将记忆存储操作加入队列
 * 
 * @param {Function} operation - 存储操作函数（返回 Promise）
 * @param {Object} options - 选项
 * @param {string} options.type - 操作类型（用于日志）
 * @param {string} options.userId - 用户ID（用于日志）
 */
function enqueueMemoryStore(operation, options = {}) {
  const { type = 'unknown', userId = null } = options;
  
  memoryQueue.push({
    operation,
    type,
    userId,
    enqueueTime: Date.now()
  });
  
  logger.debug('[MemoryQueue] 存储操作已入队', {
    type,
    userId,
    queueSize: memoryQueue.length
  });
  
  // 触发队列处理
  if (!isProcessing) {
    processQueue();
  }
}

/**
 * 处理队列中的存储操作
 * 使用批量处理提高效率
 */
async function processQueue() {
  if (isProcessing || memoryQueue.length === 0) {
    return;
  }
  
  isProcessing = true;
  
  try {
    // 批量取出操作
    const batch = memoryQueue.splice(0, BATCH_SIZE);
    
    logger.debug('[MemoryQueue] 开始批量处理', {
      batchSize: batch.length,
      remaining: memoryQueue.length
    });
    
    // 并行执行批量操作
    const results = await Promise.allSettled(
      batch.map(item => executeOperation(item))
    );
    
    // 统计结果
    const successCount = results.filter(r => r.status === 'fulfilled').length;
    const failCount = results.filter(r => r.status === 'rejected').length;
    
    if (failCount > 0) {
      logger.warn('[MemoryQueue] 批量处理完成，部分失败', {
        success: successCount,
        failed: failCount
      });
    } else {
      logger.debug('[MemoryQueue] 批量处理完成', {
        success: successCount
      });
    }
    
  } catch (error) {
    logger.error('[MemoryQueue] 队列处理异常:', error);
  } finally {
    isProcessing = false;
    
    // 如果队列中还有任务，继续处理
    if (memoryQueue.length > 0) {
      setTimeout(processQueue, PROCESS_INTERVAL);
    }
  }
}

/**
 * 执行单个存储操作
 * 
 * @param {Object} item - 队列项
 * @returns {Promise<any>}
 */
async function executeOperation(item) {
  const { operation, type, userId, enqueueTime } = item;
  const waitTime = Date.now() - enqueueTime;
  
  try {
    const result = await operation();
    
    logger.debug('[MemoryQueue] 存储操作成功', {
      type,
      userId,
      waitTime: `${waitTime}ms`
    });
    
    return result;
  } catch (error) {
    logger.error('[MemoryQueue] 存储操作失败:', {
      type,
      userId,
      waitTime: `${waitTime}ms`,
      error: error.message
    });
    
    throw error;
  }
}

// ============================================
// 队列管理
// ============================================

/**
 * 获取队列状态
 * @returns {Object} 队列状态
 */
function getQueueStatus() {
  return {
    size: memoryQueue.length,
    isProcessing,
    batchSize: BATCH_SIZE,
    processInterval: PROCESS_INTERVAL
  };
}

/**
 * 清空队列
 * 谨慎使用，主要用于测试
 */
function clearQueue() {
  const count = memoryQueue.length;
  memoryQueue.length = 0;
  logger.info('[MemoryQueue] 队列已清空', { clearedCount: count });
}

/**
 * 等待队列处理完成
 * 主要用于测试或优雅关闭
 * 
 * @param {number} timeout - 超时时间（毫秒）
 * @returns {Promise<boolean>} 是否在超时前完成
 */
async function waitForComplete(timeout = 5000) {
  const startTime = Date.now();
  
  while (memoryQueue.length > 0 || isProcessing) {
    if (Date.now() - startTime > timeout) {
      logger.warn('[MemoryQueue] 等待队列完成超时', {
        remaining: memoryQueue.length,
        isProcessing
      });
      return false;
    }
    
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return true;
}

// ============================================
// 导出模块
// ============================================

module.exports = {
  // 核心功能
  enqueueMemoryStore,
  
  // 队列管理
  getQueueStatus,
  clearQueue,
  waitForComplete
};
