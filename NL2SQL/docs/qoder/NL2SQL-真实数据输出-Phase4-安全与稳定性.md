# Phase 4 — 安全与稳定性

## 文档信息
- 版本：v1.0
- 日期：2026-04-24
- 优先级：P1（生产就绪保障）
- 前置依赖：Phase 1 完成
- 预计工时：3d

---

## 1. 目标

真实数据输出场景下的安全保障和稳定性提升：
- SQL 执行安全：只读保护 + 注入防护 + 权限控制
- 性能保护：慢查询熔断 + 超时 + 大结果集内存保护
- 数据安全：脱敏规则完善 + 敏感列自动检测
- 可观测性：执行监控指标 + 异常告警

---

## 2. 当前安全机制审计

### 2.1 已有安全措施

| 措施 | 实现 | 文件 |
|------|------|------|
| SQL 只读保护 | `SET SESSION TRANSACTION READ ONLY` | `srDatabase.js:114` |
| 禁止写操作关键字 | `forbiddenKeywords` 检查 | `sqlExecutor.js:34-66` |
| LIMIT 强制注入 | `ensureLimit()` | `sqlLimit.js` |
| 查询超时 | `MAX_EXECUTION_TIME` + `query timeout` | `srDatabase.js:115-117` |
| 结果脱敏 | `maskResult` 多规则 | `maskResult.js` |
| RLS 行级权限 | `sqlRewriter` | `sqlRewriter.js` |
| 白名单表过滤 | `allowedTables` | `config.js:157` |
| 最大行数限制 | `maxRows=1000` | `config.js:131` |

### 2.2 安全缺口

| # | 缺口 | 风险等级 | 说明 |
|---|------|---------|------|
| 1 | `validateSQL` 仅做关键字+白名单检查，未用 AST 解析 | 中 | 可被注释/编码绕过 |
| 2 | 脱敏规则硬编码，未覆盖业务特定敏感字段 | 中 | 业务字段可能泄露 |
| 3 | 无执行频率限制，可被恶意刷接口 | 高 | DB 可能被打挂 |
| 4 | 大结果集内存无主动保护 | 中 | 1000行×50列 JSON 可达数 MB |
| 5 | 无执行异常的监控和告警 | 低 | 故障发现滞后 |
| 6 | `DRY_RUN=false` 后真实数据通过 SSE 传输，无加密 | 低 | 依赖 HTTPS |

---

## 3. 任务分解

### P4-T1: 执行安全审计（0.5d）

**目标**：复检 SQL 执行链路的安全性，确保 DRY_RUN=false 后无安全漏洞

**修改文件**：
- `backend/src/core/sqlExecutor.js` — 增强 validateSQL

**详细设计**：

#### 3.1.1 增强 SQL 验证

当前 `validateSQL` 仅做关键字黑名单检查。增加 AST 级别校验：

```javascript
const { Parser } = require('node-sql-parser');

async function validateSQL(sql) {
  // 1. 关键字黑名单检查（保留现有逻辑）
  const upperSql = sql.toUpperCase();
  for (const keyword of config.security.forbiddenKeywords) {
    if (upperSql.includes(keyword)) {
      return {
        success: false,
        error: `SQL包含禁止的关键字: ${keyword}`,
        errorCode: 'FORBIDDEN_KEYWORD'
      };
    }
  }

  // 2. AST 解析验证（新增）
  try {
    const parser = new Parser();
    const ast = parser.astify(sql);
    
    // 确保只包含 SELECT 语句
    const stmts = Array.isArray(ast) ? ast : [ast];
    for (const stmt of stmts) {
      if (stmt.type !== 'select') {
        return {
          success: false,
          error: `只允许SELECT查询，检测到: ${stmt.type}`,
          errorCode: 'NON_SELECT_STATEMENT'
        };
      }
    }
  } catch (parseErr) {
    // AST 解析失败不阻断（兼容复杂SQL），仅记录告警
    logger.warn('[SQL验证] AST解析失败，降级为关键字检查', { 
      error: parseErr.message,
      sql: sql.substring(0, 100) 
    });
  }

  // 3. 白名单表检查（保留现有逻辑）
  // ...

  return { success: true };
}
```

