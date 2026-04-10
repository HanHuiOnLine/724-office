/**
 * WebSocket处理器模块
 * 
 * 负责处理WebSocket连接和消息，实现：
 * 1. 客户端连接管理
 * 2. 消息接收和解析
 * 3. 流式响应发送
 * 4. 心跳检测和连接保活
 */

// ============================================
// 导入依赖模块
// ============================================

// 导入UUID生成库，用于生成唯一标识
const { v4: uuidv4 } = require('uuid');
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
 * 活跃的WebSocket连接映射
 * 以sessionId为key，连接信息为value
 */
const connections = new Map();

/**
 * 心跳检测间隔（毫秒）
 * 每30秒发送一次心跳
 */
const HEARTBEAT_INTERVAL = 30000;

/**
 * 连接超时时间（毫秒）
 * 90秒未收到心跳则认为连接断开
 */
const CONNECTION_TIMEOUT = 90000;

// ============================================
// 连接处理
// ============================================

/**
 * 处理新的WebSocket连接
 * 当客户端连接时调用
 * 
 * @param {WebSocket} ws - WebSocket连接对象
 * @param {http.IncomingMessage} req - HTTP请求对象
 */
async function handleConnection(ws, req) {
  // 从URL查询参数获取会话ID和用户ID
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('session_id') || uuidv4();
  const userId = url.searchParams.get('user_id') || 'anonymous';
  
  // 记录连接日志
  logger.info(`WebSocket连接建立`, { sessionId, userId, ip: req.socket.remoteAddress });
  
  // 检查会话是否存在，不存在则创建
  let session = await database.getSession(sessionId);
  if (!session) {
    session = await database.createSession(sessionId, userId, '新会话');
    logger.debug(`创建新会话: ${sessionId}`);
  }
  
  // 存储连接信息
  const connectionInfo = {
    // WebSocket连接对象
    ws: ws,
    // 会话ID
    sessionId: sessionId,
    // 用户ID
    userId: userId,
    // 连接时间
    connectedAt: Date.now(),
    // 最后活跃时间
    lastActiveAt: Date.now(),
    // 是否正在处理请求
    isProcessing: false,
    // 心跳定时器
    heartbeatTimer: null,
    // 超时检测定时器
    timeoutTimer: null
  };
  
  // 添加到连接映射
  connections.set(sessionId, connectionInfo);
  
  // 设置消息处理器
  ws.on('message', (data) => handleMessage(connectionInfo, data));
  
  // 设置关闭处理器
  ws.on('close', (code, reason) => handleClose(connectionInfo, code, reason));
  
  // 设置错误处理器
  ws.on('error', (error) => handleError(connectionInfo, error));
  
  // 启动心跳检测
  startHeartbeat(connectionInfo);
  
  // 发送连接成功消息
  sendMessage(connectionInfo, {
    type: 'connected',
    data: {
      session_id: sessionId,
      message: '连接成功'
    }
  });
}

/**
 * 处理收到的消息
 * 
 * @param {Object} conn - 连接信息对象
 * @param {Buffer} data - 收到的数据
 */
async function handleMessage(conn, data) {
  // 更新最后活跃时间
  conn.lastActiveAt = Date.now();
  
  try {
    // 解析JSON消息
    const message = JSON.parse(data.toString());
    
    // 记录收到消息日志
    logger.debug(`收到WebSocket消息`, { 
      sessionId: conn.sessionId, 
      type: message.type 
    });
    
    // 根据消息类型处理
    switch (message.type) {
      case 'ping':
        // 心跳响应
        handlePing(conn);
        break;

      case 'pong':
        // 收到客户端pong响应，更新最后活跃时间
        // 无需回复，仅用于保活
        break;

      case 'query':
        // 数据查询请求
        await handleQuery(conn, message);
        break;
        
      case 'get_history':
        // 获取历史消息
        await handleGetHistory(conn, message);
        break;
        
      case 'clear_history':
        // 清空历史
        await handleClearHistory(conn, message);
        break;
        
      default:
        // 未知消息类型
        sendError(conn, `未知的消息类型: ${message.type}`);
    }
    
  } catch (error) {
    // JSON解析失败或其他错误
    logger.error('处理WebSocket消息失败:', error);
    sendError(conn, '消息格式错误: ' + error.message);
  }
}

/**
 * 处理心跳消息
 * 
 * @param {Object} conn - 连接信息对象
 */
function handlePing(conn) {
  // 回复pong消息
  sendMessage(conn, {
    type: 'pong',
    data: { timestamp: Date.now() }
  });
}

/**
 * 处理查询请求
 * 调用NL2SQL引擎处理用户查询
 * 
 * @param {Object} conn - 连接信息对象
 * @param {Object} message - 消息对象
 */
