/**
 * 异步记忆存储队列模块（Phase 4 · 任务 C.2 增强）
 *
 * 将记忆存储操作异步化，避免阻塞主流程。
 *
 * Phase 4 新增：
 * - 指数退避重试：100ms → 400ms → 1600ms（BACKOFF_FACTOR=4），最多 MAX_RETRIES=3 次
 * - 失败持久化：重试耗尽后写入 memory_failed_queue 表（sqlite），避免静默丢失
 * - 队列长度保护：超过 QUEUE_MAX_SIZE 直接走死信，避免 OOM
 * - metrics 导出：`getQueueMetrics()` 返回累计入队/成功/重试/死信数
 */

const logger = require('../utils/logger');

let database = null;
try {
  database = require('../core/database');
} catch (e) {
  // 测试环境下允许 database 不可用;死信写入会降级为日志告警
}

// ============================================
// 队列状态与调参常量
// ============================================

const memoryQueue = [];
let isProcessing = false;

const PROCESS_INTERVAL = 100;
const BATCH_SIZE       = 5;

// 【Phase 4 · 任务 C.2】重试参数
const MAX_RETRIES      = 3;
const BASE_BACKOFF_MS  = 100;
const BACKOFF_FACTOR   = 4;
const QUEUE_MAX_SIZE   = 1000;

// 【Phase 4 · 任务 C.2】进程内指标
const metrics = {
  enqueued:        0,
  succeeded:       0,
  retried:         0,   // 执行过重试的次数(不是入队次数)
  deadLettered:    0,
  rejectedFull:    0,   // 队列超限直接走死信
  lastErrorTime:   null,
  lastError:       null
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// 核心功能
// ============================================

/**
 * 将记忆存储操作加入队列
 *
 * @param {Function} operation - 存储操作函数（返回 Promise）
 * @param {Object} options - 选项
 * @param {string} options.type - 操作类型（用于日志和死信追溯）
 * @param {string} options.userId - 用户ID（用于日志和死信追溯）
 * @param {Object} options.meta - 可序列化的元数据,写入死信表用于事后排查
 */
function enqueueMemoryStore(operation, options = {}) {
  const { type = 'unknown', userId = null, meta = null } = options;

  metrics.enqueued++;

  // 【Phase 4】队列长度保护
  if (memoryQueue.length >= QUEUE_MAX_SIZE) {
    metrics.rejectedFull++;
    logger.warn('[MemoryQueue] 队列已满,直接入死信', { type, userId, queueSize: memoryQueue.length });
    persistDeadLetter({
      operationType: type,
      userId,
      payload: meta || {},
      lastError: `queue full (size=${memoryQueue.length})`,
      retryCount: 0
    });
    return;
  }

  memoryQueue.push({
    operation,
    type,
    userId,
    meta,
    enqueueTime: Date.now()
  });

  logger.debug('[MemoryQueue] 存储操作已入队', {
    type,
    userId,
    queueSize: memoryQueue.length
  });

  if (!isProcessing) {
    processQueue();
  }
}

/**
 * 处理队列中的存储操作（批量）
 */
async function processQueue() {
  if (isProcessing || memoryQueue.length === 0) {
    return;
  }

  isProcessing = true;

  try {
    const batch = memoryQueue.splice(0, BATCH_SIZE);

    logger.debug('[MemoryQueue] 开始批量处理', {
      batchSize: batch.length,
      remaining: memoryQueue.length
    });

    const results = await Promise.allSettled(
      batch.map(item => executeOperation(item))
    );

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

    if (memoryQueue.length > 0) {
      setTimeout(processQueue, PROCESS_INTERVAL);
    }
  }
}

/**
 * 执行单个存储操作,失败时指数退避重试 MAX_RETRIES 次,仍失败则入死信表
 */
async function executeOperation(item) {
  const { operation, type, userId, meta, enqueueTime } = item;
  const waitTime = Date.now() - enqueueTime;

  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await operation();

      if (attempt === 0) {
        metrics.succeeded++;
        logger.debug('[MemoryQueue] 存储操作成功', {
          type, userId, waitTime: `${waitTime}ms`
        });
      } else {
        metrics.succeeded++;
        logger.info('[MemoryQueue] 重试后成功', {
          type, userId, attempt, waitTime: `${waitTime}ms`
        });
      }

      return result;
    } catch (error) {
      lastError = error;
      metrics.lastErrorTime = Date.now();
      metrics.lastError = error.message;

      if (attempt < MAX_RETRIES) {
        metrics.retried++;
        const backoff = BASE_BACKOFF_MS * Math.pow(BACKOFF_FACTOR, attempt);
        logger.warn('[MemoryQueue] 存储操作失败,退避重试', {
          type, userId,
          attempt: attempt + 1, maxRetries: MAX_RETRIES,
          backoffMs: backoff,
          error: error.message
        });
        await sleep(backoff);
        continue;
      }

      // 重试耗尽 → 写死信
      logger.error('[MemoryQueue] 重试耗尽,写入死信队列', {
        type, userId, maxRetries: MAX_RETRIES,
        waitTime: `${waitTime}ms`, error: error.message
      });

      await persistDeadLetter({
        operationType: type,
        userId,
        payload: meta || {},
        lastError: error.message,
        retryCount: MAX_RETRIES
      });

      metrics.deadLettered++;
      throw error;
    }
  }

  // 理论不可达
  throw lastError || new Error('[MemoryQueue] unknown');
}

/**
 * 持久化死信。database 不可用时降级为 error 日志(不丢失可观测性)。
 */
async function persistDeadLetter({ operationType, userId, payload, lastError, retryCount }) {
  if (!database || typeof database.addMemoryFailedOperation !== 'function') {
    logger.error('[MemoryQueue] 死信持久化降级(database 不可用)', {
      operationType, userId, lastError
    });
    return;
  }
  try {
    await database.addMemoryFailedOperation({
      operationType, userId, payload, lastError, retryCount
    });
  } catch (err) {
    logger.error('[MemoryQueue] 死信持久化失败:', err.message);
  }
}

// ============================================
// 队列管理
// ============================================

function getQueueStatus() {
  return {
    size: memoryQueue.length,
    isProcessing,
    batchSize: BATCH_SIZE,
    processInterval: PROCESS_INTERVAL,
    maxSize: QUEUE_MAX_SIZE,
    maxRetries: MAX_RETRIES
  };
}

/**
 * 【Phase 4 · 任务 C.2】导出进程内指标
 */
function getQueueMetrics() {
  return {
    ...metrics,
    queueSize: memoryQueue.length,
    isProcessing
  };
}

function clearQueue() {
  const count = memoryQueue.length;
  memoryQueue.length = 0;
  logger.info('[MemoryQueue] 队列已清空', { clearedCount: count });
}

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

module.exports = {
  enqueueMemoryStore,
  getQueueStatus,
  getQueueMetrics,
  clearQueue,
  waitForComplete
};
