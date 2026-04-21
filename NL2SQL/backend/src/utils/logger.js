/**
 * 日志工具模块
 * 
 * 提供统一的日志记录功能，支持：
 * 1. 控制台输出（带颜色）
 * 2. 文件输出（自动轮转）
 * 3. 多级别日志（debug, info, warn, error）
 * 4. 结构化日志格式
 * 5. 执行流程追踪（trace）- 用于调试NL2SQL流程
 */

// ============================================
// 导入依赖模块
// ============================================

// 导入Node.js内置的events模块，用于创建事件发射器
const EventEmitter = require('events');
// 导入Node.js内置的fs模块，用于文件操作
const fs = require('fs');
// 导入Node.js内置的path模块，用于路径处理
const path = require('path');
// 导入配置模块，获取日志相关配置
const config = require('../core/config');

// ============================================
// 日志级别定义
// ============================================

/**
 * 日志级别枚举
 * 定义支持的日志级别及其优先级
 */
const LogLevel = {
  // 追踪级别，用于详细流程追踪（最详细）
  TRACE: { value: 0, label: 'TRACE', color: '\x1b[90m' }, // 灰色
  // 调试级别，用于开发调试
  DEBUG: { value: 1, label: 'DEBUG', color: '\x1b[36m' }, // 青色
  // 信息级别，记录一般信息
  INFO: { value: 2, label: 'INFO', color: '\x1b[32m' },  // 绿色
  // 警告级别，记录可能的问题
  WARN: { value: 3, label: 'WARN', color: '\x1b[33m' },  // 黄色
  // 错误级别，记录错误信息
  ERROR: { value: 4, label: 'ERROR', color: '\x1b[31m' } // 红色
};

// ============================================
// 日志类定义
// ============================================

/**
 * Logger类
 * 封装日志记录的所有功能
 */
class Logger extends EventEmitter {
  /**
   * 构造函数
   * 初始化日志记录器
   */
  constructor() {
    // 调用父类构造函数
    super();
    
    // 当前日志级别，从配置读取，默认为info
    this.level = this.parseLevel(config.log.level);
    // 日志文件路径
    this.logFile = config.log.file;
    // 是否输出到控制台
    this.consoleOutput = config.log.console;
    // 是否输出到文件
    this.fileOutput = config.log.fileOutput;
    // 当前日志文件大小（字节）
    this.currentFileSize = 0;
    // 最大文件大小（字节）
    this.maxSize = config.log.maxSize;
    // 最大保留文件数
    this.maxFiles = config.log.maxFiles;
    
    // 追踪上下文：用于关联同一请求的多条日志
    this.traceContext = new Map();
    // 追踪上下文最大容量，防止无界增长
    this.traceContextMaxSize = 500;
    // 追踪条目最大存活时间（毫秒）
    this.traceContextMaxAge = 10 * 60 * 1000; // 10 分钟

    // 定期清理僵尸追踪条目（每 5 分钟）
    this._traceCleanupTimer = setInterval(() => {
      this._cleanupStaleTraces();
    }, 5 * 60 * 1000);
    // 允许进程正常退出，不被此定时器阻塞
    if (this._traceCleanupTimer.unref) {
      this._traceCleanupTimer.unref();
    }
    
    // 初始化：确保日志目录存在
    this.ensureLogDirectory();
    // 初始化：获取当前日志文件大小
    this.updateCurrentFileSize();
  }

  /**
   * 解析日志级别字符串为枚举值
   * @param {string} level - 日志级别字符串
   * @returns {Object} 日志级别对象
   */
  parseLevel(level) {
    // 将输入转为大写，进行不区分大小写的匹配
    const upperLevel = (level || 'INFO').toUpperCase();
    // 返回匹配的日志级别，如果没有匹配则默认返回INFO
    return LogLevel[upperLevel] || LogLevel.INFO;
  }

