/**
 * SQLite数据库管理模块
 * 
 * 负责会话历史、查询日志等数据的持久化存储
 * 使用SQLite轻量级数据库，无需额外安装数据库服务
 */

// ============================================
// 导入依赖模块
// ============================================

// 导入sqlite3模块，使用verbose模式获取更详细的错误信息
const sqlite3 = require('sqlite3').verbose();
// 导入Node.js内置的path模块，用于处理文件路径
const path = require('path');
// 导入配置模块，获取数据库配置
const config = require('./config');
// 导入日志模块，用于记录数据库操作日志
const logger = require('../utils/logger');

// ============================================
// 数据库连接实例
// ============================================

/**
 * 数据库连接实例
 * 初始为null，在initialize函数中创建
 */
let db = null;

// ============================================
// SQL语句定义
// ============================================

/**
 * 初始化数据库表结构的SQL语句
 * 按顺序执行创建表和索引
 */
const CREATE_TABLES_SQL = `
-- ============================================
-- 会话表 (sessions)
-- 存储用户的会话信息
-- ============================================
CREATE TABLE IF NOT EXISTS sessions (
  -- 会话唯一标识，使用UUID
  id TEXT PRIMARY KEY,
  -- 用户标识
  user_id TEXT NOT NULL,
  -- 会话标题（可选，用于展示）
  title TEXT,
  -- 会话创建时间，默认为当前时间
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- 最后更新时间
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- 会话状态：active(活跃), archived(归档), deleted(删除)
  status TEXT DEFAULT 'active'
);

-- 为user_id创建索引，加速按用户查询会话
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
-- 为status创建索引，加速按状态筛选
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
-- 为updated_at创建索引，加速按时间排序
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);

-- ============================================
-- 消息表 (messages)
-- 存储会话中的消息历史
-- ============================================
CREATE TABLE IF NOT EXISTS messages (
  -- 消息唯一标识
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 所属会话ID，外键关联sessions表
  session_id TEXT NOT NULL,
  -- 消息角色：user(用户), assistant(助手), system(系统), tool(工具)
  role TEXT NOT NULL,
  -- 消息内容
  content TEXT NOT NULL,
  -- 消息类型：text(文本), sql(SQL代码), result(查询结果), error(错误), clarify(澄清)
  type TEXT DEFAULT 'text',
  -- 附加元数据，以JSON字符串存储
  metadata TEXT,
  -- 消息创建时间
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- 外键约束，关联sessions表
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- 为session_id创建索引，加速按会话查询消息
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
-- 为created_at创建索引，加速按时间排序
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- ============================================
-- 查询历史表 (query_history)
-- 存储用户的数据查询记录
-- ============================================
CREATE TABLE IF NOT EXISTS query_history (
  -- 查询唯一标识
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 所属会话ID
  session_id TEXT,
  -- 用户标识
  user_id TEXT NOT NULL,
  -- 用户的自然语言查询
  natural_query TEXT NOT NULL,
  -- 生成的SQL语句
  generated_sql TEXT,
  -- 查询执行状态：pending(待执行), success(成功), failed(失败)
  status TEXT DEFAULT 'pending',
  -- 查询执行结果（JSON格式）
  result TEXT,
  -- 错误信息（如果失败）
  error_message TEXT,
  -- 执行耗时（毫秒）
  execution_time INTEGER,
  -- 返回行数
  row_count INTEGER,
  -- 查询创建时间
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- 查询执行时间
  executed_at DATETIME,
  -- 外键约束
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

-- 为user_id创建索引，加速按用户查询历史
CREATE INDEX IF NOT EXISTS idx_query_history_user_id ON query_history(user_id);
-- 为session_id创建索引，加速按会话查询
CREATE INDEX IF NOT EXISTS idx_query_history_session_id ON query_history(session_id);
-- 为created_at创建索引，加速按时间排序
CREATE INDEX IF NOT EXISTS idx_query_history_created_at ON query_history(created_at);
-- 为status创建索引，加速按状态筛选
CREATE INDEX IF NOT EXISTS idx_query_history_status ON query_history(status);

-- ============================================
-- 用户偏好表 (user_preferences)
-- 存储用户的查询偏好和常用模式
-- ============================================
CREATE TABLE IF NOT EXISTS user_preferences (
  -- 记录唯一标识
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 用户标识（移除UNIQUE约束，允许一个用户有多条偏好）
  user_id TEXT NOT NULL,
  -- 偏好类型：field_alias(字段别名), query_pattern(查询模式), metric_preference(常用指标), dimension_preference(常用维度)
  preference_type TEXT NOT NULL,
  -- 偏好内容（JSON格式）
  content TEXT NOT NULL,
  -- 使用次数，用于排序推荐
  usage_count INTEGER DEFAULT 1,
  -- 最后使用时间
  last_used_at DATETIME,
  -- 创建时间
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- 更新时间
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 为user_id创建索引
CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id ON user_preferences(user_id);
-- 为preference_type创建索引
CREATE INDEX IF NOT EXISTS idx_user_preferences_type ON user_preferences(preference_type);
-- 添加复合索引，加速按用户和类型查询
CREATE INDEX IF NOT EXISTS idx_user_prefs_user_type ON user_preferences(user_id, preference_type);

-- ============================================
-- 系统日志表 (system_logs)
-- 存储系统运行日志
-- ============================================
CREATE TABLE IF NOT EXISTS system_logs (
  -- 日志唯一标识
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 日志级别：debug, info, warn, error
  level TEXT NOT NULL,
  -- 日志消息
  message TEXT NOT NULL,
  -- 日志来源模块
  source TEXT,
  -- 附加数据（JSON格式）
  metadata TEXT,
  -- 日志时间
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 为level创建索引，加速按级别查询
CREATE INDEX IF NOT EXISTS idx_system_logs_level ON system_logs(level);
-- 为created_at创建索引，加速按时间查询
CREATE INDEX IF NOT EXISTS idx_system_logs_created_at ON system_logs(created_at);
`;