#### 3.1.2 执行前二次校验

在 `srDatabase.js` 的 `executeQuery` 中增加防御性检查：

```javascript
async function executeQuery(sql, params = [], options = {}) {
  // 防御性检查：确保 SQL 以 SELECT 或 WITH 开头
  const trimmedSql = sql.trim().toUpperCase();
  if (!trimmedSql.startsWith('SELECT') && !trimmedSql.startsWith('WITH')) {
    throw new Error('安全策略：仅允许执行 SELECT/WITH 语句');
  }
  
  // ... 现有逻辑
}
```

**验证步骤**：
1. 尝试注入 `DROP TABLE` → 被 AST 检查拦截
2. 尝试 `INSERT INTO ... SELECT` → 被类型检查拦截
3. 正常 SELECT 查询 → 通过验证
4. 复杂 WITH CTE 查询 → 通过验证

---

### P4-T2: 慢查询熔断 + 执行超时增强（0.5d）

**目标**：防止单条慢查询拖垮整个服务

**修改文件**：
- `backend/src/core/sqlExecutor.js`
- `backend/src/core/srDatabase.js`

**详细设计**：

#### 3.2.1 慢查询统计与熔断

在 `sqlExecutor.js` 中增加慢查询计数器：

```javascript
// 慢查询熔断器
const slowQueryTracker = {
  windowStart: Date.now(),
  count: 0,
  threshold: 5,          // 窗口内允许的慢查询次数
  windowMs: 60 * 1000,   // 1分钟窗口
  slowThresholdMs: 10000 // 10秒为慢查询
};

function checkSlowQueryCircuit() {
  const now = Date.now();
  // 重置窗口
  if (now - slowQueryTracker.windowStart > slowQueryTracker.windowMs) {
    slowQueryTracker.windowStart = now;
    slowQueryTracker.count = 0;
  }
  // 检查是否熔断
  return slowQueryTracker.count >= slowQueryTracker.threshold;
}

function recordSlowQuery(executionTime) {
  if (executionTime > slowQueryTracker.slowThresholdMs) {
    slowQueryTracker.count++;
    logger.warn('[慢查询熔断] 记录慢查询', {
      executionTime,
      windowCount: slowQueryTracker.count,
      threshold: slowQueryTracker.threshold
    });
  }
}
```

#### 3.2.2 executeQuery 熔断集成

```javascript
async function executeQuery(sql) {
  // 熔断检查
  if (checkSlowQueryCircuit()) {
    logger.warn('[慢查询熔断] 触发熔断，拒绝执行');
    return {
      success: false,
      error: '当前查询压力过大，请稍后重试',
      errorCode: 'SLOW_QUERY_CIRCUIT_BREAK',
      executionTime: 0,
      sql
    };
  }
  
  // ... 现有执行逻辑
  
  // 记录慢查询
  if (result.success) {
    recordSlowQuery(result.executionTime);
  }
  
  return result;
}
```

#### 3.2.3 超时配置增强

在 `config.js` 中增加可配置的超时梯度：

```javascript
srDatabase: {
  // ... 现有配置
  queryTimeoutMs: parseInt(process.env.SR_QUERY_TIMEOUT_MS) || 30000,
  maxRows: parseInt(process.env.SR_MAX_ROWS) || 1000,
  // 新增：慢查询阈值
  slowQueryThresholdMs: parseInt(process.env.SR_SLOW_QUERY_MS) || 10000,
  // 新增：熔断窗口
  circuitBreakerThreshold: parseInt(process.env.SR_CIRCUIT_THRESHOLD) || 5,
  circuitBreakerWindowMs: parseInt(process.env.SR_CIRCUIT_WINDOW_MS) || 60000,
}
```

