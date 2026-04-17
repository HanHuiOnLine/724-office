# NL2SQL Schema 动态加载优化方案

## 一、问题诊断

### 1.1 核心风险：硬编码截断

**当前代码问题：**
```javascript
// nl2sqlEngine.js L1645
const tableNames = [...allTableNames].slice(0, 5);
```

| 问题点 | 具体表现 | 潜在后果 |
|--------|----------|----------|
| **硬编码限制** | `slice(0, 5)` 固定截断 | 复杂查询时关键表被丢弃 |
| **搜索层截断** | `searchRelevantTables(..., 3, ...)` | 源头限制过严，候选表不足 |
| **无核心表保护** | 注册表等主表可能被挤出 | JOIN 基础表缺失，SQL 生成失败 |
| **无权重排序** | `allTableNames` 为 Set 合并 | 语义相关性信息丢失 |

### 1.2 典型案例

**场景：** 用户查询"近7天注册且有过聊天行为的付费用户"

**涉及维度：**
- 注册（tzpingtai_tz_sdk_log_pf_reg）
- 付费（tzpingtai_tz_sdk_log_pf_order）
- 聊天（tzqingmu_log_game_user_chat）
- 登录（tzpingtai_tz_sdk_log_pf_login）

**问题：** 聊天表在向量检索中排名第 6，被 `slice(0, 5)` 截断丢弃，导致 LLM 找不到聊天表而触发澄清或产生幻觉。

---

## 二、优化目标

1. **核心表保护**：确保用户行为分析的三张基础表始终被包含
2. **动态容量**：根据查询复杂度动态调整表数量上限
3. **语义排序**：基于意图相关性排序，优先保留高相关表
4. **可观测性**：增强日志，便于排查表选择问题

---

## 三、核心表定义

```javascript
/**
 * 核心基础表配置
 * 这些表是用户行为分析的基石，涉及用户圈选时必须保留
 */
const CORE_TABLES = [
  'tzpingtai_tz_sdk_log_pf_reg',    // 注册表（用户新增）
  'tzpingtai_tz_sdk_log_pf_login',  // 登录表（活跃用户）
  'tzpingtai_tz_sdk_log_pf_order'   // 订单表（付费流水）
];
```

**选择理由：**
- **注册表**：用户生命周期起点，所有用户分析的基础
- **登录表**：活跃、留存、在线时长等核心指标的数据源
- **订单表**：付费、LTV、ARPPU 等商业化指标的数据源

---

## 四、优化方案

### Phase 1: 核心表保护机制（P0 - 已实施）

#### 4.1.1 代码修改

**文件：** `backend/src/core/nl2sqlEngine.js`

**1. 添加核心表常量（L69 后）：**
```javascript
/**
 * 【优化】核心基础表配置
 * 这些表是用户行为分析的基石，涉及用户圈选时必须保留
 */
const CORE_TABLES = [
  'tzpingtai_tz_sdk_log_pf_reg',
  'tzpingtai_tz_sdk_log_pf_login', 
  'tzpingtai_tz_sdk_log_pf_order'
];
```

**2. 修改表选择逻辑（L1625-1648）：**
```javascript
// 搜索相关表（传入上下文进行智能匹配）
// 【优化】限制返回表数量为5，确保有足够候选表供后续筛选
const relevantTables = await schemaLoader.searchRelevantTables(
  intent.original_query, 
  5,  // 从 3 放宽到 5
  context
);

// 【修复】根据业务关键词推断可能需要的表
const inferredTables = inferTablesFromQuery(intent.original_query);

// 【Phase 2 新增】合并语义层推荐的表
// 【优化】核心表强制优先保留，避免被 slice 截断丢弃
const allTableNames = new Set([
  ...CORE_TABLES,                    // 核心表始终排在最前
  ...relevantTables.map(t => t.name),
  ...inferredTables,
  ...semanticLayerTables
]);

// 【优化】转换为数组并去重，核心表已确保在前
let selectedTables = [...allTableNames];

// 【优化】放宽表数量限制至8张，游戏业务通常涉及多维度交叉分析
const MAX_TABLES = 8;
if (selectedTables.length > MAX_TABLES) {
  const droppedTables = selectedTables.slice(MAX_TABLES);
  logger.warn('[Schema选择] 关联表过多，已截断至' + MAX_TABLES + '张', {
    originalCount: selectedTables.length,
    kept: selectedTables.slice(0, MAX_TABLES),
    dropped: droppedTables
  });
  selectedTables = selectedTables.slice(0, MAX_TABLES);
}

// 最终表名列表
const tableNames = selectedTables;

// 【优化】增强日志，记录实际选用的表
logger.info('[SQL生成] 生成Schema详细信息', { 
  tableCount: tableNames.length,
  tables: tableNames,
  schemaDetail: schemaDetail 
});
```

