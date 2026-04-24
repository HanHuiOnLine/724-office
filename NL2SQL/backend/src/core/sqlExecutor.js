/**
 * NL2SQL SQL 执行模块（Phase 4 · 任务 A.4）
 *
 * 职责：
 * - `validateSQL`：安全性校验（调 schemaLoader 白名单 + SELECT/WITH 前缀 + LIMIT 必须存在）
 * - `executeQuery`：连接 SR 业务库执行 SQL，返回统一结构
 *     - 5 类错误码：DRY_RUN / SR_DB_NOT_CONFIGURED / SR_DB_NOT_READY / SR_EXEC_ERROR / 正常
 *     - 行数限流（config.srDatabase.maxRows）+ `truncated` 标志
 *     - Phase 3 结果脱敏（maskResult.maskRows + FF_RESULT_MASKING）
 *
 * 不含 RLS 改写（仍由 `nl2sqlEngine.processQuery` 编排层调用 `sqlRewriter`，
 * 保持"改写 → 执行"解耦）。
 */

const config = require('./config');
const logger = require('../utils/logger');
const schemaLoader = require('./schemaLoader');
const srDatabase = require('./srDatabase');
const maskResult = require('../utils/maskResult');

let featureFlags = null;
try {
  featureFlags = require('../../config/feature-flags');
} catch (e) {
  featureFlags = {
    isEnabled: () => false
  };
}

// ============================================
// SQL 验证
// ============================================

function validateSQL(sql) {
  const validation = schemaLoader.validateSQL(sql);

  if (!validation.valid) {
    return validation;
  }

  let cleanedSQL = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--.*$/gm, '')
    .replace(/^\s*\n/gm, '')
    .trim()
    .toUpperCase();

  const allowedPrefixes = ['SELECT', 'WITH'];
  const hasValidPrefix = allowedPrefixes.some(prefix => cleanedSQL.startsWith(prefix));

  if (!hasValidPrefix) {
    return {
      valid: false,
      error: '只支持SELECT查询'
    };
  }

  if (!cleanedSQL.includes('LIMIT')) {
    return {
      valid: false,
      error: 'SQL必须包含LIMIT限制'
    };
  }

  return { valid: true };
}

// ============================================
// SQL 执行
// ============================================

async function executeQuery(sql) {
  logger.info('执行SQL查询', { sql: sql.substring(0, 100) + '...' });

  const startTime = Date.now();

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
    if (!config.srDatabase.enabled) {
      return {
        success: false,
        error: 'SR 数据源未配置（SR_DATABASE_URL 为空）',
        errorCode: 'SR_DB_NOT_CONFIGURED',
        executionTime: Date.now() - startTime,
        sql
      };
    }
    if (!srDatabase.isReady()) {
      return {
        success: false,
        error: 'SR 数据源连接池未就绪（启动时初始化失败）',
        errorCode: 'SR_DB_NOT_READY',
        executionTime: Date.now() - startTime,
        sql
      };
    }

    const { rows, columns, rowCount } = await srDatabase.executeQuery(sql, [], {
      timeoutMs: config.srDatabase.queryTimeoutMs
    });

    const maxRows = config.srDatabase.maxRows;
    const truncated = rowCount > maxRows;
    let limitedRows = truncated ? rows.slice(0, maxRows) : rows;

    // 【Phase 3 · T3a】结果脱敏
    let maskedCells = 0;
    if (
      featureFlags.isEnabled('RESULT_MASKING') &&
      config.security.masking &&
      config.security.masking.enabled
    ) {
      const masked = maskResult.maskRows(limitedRows, columns, config.security.masking.rules);
      limitedRows = masked.rows;
      maskedCells = masked.maskedCells;
      if (maskedCells > 0) {
        logger.debug('[脱敏] 已脱敏敏感字段值', { maskedCells, rowCount: limitedRows.length });
      }
    }

    const executionTime = Date.now() - startTime;

    logger.info('查询执行完成', {
      rowCount,
      returnedRows: limitedRows.length,
      truncated,
      maskedCells,
      executionTime
    });

    return {
      success: true,
      data: {
        columns,
        rows: limitedRows,
        rowCount,
        truncated
      },
      executionTime,
      sql
    };

  } catch (error) {
    logger.error('查询执行失败:', error);
    return {
      success: false,
      error: error.message,
      errorCode: error.code || 'SR_EXEC_ERROR',
      executionTime: Date.now() - startTime,
      sql
    };
  }
}

module.exports = {
  validateSQL,
  executeQuery
};
