/**
 * REST API路由模块
 * 
 * 定义HTTP RESTful API端点，提供：
 * 1. 健康检查接口
 * 2. Schema查询接口
 * 3. 会话管理接口
 * 4. 查询历史接口
 * 5. 统计信息接口
 */

// ============================================
// 导入依赖模块
// ============================================

// 导入Express路由构造函数
const express = require('express');
// 导入日志模块
const logger = require('../utils/logger');
// 导入配置模块
const config = require('./config');
// 导入Schema加载模块
const schemaLoader = require('./schemaLoader');
// 导入数据库模块
const database = require('./database');
// 导入SSE处理器，获取连接统计
const sseHandler = require('./sseHandler');
// 导入评估模块
const evaluation = require('../utils/evaluation');
// 导入请求上下文工具(Phase 3 · T1)
const requestContext = require('./requestContext');

// ============================================
// 创建路由实例
// ============================================

// 创建Express路由实例
const router = express.Router();

// ============================================
// 中间件
// ============================================

/**
 * 请求日志中间件
 * 记录每个API请求的基本信息
 */
router.use((req, res, next) => {
  // 记录请求日志
  logger.debug(`${req.method} ${req.path}`, {
    query: req.query,
    ip: req.ip
  });
  // 继续处理下一个中间件或路由
  next();
});

// ============================================
// 健康检查接口
// ============================================

/**
 * GET /api/health
 * 健康检查接口，用于监控服务状态
 * 
 * 响应：
 * {
 *   status: "ok|error",
 *   timestamp: "ISO时间字符串",
 *   version: "服务版本",
 *   uptime: 运行时间（秒）
 * }
 */
router.get('/health', (req, res) => {
  // 构造健康状态响应
  const health = {
    // 服务状态，正常为ok
    status: 'ok',
    // 当前时间戳
    timestamp: new Date().toISOString(),
    // 服务版本
    version: '1.0.0',
    // 进程运行时间（秒）
    uptime: process.uptime(),
    // 内存使用情况
    memory: {
      // 已使用内存（MB）
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      // 总内存（MB）
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
    }
  };
  
  // 返回200状态码和健康信息
  res.json(health);
});

/**
 * GET /api/health/detail
 * 详细健康检查，包含各组件状态
 */
router.get('/health/detail', async (req, res) => {
  // 构造详细健康状态
  const detail = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    components: {
      // 数据库状态
      database: {
        status: 'ok',
        message: 'SQLite连接正常'
      },
      // LLM API状态
      llm: {
        status: 'ok',
        message: 'LLM API配置正常'
      },
      // Schema加载状态
      schema: {
        status: schemaLoader.getAllTables().length > 0 ? 'ok' : 'error',
        tables: schemaLoader.getAllTables().length
      },
      // SSE连接状态
      sse: {
        status: 'ok',
        connections: sseHandler.getConnectionCount()
      }
    }
  };
  
  // 检查是否有组件异常
  const hasError = Object.values(detail.components).some(c => c.status !== 'ok');
  if (hasError) {
    detail.status = 'error';
    return res.status(503).json(detail);
  }
  
  res.json(detail);
});

// ============================================
// Schema接口
// ============================================

/**
 * GET /api/schema
 * 获取完整的Schema信息
 * 
 * 查询参数：
 * - type: 类型筛选（tables|metrics|dimensions）
 */
router.get('/schema', (req, res) => {
  // 获取查询参数中的类型
  const { type } = req.query;
  
  // 根据类型返回不同的数据
  switch (type) {
    case 'tables':
      // 只返回表定义
      res.json({
        tables: schemaLoader.getAllTables()
      });
      break;
      
    case 'metrics':
      // 只返回指标定义
      res.json({
        metrics: schemaLoader.getAllMetrics()
      });
      break;
      
    case 'dimensions':
      // 只返回维度定义
      res.json({
        dimensions: schemaLoader.getAllDimensions()
      });
      break;
      
    default:
      // 返回完整Schema
      res.json({
        version: '1.0',
        tables: schemaLoader.getAllTables(),
        metrics: schemaLoader.getAllMetrics(),
        dimensions: schemaLoader.getAllDimensions()
      });
  }
});