#### 4.1.2 优化效果

| 优化项 | 修改前 | 修改后 |
|--------|--------|--------|
| 搜索层返回 | 3 张 | 5 张 |
| 核心表保护 | 无 | 强制优先保留 |
| 最大表数量 | 5 张 | 8 张 |
| 截断日志 | 无 | 记录被丢弃的表 |

---

### Phase 2: 语义权重排序（P1）

#### 4.2.1 设计目标

基于意图相关性动态排序，而非先到先得。

#### 4.2.2 实现方案

```javascript
/**
 * 带权重的表排序函数
 * @param {Array<string>} tables - 表名数组
 * @param {Object} intent - 查询意图
 * @param {string} query - 原始查询
 * @returns {Array<string>} 排序后的表名数组
 */
function rankTablesByRelevance(tables, intent, query) {
  const scored = tables.map(tableName => {
    let score = 0;
    const table = schemaLoader.getTable(tableName);
    if (!table) return { name: tableName, score: 0 };
    
    // 1. 向量检索原始分数（如可用）
    if (table._searchScore) score += table._searchScore * 10;
    
    // 2. 语义层推荐加分
    if (intent.semanticLayerTables?.includes(tableName)) score += 5;
    
    // 3. 关键词匹配加分
    const keywords = extractIntentKeywords(intent);
    const tableText = `${table.name} ${table.name_cn || ''} ${table.description || ''}`;
    keywords.forEach(kw => {
      if (tableText.includes(kw)) score += 2;
    });
    
    // 4. 核心表保底分（确保优先级）
    if (CORE_TABLES.includes(tableName)) score += 100;
    
    // 5. 显式表名匹配（用户在查询中直接提到表名）
    if (query.includes(tableName)) score += 50;
    
    return { name: tableName, score };
  });
  
  // 按分数降序排序
  return scored
    .sort((a, b) => b.score - a.score)
    .map(s => s.name);
}
```

#### 4.2.3 使用方式

```javascript
// 在表选择逻辑中应用排序
let selectedTables = rankTablesByRelevance(
  [...allTableNames], 
  intent, 
  intent.original_query
);
```

---

### Phase 3: Token 感知动态调整（P2）

#### 4.3.1 设计目标

根据表字段数量动态调整容量，避免 Token 溢出。

#### 4.3.2 实现方案

```javascript
/**
 * 估算 Schema Token 占用
 * @param {Array<string>} tableNames - 表名数组
 * @returns {number} 预估 Token 数
 */
function estimateSchemaTokens(tableNames) {
  let totalFields = 0;
  tableNames.forEach(name => {
    const table = schemaLoader.getTable(name);
    if (table) totalFields += table.fields?.length || 0;
  });
  // 粗略估算：每个字段约 15 tokens
  return totalFields * 15;
}

/**
 * 动态计算最大表数量
 * @param {Array<string>} candidateTables - 候选表数组
 * @returns {number} 动态调整后的最大表数量
 */
function calculateMaxTables(candidateTables) {
  const MAX_TOKENS = 3000;      // 预留空间给 Prompt 其他部分
  const BASE_MAX_TABLES = 8;     // 基础上限
  const MIN_MAX_TABLES = 5;      // 最低上限
  
  const estimatedTokens = estimateSchemaTokens(candidateTables);
  
  if (estimatedTokens > MAX_TOKENS) {
    // Token 紧张时减少表数量
    const ratio = MAX_TOKENS / estimatedTokens;
    const adjusted = Math.floor(BASE_MAX_TABLES * ratio);
    return Math.max(adjusted, MIN_MAX_TABLES);
  }
  
  return BASE_MAX_TABLES;
}
```

#### 4.3.3 使用方式