  /**
   * 确保日志目录存在
   * 如果目录不存在则自动创建
   */
  ensureLogDirectory() {
    // 从文件路径提取目录路径
    const dir = path.dirname(this.logFile);
    // 检查目录是否存在
    if (!fs.existsSync(dir)) {
      // 递归创建目录，包括所有父目录
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 更新当前日志文件大小
   * 用于判断是否需要轮转
   */
  updateCurrentFileSize() {
    // 检查日志文件是否存在
    if (fs.existsSync(this.logFile)) {
      // 获取文件状态信息
      const stats = fs.statSync(this.logFile);
      // 更新当前文件大小
      this.currentFileSize = stats.size;
    } else {
      // 文件不存在，大小为0
      this.currentFileSize = 0;
    }
  }

  /**
   * 轮转日志文件
   * 当当前日志文件超过最大大小时，进行轮转
   */
  rotateLogFile() {
    // 检查是否需要轮转
    if (this.currentFileSize < this.maxSize) {
      return; // 不需要轮转
    }

    // 从后往前删除旧文件，为轮转腾出空间
    for (let i = this.maxFiles - 1; i > 0; i--) {
      // 构造旧文件路径
      const oldFile = `${this.logFile}.${i}`;
      // 构造新文件路径
      const newFile = `${this.logFile}.${i + 1}`;
      
      // 如果旧文件存在
      if (fs.existsSync(oldFile)) {
        // 如果是最老的文件，直接删除
        if (i === this.maxFiles - 1) {
          fs.unlinkSync(oldFile);
        } else {
          // 否则重命名为更老的编号
          fs.renameSync(oldFile, newFile);
        }
      }
    }

    // 将当前日志文件重命名为.1
    if (fs.existsSync(this.logFile)) {
      fs.renameSync(this.logFile, `${this.logFile}.1`);
    }

    // 重置当前文件大小
    this.currentFileSize = 0;
  }

  /**
   * 格式化日志消息
   * @param {string} level - 日志级别标签
   * @param {string} message - 日志消息
   * @param {Object} meta - 附加元数据
   * @returns {string} 格式化后的日志字符串
   */
  formatMessage(level, message, meta) {
    // 获取当前时间戳，格式：YYYY-MM-DD HH:mm:ss
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    // 基础日志字符串
    let logString = `[${timestamp}] [${level}] ${message}`;
    
    // 如果有附加元数据，转换为JSON字符串追加
    if (meta && Object.keys(meta).length > 0) {
      logString += ` ${JSON.stringify(meta)}`;
    }
    
    return logString;
  }

  /**
   * 写入日志到文件
   * @param {string} message - 日志消息
   */
  writeToFile(message) {
    // 如果文件输出被禁用，直接返回
    if (!this.fileOutput) return;

    try {
      // 检查并执行日志轮转
      this.rotateLogFile();
      
      // 追加写入日志文件，添加换行符
      fs.appendFileSync(this.logFile, message + '\n');
      
      // 更新当前文件大小
      this.currentFileSize += Buffer.byteLength(message + '\n', 'utf8');
    } catch (error) {
      // 文件写入失败，输出到控制台（避免递归调用）
      console.error('写入日志文件失败:', error.message);
    }
  }

  /**
   * 输出日志到控制台
   * @param {string} message - 日志消息
   * @param {string} color - ANSI颜色代码
   */
  writeToConsole(message, color) {
    // 如果控制台输出被禁用，直接返回
    if (!this.consoleOutput) return;

    // 重置颜色代码
    const resetColor = '\x1b[0m';
    // 输出带颜色的日志到控制台
    console.log(`${color}${message}${resetColor}`);
  }

  /**
   * 记录日志的核心方法
   * @param {Object} level - 日志级别对象
   * @param {string} message - 日志消息
   * @param {Object} meta - 附加元数据
   */
  log(level, message, meta = {}) {
    // 检查当前日志级别是否允许记录该级别日志
    // 只有优先级大于等于当前级别的日志才会被记录
    if (level.value < this.level.value) {
      return; // 级别不够，忽略
    }

    // 格式化日志消息
    const formattedMessage = this.formatMessage(level.label, message, meta);
    
    // 输出到控制台（带颜色）
    this.writeToConsole(formattedMessage, level.color);
    
    // 写入到文件（不带颜色代码）
    this.writeToFile(formattedMessage);
    
    // 触发日志事件，允许其他模块监听
    this.emit('log', { level: level.label, message, meta, timestamp: new Date() });
  }

  // ----------------------------------------
  // 便捷方法
  // ----------------------------------------

  /**
   * 记录追踪级别日志
   * 用于详细流程追踪，比debug更详细
   * @param {string} message - 日志消息
   * @param {Object} meta - 附加元数据
   */
  trace(message, meta) {
    this.log(LogLevel.TRACE, message, meta);
  }

  /**
   * 记录调试级别日志
   * @param {string} message - 日志消息
   * @param {Object} meta - 附加元数据
   */
  debug(message, meta) {
    this.log(LogLevel.DEBUG, message, meta);
  }

  /**
   * 记录信息级别日志
   * @param {string} message - 日志消息
   * @param {Object} meta - 附加元数据
   */
  info(message, meta) {
    this.log(LogLevel.INFO, message, meta);
  }

  /**
   * 记录警告级别日志
   * @param {string} message - 日志消息
   * @param {Object} meta - 附加元数据
   */
  warn(message, meta) {
    this.log(LogLevel.WARN, message, meta);
  }

  /**
   * 记录错误级别日志
   * @param {string} message - 日志消息
   * @param {Error} error - 错误对象
   */
  error(message, error) {
    // 构造元数据，包含错误信息
    const meta = {};
    if (error) {
      meta.error = {
        message: error.message,
        stack: error.stack
      };
    }
    this.log(LogLevel.ERROR, message, meta);
  }

  // ============================================
  // 执行流程追踪方法（用于NL2SQL调试）
  // ============================================

  /**
   * 清理超时的僵尸追踪条目
   */
  _cleanupStaleTraces() {
    const now = Date.now();
    let cleaned = 0;
    for (const [traceId, session] of this.traceContext) {
      if (now - session.startTime > this.traceContextMaxAge) {
        this.traceContext.delete(traceId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.debug(`[TraceCleanup] 清理了 ${cleaned} 个僵尸追踪条目，剩余 ${this.traceContext.size} 个`);
    }
  }

  /**
   * 开始一个追踪会话
   * @param {string} traceId - 追踪ID（如sessionId）
   * @param {string} operation - 操作名称
   * @param {Object} context - 初始上下文数据
   * @returns {Object} 追踪会话对象
   */
  startTrace(traceId, operation, context = {}) {
    // 容量保护：超过上限时清理最老的条目
    if (this.traceContext.size >= this.traceContextMaxSize) {
      this._cleanupStaleTraces();
      // 如果清理后仍超限，删除最老的条目
      if (this.traceContext.size >= this.traceContextMaxSize) {
        const oldestKey = this.traceContext.keys().next().value;
        this.traceContext.delete(oldestKey);
      }
    }

    const traceSession = {
      traceId,
      operation,
      startTime: Date.now(),
      steps: [],
      context: { ...context }
    };
    this.traceContext.set(traceId, traceSession);
    
    this.trace(`[${traceId}] 开始追踪: ${operation}`, {
      traceId,
      operation,
      context
    });
    
    return traceSession;
  }

  /**
   * 记录追踪步骤
   * @param {string} traceId - 追踪ID
   * @param {string} step - 步骤名称
   * @param {Object} data - 步骤数据
   * @param {string} status - 步骤状态 (start|success|error)
   */
  traceStep(traceId, step, data = {}, status = 'start') {
    const session = this.traceContext.get(traceId);
    const timestamp = Date.now();
    const stepData = {
      step,
      status,
      timestamp,
      elapsed: session ? timestamp - session.startTime : 0,
      data
    };
    
    if (session) {
      session.steps.push(stepData);
    }
    
    // 根据状态选择日志级别
    const level = status === 'error' ? LogLevel.ERROR : 
                  status === 'success' ? LogLevel.DEBUG : LogLevel.TRACE;
    
    this.log(level, `[${traceId}] [${step}] ${status.toUpperCase()}`, {
      traceId,
      step,
      status,
      elapsed: stepData.elapsed,
      ...data
    });
  }

  /**
   * 结束追踪会话
   * @param {string} traceId - 追踪ID
   * @param {Object} result - 最终结果
   * @returns {Object} 完整的追踪记录
   */
  endTrace(traceId, result = {}) {
    const session = this.traceContext.get(traceId);
    if (!session) return null;
    
    const endTime = Date.now();
    const totalTime = endTime - session.startTime;
    
    const traceRecord = {
      ...session,
      endTime,
      totalTime,
      result,
      stepCount: session.steps.length
    };
    
    this.trace(`[${traceId}] 结束追踪`, {
      traceId,
      operation: session.operation,
      totalTime: `${totalTime}ms`,
      stepCount: session.steps.length
    });
    
    // 清理追踪上下文
    this.traceContext.delete(traceId);
    
    return traceRecord;
  }

  /**
   * 获取追踪会话
   * @param {string} traceId - 追踪ID
   * @returns {Object|null} 追踪会话对象
   */
  getTrace(traceId) {
    return this.traceContext.get(traceId) || null;
  }

  /**
   * 设置日志级别
   * @param {string} level - 日志级别字符串
   */
  setLevel(level) {
    this.level = this.parseLevel(level);
    this.info(`日志级别已设置为: ${this.level.label}`);
  }
}

// ============================================
// 创建单例实例
// ============================================

// 创建Logger类的唯一实例，确保整个应用使用同一个日志记录器
const logger = new Logger();

// ============================================
// 导出模块
// ============================================

// 导出日志记录器实例
module.exports = logger;
