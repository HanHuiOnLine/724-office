/**
 * SSE处理器模块
 * 
 * 负责处理Server-Sent Events连接和消息，实现：
 * 1. SSE连接管理
 * 2. 流式消息发送
 * 3. 进度回调支持
 * 4. 连接清理
 */

// ============================================
// 导入依赖模块
// ============================================

// 导入日志模块
const logger = require('../utils/logger');
// 导入数据库模块
const database = require('./database');
// 导入NL2SQL引擎
const nl2sqlEngine = require('./nl2sqlEngine');

// ============================================
// 连接管理
// ============================================

/**
 * 活跃的SSE连接映射
 * 以sessionId为key，连接信息数组为value（支持多标签页）
 */
const connections = new Map();

// ============================================
// 连接处理
// ============================================

/**
 * 处理新的SSE连接
 * 当客户端建立SSE连接时调用
 * 
 * @param {Object} req - HTTP请求对象
 * @param {Object} res - HTTP响应对象
 */
async function handleConnection(req, res) {
  // 从URL查询参数获取会话ID和用户ID
  const sessionId = req.query.session_id;
  const userId = req.query.user_id || 'anonymous';
  
  if (!sessionId) {
    res.status(400).json({ error: '缺少session_id参数' });
    return;
  }
  
  // 记录连接日志
  logger.info(`SSE连接建立`, { sessionId, userId, ip: req.ip });
  
  // 检查会话是否存在
  let session = await database.getSession(sessionId);
  if (!session) {
    logger.warn(`SSE连接失败: 会话不存在`, { sessionId });
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  
  // 设置SSE响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // 禁用Nginx缓冲
  });
  
  // 存储连接信息
  const connectionInfo = {
    // HTTP响应对象（用于发送消息）
    res: res,
    // 会话ID
    sessionId: sessionId,
    // 用户ID
    userId: userId,
    // 连接时间
    connectedAt: Date.now(),
    // 最后活跃时间
    lastActiveAt: Date.now(),
    // 是否正在处理请求
    isProcessing: false
  };
  
  // 添加到连接映射（支持多连接）
  if (!connections.has(sessionId)) {
    connections.set(sessionId, []);
  }
  connections.get(sessionId).push(connectionInfo);
  
  // 发送连接成功消息
  sendMessage(connectionInfo, {
    type: 'connected',
    data: {
      session_id: sessionId,
      message: '连接成功'
    }
  });
  
  // 监听连接关闭
  req.on('close', () => {
    handleClose(connectionInfo);
  });
  
  // 监听错误
  req.on('error', (error) => {
    handleError(connectionInfo, error);
  });
}

/**
 * 处理连接关闭
 * 
 * @param {Object} conn - 连接信息对象
 */
function handleClose(conn) {
  logger.info(`SSE连接关闭`, { 
    sessionId: conn.sessionId, 
    connectedAt: conn.connectedAt 
  });
  
  // 从连接映射中移除
  const connList = connections.get(conn.sessionId);
  if (connList) {
    const index = connList.indexOf(conn);
    if (index > -1) {
      connList.splice(index, 1);
    }
    // 如果该sessionId没有连接了，删除key
    if (connList.length === 0) {
      connections.delete(conn.sessionId);
    }
  }
}

/**
 * 处理连接错误
 * 
 * @param {Object} conn - 连接信息对象
 * @param {Error} error - 错误对象
 */
function handleError(conn, error) {
  logger.error(`SSE连接错误`, { 
    sessionId: conn.sessionId, 
    error: error.message 
  });
  
  // 从连接映射中移除
  handleClose(conn);
}

// ============================================
// 消息发送
// ============================================

/**
 * 发送消息到客户端
 * 
 * @param {Object} conn - 连接信息对象
 * @param {Object} message - 要发送的消息对象
 */
function sendMessage(conn, message) {
  try {
    // 将消息对象转为JSON字符串，包装为SSE格式
    const data = JSON.stringify(message);
    conn.res.write(`data: ${data}\n\n`);
    
    // 更新最后活跃时间
    conn.lastActiveAt = Date.now();
  } catch (error) {
    logger.error('发送SSE消息失败:', error);
  }
}

/**
 * 发送错误消息
 * 
 * @param {Object} conn - 连接信息对象
 * @param {string} errorMessage - 错误信息
 */
function sendError(conn, errorMessage) {
  sendMessage(conn, {
    type: 'error',
    data: { message: errorMessage }
  });
}

