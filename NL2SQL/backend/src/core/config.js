/**
 * 配置管理模块
 * 
 * 统一管理应用的所有配置项，从环境变量读取并提供默认值
 * 集中管理配置便于维护和修改，避免配置散落在各个文件中
 */

// ============================================
// 配置对象定义
// ============================================

// 【Phase 3 · T3b】RLS env 解析辅助
// 提前从 sqlRewriter 导入,以便在 config 对象定义时直接使用
const { parseTenantMapEnv } = require('../utils/sqlRewriter');

/**
 * 应用配置对象
 * 所有配置项都从这里获取，不要直接从process.env读取
 */
const config = {
  
  // ----------------------------------------
  // 服务器基础配置
  // ----------------------------------------
  
  /**
   * 服务监听的端口号
   * 从环境变量PORT读取，默认为3000
   */
  port: parseInt(process.env.PORT) || 3000,
  
  /**
   * 运行环境
   * development: 开发环境，启用详细日志
   * production: 生产环境，精简日志，启用性能优化
   */
  nodeEnv: process.env.NODE_ENV || 'development',
  
  /**
   * 判断是否为开发环境
   * 用于条件启用开发特性，如详细日志、调试工具等
   */
  isDevelopment: function() {
    return this.nodeEnv === 'development';
  },
  
  /**
   * 判断是否为生产环境
   * 用于条件启用生产特性，如性能优化、错误上报等
   */
  isProduction: function() {
    return this.nodeEnv === 'production';
  },

  // ----------------------------------------
  // LLM API 配置
  // ----------------------------------------
  
  /**
   * LLM API的基础URL
   * 支持任何兼容OpenAI API格式的服务
   * 例如：OpenAI, DeepSeek, Azure OpenAI等
   */
  llm: {
    // API基础URL，必须以/v1结尾
    apiBase: process.env.LLM_API_BASE || 'https://api.openai.com/v1',
    // API密钥，用于身份验证
    apiKey: process.env.LLM_API_KEY || '',
    // 默认使用的模型名称
    model: process.env.LLM_MODEL || 'gpt-4',
    // 请求超时时间（毫秒），防止请求挂起
    // 大模型（如Qwen3.5-397B）可能需要更长时间，建议设置为120000或更长
    timeout: parseInt(process.env.LLM_TIMEOUT) || 60000,
    // 最大重试次数，请求失败时自动重试
    maxRetries: 3,
    // 重试间隔（毫秒）
    retryDelay: 1000
  },
  
  /**
   * Embedding模型配置
   * 用于将文本转换为向量，实现语义检索
   */
  embedding: {
    // 是否启用 Embedding 向量检索功能
    // 关闭时跳过相似历史查询检索与查询向量写入分支，退化为关键词/传统路径
    enabled: process.env.EMBEDDING_ENABLED !== 'false',
    // Embedding模型名称
    model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
    // 向量维度，不同模型维度不同
    dimension: parseInt(process.env.EMBEDDING_DIMENSION) || 1536,
    // 请求超时时间（毫秒）- Embedding可能需要更长时间
    timeout: parseInt(process.env.EMBEDDING_TIMEOUT) || 60000
  },

  // ----------------------------------------
  // 数据库配置
  // ----------------------------------------
  
  /**
   * SQLite数据库配置
   * 用于存储会话历史、查询日志等
   */
  database: {
    // SQLite数据库文件路径
    path: process.env.DB_PATH || './data/sessions.db'
  },
  
  /**
   * LanceDB向量数据库配置
   * 用于存储向量化的Schema信息和查询历史
   */
  vectorDb: {
    // 数据库存储目录路径
    path: process.env.VECTOR_DB_PATH || './data/vectordb'
  },
  
  /**
   * SR数据源数据库配置
   * 这是实际查询的业务数据库
   */
  srDatabase: {
    // 数据库连接URL
    // 格式: mysql://user:password@host:port/database
    url: process.env.SR_DATABASE_URL || '',
    // 是否启用真实 SR 数据源执行（依据 URL 自动推断，可被环境变量覆盖）
    enabled: process.env.SR_DB_ENABLED !== 'false' && !!process.env.SR_DATABASE_URL,
    // 单条查询的最大执行时长（毫秒），超过则触发 MAX_EXECUTION_TIME 终止
    queryTimeoutMs: parseInt(process.env.SR_QUERY_TIMEOUT_MS) || 30000,
    // 单次返回最多保留多少行，防止超大结果集撑爆内存
    maxRows: parseInt(process.env.SR_MAX_ROWS) || 1000,
    // 连接池配置
    pool: {
      // 最小连接数
      min: 2,
      // 最大连接数
      max: 10,
      // 连接超时时间（毫秒）
      acquireTimeout: 30000,
      // 空闲连接超时时间（毫秒）
      idleTimeout: 600000
    }
  },

  // ----------------------------------------
  // 安全配置
  // ----------------------------------------
  
  /**
   * 安全相关配置
   * 防止SQL注入、数据泄露等安全问题
   */
  security: {
    // 允许查询的数据表白名单
    // 多个表用逗号分隔，不在白名单中的表无法查询
    // 如果为空数组，则允许访问所有表（生产环境不建议）
    allowedTables: (process.env.ALLOWED_TABLES || '').split(',').filter(Boolean),
    
    // 是否只生成SQL而不实际执行查询
    // 开发调试时使用，只返回生成的SQL语句
    dryRun: process.env.DRY_RUN === 'true' || false,
    
    // 单个查询返回的最大行数限制
    // 防止大查询导致内存溢出或响应过慢
    maxQueryRows: parseInt(process.env.MAX_QUERY_ROWS) || 1000,
    
    // 查询超时时间（毫秒）
    // 超过此时间的查询会被强制终止
    queryTimeout: parseInt(process.env.QUERY_TIMEOUT) || 30000,
    
    // 禁止的SQL关键字列表
    // 包含这些关键字的SQL会被拒绝执行
    forbiddenKeywords: [
      'UPDATE', 'DELETE', 'DROP', 'INSERT', 'ALTER', 'TRUNCATE',
      'CREATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE'
    ],
    
    // 敏感字段列表，查询结果中会被脱敏处理
    // 【Phase 3 · T3a】保留作向后兼容别名;实际脱敏走 masking.rules
    sensitiveFields: [
      'password', 'phone', 'mobile', 'id_card', 'idcard',
      'credit_card', 'creditcard', 'secret', 'token'
    ],

    // 【Phase 3 · T3a】结果脱敏配置
    // 规则: mid_4 / domain_only / head_tail / redact / first_1 / last_4 / length_stars
    // 列名匹配大小写不敏感;null/undefined 值透传不脱敏
    masking: {
      enabled: process.env.MASKING_ENABLED === 'false' ? false : true,
      rules: {
        phone:       'mid_4',
        mobile:      'mid_4',
        email:       'domain_only',
        id_card:     'head_tail',
        idcard:      'head_tail',
        credit_card: 'redact',
        creditcard:  'redact',
        password:    'redact',
        secret:      'redact',
        token:       'redact'
      }
    },

    // 【Phase 3 · T3b】行级权限(RLS)配置
    // tableTenantMap:{tableName: tenantColumn} 形式;列表里的表会被 post-parse 改写追加 tenant 条件
    // 默认空 map + enabled=false,需显式 opt-in
    rls: {
      enabled: process.env.RLS_ENABLED === 'true' || false,
      tableTenantMap: parseTenantMapEnv(process.env.RLS_TABLE_TENANT_MAP)
    }
  },

  // ----------------------------------------
  // 会话配置
  // ----------------------------------------
  
  /**
   * 会话管理配置
   */
  session: {
    // 会话历史保留的最大消息数
    maxHistory: 20,
    // 会话过期时间（毫秒），默认7天
    expireTime: 7 * 24 * 60 * 60 * 1000,
    // 清理过期会话的间隔（毫秒），默认1小时
    cleanupInterval: 60 * 60 * 1000
  },

  // ----------------------------------------
  // 日志配置
  // ----------------------------------------
  
  /**
   * 日志配置
   */
  log: {
    // 日志级别：trace, debug, info, warn, error
    // trace: 最详细，记录所有执行步骤（用于深度调试）
    // debug: 详细调试信息
    // info: 一般信息（默认）
    // warn: 警告信息
    // error: 错误信息
    level: process.env.LOG_LEVEL || 'info',
    // 日志文件路径
    file: process.env.LOG_FILE || './logs/app.log',
    // 是否输出到控制台
    console: true,
    // 是否输出到文件
    fileOutput: true,
    // 日志文件最大大小（字节），超过后自动轮转
    maxSize: 10 * 1024 * 1024, // 10MB
    // 保留的历史日志文件数量
    maxFiles: 5
  },

  // ----------------------------------------
  // 自修复配置
  // ----------------------------------------
  
  /**
   * 自修复机制配置
   */
  selfRepair: {
    // 是否启用自修复
    enabled: true,
    // 每日自检的Cron表达式，默认每天凌晨2点
    dailyCheckCron: '0 2 * * *',
    // 会话健康检查间隔（毫秒），默认30分钟
    sessionCheckInterval: 30 * 60 * 1000,
    // 慢查询阈值（毫秒），超过此值记录为慢查询
    slowQueryThreshold: 5000
  },

  // ----------------------------------------
  // Schema配置
  // ----------------------------------------
  
  /**
   * Schema元数据配置
   */
  schema: {
    // Schema配置文件路径
    configPath: process.env.SCHEMA_CONFIG_PATH || './config/schema-metadata.json',
    // 是否启用Schema缓存
    enableCache: true,
    // 缓存过期时间（毫秒），默认1小时
    cacheExpireTime: 60 * 60 * 1000,
    // 是否强制重新向量化Schema（即使向量数据库中已有数据）
    // 设置为 true 时，每次启动都会重新生成向量；设置为 false 时，如果向量已存在则跳过
    revectorize: process.env.SCHEMA_REVECTORIZE === 'true' || false
  },

  // ----------------------------------------
  // 长期记忆配置（新增）
  // ----------------------------------------
  
  /**
   * 长期记忆（Layer 2）配置
   */
  longTermMemory: {
    // 是否启用长期记忆功能
    enabled: process.env.LTM_ENABLED !== 'false', // 默认启用
    
    // 是否使用LLM进行智能提炼
    // true: 使用LLM分析查询价值，区分个人偏好和通用知识
    // false: 使用纯逻辑判断（高频模式、高价值模板等）
    useLLMForExtraction: process.env.LTM_USE_LLM === 'true' || false, // 默认关闭，需要时开启
    
    // 存储筛选阈值
    thresholds: {
      // 最小置信度
      minConfidence: 0.7,
      // 高价值模板最小维度数
      minDimensionsForTemplate: 2,
      // 高价值模板最小指标数
      minMetricsForTemplate: 1,
      // 频率判断天数
      recentDaysForFrequency: 7,
      // 简单查询最小频率
      minFrequencyForSimple: 2
    },
    
    // 分级保留策略（天数）
    retention: {
      // 高频(≥10次)：null表示永久保留
      highUsage: null,
      // 中频(3-9次)
      mediumUsage: 90,
      // 低频(<3次)
      lowUsage: 30,
      // 字段别名（用户习惯较稳定）
      fieldAlias: 365
    }
  },

  // ----------------------------------------
  // 上下文管理配置（新增）
  // ----------------------------------------
  
  /**
   * 上下文管理配置
   * 用于Token预算管理、对话摘要等
   */
  contextManagement: {
    // 是否启用Token预算检查
    enableTokenBudget: process.env.ENABLE_TOKEN_BUDGET !== 'false', // 默认启用
    
    // 是否启用对话摘要
    enableSummarizer: process.env.ENABLE_SUMMARIZER !== 'false', // 默认启用
    
    // Token预算配置
    tokenBudget: {
      // 最大上下文Token数（默认128k的80%）
      maxContextTokens: parseInt(process.env.MAX_CONTEXT_TOKENS) || 102400,
      // 为模型输出预留的Token数
      reservedOutputTokens: parseInt(process.env.RESERVED_OUTPUT_TOKENS) || 8192,
      // 触发警告的阈值比例（0-1）
      warningThreshold: 0.8,
      // 触发压缩的阈值比例（0-1）
      compressionThreshold: 0.9
    },
    
    // 对话摘要配置
    summarizer: {
      // 触发摘要的对话轮数阈值
      triggerRounds: parseInt(process.env.SUMMARIZER_TRIGGER_ROUNDS) || 8,
      // 保留的最近对话轮数
      preserveRecentRounds: parseInt(process.env.SUMMARIZER_PRESERVE_ROUNDS) || 4,
      // 摘要的最大Token数
      maxSummaryTokens: parseInt(process.env.SUMMARIZER_MAX_TOKENS) || 500,
      // 摘要更新间隔（轮数）
      updateInterval: parseInt(process.env.SUMMARIZER_UPDATE_INTERVAL) || 4
    }
  },

  // ----------------------------------------
  // 评估配置（新增）
  // ----------------------------------------
  
  /**
   * 向量化质量和记忆命中率评估配置
   */
  evaluation: {
    // 是否启用评估功能（需要手动开启）
    enabled: process.env.EVALUATION_ENABLED === 'true' || false,
    // 是否记录运行时统计
    trackStats: process.env.EVALUATION_TRACK_STATS === 'true' || false,
    // 评估阈值
    thresholds: {
      highSimilarity: 0.8,
      mediumSimilarity: 0.5,
      highQuality: 0.8,
      mediumQuality: 0.5
    }
  }
};