**验证步骤**：
1. 发送多次慢查询 → 触发熔断 → 后续请求被拒绝
2. 等待窗口重置 → 熔断恢复
3. 正常查询 → 不受影响

---

### P4-T3: 大结果集内存保护（0.5d）

**目标**：防止大结果集导致内存溢出

**修改文件**：
- `backend/src/core/sqlExecutor.js`
- `backend/src/core/srDatabase.js`

**详细设计**：

#### 3.3.1 结果集大小预估

在 `sqlExecutor.js` 中增加结果大小检查：

```javascript
// 最大允许的结果 JSON 大小（字节）
const MAX_RESULT_SIZE = parseInt(process.env.MAX_RESULT_SIZE) || 5 * 1024 * 1024; // 默认5MB

function estimateResultSize(rows) {
  // 采样估算：取前10行的JSON大小，乘以总行数/10
  if (!rows || rows.length === 0) return 0;
  const sampleSize = Math.min(10, rows.length);
  const sampleJson = JSON.stringify(rows.slice(0, sampleSize));
  const estimatedSize = (sampleJson.length / sampleSize) * rows.length;
  return estimatedSize;
}
```

#### 3.3.2 大结果集截断策略

```javascript
// 在 executeQuery 返回前检查结果大小
function trimResultIfNeeded(data) {
  const estimatedSize = estimateResultSize(data.rows);
  
  if (estimatedSize > MAX_RESULT_SIZE) {
    // 按大小截断：逐步减少行数直到满足限制
    const ratio = MAX_RESULT_SIZE / estimatedSize;
    const safeRows = Math.floor(data.rows.length * ratio * 0.9); // 90%安全余量
    const trimmedRows = data.rows.slice(0, safeRows);
    
    logger.warn('[结果保护] 大结果集截断', {
      originalRows: data.rows.length,
      trimmedRows: trimmedRows.length,
      estimatedOriginalSize: `${(estimatedSize / 1024 / 1024).toFixed(2)}MB`,
      limit: `${(MAX_RESULT_SIZE / 1024 / 1024).toFixed(2)}MB`
    });
    
    return {
      ...data,
      rows: trimmedRows,
      rowCount: data.rowCount, // 保持原始行数
      truncated: true,
      truncationReason: 'result_size_exceeded'
    };
  }
  
  return data;
}
```

#### 3.3.3 SSE 传输大小保护

在 `sseHandler.js` 的 `sendMessage` 中增加大小检查：

```javascript
function sendMessage(conn, message) {
  try {
    const data = JSON.stringify(message);
    
    // SSE 消息大小警告（超过 1MB）
    if (data.length > 1024 * 1024) {
      logger.warn('[SSE] 消息体过大', {
        sessionId: conn.sessionId,
        sizeKB: Math.round(data.length / 1024),
        type: message.type
      });
    }
    
    conn.res.write(`data: ${data}\n\n`);
    conn.lastActiveAt = Date.now();
  } catch (error) {
    logger.error('发送SSE消息失败:', error);
  }
}
```

**验证步骤**：
1. 查询返回大结果集 → 确认被截断到安全大小
2. 检查截断后 `truncated=true` 和 `truncationReason`
3. SSE 传输不因消息过大而断连

---

### P4-T4: 结果脱敏规则完善 + 敏感列自动检测（1d）

**目标**：自动识别潜在敏感列，防止数据泄露

**修改文件**：
- `backend/src/utils/maskResult.js`
- `backend/config/schema-metadata.json`（配置敏感列）

**详细设计**：

#### 3.4.1 敏感列自动检测

在 `maskResult.js` 中增加基于列名的自动检测：