async function handleQuery(conn, message) {
  // 检查是否正在处理其他请求
  if (conn.isProcessing) {
    sendError(conn, '正在处理其他请求，请稍候');
    return;
  }
  
  // 获取查询内容
  const query = message.data?.query;
  if (!query || query.trim() === '') {
    sendError(conn, '查询内容不能为空');
    return;
  }
  
  // 标记为正在处理
  conn.isProcessing = true;
  
  try {
    // 发送开始处理消息
    sendMessage(conn, {
      type: 'processing',
      data: { message: '开始处理查询...' }
    });
    
    // 调用NL2SQL引擎处理查询
    const result = await nl2sqlEngine.processQuery(
      query,
      conn.sessionId,
      // 进度回调函数
      (progress) => {
        sendMessage(conn, {
          type: 'progress',
          data: progress
        });
      }
    );
    
    // 发送结果
    sendMessage(conn, {
      type: 'result',
      data: result
    });
    
  } catch (error) {
    logger.error('处理查询失败:', error);
    sendError(conn, '处理查询失败: ' + error.message);
  } finally {
    // 标记处理完成
    conn.isProcessing = false;
  }
}

/**
 * 处理获取历史消息请求
 * 
 * @param {Object} conn - 连接信息对象
 * @param {Object} message - 消息对象
 */
async function handleGetHistory(conn, message) {
  try {
    // 获取限制数量，默认50条
    const limit = message.data?.limit || 50;
    
    // 从数据库获取历史消息
    const messages = await database.getSessionMessages(conn.sessionId, limit);
    
    // 发送历史消息
    sendMessage(conn, {
      type: 'history',
      data: { messages }
    });
    
  } catch (error) {
    logger.error('获取历史消息失败:', error);
    sendError(conn, '获取历史消息失败: ' + error.message);
  }
}

/**
 * 处理清空历史请求
 * 
 * @param {Object} conn - 连接信息对象
 * @param {Object} message - 消息对象
 */
async function handleClearHistory(conn, message) {
  // 注意：这里只是逻辑清空，实际可以删除消息或标记为已删除
  // 目前简单返回成功
  sendMessage(conn, {
    type: 'cleared',
    data: { message: '历史记录已清空' }
  });
}

/**
 * 处理连接关闭
 * 
 * @param {Object} conn - 连接信息对象
 * @param {number} code - 关闭代码
 * @param {Buffer} reason - 关闭原因
 */
function handleClose(conn, code, reason) {
  logger.info(`WebSocket连接关闭`, { 
    sessionId: conn.sessionId, 
    code, 
    reason: reason?.toString() 
  });
  
  // 清理定时器
  if (conn.heartbeatTimer) {
    clearInterval(conn.heartbeatTimer);
  }
  if (conn.timeoutTimer) {
    clearInterval(conn.timeoutTimer);
  }
  
  // 从连接映射中移除
  connections.delete(conn.sessionId);
}

/**
 * 处理连接错误
 * 
 * @param {Object} conn - 连接信息对象
 * @param {Error} error - 错误对象
 */
function handleError(conn, error) {
  logger.error(`WebSocket连接错误`, { 
    sessionId: conn.sessionId, 
    error: error.message 
  });
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
    // 检查连接是否仍然打开
    if (conn.ws.readyState === 1) { // 1 = OPEN
      // 将消息对象转为JSON字符串发送
      conn.ws.send(JSON.stringify(message));
    }
  } catch (error) {
    logger.error('发送WebSocket消息失败:', error);
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

// ============================================
// 心跳检测
// ============================================

/**
 * 启动心跳检测
 * 
 * @param {Object} conn - 连接信息对象
 */
function startHeartbeat(conn) {
  // 设置心跳定时器
  conn.heartbeatTimer = setInterval(() => {
    // 发送ping消息
    sendMessage(conn, {
      type: 'ping',
      data: { timestamp: Date.now() }
    });
  }, HEARTBEAT_INTERVAL);
  
  // 设置超时检测定时器
  conn.timeoutTimer = setInterval(() => {
    const now = Date.now();
    const inactiveTime = now - conn.lastActiveAt;
    
    // 如果超过超时时间未活跃，关闭连接
    if (inactiveTime > CONNECTION_TIMEOUT) {
      logger.warn(`连接超时，关闭连接`, { sessionId: conn.sessionId });
      conn.ws.close(1000, '连接超时');
    }
  }, HEARTBEAT_INTERVAL);
}

// ============================================
// 广播功能
// ============================================

/**
 * 广播消息到所有连接
 * 
 * @param {Object} message - 要广播的消息
 */
function broadcast(message) {
  for (const conn of connections.values()) {
    sendMessage(conn, message);
  }
}

/**
 * 获取活跃连接数
 * 
 * @returns {number} 活跃连接数量
 */
function getConnectionCount() {
  return connections.size;
}

/**
 * 获取连接信息列表
 * 
 * @returns {Array} 连接信息数组
 */
function getConnectionList() {
  return Array.from(connections.values()).map(conn => ({
    sessionId: conn.sessionId,
    userId: conn.userId,
    connectedAt: conn.connectedAt,
    lastActiveAt: conn.lastActiveAt,
    isProcessing: conn.isProcessing
  }));
}

// ============================================
// 导出模块
// ============================================

module.exports = {
  // 连接处理
  handleConnection,
  // 消息发送
  sendMessage,
  sendError,
  // 广播
  broadcast,
  // 统计信息
  getConnectionCount,
  getConnectionList
};