/**
 * GET /api/schema/tables/:tableName
 * 获取指定表的详细信息
 */
router.get('/schema/tables/:tableName', (req, res) => {
  // 获取表名参数
  const { tableName } = req.params;
  
  // 查询表定义
  const table = schemaLoader.getTable(tableName);
  
  if (!table) {
    // 表不存在，返回404
    return res.status(404).json({
      error: '表不存在',
      tableName
    });
  }
  
  // 获取关联表
  const relatedTables = schemaLoader.getRelatedTables(tableName);
  
  // 返回表详情
  res.json({
    table,
    relatedTables
  });
});

/**
 * GET /api/schema/search
 * 搜索Schema
 * 
 * 查询参数：
 * - q: 搜索关键词
 * - limit: 返回结果数量限制（默认5）
 */
router.get('/schema/search', async (req, res) => {
  // 获取搜索关键词
  const { q, limit = 5 } = req.query;
  
  if (!q) {
    return res.status(400).json({
      error: '缺少搜索关键词（q参数）'
    });
  }
  
  try {
    // 搜索相关表
    const tables = await schemaLoader.searchRelevantTables(q, parseInt(limit));
    
    res.json({
      query: q,
      count: tables.length,
      tables
    });
  } catch (error) {
    logger.error('搜索Schema失败:', error);
    res.status(500).json({
      error: '搜索失败: ' + error.message
    });
  }
});

// ============================================
// 会话管理接口
// ============================================

/**
 * POST /api/sessions
 * 创建新会话
 * 
 * 请求体：
 * {
 *   user_id: "用户ID",
 *   title: "会话标题（可选）"
 * }
 */
router.post('/sessions', async (req, res) => {
  try {
    // 从请求体获取参数
    const { user_id, title } = req.body;
    
    // 生成新的会话ID
    const { v4: uuidv4 } = require('uuid');
    const sessionId = uuidv4();
    
    // 创建会话
    const session = await database.createSession(
      sessionId,
      user_id || 'anonymous',
      title || '新会话'
    );
    
    // 返回创建的会话信息
    res.status(201).json(session);
  } catch (error) {
    logger.error('创建会话失败:', error);
    res.status(500).json({
      error: '创建会话失败: ' + error.message
    });
  }
});

/**
 * GET /api/sessions/:sessionId
 * 获取会话信息
 */
router.get('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await database.getSession(sessionId);
    
    if (!session) {
      return res.status(404).json({
        error: '会话不存在'
      });
    }
    
    res.json(session);
  } catch (error) {
    logger.error('获取会话失败:', error);
    res.status(500).json({
      error: '获取会话失败: ' + error.message
    });
  }
});

/**
 * DELETE /api/sessions/:sessionId
 * 删除会话
 */
router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    // 检查会话是否存在
    const session = await database.getSession(sessionId);
    if (!session) {
      return res.status(404).json({
        error: '会话不存在'
      });
    }
    
    // 删除会话
    await database.deleteSession(sessionId);
    
    res.json({
      success: true,
      message: '会话已删除'
    });
  } catch (error) {
    logger.error('删除会话失败:', error);
    res.status(500).json({
      error: '删除会话失败: ' + error.message
    });
  }
});

/**
 * GET /api/sessions/:sessionId/messages
 * 获取会话消息历史
 * 
 * 查询参数：
 * - limit: 返回消息数量限制（默认50）
 */
router.get('/sessions/:sessionId/messages', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    // 获取消息历史
    const messages = await database.getSessionMessages(sessionId, limit);
    
    res.json({
      session_id: sessionId,
      count: messages.length,
      messages
    });
  } catch (error) {
    logger.error('获取消息历史失败:', error);
    res.status(500).json({
      error: '获取消息历史失败: ' + error.message
    });
  }
});