```javascript
// 动态调整表数量上限
const MAX_TABLES = calculateMaxTables(selectedTables);

if (selectedTables.length > MAX_TABLES) {
  logger.warn('[Schema选择] Token 预估超限，动态调整表数量', {
    estimatedTokens: estimateSchemaTokens(selectedTables),
    originalCount: selectedTables.length,
    adjustedMax: MAX_TABLES
  });
  selectedTables = selectedTables.slice(0, MAX_TABLES);
}
```

---

### Phase 4: 精简 Schema 保留关键元数据（已部分实现）

#### 4.4.1 当前状态检查

**已实现的优化：**
- ✅ `getTableSchemaDetailCompact` 已保留主键/外键标记（L883）
- ✅ 关键字段白名单机制（L844）

#### 4.4.2 建议增强

```javascript
// 在 getTableSchemaDetailCompact 中增强外键提示
if (field.foreign_key) {
  const refTable = field.foreign_key.split('.')[0];
  tags.push(`外键:${field.foreign_key}`);
  
  // 【增强】添加关联表提示，帮助 LLM 理解 JOIN 关系
  if (!tableNames.includes(refTable)) {
    tags.push(`关联表未选:${refTable}`);
  }
}
```

---

## 五、实施计划

| 阶段 | 优化项 | 优先级 | 预估工作量 | 状态 |
|------|--------|--------|-----------|------|
| Phase 1 | 核心表保护 + 放宽至 8 张 | P0 | 30min | ✅ 已完成 |
| Phase 2 | 语义权重排序 | P1 | 2h | ✅ 已完成 |
| Phase 3 | Token 感知动态调整 | P2 | 1h | ✅ 已完成 |
| Phase 4 | 外键关联提示增强 | P3 | 30min | ✅ 已完成 |

---

## 六、验证方案

### 6.1 回归测试用例

| 用例编号 | 查询场景 | 预期结果 |
|----------|----------|----------|
| TC-001 | "查询近7天游戏内聊天用户" | 必须包含 `tzqingmu_log_game_user_chat` 表 |
| TC-002 | "注册且付费的用户" | 必须包含 `tzpingtai_tz_sdk_log_pf_reg` 和 `tzpingtai_tz_sdk_log_pf_order` |
| TC-003 | "活跃用户留存" | 必须包含 `tzpingtai_tz_sdk_log_pf_login` |
| TC-004 | 涉及6+维度的复杂查询 | 三张核心表均不被截断 |

### 6.2 监控指标

```javascript
// 在表选择完成后记录关键指标
logger.info('[Schema选择] 决策完成', {
  query: intent.original_query,
  coreTablesIncluded: CORE_TABLES.filter(t => tableNames.includes(t)),
  totalTables: tableNames.length,
  estimatedTokens: estimateSchemaTokens(tableNames),
  tables: tableNames
});
```

---

## 七、相关文件

| 文件路径 | 说明 |
|----------|------|
| `backend/src/core/nl2sqlEngine.js` | 核心修改文件，表选择逻辑 |
| `backend/src/core/schemaLoader.js` | Schema 加载模块，提供 `getTableSchemaDetailCompact` |
| `backend/config/schema-metadata.json` | 表结构元数据配置 |

---

## 八、附录

### 8.1 核心表选择依据

```
tzpingtai_tz_sdk_log_pf_reg
├── 业务含义：用户注册行为记录
├── 关键字段：tz_account_id, create_time, channel_id, game_id
└── 关联场景：新增用户、渠道质量、注册转化

tzpingtai_tz_sdk_log_pf_login
├── 业务含义：用户登录行为记录
├── 关键字段：tz_account_id, login_time, online_time
└── 关联场景：DAU/MAU、留存分析、在线时长

tzpingtai_tz_sdk_log_pf_order
├── 业务含义：用户付费订单记录
├── 关键字段：tz_account_id, order_id, real_amount, pay_time
└── 关联场景：付费率、ARPPU、LTV、流水统计
```

### 8.2 修改记录

| 日期 | 修改内容 | 修改人 |
|------|----------|--------|
| 2026-04-16 | 实施 Phase 1：核心表保护机制 | Qoder |
| 2026-04-16 | 实施 Phase 2：语义权重排序 | Qoder |
| 2026-04-16 | 实施 Phase 3：Token 感知动态调整 | Qoder |
| 2026-04-16 | 实施 Phase 4：外键关联提示增强 | Qoder |

---

*文档版本：v1.0*
*最后更新：2026-04-16*