// ============================================
// 数据库初始化
// ============================================

/**
 * 初始化数据库
 * 创建数据库连接并初始化表结构
 * @returns {Promise<void>}
 */
async function initialize() {
  // 返回一个Promise，用于异步处理
  return new Promise((resolve, reject) => {
    // 获取数据库文件路径，从配置中读取
    const dbPath = path.resolve(config.database.path);
    
    // 记录开始初始化日志
    logger.info(`正在初始化SQLite数据库: ${dbPath}`);
    
    // 创建数据库连接
    // sqlite3.Database构造函数参数：
    // 1. 数据库文件路径
    // 2. 打开模式（OPEN_CREATE: 如果不存在则创建，OPEN_READWRITE: 读写模式）
    // 3. 回调函数，连接成功或失败时调用
    db = new sqlite3.Database(
      dbPath,
      sqlite3.OPEN_CREATE | sqlite3.OPEN_READWRITE,
      (err) => {
        // 如果发生错误，记录错误日志并拒绝Promise
        if (err) {
          logger.error('数据库连接失败:', err);
          reject(err);
          return;
        }
        
        // 连接成功，记录日志
        logger.info('数据库连接成功');
        
        // 启用外键约束（SQLite默认关闭）
        db.run('PRAGMA foreign_keys = ON', (err) => {
          if (err) {
            logger.error('启用外键约束失败:', err);
          } else {
            logger.debug('外键约束已启用');
          }
        });
        
        // 执行创建表的SQL语句
        db.exec(CREATE_TABLES_SQL, async (err) => {
          if (err) {
            // 创建表失败，记录错误并拒绝Promise
            logger.error('创建数据表失败:', err);
            reject(err);
            return;
          }
          
          // 表创建成功，记录日志
          logger.info('数据表初始化完成');
          
          // 执行数据库迁移（修复旧表结构）
          try {
            await runMigrations();
            resolve();
          } catch (migrationErr) {
            logger.error('数据库迁移失败:', migrationErr);
            reject(migrationErr);
          }
        });
      }
    );
  });
}