/**
 * 广播消息到指定会话的所有连接
 *
 * @param {string} sessionId - 会话ID
 * @param {Object} message - 要广播的消息
 */
function broadcastToSession(sessionId, message) {
  const connList = connections.get(sessionId);
  if (connList) {
    connList.forEach(conn => {
      sendMessage(conn, message);
    });
  }
}

/**
 * 判断会话是否存在活跃 SSE 连接
 * 用于 POST /sse/query 前置校验，避免“提交成功但连接不在”
 * @param {string} sessionId
 * @returns {boolean}
 */
function hasActiveConnection(sessionId) {
  const list = connections.get(sessionId);
  return !!(list && list.length > 0);
}

/**
 * 以统一格式向指定会话推送 error 事件
 * 若连接已断开，仅记录告警
 * @param {string} sessionId
 * @param {string} message
 */
function pushError(sessionId, message) {
  const list = connections.get(sessionId);
  if (!list || list.length === 0) {
    logger.warn('推送 error 时 SSE 连接已断开', { sessionId, message });
    return;
  }
  broadcastToSession(sessionId, {
    type: 'error',
    data: { message, timestamp: Date.now() }
  });
}

// ============================================
// 查询处理
// ============================================

/**
 * 处理查询请求
 * 调用NL2SQL引擎处理用户查询
 * 
 * @param {string} sessionId - 会话ID
 * @param {string} query - 查询内容
 * @returns {Promise<Object>} 处理结果
 */
async function handleQuery(sessionId, query) {
  // 获取该会话的连接列表
  const connList = connections.get(sessionId);
  if (!connList || connList.length === 0) {
    // 连接可能已断开：仅记录告警，不 throw，避免 unhandled rejection
    logger.warn('handleQuery 调用时 SSE 连接未建立或已断开', { sessionId });
    return null;
  }

  // 使用第一个连接作为主连接
  const conn = connList[0];

  // 检查是否正在处理其他请求
  if (conn.isProcessing) {
    pushError(sessionId, '正在处理其他请求，请稍候');
    return null;
  }

  // 获取查询内容
  if (!query || query.trim() === '') {
    pushError(sessionId, '查询内容不能为空');
    return null;
  }
  
  // 标记为正在处理
  connList.forEach(c => c.isProcessing = true);
  
  try {
    // 发送开始处理消息
    broadcastToSession(sessionId, {
      type: 'processing',
      data: { message: '开始处理查询...' }
    });
    
    // 调用NL2SQL引擎处理查询
    const result = await nl2sqlEngine.processQuery(
      query,
      sessionId,
      // 进度回调函数
      (progress) => {
        broadcastToSession(sessionId, {
          type: 'progress',
          data: progress
        });
      }
    );
    
    // 发送结果
    broadcastToSession(sessionId, {
      type: 'result',
      data: result
    });
    
    return result;
    
  } catch (error) {
    logger.error('处理查询失败:', error);
    broadcastToSession(sessionId, {
      type: 'error',
      data: { message: '处理查询失败: ' + error.message }
    });
    throw error;
  } finally {
    // 标记处理完成
    connList.forEach(c => c.isProcessing = false);
  }
}

// ============================================
// 统计功能
// ============================================

/**
 * 获取活跃连接数
 * 
 * @returns {number} 活跃连接数量
 */
function getConnectionCount() {
  let count = 0;
  for (const connList of connections.values()) {
    count += connList.length;
  }
  return count;
}

/**
 * 获取连接信息列表
 * 
 * @returns {Array} 连接信息数组
 */
function getConnectionList() {
  const list = [];
  for (const connList of connections.values()) {
    connList.forEach(conn => {
      list.push({
        sessionId: conn.sessionId,
        userId: conn.userId,
        connectedAt: conn.connectedAt,
        lastActiveAt: conn.lastActiveAt,
        isProcessing: conn.isProcessing
      });
    });
  }
  return list;
}

/**
 * 获取指定会话的连接数
 * 
 * @param {string} sessionId - 会话ID
 * @returns {number} 连接数量
 */
function getSessionConnectionCount(sessionId) {
  const connList = connections.get(sessionId);
  return connList ? connList.length : 0;
}

// ============================================
// 导出模块
// ============================================

module.exports = {
  // 连接处理
  handleConnection,
  // 查询处理
  handleQuery,
  // 消息发送
  sendMessage,
  sendError,
  broadcastToSession,
  hasActiveConnection,
  pushError,
  // 统计信息
  getConnectionCount,
  getConnectionList,
  getSessionConnectionCount
};
