# NL2SQL部署指南

<cite>
**本文档引用的文件**
- [package.json](file://NL2SQL/backend/package.json)
- [app.js](file://NL2SQL/backend/src/app.js)
- [config.js](file://NL2SQL/backend/src/core/config.js)
- [routes.js](file://NL2SQL/backend/src/core/routes.js)
- [vectorStore.js](file://NL2SQL/backend/src/memory/vectorStore.js)
- [logger.js](file://NL2SQL/backend/src/utils/logger.js)
- [schemaLoader.js](file://NL2SQL/backend/src/core/schemaLoader.js)
- [nl2sqlEngine.js](file://NL2SQL/backend/src/core/nl2sqlEngine.js)
- [llmService.js](file://NL2SQL/backend/src/core/llmService.js)
- [database.js](file://NL2SQL/backend/src/core/database.js)
- [selfRepair.js](file://NL2SQL/backend/src/core/selfRepair.js)
- [wsHandler.js](file://NL2SQL/backend/src/core/wsHandler.js)
- [schema-metadata.json](file://NL2SQL/backend/config/schema-metadata.json)
- [main.js](file://NL2SQL/frontend/src/main.js)
- [.env.example](file://config.example.json)
</cite>

## 目录
1. [项目概述](#项目概述)
2. [系统架构](#系统架构)
3. [部署前置条件](#部署前置条件)
4. [后端服务部署](#后端服务部署)
5. [前端应用部署](#前端应用部署)
6. [配置管理](#配置管理)
7. [数据迁移与初始化](#数据迁移与初始化)
8. [监控与维护](#监控与维护)
9. [故障排查](#故障排查)
10. [最佳实践](#最佳实践)

## 项目概述

NL2SQL是一个基于人工智能技术的自然语言到SQL查询转换系统。该系统允许用户通过自然语言查询数据库，系统会自动将其转换为标准SQL语句并执行查询，最终将结果以自然语言形式反馈给用户。

### 核心特性
- **自然语言查询**：用户可以用中文描述数据需求
- **智能SQL生成**：基于AI模型自动生成准确的SQL语句
- **实时交互**：支持WebSocket实时通信和流式响应
- **语义检索**：基于向量数据库实现Schema语义匹配
- **会话管理**：完整的对话历史记录和管理
- **安全控制**：多层安全防护和访问控制

## 系统架构

```mermaid
graph TB
subgraph "前端层"
FE[Vue.js前端应用]
WS[WebSocket连接]
end
subgraph "后端服务层"
API[Express API服务]
WS_S[WebSocket服务]
ENGINE[NL2SQL引擎]
ROUTES[路由处理]
end
subgraph "数据层"
SQLITE[SQLite数据库]
LANCEDB[LanceDB向量数据库]
SRDB[业务数据库]
end
subgraph "AI服务层"
LLM[LLM API服务]
EMBED[Embedding服务]
end
FE --> WS
WS --> WS_S
API --> ROUTES
ROUTES --> ENGINE
ENGINE --> LLM
ENGINE --> EMBED
ENGINE --> SQLITE
ENGINE --> LANCEDB
ENGINE --> SRDB
WS_S --> ENGINE
```

**架构图来源**
- [app.js:101-111](file://NL2SQL/backend/src/app.js#L101-L111)
- [routes.js:16-34](file://NL2SQL/backend/src/core/routes.js#L16-L34)
- [wsHandler.js:57-116](file://NL2SQL/backend/src/core/wsHandler.js#L57-L116)

## 部署前置条件

### 系统要求
- **Node.js版本**：≥ 18.0.0
- **内存**：至少4GB RAM
- **存储**：至少1GB可用磁盘空间
- **网络**：能够访问外部LLM API服务

### 依赖组件
- **数据库**：SQLite（自动安装）
- **向量数据库**：LanceDB（自动安装）
- **Web服务器**：Node.js内置HTTP服务器
- **WebSocket**：ws库

**章节来源**
- [package.json:25-27](file://NL2SQL/backend/package.json#L25-L27)

## 后端服务部署

### 1. 环境准备

```bash
# 克隆项目
git clone <repository-url>
cd NL2SQL

# 安装依赖
npm install
```

### 2. 环境变量配置

创建`.env`文件：

```env
# 服务器配置
PORT=3000
NODE_ENV=production

# LLM API配置
LLM_API_BASE=https://api.openai.com/v1
LLM_API_KEY=your_api_key_here
LLM_MODEL=gpt-4
LLM_TIMEOUT=60000

# Embedding配置
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_TIMEOUT=60000

# 数据库配置
DB_PATH=./data/sessions.db
VECTOR_DB_PATH=./data/vectordb
SR_DATABASE_URL=mysql://user:password@host:port/database

# 安全配置
ALLOWED_TABLES=table1,table2,table3
DRY_RUN=false
MAX_QUERY_ROWS=1000
QUERY_TIMEOUT=30000

# Schema配置
SCHEMA_CONFIG_PATH=./config/schema-metadata.json
SCHEMA_REVECTORIZE=false
```

**章节来源**
- [config.js:16-246](file://NL2SQL/backend/src/core/config.js#L16-L246)

### 3. 启动服务

```bash
# 开发模式
npm run dev

# 生产模式
npm run start
```

### 4. 服务健康检查

```bash
# 健康检查
curl http://localhost:3000/api/health

# 详细健康检查
curl http://localhost:3000/api/health/detail
```

**章节来源**
- [app.js:121-190](file://NL2SQL/backend/src/app.js#L121-L190)
- [routes.js:70-135](file://NL2SQL/backend/src/core/routes.js#L70-L135)

## 前端应用部署

### 1. 前端环境准备

```bash
# 进入前端目录
cd NL2SQL/frontend

# 安装依赖
npm install
```

### 2. 前端配置

编辑`vite.config.js`：

```javascript
export default {
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '/api')
      }
    }
  }
}
```

### 3. 构建前端应用

```bash
# 开发构建
npm run dev

# 生产构建
npm run build
```

### 4. 部署前端静态文件

将构建产物部署到Nginx或Apache：

```nginx
server {
    listen 80;
    server_name your-domain.com;
    root /var/www/nl2sql/frontend/dist;
    
    location / {
        try_files $uri $uri/ /index.html;
    }
    
    location /api/ {
        proxy_pass http://localhost:3000/;
    }
}
```

**章节来源**
- [main.js:55-89](file://NL2SQL/frontend/src/main.js#L55-L89)

## 配置管理

### 1. 核心配置文件

配置文件位置：`NL2SQL/backend/src/core/config.js`

#### 服务器配置
```javascript
port: parseInt(process.env.PORT) || 3000,
nodeEnv: process.env.NODE_ENV || 'development',
```

#### LLM API配置
```javascript
llm: {
    apiBase: process.env.LLM_API_BASE || 'https://api.openai.com/v1',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'gpt-4',
    timeout: parseInt(process.env.LLM_TIMEOUT) || 60000,
    maxRetries: 3,
    retryDelay: 1000
},
```

#### 数据库配置
```javascript
database: {
    path: process.env.DB_PATH || './data/sessions.db'
},
vectorDb: {
    path: process.env.VECTOR_DB_PATH || './data/vectordb'
},
srDatabase: {
    url: process.env.SR_DATABASE_URL || '',
    pool: {
        min: 2,
        max: 10,
        acquireTimeout: 30000,
        idleTimeout: 600000
    }
}
```

#### 安全配置
```javascript
security: {
    allowedTables: (process.env.ALLOWED_TABLES || '').split(',').filter(Boolean),
    dryRun: process.env.DRY_RUN === 'true' || false,
    maxQueryRows: parseInt(process.env.MAX_QUERY_ROWS) || 1000,
    queryTimeout: parseInt(process.env.QUERY_TIMEOUT) || 30000,
    forbiddenKeywords: [
        'UPDATE', 'DELETE', 'DROP', 'INSERT', 'ALTER', 'TRUNCATE',
        'CREATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE'
    ]
}
```

**章节来源**
- [config.js:16-246](file://NL2SQL/backend/src/core/config.js#L16-L246)

### 2. Schema元数据配置

Schema配置文件：`NL2SQL/backend/config/schema-metadata.json`

```json
{
  "version": "1.0.0",
  "tables": [
    {
      "name": "tzpingtai_tz_sdk_log_pf_reg",
      "name_cn": "平台注册表",
      "description": "平台注册表，记录用户在平台的注册行为",
      "fields": [
        {
          "name": "sf_id",
          "name_cn": "唯一ID",
          "type": "BIGINT",
          "description": "雪花ID，全局唯一"
        }
      ]
    }
  ]
}
```

**章节来源**
- [schema-metadata.json:1-800](file://NL2SQL/backend/config/schema-metadata.json#L1-L800)

## 数据迁移与初始化

### 1. 数据库初始化

```javascript
// SQLite数据库初始化
await database.initialize();
logger.info('SQLite数据库初始化完成');

// LanceDB向量数据库初始化
await vectorStore.initialize();
logger.info('LanceDB向量数据库初始化完成');
```

### 2. Schema向量化

```javascript
// 检查向量数据库状态
if (vectorStore.isInitialized()) {
    await vectorizeSchema();
}

// 向量化Schema
async function vectorizeSchema() {
    const texts = [];
    const metadata = [];
    
    // 构造表和字段描述文本
    for (const table of schemaData.tables) {
        const tableText = `
        表名: ${table.name}
        中文名: ${table.name_cn || ''}
        描述: ${table.description || ''}
        字段: ${table.fields.map(f => f.name_cn || f.name).join(', ')}
        `.trim();
        
        texts.push(tableText);
        metadata.push({
            type: 'table',
            name: table.name,
            name_cn: table.name_cn
        });
        
        // 处理字段
        for (const field of table.fields) {
            const fieldText = `
            字段: ${table.name}.${field.name}
            中文名: ${field.name_cn || ''}
            类型: ${field.type}
            描述: ${field.description || ''}
            所属表: ${table.name_cn || table.name}
            `.trim();
            
            texts.push(fieldText);
            metadata.push({
                type: 'field',
                table: table.name,
                name: field.name,
                name_cn: field.name_cn
            });
        }
    }
    
    // 获取Embedding向量
    const allEmbeddings = [];
    for (let i = 0; i < texts.length; i += batchSize) {
        const batchTexts = texts.slice(i, i + batchSize);
        const batchEmbeddings = await llmService.getEmbedding(batchTexts);
        allEmbeddings.push(...batchEmbeddings);
    }
    
    // 存储到向量数据库
    await vectorStore.addSchemaVectors(
        texts.slice(0, allEmbeddings.length), 
        allEmbeddings, 
        metadata.slice(0, allEmbeddings.length)
    );
}
```

**章节来源**
- [database.js:198-252](file://NL2SQL/backend/src/core/database.js#L198-L252)
- [vectorStore.js:55-85](file://NL2SQL/backend/src/memory/vectorStore.js#L55-L85)
- [schemaLoader.js:195-290](file://NL2SQL/backend/src/core/schemaLoader.js#L195-L290)

### 3. 自修复机制

```javascript
// 启动自修复调度器
selfRepair.start();

// 每日自检任务
dailyCheckJob = cron.schedule(
    config.selfRepair.dailyCheckCron,
    performDailyCheck,
    {
        name: 'daily-check',
        runOnInit: false
    }
);

// 会话清理任务
sessionCleanupJob = cron.schedule(
    '*/30 * * * *',
    cleanupSessions,
    {
        name: 'session-cleanup'
    }
);
```

**章节来源**
- [selfRepair.js:55-107](file://NL2SQL/backend/src/core/selfRepair.js#L55-L107)

## 监控与维护

### 1. 日志管理

```javascript
// 日志级别配置
const LogLevel = {
    DEBUG: { value: 0, label: 'DEBUG', color: '\x1b[36m' },
    INFO: { value: 1, label: 'INFO', color: '\x1b[32m' },
    WARN: { value: 2, label: 'WARN', color: '\x1b[33m' },
    ERROR: { value: 3, label: 'ERROR', color: '\x1b[31m' }
};

// 日志轮转
rotateLogFile() {
    if (this.currentFileSize >= this.maxSize) {
        // 执行日志轮转
        for (let i = this.maxFiles - 1; i > 0; i--) {
            const oldFile = `${this.logFile}.${i}`;
            const newFile = `${this.logFile}.${i + 1}`;
            if (fs.existsSync(oldFile)) {
                fs.renameSync(oldFile, newFile);
            }
        }
        if (fs.existsSync(this.logFile)) {
            fs.renameSync(this.logFile, `${this.logFile}.1`);
        }
        this.currentFileSize = 0;
    }
}
```

### 2. 性能监控

```javascript
// 系统统计信息
const stats = {
    timestamp: new Date().toISOString(),
    connections: {
        websocket: wsHandler.getConnectionCount()
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
```

**章节来源**
- [logger.js:32-42](file://NL2SQL/backend/src/utils/logger.js#L32-L42)
- [selfRepair.js:359-379](file://NL2SQL/backend/src/core/selfRepair.js#L359-L379)

## 故障排查

### 1. 常见问题诊断

#### 服务启动失败
```bash
# 检查端口占用
netstat -tulpn | grep 3000

# 查看错误日志
tail -f ./logs/app.log

# 检查环境变量
cat .env
```

#### LLM API连接问题
```javascript
// 检查API配置
console.log('LLM API Base:', config.llm.apiBase);
console.log('LLM API Key:', config.llm.apiKey ? '***' : 'MISSING');

// 测试API连接
try {
    const response = await llmService.chat([
        {
            role: 'user',
            content: 'test'
        }
    ]);
    console.log('API连接成功');
} catch (error) {
    console.error('API连接失败:', error.message);
}
```

#### 数据库连接问题
```javascript
// 检查SQLite连接
try {
    await database.query('SELECT 1');
    console.log('SQLite连接成功');
} catch (error) {
    console.error('SQLite连接失败:', error.message);
}

// 检查向量数据库
try {
    const stats = await vectorStore.getStats();
    console.log('向量数据库状态:', stats);
} catch (error) {
    console.error('向量数据库连接失败:', error.message);
}
```

### 2. 性能优化

#### 内存管理
```javascript
// 监控内存使用
const memoryUsage = process.memoryUsage();
console.log('Heap Used:', memoryUsage.heapUsed / 1024 / 1024, 'MB');
console.log('Heap Total:', memoryUsage.heapTotal / 1024 / 1024, 'MB');

// 设置内存限制
const MAX_MEMORY = 1024 * 1024 * 1024; // 1GB
if (memoryUsage.heapUsed > MAX_MEMORY) {
    console.warn('内存使用过高，考虑重启服务');
}
```

#### 查询优化
```javascript
// 限制查询行数
const maxQueryRows = config.security.maxQueryRows || 1000;

// 设置查询超时
const queryTimeout = config.security.queryTimeout || 30000;

// 检查SQL安全性
function validateSQL(sql) {
    const upperSQL = sql.toUpperCase();
    
    // 检查禁止的关键字
    for (const keyword of config.security.forbiddenKeywords) {
        const regex = new RegExp(`\\b${keyword}\\b`, 'i');
        if (regex.test(sql)) {
            return {
                valid: false,
                error: `SQL包含禁止的操作: ${keyword}`
            };
        }
    }
    
    return { valid: true };
}
```

**章节来源**
- [app.js:200-258](file://NL2SQL/backend/src/app.js#L200-L258)
- [nl2sqlEngine.js:419-456](file://NL2SQL/backend/src/core/nl2sqlEngine.js#L419-L456)

## 最佳实践

### 1. 安全配置

#### 环境变量安全
```bash
# 创建独立的环境文件
cp .env.example .env.production

# 设置严格的权限
chmod 600 .env.production

# 使用加密存储敏感信息
# 在生产环境中使用密钥管理系统
```

#### 访问控制
```javascript
// 白名单机制
const allowedTables = config.security.allowedTables;
if (allowedTables.length > 0) {
    const tableMatches = sql.match(/FROM\s+(\w+)|JOIN\s+(\w+)/gi) || [];
    for (const match of tableMatches) {
        const tableName = match.replace(/FROM\s+|JOIN\s+/i, '').trim();
        if (!allowedTables.includes(tableName)) {
            throw new Error(`无权访问表: ${tableName}`);
        }
    }
}
```

### 2. 性能优化

#### 缓存策略
```javascript
// Schema缓存
const cacheTimestamp = 0;
const cacheExpireTime = 60 * 60 * 1000; // 1小时

function isCacheExpired() {
    return Date.now() - cacheTimestamp > config.schema.cacheExpireTime;
}

// 向量缓存
async function hasSchemaVectors() {
    if (!initialized || !schemaTable) {
        return false;
    }
    
    const count = await schemaTable.countRows();
    return count > 1;
}
```

#### 连接池管理
```javascript
// SQLite连接池
const sqlitePool = {
    min: 2,
    max: 10,
    acquireTimeout: 30000,
    idleTimeout: 600000
};

// WebSocket连接管理
const connections = new Map();
const MAX_CONNECTIONS = 1000;
```

### 3. 监控告警

#### 健康检查
```javascript
// 健康检查接口
router.get('/api/health', (req, res) => {
    const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        uptime: process.uptime(),
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
        }
    };
    
    res.json(health);
});
```

#### 错误监控
```javascript
// 全局错误处理
process.on('unhandledRejection', (reason, promise) => {
    logger.error('未处理的Promise拒绝:', reason);
});

process.on('uncaughtException', (error) => {
    logger.error('未捕获的异常:', error);
    gracefulShutdown();
});
```

### 4. 备份恢复

#### 数据备份
```bash
# 备份SQLite数据库
sqlite3 sessions.db ".backup backup.db"

# 备份向量数据库
tar -czf vectordb_backup.tar.gz data/vectordb/

# 备份配置文件
cp .env backup_env
```

#### 恢复流程
```bash
# 恢复数据库
sqlite3 sessions.db ".restore backup.db"

# 恢复向量数据库
rm -rf data/vectordb/
tar -xzf vectordb_backup.tar.gz -C data/

# 重新初始化向量数据
node scripts/rebuild-vectors.js
```

**章节来源**
- [config.js:140-170](file://NL2SQL/backend/src/core/config.js#L140-L170)
- [database.js:200-252](file://NL2SQL/backend/src/core/database.js#L200-L252)
- [selfRepair.js:145-286](file://NL2SQL/backend/src/core/selfRepair.js#L145-L286)