// ============================================
// 数据库迁移
// ============================================

/**
 * 执行数据库迁移
 * 修复旧版本表结构问题
 */
async function runMigrations() {
  logger.info('执行数据库迁移...');
  
  try {
    // 检查 user_preferences 表是否有 UNIQUE 约束
    const tableInfo = await query(`PRAGMA index_list(user_preferences)`);
    
    // 查找是否有以 sqlite_autoindex 开头的唯一索引（表示有 UNIQUE 约束）
    const uniqueIndex = tableInfo.find(idx => 
      idx.name && idx.name.startsWith('sqlite_autoindex') && idx.unique === 1
    );
    
    if (uniqueIndex) {
      logger.warn('检测到 user_preferences 表有旧的 UNIQUE 约束，需要重建表...');
      
      // 重建表以移除 UNIQUE 约束
      await run('BEGIN TRANSACTION');
      
      try {
        // 1. 创建新表（没有 UNIQUE 约束）
        await run(`
          CREATE TABLE user_preferences_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            preference_type TEXT NOT NULL,
            content TEXT NOT NULL,
            usage_count INTEGER DEFAULT 1,
            last_used_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);
        
        // 2. 复制数据
        await run(`
          INSERT INTO user_preferences_new 
          SELECT * FROM user_preferences
        `);
        
        // 3. 删除旧表
        await run('DROP TABLE user_preferences');
        
        // 4. 重命名新表
        await run('ALTER TABLE user_preferences_new RENAME TO user_preferences');
        
        // 5. 重新创建索引
        await run('CREATE INDEX idx_user_preferences_user_id ON user_preferences(user_id)');
        await run('CREATE INDEX idx_user_preferences_type ON user_preferences(preference_type)');
        await run('CREATE INDEX idx_user_prefs_user_type ON user_preferences(user_id, preference_type)');
        
        await run('COMMIT');
        logger.info('user_preferences 表重建完成，UNIQUE 约束已移除');
      } catch (err) {
        await run('ROLLBACK');
        throw err;
      }
    } else {
      logger.debug('user_preferences 表结构正常，无需迁移');
    }
    
    logger.info('数据库迁移完成');
  } catch (error) {
    logger.error('数据库迁移失败:', error);
    throw error;
  }
}

// ============================================
// 数据库操作方法
// ============================================

/**
 * 获取数据库连接实例
 * @returns {sqlite3.Database} 数据库连接对象
 * @throws {Error} 如果数据库未初始化
 */
function getDb() {
  // 检查数据库是否已初始化
  if (!db) {
    throw new Error('数据库尚未初始化，请先调用initialize()');
  }
  return db;
}

/**
 * 执行SQL查询（返回多行结果）
 * @param {string} sql - SQL查询语句
 * @param {Array} params - 查询参数（用于参数化查询，防止SQL注入）
 * @returns {Promise<Array>} 查询结果数组
 */
function query(sql, params = []) {
  // 返回Promise用于异步处理
  return new Promise((resolve, reject) => {
    // 使用all方法执行查询，返回所有匹配的行
    // 参数：
    // 1. SQL语句
    // 2. 参数数组（替换SQL中的?占位符）
    // 3. 回调函数
    db.all(sql, params, (err, rows) => {
      if (err) {
        // 查询出错，记录错误并拒绝Promise
        logger.error('SQL查询失败:', err, { sql, params });
        reject(err);
        return;
      }
      // 查询成功，返回结果行
      resolve(rows);
    });
  });
}

/**
 * 执行SQL查询（返回单行结果）
 * @param {string} sql - SQL查询语句
 * @param {Array} params - 查询参数
 * @returns {Promise<Object>} 单行结果对象
 */
function queryOne(sql, params = []) {
  return new Promise((resolve, reject) => {
    // 使用get方法执行查询，只返回第一行
    db.get(sql, params, (err, row) => {
      if (err) {
        logger.error('SQL查询失败:', err, { sql, params });
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

/**
 * 执行SQL语句（插入、更新、删除）
 * @param {string} sql - SQL语句
 * @param {Array} params - 语句参数
 * @returns {Promise<Object>} 执行结果，包含lastID和changes
 */
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    // 使用run方法执行非查询语句
    db.run(sql, params, function(err) {
      if (err) {
        logger.error('SQL执行失败:', err, { sql, params });
        reject(err);
        return;
      }
      // this对象包含：lastID（最后插入的ID）和changes（受影响的行数）
      resolve({
        lastID: this.lastID,
        changes: this.changes
      });
    });
  });
}

/**
 * 在事务中执行多个操作
 * @param {Function} callback - 回调函数，接收db参数执行操作
 * @returns {Promise<void>}
 */
async function transaction(callback) {
  // 开始事务
  await run('BEGIN TRANSACTION');
  
  try {
    // 执行回调函数中的操作
    await callback(db);
    // 提交事务
    await run('COMMIT');
  } catch (error) {
    // 发生错误，回滚事务
    await run('ROLLBACK');
    throw error;
  }
}

// ============================================
// 会话相关操作
// ============================================

/**
 * 创建新会话
 * @param {string} sessionId - 会话ID
 * @param {string} userId - 用户ID
 * @param {string} title - 会话标题
 * @returns {Promise<Object>} 创建的会话信息
 */
async function createSession(sessionId, userId, title = null) {
  const sql = `
    INSERT INTO sessions (id, user_id, title)
    VALUES (?, ?, ?)
  `;
  await run(sql, [sessionId, userId, title]);
  logger.debug(`创建会话: ${sessionId}`);
  return { id: sessionId, user_id: userId, title };
}

/**
 * 获取会话信息
 * @param {string} sessionId - 会话ID
 * @returns {Promise<Object>} 会话信息
 */
async function getSession(sessionId) {
  const sql = 'SELECT * FROM sessions WHERE id = ? AND status = ?';
  return await queryOne(sql, [sessionId, 'active']);
}

/**
 * 获取用户的所有会话
 * @param {string} userId - 用户ID
 * @param {number} limit - 返回数量限制
 * @returns {Promise<Array>} 会话列表
 */
async function getUserSessions(userId, limit = 20) {
  const sql = `
    SELECT * FROM sessions 
    WHERE user_id = ? AND status = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `;
  return await query(sql, [userId, 'active', limit]);
}

/**
 * 更新会话时间
 * @param {string} sessionId - 会话ID
 */
async function touchSession(sessionId) {
  const sql = 'UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?';
  await run(sql, [sessionId]);
}

/**
 * 更新会话标题
 * @param {string} sessionId - 会话ID
 * @param {string} title - 新标题
 * @returns {Promise<boolean>} 是否更新成功
 */
async function updateSessionTitle(sessionId, title) {
  const sql = 'UPDATE sessions SET title = ? WHERE id = ?';
  const result = await run(sql, [title, sessionId]);
  logger.debug(`更新会话标题: ${sessionId} -> ${title}`);
  return result.changes > 0;
}

/**
 * 删除会话
 * @param {string} sessionId - 会话ID
 * @returns {Promise<boolean>} 是否删除成功
 */
async function deleteSession(sessionId) {
  try {
    // 开启事务
    await transaction(async () => {
      // 先删除会话相关的所有消息
      const deleteMessagesSql = 'DELETE FROM messages WHERE session_id = ?';
      await run(deleteMessagesSql, [sessionId]);
      
      // 再删除会话
      const deleteSessionSql = 'DELETE FROM sessions WHERE id = ?';
      await run(deleteSessionSql, [sessionId]);
    });
    
    logger.info(`会话已删除: ${sessionId}`);
    return true;
  } catch (error) {
    logger.error(`删除会话失败: ${sessionId}`, error);
    throw error;
  }
}

// ============================================
// 消息相关操作
// ============================================

/**
 * 添加消息到会话
 * @param {string} sessionId - 会话ID
 * @param {string} role - 消息角色
 * @param {string} content - 消息内容
 * @param {string} type - 消息类型
 * @param {Object} metadata - 附加元数据
 * @returns {Promise<Object>} 创建的消息
 */
async function addMessage(sessionId, role, content, type = 'text', metadata = null) {
  const sql = `
    INSERT INTO messages (session_id, role, content, type, metadata)
    VALUES (?, ?, ?, ?, ?)
  `;
  const metaStr = metadata ? JSON.stringify(metadata) : null;
  const result = await run(sql, [sessionId, role, content, type, metaStr]);
  
  // 更新会话时间
  await touchSession(sessionId);
  
  return {
    id: result.lastID,
    session_id: sessionId,
    role,
    content,
    type,
    metadata
  };
}

/**
 * 获取会话的消息历史
 * @param {string} sessionId - 会话ID
 * @param {number} limit - 返回消息数量限制
 * @returns {Promise<Array>} 消息列表
 */
async function getSessionMessages(sessionId, limit = 50) {
  const sql = `
    SELECT * FROM messages 
    WHERE session_id = ?
    ORDER BY created_at ASC
    LIMIT ?
  `;
  const messages = await query(sql, [sessionId, limit]);
  
  // 解析metadata JSON字符串
  return messages.map(msg => ({
    ...msg,
    metadata: msg.metadata ? JSON.parse(msg.metadata) : null
  }));
}

// ============================================
// 长期记忆（用户偏好）操作
// ============================================

/**
 * 添加用户偏好
 * @param {string} userId - 用户ID
 * @param {string} type - 偏好类型
 * @param {Object} content - 偏好内容
 * @returns {Promise<Object>} 创建的偏好记录
 */
async function addUserPreference(userId, type, content) {
  const sql = `
    INSERT INTO user_preferences (user_id, preference_type, content, last_used_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `;
  const contentStr = JSON.stringify(content);
  const result = await run(sql, [userId, type, contentStr]);
  logger.debug(`添加用户偏好: ${userId}, type=${type}`);
  return { id: result.lastID, user_id: userId, preference_type: type, content };
}

/**
 * 获取用户偏好列表
 * @param {string} userId - 用户ID
 * @param {string} type - 偏好类型（可选）
 * @param {number} limit - 返回数量限制
 * @returns {Promise<Array>} 偏好列表
 */
async function getUserPreferences(userId, type = null, limit = 50) {
  let sql = `
    SELECT * FROM user_preferences 
    WHERE user_id = ?
  `;
  const params = [userId];
  
  if (type) {
    sql += ' AND preference_type = ?';
    params.push(type);
  }
  
  sql += ' ORDER BY usage_count DESC, last_used_at DESC LIMIT ?';
  params.push(limit);
  
  const preferences = await query(sql, params);
  
  // 解析content JSON字符串
  return preferences.map(pref => ({
    ...pref,
    content: pref.content ? JSON.parse(pref.content) : null
  }));
}

/**
 * 更新偏好使用统计
 * @param {number} preferenceId - 偏好记录ID
 * @returns {Promise<boolean>} 是否更新成功
 */
async function updatePreferenceUsage(preferenceId) {
  const sql = `
    UPDATE user_preferences 
    SET usage_count = usage_count + 1, 
        last_used_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `;
  const result = await run(sql, [preferenceId]);
  return result.changes > 0;
}

/**
 * 获取常用查询模板（按使用次数排序）
 * @param {string} userId - 用户ID
 * @param {number} limit - 返回数量限制
 * @returns {Promise<Array>} 查询模板列表
 */
async function getTopQueryPatterns(userId, limit = 10) {
  const sql = `
    SELECT * FROM user_preferences 
    WHERE user_id = ? AND preference_type = 'query_pattern'
    ORDER BY usage_count DESC, last_used_at DESC
    LIMIT ?
  `;
  const patterns = await query(sql, [userId, limit]);
  
  return patterns.map(p => ({
    ...p,
    content: p.content ? JSON.parse(p.content) : null
  }));
}

/**
 * 获取字段别名映射
 * @param {string} userId - 用户ID
 * @param {string} fieldName - 字段名（可选，不传则返回所有别名）
 * @returns {Promise<Array>} 别名映射列表
 */
async function getFieldAliases(userId, fieldName = null) {
  let sql = `
    SELECT * FROM user_preferences 
    WHERE user_id = ? AND preference_type = 'field_alias'
  `;
  const params = [userId];
  
  if (fieldName) {
    sql += ' AND json_extract(content, "$.schema_field") = ?';
    params.push(fieldName);
  }
  
  sql += ' ORDER BY usage_count DESC';
  
  const aliases = await query(sql, params);
  
  return aliases.map(a => ({
    ...a,
    content: a.content ? JSON.parse(a.content) : null
  }));
}

/**
 * 查找已存在的偏好（用于判断是否需要更新而非新增）
 * @param {string} userId - 用户ID
 * @param {string} type - 偏好类型
 * @param {string} contentKey - 内容中的关键字段值（如pattern的名称或alias的用户术语）
 * @returns {Promise<Object|null>} 已存在的偏好记录
 */
async function findExistingPreference(userId, type, contentKey) {
  let sql;
  let params = [userId, type];
  
  if (type === 'query_pattern') {
    sql = `
      SELECT * FROM user_preferences 
      WHERE user_id = ? AND preference_type = ?
      AND json_extract(content, "$.name") = ?
    `;
    params.push(contentKey);
  } else if (type === 'field_alias') {
    sql = `
      SELECT * FROM user_preferences 
      WHERE user_id = ? AND preference_type = ?
      AND json_extract(content, "$.user_term") = ?
    `;
    params.push(contentKey);
  } else {
    return null;
  }
  
  const result = await queryOne(sql, params);
  if (result) {
    result.content = result.content ? JSON.parse(result.content) : null;
  }
  return result;
}

/**
 * 删除用户偏好
 * @param {number} preferenceId - 偏好记录ID
 * @returns {Promise<boolean>} 是否删除成功
 */
async function deleteUserPreference(preferenceId) {
  const sql = 'DELETE FROM user_preferences WHERE id = ?';
  const result = await run(sql, [preferenceId]);
  logger.debug(`删除用户偏好: ${preferenceId}`);
  return result.changes > 0;
}

/**
 * 获取近期相似查询次数（用于频率判断）
 * @param {string} userId - 用户ID
 * @param {string} patternType - 模式类型
 * @param {number} days - 天数范围
 * @returns {Promise<number>} 相似查询次数
 */
async function getRecentPatternCount(userId, patternType, days = 7) {
  const sql = `
    SELECT COUNT(*) as count FROM user_preferences 
    WHERE user_id = ? 
    AND preference_type = ?
    AND created_at > datetime('now', '-${days} days')
  `;
  const result = await queryOne(sql, [userId, patternType]);
  return result ? result.count : 0;
}

// ============================================
// 关闭数据库
// ============================================

/**
 * 关闭数据库连接
 * @returns {Promise<void>}
 */
async function close() {
  // 返回Promise用于异步处理
  return new Promise((resolve, reject) => {
    // 检查数据库是否已初始化
    if (!db) {
      resolve(); // 未初始化，直接返回
      return;
    }
    
    // 关闭数据库连接
    db.close((err) => {
      if (err) {
        logger.error('关闭数据库失败:', err);
        reject(err);
        return;
      }
      logger.info('数据库连接已关闭');
      db = null;
      resolve();
    });
  });
}

// ============================================
// 导出模块
// ============================================

module.exports = {
  // 初始化函数
  initialize,
  // 获取数据库实例
  getDb,
  // 查询方法
  query,
  queryOne,
  run,
  transaction,
  // 会话操作
  createSession,
  getSession,
  getUserSessions,
  touchSession,
  updateSessionTitle,
  deleteSession,
  // 消息操作
  addMessage,
  getSessionMessages,
  // 长期记忆操作
  addUserPreference,
  getUserPreferences,
  updatePreferenceUsage,
  getTopQueryPatterns,
  getFieldAliases,
  findExistingPreference,
  deleteUserPreference,
  getRecentPatternCount,
  // 关闭连接
  close
};
