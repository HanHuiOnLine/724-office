/**
 * 自修复机制模块
 * 
 * 实现系统的自我监控和维护功能：
 * 1. 每日自检 - 检查系统健康状态
 * 2. 会话健康诊断 - 清理过期会话
 * 3. 错误日志分析 - 统计和分析错误
 * 4. 定时任务调度
 */

// ============================================
// 导入依赖模块
// ============================================

// 导入定时任务库
const cron = require('node-cron');
// 导入配置模块
const config = require('./config');
// 导入日志模块
const logger = require('../utils/logger');
// 导入数据库模块
const database = require('./database');
// 导入向量存储模块
const vectorStore = require('../memory/vectorStore');
// 导入SSE处理器
const sseHandler = require('./sseHandler');

// ============================================
// 定时任务引用
// ============================================

/**
 * 每日自检任务引用
 */
let dailyCheckJob = null;

/**
 * 会话清理任务引用
 */
let sessionCleanupJob = null;

/**
 * 统计信息收集任务引用
 */
let statsCollectionJob = null;

/**
 * 记忆维护任务引用
 */
let memoryMaintenanceJob = null;

/**
 * 【Phase 4 · 任务 C.4】死信队列重放任务引用
 */
let deadLetterReplayJob = null;

// ============================================
// 启动和停止
// ============================================

/**
 * 启动自修复调度器
 * 注册所有定时任务
 */
function start() {
  // 如果禁用了自修复，直接返回
  if (!config.selfRepair.enabled) {
    logger.info('自修复机制已禁用');
    return;
  }
  
  logger.info('启动自修复调度器...');
  
  // ----------------------------------------
  // 注册每日自检任务
  // ----------------------------------------
  // 使用配置的Cron表达式，默认每天凌晨2点执行
  dailyCheckJob = cron.schedule(
    config.selfRepair.dailyCheckCron,
    performDailyCheck,
    {
      // 任务名称
      name: 'daily-check',
      // 是否立即执行一次（用于测试）
      runOnInit: false
    }
  );
  logger.info(`每日自检任务已注册: ${config.selfRepair.dailyCheckCron}`);
  
  // ----------------------------------------
  // 注册会话清理任务
  // ----------------------------------------
  // 每30分钟执行一次
  sessionCleanupJob = cron.schedule(
    '*/30 * * * *',
    cleanupSessions,
    {
      name: 'session-cleanup'
    }
  );
  logger.info('会话清理任务已注册: 每30分钟');
  
  // ----------------------------------------
  // 注册统计信息收集任务
  // ----------------------------------------
  // 每5分钟收集一次统计信息
  statsCollectionJob = cron.schedule(
    '*/5 * * * *',
    collectStats,
    {
      name: 'stats-collection'
    }
  );
  logger.info('统计收集任务已注册: 每5分钟');
  
  // ----------------------------------------
  // 注册记忆维护任务
  // ----------------------------------------
  // 每天凌晨3点执行记忆压缩
  memoryMaintenanceJob = cron.schedule(
    '0 3 * * *',
    performMemoryMaintenance,
    {
      name: 'memory-maintenance'
    }
  );
  logger.info('记忆维护任务已注册: 每天凌晨3点');

  // ----------------------------------------
  // 【Phase 4 · 任务 C.4】死信队列重放/告警任务
  // ----------------------------------------
  // 每 6 小时扫描一次 memory_failed_queue 的 pending 记录并告警
  deadLetterReplayJob = cron.schedule(
    '0 */6 * * *',
    replayDeadLetters,
    {
      name: 'dead-letter-replay'
    }
  );
  logger.info('死信重放任务已注册: 每 6 小时');

  logger.info('自修复调度器启动完成');
}

/**
 * 停止自修复调度器
 * 停止所有定时任务
 */
function stop() {
  logger.info('停止自修复调度器...');
  
  // 停止每日自检任务
  if (dailyCheckJob) {
    dailyCheckJob.stop();
    dailyCheckJob = null;
  }
  
  // 停止会话清理任务
  if (sessionCleanupJob) {
    sessionCleanupJob.stop();
    sessionCleanupJob = null;
  }
  
  // 停止统计收集任务
  if (statsCollectionJob) {
    statsCollectionJob.stop();
    statsCollectionJob = null;
  }
  
  // 停止记忆维护任务
  if (memoryMaintenanceJob) {
    memoryMaintenanceJob.stop();
    memoryMaintenanceJob = null;
  }

  // 【Phase 4 · 任务 C.4】停止死信重放任务
  if (deadLetterReplayJob) {
    deadLetterReplayJob.stop();
    deadLetterReplayJob = null;
  }

  logger.info('自修复调度器已停止');
}

