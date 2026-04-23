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
  -- 【Phase 3 · T3c】审计字段
  -- 用户角色(admin/analyst/user 等,由 header X-User-Role 注入)
  user_role TEXT,
  -- 租户 ID(由 header X-Tenant-Id 注入,RLS 依据)
  tenant_id TEXT,
  -- 请求来源(web/cli/api 等,由 header X-Request-Source 注入)
  request_source TEXT,
  -- 请求 IP
  request_ip TEXT,
  -- 结构化错误码(如 RLS_REWRITE_FAILED / SR_EXEC_ERROR / VALIDATION_ERROR)
  error_code TEXT,
  -- 是否走了 agentic→legacy 自动回退(0=否,1=是)
  fallback_used INTEGER DEFAULT 0,
  -- RLS 改写命中的表列表(JSON 字符串),未启用/未命中为 NULL
  rls_applied TEXT,
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
-- 【Phase 3 · T3c】tenant_id 索引在 ensureQueryHistoryColumns 内创建(升级路径依赖列先 ALTER 补齐)

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
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- 是否置顶（0=普通, 1=置顶），置顶记忆不会被清理
  is_pinned INTEGER DEFAULT 0,
  -- 优先级（0=auto自动提取, 1=manual手动设置, 2=pinned置顶）
  priority INTEGER DEFAULT 0,
  -- 来源（auto=自动提取, manual=手动设置）
  source TEXT DEFAULT 'auto'
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
 * 【Phase 3 · T3c】幂等迁移:query_history 审计字段
 * PRAGMA table_info 收集现有列 → 缺失的逐列 ALTER TABLE ADD COLUMN。
 * 重复运行是 no-op;历史行新列 NULL(语义正确:Phase 3 前未知)。
 */
