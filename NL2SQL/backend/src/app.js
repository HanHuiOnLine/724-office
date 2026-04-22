/**
 * NL2SQL 服务主入口文件
 * 
 * 这是整个后端服务的启动入口，负责：
 * 1. 加载环境变量配置
 * 2. 初始化各个核心模块
 * 3. 启动HTTP服务器和SSE服务
 * 4. 处理优雅关闭
 */

// ============================================
// 加载环境变量配置
// ============================================

// 加载dotenv库，用于从.env文件读取环境变量到process.env
require('dotenv').config();

// ============================================
// 导入核心依赖模块
// ============================================

// 导入Express框架，用于创建HTTP服务器
const express = require('express');
// 导入HTTP模块，用于创建HTTP服务器
const http = require('http');
// 导入CORS中间件，用于处理跨域请求
const cors = require('cors');
// 导入body-parser中间件，用于解析JSON请求体
const bodyParser = require('body-parser');
// 导入path模块，用于处理文件路径
const path = require('path');
// 导入fs模块，用于文件系统操作
const fs = require('fs');

// ============================================
// 导入项目内部模块
// ============================================

// 导入配置管理模块，统一管理所有配置项
const config = require('./core/config');
// 导入日志模块，用于记录应用日志
const logger = require('./utils/logger');
// 导入数据库初始化模块，负责SQLite数据库的初始化和连接
const database = require('./core/database');
// SR 业务数据库（MySQL）连接池
const srDatabase = require('./core/srDatabase');
// 导入向量数据库初始化模块，负责LanceDB的初始化
const vectorStore = require('./memory/vectorStore');
// 导入API路由模块，定义RESTful API端点
const routes = require('./core/routes');
// 导入自修复调度器，负责定时健康检查和维护任务
const selfRepair = require('./core/selfRepair');

// ============================================
// 创建Express应用实例
// ============================================

// 创建Express应用实例，这是整个HTTP服务的核心
const app = express();

// ============================================
// 配置Express中间件
// ============================================

// 启用CORS中间件，允许前端跨域访问
// origin: '*' 表示允许所有来源，生产环境应配置为具体域名
app.use(cors({ origin: '*' }));

// 启用body-parser中间件，解析JSON格式的请求体
// limit: '10mb' 设置最大请求体大小为10MB
app.use(bodyParser.json({ limit: '10mb' }));

// 启用body-parser中间件，解析URL编码的请求体
app.use(bodyParser.urlencoded({ extended: true }));

// ============================================
// 挂载API路由
// ============================================

// 将所有API路由挂载到 /api 路径下
// 例如：/api/health, /api/schema 等
app.use('/api', routes);

// ============================================
// 创建HTTP服务器
// ============================================

// 使用Node.js原生http模块创建服务器
const server = http.createServer(app);

// ============================================
// 初始化服务
// ============================================

/**
 * 初始化函数
 * 按顺序初始化各个模块，确保依赖关系正确
 */