/**
 * GET /api/users/:userId/sessions
 * 获取用户的所有会话
 */
router.get('/users/:userId/sessions', async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit) || 20;
    
    // 获取用户会话列表
    const sessions = await database.getUserSessions(userId, limit);
    
    res.json({
      user_id: userId,
      count: sessions.length,
      sessions
    });
  } catch (error) {
    logger.error('获取用户会话失败:', error);
    res.status(500).json({
      error: '获取用户会话失败: ' + error.message
    });
  }
});

// ============================================
// 查询历史接口
// ============================================

/**
 * GET /api/queries/history
 * 获取查询历史
 * 
 * 查询参数：
 * - user_id: 用户ID筛选
 * - session_id: 会话ID筛选
 * - limit: 返回数量限制（默认20）
 */
router.get('/queries/history', async (req, res) => {
  try {
    const { user_id, session_id, limit = 20 } = req.query;
    
    // 构造SQL查询
    let sql = 'SELECT * FROM query_history WHERE 1=1';
    const params = [];
    
    // 添加用户筛选
    if (user_id) {
      sql += ' AND user_id = ?';
      params.push(user_id);
    }
    
    // 添加会话筛选
    if (session_id) {
      sql += ' AND session_id = ?';
      params.push(session_id);
    }
    
    // 添加排序和限制
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(parseInt(limit));
    
    // 执行查询
    const history = await database.query(sql, params);
    
    res.json({
      count: history.length,
      history
    });
  } catch (error) {
    logger.error('获取查询历史失败:', error);
    res.status(500).json({
      error: '获取查询历史失败: ' + error.message
    });
  }
});

// ============================================
// 用户偏好（长期记忆）接口
// ============================================

/**
 * GET /api/preferences/:userId/raw
 * 获取用户长期记忆原始数据（用于调试）
 * 注意：这个路由必须在 /:userId 之前定义
 */
router.get('/preferences/:userId/raw', async (req, res) => {
  try {
    const { userId } = req.params;
    const { type } = req.query;
    
    const database = require('./database');
    
    // 构建查询条件
    let sql = 'SELECT * FROM user_preferences WHERE user_id = ?';
    const params = [userId];
    
    if (type) {
      sql += ' AND preference_type = ?';
      params.push(type);
    }
    
    sql += ' ORDER BY preference_type, created_at DESC';
    
    const rows = await database.query(sql, params);
    
    // 解析 content JSON
    const parsedRows = rows.map(row => ({
      ...row,
      content: typeof row.content === 'string' ? JSON.parse(row.content) : row.content
    }));
    
    // 按类型分组
    const grouped = {
      field_alias: [],
      query_pattern: [],
      metric_preference: [],
      dimension_preference: []
    };
    
    parsedRows.forEach(row => {
      if (grouped[row.preference_type]) {
        grouped[row.preference_type].push(row);
      }
    });
    
    res.json({
      success: true,
      user_id: userId,
      total_count: rows.length,
      data: {
        all: parsedRows,
        grouped: grouped
      }
    });
  } catch (error) {
    logger.error('获取原始记忆数据失败:', error);
    res.status(500).json({
      success: false,
      error: '获取原始记忆数据失败: ' + error.message
    });
  }
});

/**
 * GET /api/preferences/:userId/stats
 * 获取用户记忆统计
 * 注意：这个路由必须在 /:userId 之前定义
 */
router.get('/preferences/:userId/stats', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const memoryMaintenance = require('../memory/memoryMaintenance');
    const stats = await memoryMaintenance.getUserMemoryStats(userId);
    
    res.json({
      success: true,
      user_id: userId,
      data: stats
    });
  } catch (error) {
    logger.error('获取用户记忆统计失败:', error);
    res.status(500).json({
      success: false,
      error: '获取用户记忆统计失败: ' + error.message
    });
  }
});

/**
 * GET /api/preferences/:userId
 * 获取用户偏好列表
 * 
 * 查询参数：
 * - type: 偏好类型筛选（query_pattern|field_alias|metric_preference|dimension_preference）
 * - limit: 返回数量限制（默认50）
 */