```javascript
// 敏感列名模式（正则，大小写不敏感）
const SENSITIVE_PATTERNS = [
  { pattern: /phone|mobile|tel|telephone/i, rule: 'mid_4' },
  { pattern: /email|mail/i, rule: 'domain_only' },
  { pattern: /id_card|idcard|identity/i, rule: 'head_tail' },
  { pattern: /credit_card|card_no|bank_card/i, rule: 'redact' },
  { pattern: /password|passwd|pwd/i, rule: 'redact' },
  { pattern: /secret|token|api_key|apikey/i, rule: 'redact' },
  { pattern: /address|addr/i, rule: 'head_tail' },        // 新增：地址
  { pattern: /name$/i, rule: 'first_1' },                  // 新增：姓名类字段
  { pattern: /birth|birthday|dob/i, rule: 'head_tail' },   // 新增：生日
  { pattern: /salary|wage|income|pay/i, rule: 'mid_4' },   // 新增：薪资
];

function detectSensitiveColumns(columns, existingRules) {
  const detected = {};
  for (const col of columns) {
    // 已有规则的列跳过
    if (existingRules[col.toLowerCase()]) continue;
    
    for (const { pattern, rule } of SENSITIVE_PATTERNS) {
      if (pattern.test(col)) {
        detected[col.toLowerCase()] = rule;
        break;
      }
    }
  }
  return detected;
}
```

#### 3.4.2 maskRows 增强

```javascript
function maskRows(rows, columns, rules = {}) {
  // 合并配置规则和自动检测规则
  const allRules = { ...rules };
  const detected = detectSensitiveColumns(columns, allRules);
  Object.assign(allRules, detected);
  
  if (Object.keys(allRules).length === 0) {
    return { maskedRows: rows, maskedCells: 0 };
  }
  
  // ... 现有脱敏逻辑
}
```

#### 3.4.3 可配置的敏感列覆盖

在 `config.js` 中增加环境变量支持：

```javascript
masking: {
  enabled: process.env.MASKING_ENABLED === 'false' ? false : true,
  rules: {
    // 现有规则...
  },
  // 新增：自动检测开关
  autoDetect: process.env.MASKING_AUTO_DETECT !== 'false', // 默认开启
  // 新增：自定义敏感列（JSON格式环境变量）
  customRules: (() => {
    try {
      return JSON.parse(process.env.MASKING_CUSTOM_RULES || '{}');
    } catch { return {}; }
  })()
}
```

**验证步骤**：
1. 查询含 `user_phone` 列 → 自动识别并脱敏
2. 查询含 `salary` 列 → 自动识别并脱敏
3. 配置 `MASKING_AUTO_DETECT=false` → 自动检测关闭
4. 现有脱敏规则不受影响

---

### P4-T5: 监控指标（0.5d）

**目标**：关键执行指标可观测

**修改文件**：
- `backend/src/core/sqlExecutor.js` — 埋点
- `backend/src/core/routes.js` — 新增 `/api/stats/execution` 端点

**详细设计**：

#### 3.5.1 执行统计收集器

```javascript
// sqlExecutor.js 顶部
const executionStats = {
  totalQueries: 0,
  successQueries: 0,
  failedQueries: 0,
  totalExecutionTime: 0,
  slowQueries: 0,         // >10s
  totalRowsReturned: 0,
  truncatedResults: 0,
  maskedResults: 0,
  circuitBreaks: 0,
  // 按错误码分布
  errorDistribution: {},
  // 最近100条执行记录
  recentExecutions: []
};

function recordExecution(result) {
  executionStats.totalQueries++;
  if (result.success) {
    executionStats.successQueries++;
    executionStats.totalExecutionTime += result.executionTime || 0;
    executionStats.totalRowsReturned += result.data?.rowCount || 0;
    if (result.data?.truncated) executionStats.truncatedResults++;
    if (result.data?.maskedCells > 0) executionStats.maskedResults++;
    if ((result.executionTime || 0) > 10000) executionStats.slowQueries++;
  } else {
    executionStats.failedQueries++;
    const code = result.errorCode || 'UNKNOWN';
    executionStats.errorDistribution[code] = (executionStats.errorDistribution[code] || 0) + 1;
  }
  
  // 记录最近执行（FIFO，最多100条）
  executionStats.recentExecutions.push({
    success: result.success,
    executionTime: result.executionTime,
    rowCount: result.data?.rowCount,
    truncated: result.data?.truncated,
    errorCode: result.errorCode,
    timestamp: new Date().toISOString()
  });
  if (executionStats.recentExecutions.length > 100) {
    executionStats.recentExecutions.shift();
  }
}

function getExecutionStats() {
  return {
    ...executionStats,
    avgExecutionTime: executionStats.totalQueries > 0
      ? Math.round(executionStats.totalExecutionTime / executionStats.totalQueries)
      : 0,
    successRate: executionStats.totalQueries > 0
      ? (executionStats.successQueries / executionStats.totalQueries * 100).toFixed(1) + '%'
      : '0%'
  };
}
```