// ============================================
// 每日自检
// ============================================

/**
 * 【Phase 4 · 任务 B.2】根据 error_code 分组统计生成可操作建议
 * @param {Array<{code:string, count:number}>} errorCodeStats
 */
function generateErrorRecommendations(errorCodeStats) {
  const adviceMap = {
    SR_DB_NOT_READY:     '数据源未就绪,检查 SR_DATABASE_URL 与网络连通',
    SR_DB_NOT_CONFIGURED:'SR_DB_ENABLED=false 或 URL 空,检查部署配置',
    SR_EXEC_ERROR:       'SR 库执行错误,检查慢查询/权限/表缺失',
    VALIDATION_ERROR:    'SQL 验证失败,检查白名单/语法/LIMIT',
    RLS_REWRITE_FAILED:  'RLS 改写失败,用 sqlRewriter dry-run 采样定位',
    LLM_ERROR:           'LLM 调用失败,检查 LLM_API_KEY/限流/超时',
    PIPELINE_ERROR:      '管道异常(意图/生成/验证前置失败),查看最近 failed 记录的 error_message',
    UNKNOWN:             '未分类错误,排查最近 failed 记录的 error_message'
  };
  return (errorCodeStats || []).map(e => ({
    code: e.code,
    count: e.count,
    advice: adviceMap[e.code] || adviceMap.UNKNOWN
  }));
}

/**
 * 执行每日自检
 * 检查系统各项健康指标
 */