router.get('/preferences/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { type, limit = 50 } = req.query;
    
    const longTermMemory = require('../memory/longTermMemory');
    const preferences = await longTermMemory.getUserPreferencesForIntent(userId);
    
    // 根据类型过滤
    let result = preferences;
    if (type) {
      switch (type) {
        case 'query_pattern':
          result = { patterns: preferences.patterns };
          break;
        case 'field_alias':
          result = { aliases: preferences.aliases };
          break;
        case 'metric_preference':
          result = { metrics: preferences.metrics };
          break;
        case 'dimension_preference':
          result = { dimensions: preferences.dimensions };
          break;
      }
    }
    
    res.json({
      success: true,
      user_id: userId,
      data: result
    });
  } catch (error) {
    logger.error('获取用户偏好失败:', error);
    res.status(500).json({
      success: false,
      error: '获取用户偏好失败: ' + error.message
    });
  }
});

/**
 * POST /api/preferences/:userId/templates
 * 手动添加查询模板
 * 
 * 请求体：
 * {
 *   name: "模板名称",
 *   dimensions: ["维度1", "维度2"],
 *   metrics: ["指标1"],
 *   default_time_range: { type: "relative", value: "最近7天" }
 * }
 */
router.post('/preferences/:userId/templates', async (req, res) => {
  try {
    const { userId } = req.params;
    const template = req.body;
    
    if (!template.name) {
      return res.status(400).json({
        success: false,
        error: '模板名称不能为空'
      });
    }
    
    const longTermMemory = require('../memory/longTermMemory');
    const result = await longTermMemory.storeQueryTemplate(userId, template);
    
    res.json({
      success: true,
      message: '模板已保存',
      data: result
    });
  } catch (error) {
    logger.error('保存查询模板失败:', error);
    res.status(500).json({
      success: false,
      error: '保存查询模板失败: ' + error.message
    });
  }
});

/**
 * DELETE /api/preferences/:preferenceId
 * 删除用户偏好
 */
router.delete('/preferences/:preferenceId', async (req, res) => {
  try {
    const { preferenceId } = req.params;
    
    const longTermMemory = require('../memory/longTermMemory');
    const success = await longTermMemory.deletePreference(parseInt(preferenceId));
    
    if (success) {
      res.json({
        success: true,
        message: '偏好已删除'
      });
    } else {
      res.status(404).json({
        success: false,
        error: '偏好不存在或删除失败'
      });
    }
  } catch (error) {
    logger.error('删除偏好失败:', error);
    res.status(500).json({
      success: false,
      error: '删除偏好失败: ' + error.message
    });
  }
});

/**
 * POST /api/preferences/:userId/learn-alias
 * 手动学习字段别名
 * 
 * 请求体：
 * {
 *   user_term: "用户的说法",
 *   schema_field: "对应的Schema字段",
 *   field_type: "metric|dimension|filter"
 * }
 */
router.post('/preferences/:userId/learn-alias', async (req, res) => {
  try {
    const { userId } = req.params;
    const { user_term, schema_field, field_type = 'metric' } = req.body;
    
    if (!user_term || !schema_field) {
      return res.status(400).json({
        success: false,
        error: 'user_term和schema_field不能为空'
      });
    }
    
    const longTermMemory = require('../memory/longTermMemory');
    const result = await longTermMemory.learnFieldAlias(
      userId,
      user_term,
      schema_field,
      field_type
    );
    
    if (result) {
      res.json({
        success: true,
        message: '字段别名已学习',
        data: result
      });
    } else {
      res.json({
        success: false,
        message: '无需学习（可能已存在或参数无效）'
      });
    }
  } catch (error) {
    logger.error('学习字段别名失败:', error);
    res.status(500).json({
      success: false,
      error: '学习字段别名失败: ' + error.message
    });
  }
});

// ============================================
// 评估接口（新增）
// ============================================