#### 3.5.2 API 端点

在 `routes.js` 新增：

```javascript
router.get('/stats/execution', (req, res) => {
  const stats = sqlExecutor.getExecutionStats();
  res.json({
    success: true,
    data: stats
  });
});
```

#### 3.5.3 前端监控面板

在 `EvaluationView.vue` 中增加执行统计区域（非必须，可后续迭代）。最小交付：后端 API 就位，可通过 `curl /api/stats/execution` 查看。

**验证步骤**：
1. 执行多次查询 → `GET /api/stats/execution` 返回正确统计
2. 执行失败查询 → `errorDistribution` 正确计数
3. 触发熔断 → `circuitBreaks` 递增

---

## 4. 文件变更清单

| 文件 | 变更类型 | 任务 |
|------|---------|------|
| `backend/src/core/sqlExecutor.js` | AST验证+熔断+统计+大小保护 | P4-T1/T2/T3/T5 |
| `backend/src/core/srDatabase.js` | 防御性检查+超时配置 | P4-T1/T2 |
| `backend/src/utils/maskResult.js` | 自动检测+自定义规则 | P4-T4 |
| `backend/src/core/config.js` | 熔断/脱敏配置项 | P4-T2/T4 |
| `backend/src/core/routes.js` | 执行统计API | P4-T5 |
| `backend/.env` | 新增环境变量 | P4-T2/T4 |

---

## 5. 新增环境变量

```env
# --- Phase 4 安全与稳定性 ---
# 慢查询阈值（毫秒）
SR_SLOW_QUERY_MS=10000
# 熔断触发次数
SR_CIRCUIT_THRESHOLD=5
# 熔断窗口（毫秒）
SR_CIRCUIT_WINDOW_MS=60000
# 最大结果JSON大小（字节）
MAX_RESULT_SIZE=5242880
# 脱敏自动检测（默认开启）
MASKING_AUTO_DETECT=true
# 自定义脱敏规则（JSON格式）
MASKING_CUSTOM_RULES={}
```

---

## 6. 风险与回滚

| 风险 | 缓解 |
|------|------|
| AST 解析失败误拦正常 SQL | 解析失败降级为关键字检查，不阻断 |
| 熔断阈值过低导致正常查询被拒 | 可通过环境变量调整，默认5次/分钟 |
| 自动检测误脱敏非敏感列 | 50%阈值 + 可配置白名单 |
| 执行统计内存占用 | 限制 recentExecutions 100条 |

**回滚方案**：
- 设置 `MASKING_AUTO_DETECT=false` 关闭自动检测
- 设置 `SR_CIRCUIT_THRESHOLD=999` 实质关闭熔断
- `MAX_RESULT_SIZE` 设极大值关闭大小保护

---

## 7. 验收标准

1. ✅ SQL 注入攻击被 AST 检查拦截
2. ✅ 慢查询连续触发后熔断生效
3. ✅ 大结果集自动截断，`truncated=true`
4. ✅ 敏感列自动检测并脱敏
5. ✅ `GET /api/stats/execution` 返回正确执行统计
6. ✅ 所有安全功能可通过环境变量开关控制
