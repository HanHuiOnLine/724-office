/**
 * SR 业务数据源（MySQL）连接池封装
 *
 * 职责：
 *  - 基于 SR_DATABASE_URL 建立并复用 mysql2/promise 连接池
 *  - 以只读会话 + 超时方式执行 LLM 生成的 SELECT/WITH SQL
 *  - 统一返回 { rows, columns, rowCount } 结构，调用方无需接触连接对象
 *
 * 设计要点：
 *  1. 支持懒加载：mysql2 未安装或 URL 为空时 initialize() 仅打印告警，executeQuery 抛错
 *  2. 只读保护：每次取连接后 SET SESSION TRANSACTION READ ONLY
 *  3. 超时控制：通过 MAX_EXECUTION_TIME（MySQL 5.7.8+）+ query timeout 双重兜底
 */

const config = require('./config');
const logger = require('../utils/logger');
const { ensureLimit, hasOuterLimit } = require('../utils/sqlLimit');

// 连接池单例
let pool = null;
// mysql2 是否可用（避免每次 executeQuery 都重复 require 失败）
let mysqlModule = null;
let mysqlModuleLoaded = false;

function loadMysqlModule() {
  if (mysqlModuleLoaded) return mysqlModule;
  mysqlModuleLoaded = true;
  try {
    mysqlModule = require('mysql2/promise');
  } catch (err) {
    logger.warn('[SR-DB] mysql2 依赖未安装，真实查询将不可用: ' + err.message);
    mysqlModule = null;
  }
  return mysqlModule;
}

/**
 * 初始化连接池
 * - 未配置 SR_DATABASE_URL 或 mysql2 缺失：只告警，不抛错
 * - 失败不阻塞应用启动，后续 executeQuery 会以 success=false 返回
 */
async function initialize() {
  if (!config.srDatabase.enabled || !config.srDatabase.url) {
    logger.warn('[SR-DB] SR_DATABASE_URL 未配置或已禁用，跳过连接池初始化');
    return;
  }
  const mysql = loadMysqlModule();
  if (!mysql) {
    logger.warn('[SR-DB] mysql2 模块不可用，跳过连接池初始化');
    return;
  }
  try {
    pool = mysql.createPool({
      uri: config.srDatabase.url,
      connectionLimit: config.srDatabase.pool.max,
      waitForConnections: true,
      queueLimit: 0,
      timezone: '+08:00',
      supportBigNumbers: true,
      bigNumberStrings: false,
      dateStrings: true
    });
    // 探活
    const conn = await pool.getConnection();
    try {
      await conn.query('SELECT 1');
    } finally {
      conn.release();
    }
    logger.info('[SR-DB] SR 数据库连接池初始化完成', {
      maxConnections: config.srDatabase.pool.max
    });
  } catch (err) {
    // 完整输出错误详情（code / errno / message / stack），便于排查：URL 错、密码错、端口不通等
    logger.error('[SR-DB] 连接池初始化失败，将禁用真实执行', err);
    logger.warn('[SR-DB] 失败详情', {
      code: err.code,
      errno: err.errno,
      sqlState: err.sqlState,
      message: err.message,
      address: err.address,
      port: err.port
    });
    pool = null;
  }
}

/**
 * 执行只读 SQL
 * @param {string} sql - LLM 生成的 SELECT/WITH 语句
 * @param {Array}  params - 参数化查询参数
 * @param {Object} options - { timeoutMs }
 * @returns {Promise<{rows: Array, columns: Array<string>, rowCount: number}>}
 */
async function executeQuery(sql, params = [], options = {}) {
  if (!pool) {
    throw new Error('SR 数据库未初始化（连接池不可用）');
  }
  const timeoutMs = options.timeoutMs || config.srDatabase.queryTimeoutMs || 30000;

  // 【Phase 2 / TODO T3】执行层 LIMIT 兜底：若上游未注入外层 LIMIT，这里按 maxRows 补全
  // 避免大结果集全量从 MySQL 拉回再应用层 slice
  let finalSql = sql;
  if (!hasOuterLimit(sql)) {
    const limited = ensureLimit(sql, config.srDatabase.maxRows);
    finalSql = limited.sql;
    if (limited.injected) {
      logger.warn('[SR-DB] 执行前补 LIMIT（上游未注入）', { maxRows: config.srDatabase.maxRows });
    }
  }

  const conn = await pool.getConnection();
  try {
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    // MAX_EXECUTION_TIME 仅对 SELECT 生效，单位毫秒
    await conn.query(`SET SESSION MAX_EXECUTION_TIME = ${Math.max(1000, timeoutMs)}`);
    const [rows, fields] = await conn.query({ sql: finalSql, timeout: timeoutMs }, params);
    const normalizedRows = Array.isArray(rows) ? rows : [];
    return {
      rows: normalizedRows,
      columns: (fields || []).map(f => f.name),
      rowCount: normalizedRows.length
    };
  } finally {
    try { conn.release(); } catch (_) { /* noop */ }
  }
}

function isReady() {
  return !!pool;
}

function getPool() {
  return pool;
}

async function shutdown() {
  if (!pool) return;
  try {
    await pool.end();
    logger.info('[SR-DB] 连接池已关闭');
  } catch (err) {
    logger.warn('[SR-DB] 关闭连接池失败: ' + err.message);
  } finally {
    pool = null;
  }
}

module.exports = {
  initialize,
  executeQuery,
  isReady,
  getPool,
  shutdown
};