/**
 * GET /api/evaluation/stats
 * 获取运行时统计报告（向量检索命中率、记忆命中率）
 */
router.get('/evaluation/stats', (req, res) => {
  try {
    const report = evaluation.getFullStatsReport();
    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    logger.error('获取评估统计失败:', error);
    res.status(500).json({
      success: false,
      error: '获取评估统计失败: ' + error.message
    });
  }
});

/**
 * POST /api/evaluation/stats/reset
 * 重置统计数据
 */
router.post('/evaluation/stats/reset', (req, res) => {
  try {
    evaluation.resetStats();
    res.json({
      success: true,
      message: '统计数据已重置'
    });
  } catch (error) {
    logger.error('重置统计数据失败:', error);
    res.status(500).json({
      success: false,
      error: '重置统计数据失败: ' + error.message
    });
  }
});

/**
 * POST /api/evaluation/schema-quality
 * 执行Schema向量化质量评估
 * 
 * 请求体：
 * {
 *   testQueries: [{ query: "查询", expectedTables: ["表名"] }]
 * }
 */
router.post('/evaluation/schema-quality', async (req, res) => {
  try {
    if (!config.evaluation.enabled) {
      return res.status(403).json({
        success: false,
        error: '评估功能未启用，请设置 EVALUATION_ENABLED=true'
      });
    }
    
    const { testQueries } = req.body;
    const queries = testQueries || evaluation.DEFAULT_SCHEMA_TEST_QUERIES;
    
    const llmService = require('./llmService');
    const vectorStore = require('../memory/vectorStore');
    
    const results = await evaluation.evaluateSchemaVectorQuality(
      llmService,
      vectorStore,
      queries
    );
    
    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    logger.error('Schema质量评估失败:', error);
    res.status(500).json({
      success: false,
      error: 'Schema质量评估失败: ' + error.message
    });
  }
});

/**
 * POST /api/evaluation/query-quality
 * 执行查询历史向量化质量评估
 * 
 * 请求体：
 * {
 *   testPairs: [{ query1: "查询1", query2: "查询2", expectedSimilarity: 0.9 }]
 * }
 */
router.post('/evaluation/query-quality', async (req, res) => {
  try {
    if (!config.evaluation.enabled) {
      return res.status(403).json({
        success: false,
        error: '评估功能未启用，请设置 EVALUATION_ENABLED=true'
      });
    }
    
    const { testPairs } = req.body;
    const pairs = testPairs || evaluation.DEFAULT_QUERY_SIMILARITY_PAIRS;
    
    const llmService = require('./llmService');
    
    const results = await evaluation.evaluateQueryVectorQuality(llmService, pairs);
    
    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    logger.error('查询质量评估失败:', error);
    res.status(500).json({
      success: false,
      error: '查询质量评估失败: ' + error.message
    });
  }
});

/**
 * GET /api/evaluation/config
 * 获取评估配置
 */
router.get('/evaluation/config', (req, res) => {
  res.json({
    success: true,
    data: {
      enabled: config.evaluation.enabled,
      trackStats: config.evaluation.trackStats,
      thresholds: config.evaluation.thresholds
    }
  });
});

// ============================================
// 统计信息接口
// ============================================

/**
 * GET /api/stats
 * 获取服务统计信息
 */
router.get('/stats', async (req, res) => {
  try {
    // 获取今日查询统计
    const today = new Date().toISOString().split('T')[0];
    const todayStats = await database.queryOne(`
      SELECT 
        COUNT(*) as total_queries,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
        AVG(execution_time) as avg_execution_time
      FROM query_history 
      WHERE date(created_at) = date(?)
    `, [today]);
    
    // 构造统计信息
    const stats = {
      timestamp: new Date().toISOString(),
      connections: {
        sse: sseHandler.getConnectionCount()
      },
      queries: {
        today: todayStats || {
          total_queries: 0,
          success_count: 0,
          failed_count: 0,
          avg_execution_time: 0
        }
      },
      schema: {
        tables: schemaLoader.getAllTables().length,
        metrics: schemaLoader.getAllMetrics().length,
        dimensions: schemaLoader.getAllDimensions().length
      },
      system: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        node_version: process.version
      }
    };
    
    res.json(stats);
  } catch (error) {
    logger.error('获取统计信息失败:', error);
    res.status(500).json({
      error: '获取统计信息失败: ' + error.message
    });
  }
});