async function ensureQueryHistoryColumns() {
  try {
    const existing = await query(`PRAGMA table_info(query_history)`);
    const names = new Set(existing.map(r => r.name));
    const additions = [
      ['user_role',      'TEXT'],
      ['tenant_id',      'TEXT'],
      ['request_source', 'TEXT'],
      ['request_ip',     'TEXT'],
      ['error_code',     'TEXT'],
      ['fallback_used',  'INTEGER DEFAULT 0'],
      ['rls_applied',    'TEXT']
    ];
    let added = 0;
    for (const [col, type] of additions) {
      if (!names.has(col)) {
        await run(`ALTER TABLE query_history ADD COLUMN ${col} ${type}`);
        added++;
      }
    }
    if (added > 0) {
      logger.info(`[迁移] query_history 审计字段迁移完成: 新增 ${added} 列`);
    } else {
      logger.debug('[迁移] query_history 审计字段已齐全,跳过');
    }
    // 不论是新装还是升级,tenant_id 索引都在此处统一保证存在(依赖列已补齐)
    await run(`CREATE INDEX IF NOT EXISTS idx_query_history_tenant_id ON query_history(tenant_id)`);
  } catch (e) {
    // 迁移失败不应阻断启动 — 写入审计字段会降级为 NULL
    logger.error('[迁移] query_history 审计字段迁移失败:', e.message);
  }
}

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
        // 1. 创建新表（没有 UNIQUE 约束，包含新字段）
        await run(`
          CREATE TABLE user_preferences_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            preference_type TEXT NOT NULL,
            content TEXT NOT NULL,
            usage_count INTEGER DEFAULT 1,
            last_used_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            is_pinned INTEGER DEFAULT 0,
            priority INTEGER DEFAULT 0,
            source TEXT DEFAULT 'auto'
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

    // 【Phase 3 · T3c】query_history 审计字段迁移(idempotent)
    await ensureQueryHistoryColumns();

    logger.info('数据库迁移完成');
    
    // 清理重复的字段别名记录（在应用启动时执行一次）
    try {
      await cleanupDuplicateFieldAliases();
    } catch (cleanupErr) {
      logger.error('启动时清理重复字段别名失败:', cleanupErr);
      // 清理失败不影响启动
    }

    // 一次性迁移：清理重复的 metric/dimension 偏好 + 修正错误映射
    try {
      // 1. 清理重复的 metric_preference 和 dimension_preference
      //    保留每个 (user_id, preference_type, field_name) 组合中 id 最小的记录
      const dedupResult = await run(`
        DELETE FROM user_preferences
        WHERE id NOT IN (
          SELECT MIN(id) FROM user_preferences
          WHERE preference_type IN ('metric_preference', 'dimension_preference')
          GROUP BY user_id, preference_type, json_extract(content, '$.field_name')
        )
        AND preference_type IN ('metric_preference', 'dimension_preference')
      `);
      if (dedupResult.changes > 0) {
        logger.info(`清理了 ${dedupResult.changes} 条重复的 metric/dimension 偏好记录`);
      }

      // 2. 修正"老平台"映射错误：应映射到 new_tzpingtaiold [datasource]
      await run(`
        UPDATE user_preferences SET content = json_set(content,
          '$.schema_field', 'new_tzpingtaiold',
          '$.field_type', 'datasource')
        WHERE preference_type = 'field_alias'
        AND json_extract(content, '$.user_term') = '老平台'
        AND json_extract(content, '$.schema_field') = 'datasource'
        AND json_extract(content, '$.field_type') = 'filter'
      `);

      // 3. 清理 _value 后缀冗余记录
      const valueResult = await run(`
        DELETE FROM user_preferences
        WHERE preference_type = 'field_alias'
        AND json_extract(content, '$.user_term') LIKE '%_value'
      `);
      if (valueResult.changes > 0) {
        logger.info(`清理了 ${valueResult.changes} 条 _value 后缀冗余偏好记录`);
      }

      // 4. 清理"青木→game_id"冗余映射（已有"青木→30 [game]"）
      await run(`
        DELETE FROM user_preferences
        WHERE preference_type = 'field_alias'
        AND json_extract(content, '$.user_term') = '青木'
        AND json_extract(content, '$.schema_field') = 'game_id'
      `);
    } catch (migrationErr) {
      logger.error('启动时偏好数据迁移失败:', migrationErr);
      // 迁移失败不影响启动
    }
    
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
  } else if (type === 'metric_preference' || type === 'dimension_preference') {
    sql = `
      SELECT * FROM user_preferences
      WHERE user_id = ? AND preference_type = ?
      AND json_extract(content, "$.field_name") = ?
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
// 查询历史（query_history）相关操作
// ============================================

/**
 * 在查询开始时写入一条 pending 记录，返回 historyId
 * 主流程在 processQuery 入口调用，确保每次查询都有一行对应历史
 * @param {Object} params
 * @param {string} params.sessionId
 * @param {string} params.userId
 * @param {string} params.naturalQuery
 * @param {string} [params.userRole]       - Phase 3 · T3c 审计字段
 * @param {string} [params.tenantId]       - Phase 3 · T3c
 * @param {string} [params.requestSource]  - Phase 3 · T3c
 * @param {string} [params.requestIp]      - Phase 3 · T3c
 * @returns {Promise<number|null>} 新记录的自增 ID，失败返回 null
 */
async function createQueryHistory({
  sessionId, userId, naturalQuery,
  userRole, tenantId, requestSource, requestIp
}) {
  try {
    const result = await run(
      `INSERT INTO query_history
         (session_id, user_id, natural_query, status, created_at,
          user_role, tenant_id, request_source, request_ip)
       VALUES (?, ?, ?, 'pending', CURRENT_TIMESTAMP, ?, ?, ?, ?)`,
      [
        sessionId || null,
        userId || 'anonymous',
        naturalQuery || '',
        userRole || null,
        tenantId || null,
        requestSource || null,
        requestIp || null
      ]
    );
    return result.lastID;
  } catch (error) {
    logger.warn('创建 query_history 记录失败:', error.message);
    return null;
  }
}

/**
 * 将查询标记为成功，写入生成的 SQL、耗时、行数与样本结果
 * @param {number} id - createQueryHistory 返回的 historyId
 * @param {Object} params
 * @param {string} params.generatedSql
 * @param {number} params.executionTime
 * @param {number} params.rowCount
 * @param {Object} [params.result] - 可序列化的结果摘要（不建议写入完整结果集）
 * @param {boolean} [params.fallbackUsed] - Phase 3 · T3c,是否 agentic→legacy 回退
 * @param {string[]} [params.rlsApplied]  - Phase 3 · T3c,RLS 命中的表列表
 */
async function markQueryHistorySuccess(id, {
  generatedSql, executionTime, rowCount, result,
  fallbackUsed, rlsApplied
}) {
  if (!id) return;
  try {
    await run(
      `UPDATE query_history
          SET generated_sql = ?, status = 'success',
              execution_time = ?, row_count = ?,
              result = ?, executed_at = CURRENT_TIMESTAMP,
              fallback_used = ?, rls_applied = ?
        WHERE id = ?`,
      [
        generatedSql || null,
        typeof executionTime === 'number' ? executionTime : null,
        typeof rowCount === 'number' ? rowCount : null,
        result ? JSON.stringify(result).slice(0, 100000) : null,
        fallbackUsed ? 1 : 0,
        Array.isArray(rlsApplied) && rlsApplied.length > 0 ? JSON.stringify(rlsApplied) : null,
        id
      ]
    );
  } catch (error) {
    logger.warn('更新 query_history 成功状态失败:', error.message);
  }
}

/**
 * 将查询标记为失败，写入错误信息
 * @param {number} id
 * @param {Object} params
 * @param {string} [params.generatedSql]
 * @param {number} [params.executionTime]
 * @param {string} params.errorMessage
 * @param {string} [params.errorCode]     - Phase 3 · T3c,结构化错误码
 * @param {boolean} [params.fallbackUsed] - Phase 3 · T3c
 * @param {string[]} [params.rlsApplied]  - Phase 3 · T3c
 */
async function markQueryHistoryFailure(id, {
  generatedSql, executionTime, errorMessage,
  errorCode, fallbackUsed, rlsApplied
}) {
  if (!id) return;
  try {
    await run(
      `UPDATE query_history
          SET generated_sql = ?, status = 'failed',
              execution_time = ?, error_message = ?,
              executed_at = CURRENT_TIMESTAMP,
              error_code = ?, fallback_used = ?, rls_applied = ?
        WHERE id = ?`,
      [
        generatedSql || null,
        typeof executionTime === 'number' ? executionTime : null,
        (errorMessage || '').toString().slice(0, 2000),
        errorCode || null,
        fallbackUsed ? 1 : 0,
        Array.isArray(rlsApplied) && rlsApplied.length > 0 ? JSON.stringify(rlsApplied) : null,
        id
      ]
    );
  } catch (error) {
    logger.warn('更新 query_history 失败状态失败:', error.message);
  }
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

/**
 * 清理重复的字段别名记录
 * 保留使用次数最多、更新时间最新的记录，删除其他重复项
 * @returns {Promise<Object>} 清理统计
 */
async function cleanupDuplicateFieldAliases() {
  try {
    logger.info('开始清理重复的字段别名记录...');
    
    // 1. 查找所有重复的字段别名（按 user_id + user_term 分组）
    const duplicates = await query(`
      SELECT user_id, json_extract(content, '$.user_term') as user_term, COUNT(*) as count
      FROM user_preferences
      WHERE preference_type = 'field_alias'
      GROUP BY user_id, json_extract(content, '$.user_term')
      HAVING count > 1
    `);
    
    let totalRemoved = 0;
    let totalGroups = 0;
    
    for (const dup of duplicates) {
      const { user_id, user_term, count } = dup;
      totalGroups++;
      
      // 获取该组所有记录，按使用次数降序、更新时间降序排列
      const records = await query(`
        SELECT id, usage_count, last_used_at, json_extract(content, '$.schema_field') as schema_field
        FROM user_preferences
        WHERE user_id = ? 
          AND preference_type = 'field_alias'
          AND json_extract(content, '$.user_term') = ?
        ORDER BY usage_count DESC, last_used_at DESC, id ASC
      `, [user_id, user_term]);
      
      if (records.length <= 1) continue;
      
      // 按 schema_field 分组，保留每组最新的记录
      const schemaFieldGroups = {};
      for (const record of records) {
        const sf = record.schema_field || 'unknown';
        if (!schemaFieldGroups[sf]) {
          schemaFieldGroups[sf] = [];
        }
        schemaFieldGroups[sf].push(record);
      }
      
      // 对每个 schema_field 分组，保留第一条（使用次数最多、最新的），删除其余
      const idsToDelete = [];
      for (const [schemaField, groupRecords] of Object.entries(schemaFieldGroups)) {
        // 保留第一条，删除其余的
        for (let i = 1; i < groupRecords.length; i++) {
          idsToDelete.push(groupRecords[i].id);
        }
      }
      
      if (idsToDelete.length > 0) {
        // 批量删除重复记录
        const placeholders = idsToDelete.map(() => '?').join(',');
        const result = await run(`
          DELETE FROM user_preferences 
          WHERE id IN (${placeholders})
        `, idsToDelete);
        
        totalRemoved += result.changes;
        logger.info('清理重复字段别名', {
          userId: user_id,
          userTerm,
          removedCount: result.changes,
          keptId: records[0].id
        });
      }
    }
    
    logger.info('重复字段别名清理完成', {
      duplicateGroups: totalGroups,
      totalRemoved
    });
    
    return {
      duplicateGroups: totalGroups,
      totalRemoved
    };
    
  } catch (error) {
    logger.error('清理重复字段别名失败:', error);
    return { duplicateGroups: 0, totalRemoved: 0, error: error.message };
  }
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
  cleanupDuplicateFieldAliases,
  // 查询历史
  createQueryHistory,
  markQueryHistorySuccess,
  markQueryHistoryFailure,
  // 【Phase 3 · T3c】幂等迁移函数(供单测直接调用)
  ensureQueryHistoryColumns,
  // 关闭连接
  close
};