async function initialize() {
  // 记录启动日志
  logger.info('========================================');
  logger.info('NL2SQL 服务正在启动...');
  logger.info('========================================');

  try {
    // ----------------------------------------
    // 步骤0：验证配置
    // ----------------------------------------
    config.validate();
    logger.info('配置验证通过');

    // ----------------------------------------
    // 步骤1：确保数据目录存在
    // ----------------------------------------
    // 创建数据存储目录，如果不存在则自动创建
    const dataDir = path.join(__dirname, '../data');
    if (!fs.existsSync(dataDir)) {
      // 递归创建目录，包括所有父目录
      fs.mkdirSync(dataDir, { recursive: true });
      logger.info(`创建数据目录: ${dataDir}`);
    }

    // ----------------------------------------
    // 步骤2：初始化SQLite数据库
    // ----------------------------------------
    // 初始化会话存储数据库，创建必要的表结构
    await database.initialize();
    logger.info('SQLite数据库初始化完成');

    // ----------------------------------------
    // 步骤3：初始化LanceDB向量数据库
    // ----------------------------------------
    // 初始化向量存储，用于语义检索
    await vectorStore.initialize();
    logger.info('LanceDB向量数据库初始化完成');

    // ----------------------------------------
    // 步骤4：加载Schema元数据
    // ----------------------------------------
    // 从配置文件加载SR系统的表结构信息
    const schemaLoader = require('./core/schemaLoader');
    await schemaLoader.load();
    logger.info('Schema元数据加载完成');

    // ----------------------------------------
    // 步骤4.5：加载业务语义层（Phase 2新增）
    // ----------------------------------------
    // 加载业务概念到物理表的映射配置
    try {
      const semanticLayer = require('./core/semanticLayer');
      semanticLayer.load();
      logger.info('业务语义层加载完成');
    } catch (e) {
      logger.warn('业务语义层加载失败，将使用传统流程:', e.message);
    }

    // ----------------------------------------
    // 步骤4.6：打印功能开关状态
    // ----------------------------------------
    try {
      const featureFlags = require('../config/feature-flags');
      featureFlags.logFeatureFlags();
    } catch (e) {
      // 功能开关配置加载失败，使用默认值
    }

    // ----------------------------------------
    // 步骤4.7：初始化 SR 业务数据库连接池（真实执行层）
    // ----------------------------------------
    // 失败不阻塞启动，executeQuery 会返回 SR_DB_NOT_READY
    await srDatabase.initialize();
    logger.info('[Startup] SR.enabled=%s DRY_RUN=%s EMB.enabled=%s',
      config.srDatabase.enabled, config.security.dryRun, config.embedding.enabled);

    // ----------------------------------------
    // 步骤5：启动自修复调度器
    // ----------------------------------------
    // 启动定时任务，执行健康检查和维护
    selfRepair.start();
    logger.info('自修复调度器已启动');

    // ----------------------------------------
    // 步骤6：启动HTTP服务器
    // ----------------------------------------
    // 从配置获取端口号，默认3000
    const port = config.port || 3000;
    
    // 监听指定端口，开始接收请求
    server.listen(port, () => {
      logger.info(`HTTP服务器已启动，监听端口: ${port}`);
      logger.info(`SSE端点: http://localhost:${port}/api/sse/stream`);
      logger.info(`API地址: http://localhost:${port}/api`);
      logger.info('========================================');
      logger.info('NL2SQL 服务启动成功！');
      logger.info('========================================');
    });

  } catch (error) {
    // 初始化过程中发生错误，记录错误日志并退出
    logger.error('服务初始化失败:', error);
    // 退出进程，返回错误码1
    process.exit(1);
  }
}

// ============================================
// 优雅关闭处理
// ============================================

/**
 * 优雅关闭函数
 * 在收到终止信号时，确保资源正确释放
 */
async function gracefulShutdown() {
  logger.info('========================================');
  logger.info('正在关闭服务...');
  logger.info('========================================');

  // ----------------------------------------
  // 步骤1：停止接受新连接
  // ----------------------------------------
  // 关闭HTTP服务器，停止接受新的HTTP请求
  server.close(() => {
    logger.info('HTTP服务器已关闭');
  });

  // ----------------------------------------
  // 步骤2：关闭SSE连接
  // ----------------------------------------
  // SSE连接会在HTTP服务器关闭时自动断开
  logger.info('SSE连接已关闭');

  // ----------------------------------------
  // 步骤3：停止定时任务
  // ----------------------------------------
  selfRepair.stop();
  logger.info('自修复调度器已停止');

  // ----------------------------------------
  // 步骤4：关闭数据库连接
  // ----------------------------------------
  await database.close();
  logger.info('数据库连接已关闭');

  // 关闭 SR 业务库连接池
  await srDatabase.shutdown();

  // ----------------------------------------
  // 步骤5：退出进程
  // ----------------------------------------
  logger.info('服务已安全关闭');
  process.exit(0);
}

// 监听进程终止信号，触发优雅关闭
// SIGTERM：Docker容器停止时发送
process.on('SIGTERM', gracefulShutdown);
// SIGINT：用户按Ctrl+C时发送
process.on('SIGINT', gracefulShutdown);

// 监听未处理的Promise拒绝，防止进程崩溃
process.on('unhandledRejection', (reason, promise) => {
  logger.error('未处理的Promise拒绝:', reason);
});

// 监听未捕获的异常，记录错误信息
process.on('uncaughtException', (error) => {
  logger.error('未捕获的异常:', error);
  // 发生严重错误，执行优雅关闭
  gracefulShutdown();
});

// ============================================
// 启动服务
// ============================================

// 调用初始化函数，启动整个服务
initialize();