// ============================================
// 配置接口
// ============================================

/**
 * GET /api/config
 * 获取公开配置信息
 * （不包含敏感信息如API密钥）
 */
router.get('/config', (req, res) => {
  // 返回安全的配置信息
  res.json({
    version: '1.0.0',
    llm: {
      model: config.llm.model,
      api_base: config.llm.apiBase
    },
    security: {
      max_query_rows: config.security.maxQueryRows,
      query_timeout: config.security.queryTimeout
    },
    features: {
      streaming: true,
      clarification: true,
      vector_search: true
    }
  });
});

// ============================================
// SSE接口
// ============================================

/**
 * GET /api/sse/stream
 * SSE连接端点
 * 建立Server-Sent Events连接，用于接收流式消息
 * 
 * 查询参数：
 * - session_id: 会话ID（必需）
 * - user_id: 用户ID（可选，默认anonymous）
 */
router.get('/sse/stream', async (req, res) => {
  await sseHandler.handleConnection(req, res);
});

/**
 * POST /api/sse/query
 * 发送查询请求
 * 通过HTTP POST发送查询，结果通过SSE推送
 * 
 * 请求体：
 * {
 *   session_id: "会话ID",
 *   query: "查询内容"
 * }
 */
router.post('/sse/query', async (req, res) => {
  try {
    const { session_id, query } = req.body;

    if (!session_id) {
      return res.status(400).json({ error: '缺少session_id参数' });
    }

    if (!query || query.trim() === '') {
      return res.status(400).json({ error: '查询内容不能为空' });
    }

    // 必须先建立 SSE 长连接，否则后台处理的结果无法回传，属于“假成功”场景
    if (!sseHandler.hasActiveConnection(session_id)) {
      return res.status(409).json({
        error: 'SSE 连接未建立，请先建立 /api/sse/stream 长连接再提交查询'
      });
    }

    // 检查会话标题，如果是默认标题则更新为查询内容
    const session = await database.getSession(session_id);
    if (session && session.title === '新会话') {
      // 截取查询内容前20个字符作为标题
      const newTitle = query.trim().slice(0, 20) + (query.trim().length > 20 ? '...' : '');
      await database.updateSessionTitle(session_id, newTitle);
    }

    // 提取请求上下文(user/role/tenant/source/ip),透传给引擎和审计字段
    const context = requestContext.extractContext(req);

    // 后台异步处理，失败时兜底通过 SSE 推送 error 事件，避免 "200 OK + 前端无反馈"
    sseHandler.handleQuery(session_id, query, context).catch((err) => {
      logger.error('[SSE] 后台处理异常，向前端推送 error:', err);
      sseHandler.pushError(session_id, err.message || '处理查询失败');
    });

    // 立即返回成功响应
    res.json({ success: true, message: '查询已提交，请通过SSE接收结果' });

  } catch (error) {
    logger.error('提交查询失败:', error);
    res.status(500).json({ error: '提交查询失败: ' + error.message });
  }
});

// ============================================
// 错误处理
// ============================================

/**
 * 404错误处理
 * 当请求的路径不存在时返回
 */
router.use((req, res) => {
  res.status(404).json({
    error: '接口不存在',
    path: req.path,
    method: req.method
  });
});

/**
 * 全局错误处理中间件
 * 捕获所有未处理的错误
 */
router.use((err, req, res, next) => {
  logger.error('API错误:', err);
  res.status(500).json({
    error: '服务器内部错误',
    message: config.isDevelopment() ? err.message : '请稍后重试'
  });
});

// ============================================
// 导出路由
// ============================================

module.exports = router;