async function performDailyCheck() {
  logger.info('========================================');
  logger.info('开始执行每日自检...');
  logger.info('========================================');
  
  const report = {
    // 检查时间
    checkTime: new Date().toISOString(),
    // 各项检查结果
    checks: {},
    // 发现的问题
    issues: [],
    // 建议的操作
    recommendations: []
  };
  
  try {
    // ----------------------------------------
    // 检查1：数据库连接
    // ----------------------------------------
    try {
      // 尝试执行简单查询
      await database.query('SELECT 1');
      report.checks.database = { status: 'ok', message: '数据库连接正常' };
    } catch (error) {
      report.checks.database = { status: 'error', message: error.message };
      report.issues.push('数据库连接异常');
    }
    
    // ----------------------------------------
    // 检查2：向量数据库
    // ----------------------------------------
    try {
      const vectorStats = await vectorStore.getStats();
      report.checks.vectorDb = {
        status: vectorStats.initialized ? 'ok' : 'warning',
        message: vectorStats.initialized ? '向量数据库正常' : '向量数据库未初始化',
        stats: vectorStats
      };
    } catch (error) {
      report.checks.vectorDb = { status: 'error', message: error.message };
      report.issues.push('向量数据库异常');
    }
    
    // ----------------------------------------
    // 检查3：今日查询统计
    // ----------------------------------------
    try {
      const today = new Date().toISOString().split('T')[0];
      const queryStats = await database.queryOne(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
          AVG(execution_time) as avg_time
        FROM query_history
        WHERE date(created_at) = date(?)
      `, [today]);

      report.checks.queries = {
        status: 'ok',
        today: queryStats
      };

      // 检查失败率
      if (queryStats && queryStats.total > 0) {
        const failRate = queryStats.failed / queryStats.total;
        if (failRate > 0.1) {
          report.issues.push(`今日查询失败率过高: ${(failRate * 100).toFixed(1)}%`);
          report.recommendations.push('建议检查LLM API状态和SQL生成逻辑');
        }
      }

      // 检查慢查询
      if (queryStats && queryStats.avg_time > config.selfRepair.slowQueryThreshold) {
        report.issues.push(`平均查询时间偏慢: ${Math.round(queryStats.avg_time)}ms`);
        report.recommendations.push('建议优化查询性能或检查数据源状态');
      }

      // 【Phase 4 · 任务 B】Phase 3 审计字段深入分析
      try {
        const [errorCodeStats, rlsStats, fallbackStats] = await Promise.all([
          database.query(
            `SELECT COALESCE(error_code, 'UNKNOWN') AS code, COUNT(*) AS count
               FROM query_history
              WHERE status='failed' AND date(created_at) = date(?)
              GROUP BY COALESCE(error_code, 'UNKNOWN')
              ORDER BY count DESC`,
            [today]
          ),
          database.queryOne(
            `SELECT COUNT(CASE WHEN rls_applied IS NOT NULL AND rls_applied != '' THEN 1 END) AS rls_hit,
                    COUNT(*) AS total
               FROM query_history
              WHERE date(created_at) = date(?)`,
            [today]
          ),
          database.queryOne(
            `SELECT COALESCE(SUM(fallback_used), 0) AS fallback_count, COUNT(*) AS total
               FROM query_history
              WHERE date(created_at) = date(?)`,
            [today]
          )
        ]);

        report.checks.queries.errorCodes    = errorCodeStats;
        report.checks.queries.rlsStats      = rlsStats;
        report.checks.queries.fallbackStats = fallbackStats;

        if (Array.isArray(errorCodeStats) && errorCodeStats.length > 0) {
          report.recommendations.push(...generateErrorRecommendations(errorCodeStats));
        }

        if (fallbackStats && fallbackStats.total > 0) {
          const fbRate = fallbackStats.fallback_count / fallbackStats.total;
          if (fbRate > 0.2) {
            report.issues.push(`fallback 占比 ${(fbRate * 100).toFixed(1)}%（>20%）`);
            report.recommendations.push({
              code: 'FALLBACK_RATE_HIGH',
              advice: 'agentic 路径失败率偏高,检查 agenticEngine 日志与 FF_AGENTIC_ENGINE 配置'
            });
          }
        }
      } catch (auditErr) {
        logger.warn('[selfRepair] 审计字段分析失败:', auditErr.message);
      }

    } catch (error) {
      report.checks.queries = { status: 'error', message: error.message };
    }

    // ----------------------------------------
    // 检查4：活跃会话
    // ----------------------------------------
    try {
      const activeConnections = sseHandler.getConnectionCount();
      report.checks.connections = {
        status: 'ok',
        activeConnections: activeConnections
      };
    } catch (error) {
      report.checks.connections = { status: 'error', message: error.message };
    }

    // ----------------------------------------
    // 检查5：系统资源
    // ----------------------------------------
    const memoryUsage = process.memoryUsage();
    report.checks.system = {
      status: 'ok',
      memory: {
        used: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        total: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        rss: Math.round(memoryUsage.rss / 1024 / 1024)
      },
      uptime: process.uptime()
    };

    // 检查内存使用
    const memoryPercent = memoryUsage.heapUsed / memoryUsage.heapTotal;
    if (memoryPercent > 0.9) {
      report.issues.push(`内存使用率过高: ${(memoryPercent * 100).toFixed(1)}%`);
      report.recommendations.push('建议重启服务或优化内存使用');
    }

    // ----------------------------------------
    // 【Phase 4 · 任务 B.3】死信队列健康扫描
    // ----------------------------------------
    try {
      const deadLetter = await database.queryOne(
        `SELECT COUNT(*) AS count FROM memory_failed_queue WHERE status='pending'`
      );
      report.checks.memoryDeadLetter = {
        status: 'ok',
        pending: deadLetter ? deadLetter.count : 0
      };
      if (deadLetter && deadLetter.count > 100) {
        report.issues.push(`memory 死信队列待处理 ${deadLetter.count} 条（>100）`);
        report.recommendations.push({
          code: 'DEAD_LETTER_BACKLOG',
          advice: '检查 memoryQueue 持续失败的原因(db 写入/longTermMemory 逻辑),或手工 REVIEW 死信'
        });
      }
    } catch (deadErr) {
      // 表不存在(未运行迁移)时不 fatal
      report.checks.memoryDeadLetter = { status: 'warning', message: deadErr.message };
    }
    
    // ----------------------------------------
    // 输出检查报告
    // ----------------------------------------
    logger.info('每日自检完成');
    logger.info(`检查结果: ${report.issues.length === 0 ? '正常' : `发现 ${report.issues.length} 个问题`}`);
    
    if (report.issues.length > 0) {
      logger.warn('发现的问题:');
      report.issues.forEach(issue => logger.warn(`  - ${issue}`));
    }
    
    if (report.recommendations.length > 0) {
      logger.info('建议操作:');
      report.recommendations.forEach(rec => logger.info(`  - ${rec}`));
    }
    
    // 保存检查报告到数据库
    await saveCheckReport(report);
    
  } catch (error) {
    logger.error('每日自检执行失败:', error);
  }
  
  logger.info('========================================');
}

/**
 * 保存检查报告
 * 
 * @param {Object} report - 检查报告
 */
async function saveCheckReport(report) {
  try {
    // 将报告转为JSON字符串
    const reportJson = JSON.stringify(report);
    
    // 插入到系统日志表
    await database.run(`
      INSERT INTO system_logs (level, message, source, metadata)
      VALUES (?, ?, ?, ?)
    `, ['info', '每日自检报告', 'self_repair', reportJson]);
    
  } catch (error) {
    logger.error('保存检查报告失败:', error);
  }
}

// ============================================
// 会话清理
// ============================================

/**
 * 清理过期会话
 * 删除长时间未活跃的会话数据
 */
async function cleanupSessions() {
  try {
    // 计算过期时间戳
    const expireTime = Date.now() - config.session.expireTime;
    const expireDate = new Date(expireTime).toISOString();
    
    // 查询需要清理的会话
    const expiredSessions = await database.query(`
      SELECT id FROM sessions 
      WHERE updated_at < ? AND status = 'active'
    `, [expireDate]);
    
    if (expiredSessions.length === 0) {
      return; // 没有过期会话
    }
    
    logger.info(`发现 ${expiredSessions.length} 个过期会话，开始清理...`);
    
    // 将会话标记为已归档
    for (const session of expiredSessions) {
      await database.run(`
        UPDATE sessions 
        SET status = 'archived' 
        WHERE id = ?
      `, [session.id]);
    }
    
    logger.info(`已归档 ${expiredSessions.length} 个过期会话`);
    
  } catch (error) {
    logger.error('清理过期会话失败:', error);
  }
}

// ============================================
// 记忆维护
// ============================================

/**
 * 执行记忆维护
 * 压缩和清理过期记忆
 */
async function performMemoryMaintenance() {
  logger.info('========================================');
  logger.info('开始执行记忆维护...');
  logger.info('========================================');
  
  try {
    const memoryMaintenance = require('../memory/memoryMaintenance');
    
    // 执行记忆压缩
    const stats = await memoryMaintenance.compressUserMemory();
    
    logger.info('记忆维护完成', {
      usersProcessed: stats.usersProcessed,
      deleted: stats.deleted.total,
      retained: stats.retained.total
    });
    
    // 生成健康报告
    const healthReport = await memoryMaintenance.generateHealthReport();
    if (healthReport) {
      logger.info('记忆系统健康报告', {
        totalPreferences: healthReport.summary?.total_preferences,
        totalUsers: healthReport.summary?.total_users,
        estimatedCleanup: healthReport.maintenance?.estimatedCleanup
      });
    }
    
  } catch (error) {
    logger.error('记忆维护执行失败:', error);
  }
  
  logger.info('========================================');
}

// ============================================
// 统计收集
// ============================================

/**
 * 收集统计信息
 * 定期收集系统运行数据
 */
async function collectStats() {
  try {
    // 获取当前连接数
    const connections = sseHandler.getConnectionCount();
    
    // 获取内存使用
    const memory = process.memoryUsage();
    
    // 记录统计信息（仅debug级别，避免日志过多）
    logger.debug('系统统计', {
      connections,
      memory: {
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memory.heapTotal / 1024 / 1024)
      }
    });
    
  } catch (error) {
    logger.error('收集统计信息失败:', error);
  }
}

// ============================================
// 手动触发
// ============================================

/**
 * 手动触发每日自检
 * 用于测试或紧急检查
 */
async function triggerDailyCheck() {
  logger.info('手动触发每日自检...');
  await performDailyCheck();
}

/**
 * 手动触发会话清理
 */
async function triggerSessionCleanup() {
  logger.info('手动触发会话清理...');
  await cleanupSessions();
}

/**
 * 手动触发记忆维护
 */
async function triggerMemoryMaintenance() {
  logger.info('手动触发记忆维护...');
  await performMemoryMaintenance();
}

// ============================================
// 【Phase 4 · 任务 C.4】死信队列重放/告警
// ============================================

/**
 * 扫描 memory_failed_queue pending 记录。
 * 当前实现只做"人工审阅告警"(payload 仅含可序列化 meta,闭包无法重放)。
 * 自动重放需要把操作固化为 type+args 描述,留 Phase 5 落地。
 */
async function replayDeadLetters() {
  try {
    const items = await database.listPendingMemoryFailed(20);
    if (!items || items.length === 0) {
      logger.debug('[DeadLetter] 无待处理记录');
      return;
    }
    logger.warn('[DeadLetter] 待人工处理的死信记录', {
      count: items.length,
      sample: items.slice(0, 5).map(i => ({
        id: i.id, type: i.operation_type, userId: i.user_id, error: i.last_error
      }))
    });
  } catch (error) {
    logger.error('[DeadLetter] 重放任务失败:', error.message);
  }
}

async function triggerDeadLetterReplay() {
  logger.info('手动触发死信重放...');
  await replayDeadLetters();
}

// ============================================
// 导出模块
// ============================================

module.exports = {
  // 启动和停止
  start,
  stop,
  // 手动触发
  triggerDailyCheck,
  triggerSessionCleanup,
  triggerMemoryMaintenance,
  // 【Phase 4 · 任务 B/C.4】新增
  triggerDeadLetterReplay,
  generateErrorRecommendations
};