// ============================================
// 配置验证
// ============================================

/**
 * 验证必要配置项
 * 在应用启动时调用，确保关键配置已设置
 * @throws {Error} 当必要配置缺失时抛出错误
 */
function validateConfig() {
  // 定义必要配置项列表
  const requiredConfigs = [
    { key: 'llm.apiKey', value: config.llm.apiKey, name: 'LLM API密钥' },
    { key: 'srDatabase.url', value: config.srDatabase.url, name: 'SR数据库连接URL' }
  ];
  
  // 遍历检查每个必要配置
  for (const item of requiredConfigs) {
    // 如果配置值为空字符串或undefined，抛出错误
    if (!item.value || item.value === 'your-api-key-here') {
      throw new Error(
        `配置错误: 缺少必要的配置项 "${item.name}" (${item.key})\n` +
        `请在 .env 文件中设置 ${item.key.replace('.', '_').toUpperCase()}`
      );
    }
  }
  
  // 检查白名单是否为空
  if (config.security.allowedTables.length === 0) {
    console.warn('警告: ALLOWED_TABLES 为空，将允许访问所有表，生产环境请配置白名单');
  }
}

// ============================================
// 导出模块
// ============================================

// 导出配置对象，供其他模块使用
module.exports = config;
// 导出验证函数，在应用启动时调用
module.exports.validate = validateConfig;
