# NL2SQL 复杂查询优化计划

## 文档信息
- **版本**: 1.1.0
- **创建日期**: 2026-04-16
- **更新日期**: 2026-04-16
- **目标**: 解决多维度复杂业务查询的表检索和意图识别问题
- **优先级**: P0
- **参考架构**: OpenClaw Agentic Workflow

---

## 1. 背景与问题分析

### 1.1 当前痛点

以以下真实业务查询为例：

```
帮我提取 game ID=67，老平台，用户圈选：
- 注册时间2025年7月10日截止2026年3月3日
- 行为圈选：历史累计充值金额≥2000元
- 在3月1日有过登录行为，但是3月2日和3月3日连续2日未登录的玩家

输出字段：
- 玩家账号ID，角色ID，账号累计充值金额，最后登录时间，最近十次游戏内发言记录
```

**核心挑战**：

| 挑战类型 | 具体问题 | 影响 |
|---------|---------|------|
| 多维度组合 | 同时涉及注册、充值、登录、发言四个维度 | 单阶段检索难以覆盖全部 |
| 业务语义鸿沟 | "老平台" → `new_tzpingtaiold` | 关键词/向量检索无法直接映射 |
| 计算逻辑歧义 | "累计充值"该用原始表还是汇总表 | 模型选择错误导致性能问题 |
| 时间逻辑复杂 | 特定日期有登录 + 连续日期未登录 | 需要理解行为序列 |
| 聚合+明细混合 | 累计金额(聚合) + 最近发言(明细) | 需要多表Join |

### 1.2 现有架构局限性

```
当前流程：
用户查询 → 向量检索Top-3表 → 意图识别 → SQL生成

问题：
1. 向量检索一次性进行，无法处理多维度需求
2. 缺乏业务语义层，"老平台"等概念无法识别
3. 没有澄清机制，检索置信度低时直接猜测
4. 意图识别阶段表信息不足或过多
5. 缺乏工具化能力，模型无法主动探索Schema
6. 无自我修正机制，出错后无法恢复
```

### 1.3 OpenClaw 架构启示

**OpenClaw 核心优势**：

| 特性 | OpenClaw 实现 | 当前差距 |
|------|--------------|---------|
| **动态上下文发现** | MCP协议 + Tool Use (`list_tables`, `get_schema`) | 硬编码Schema，无工具能力 |
| **多步推理链** | Plan → Act → Observe 循环 | 单阶段直接生成SQL |
| **按需索取** | Level 1索引 → Level 2详情 | 一次性加载全量Schema |
| **语义索引** | DDL + 历史SQL + 外键关系向量化 | 仅表结构向量化 |
| **自我修正** | 执行验证 → 错误分析 → 重新检索 | 无验证环节 |

**关键洞察**：
- 不在于Prompt多长，而在于**模型能否在不确定时主动探索**
- 不在于检索多快，而在于**能否基于反馈迭代优化**
- 不在于Schema多全，而在于**能否按需分层加载**

---

## 2. 优化目标

### 2.1 核心目标

1. **准确率提升**: 复杂查询表检索准确率从当前 ~60% 提升至 ~90%
2. **澄清率降低**: 不必要的澄清问题减少 50%
3. **响应速度**: 端到端延迟增加不超过 30%（引入多阶段）

### 2.2 成功指标

| 指标 | 当前值 | 目标值 | 测量方式 |
|------|--------|--------|---------|
| 复杂查询一次成功率 | 60% | 90% | 评估测试集 |
| 表检索准确率 | 70% | 95% | 人工标注 |
| 澄清轮数 | 1.5 | ≤1 | 生产日志 |
| 平均响应时间 | 3s | ≤4s | 监控数据 |

---

## 3. 四阶段优化方案（融合OpenClaw思想）

### 架构升级总览

```
┌─────────────────────────────────────────────────────────────────┐
│                    Agentic NL2SQL Engine                        │
├─────────────────────────────────────────────────────────────────┤
│  Phase 1: 工具化Schema探索 (Tool-Augmented Schema Discovery)   │
│  Phase 2: 动态意图拆解 (Dynamic Intent Decomposition)          │
│  Phase 3: 业务语义层 (Business Semantic Layer)                 │
│  Phase 4: 多步推理与自我修正 (Multi-step Reasoning & Recovery) │
└─────────────────────────────────────────────────────────────────┘
```

---

### Phase 1: 工具化Schema探索（Week 1）

**核心思想**：赋予LLM工具调用能力，实现"按需索取"而非"一次性灌输"

#### 3.1.1 目标
- 实现分层Schema加载（Level 1索引 → Level 2详情）
- 让模型能在不确定时主动探索表结构
- 将Prompt从5万字符降至可控范围

#### 3.1.2 技术方案

**Level 1 索引（极简）**：
```javascript
// 仅包含表名+业务注释，用于初步筛选
const level1Index = [
  { name: "tzpingtai_tz_sdk_log_pf_reg", comment: "平台注册表-用户来源" },
  { name: "tzpingtai_tz_sdk_log_pf_order", comment: "平台订单表-充值付费" },
  { name: "tzqingmu_log_game_user_chat", comment: "游戏聊天表-玩家发言" }
];
// 总大小: ~3KB (vs 原50KB)
```

**Level 2 详情（按需加载）**：
```javascript
// 工具函数：模型可调用的Schema探索工具
const schemaTools = {
  // 工具1: 搜索表（关键词匹配）
  search_tables: async (keyword) => {
    return await schemaLoader.searchRelevantTables(keyword, 5);
  },
  
  // 工具2: 获取表详情
  describe_table: async (tableName) => {
    return await schemaLoader.getTableSchemaDetailCompact([tableName]);
  },
  
  // 工具3: 查询业务知识库
  search_knowledge: async (concept) => {
    return await semanticLayer.matchConcepts(concept);
  },
  
  // 工具4: 获取表样例数据
  peek_table: async (tableName, limit = 3) => {
    return await database.query(`SELECT * FROM ${tableName} LIMIT ${limit}`);
  }
};
```

**工具化Prompt设计**：
```javascript
const toolAugmentedPrompt = `你是一位数据分析专家，负责将自然语言查询转换为SQL。

## 可用工具
你有以下工具可以探索数据库结构：

1. search_tables(keyword: string) -> Table[]
   用途：根据关键词搜索相关表
   示例：search_tables("注册") -> [{name: "pf_reg", comment: "..."}]

2. describe_table(tableName: string) -> SchemaDetail
   用途：获取指定表的详细字段信息
   示例：describe_table("pf_reg") -> {fields: [...]}

3. search_knowledge(concept: string) -> ConceptMapping[]
   用途：查询业务概念的定义和映射
   示例：search_knowledge("老平台") -> {datasource: "new_tzpingtaiold"}

4. peek_table(tableName: string, limit: number) -> Row[]
   用途：查看表的前N行样例数据
   示例：peek_table("pf_reg", 3) -> [{...}]

## 工作方式
1. 先使用 search_tables 找到可能相关的表
2. 对不确定的表，使用 describe_table 或 peek_table 验证
3. 遇到业务术语（如"老平台"），使用 search_knowledge 查询映射
4. 确认所有需要的表后，生成SQL

## 当前查询
"${userQuery}"

请按以下格式响应：
{
  "thought": "分析过程：我需要找哪些表？",
  "tool_calls": [
    {"tool": "search_tables", "args": {"keyword": "注册"}}
  ],
  "selected_tables": ["表名1", "表名2"],
  "sql": "SELECT ..."
}`;
```

#### 3.1.3 实现步骤

1. **创建工具层** (`src/core/schemaTools.js`)
   - 封装4个Schema探索工具
   - 实现工具调用解析器
   - 添加工具执行日志

2. **修改LLM调用方式**
   - 从单次调用改为"调用-观察-再调用"循环
   - 支持模型输出工具调用请求
   - 执行工具并返回结果给模型

3. **分层Schema加载**
   - Level 1: 始终加载（极小）
   - Level 2: 按需加载（工具调用触发）

#### 3.1.4 预期效果

| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| 初始Prompt大小 | 50KB | 3KB |
| Schema加载方式 | 全量 | 按需 |
| 模型探索能力 | 无 | 有 |

---

### Phase 2: 动态意图拆解（Week 1-2）

#### 3.1.1 目标
实现查询的自动分解，将复杂查询拆解为可独立检索的"数据需求单元"

#### 3.1.2 技术方案

**核心函数**: `decomposeQueryDynamically(userQuery, context)`

```javascript
// 输入示例
"查询青木游戏老平台3月1日注册且累计充值2000以上的玩家"

// 输出结构
{
  "primaryEntity": "玩家",
  "dataUnits": [
    {
      "type": "基础属性筛选",
      "description": "game_id=67, 老平台",
      "keywords": ["game_id", "平台"],
      "filters": [{"field": "game_id", "value": "67"}]
    },
    {
      "type": "时间范围筛选", 
      "description": "注册时间2025-07-10至2026-03-03",
      "keywords": ["注册", "时间"],
      "timeRange": {"start": "2025-07-10", "end": "2026-03-03"}
    },
    {
      "type": "聚合指标筛选",
      "description": "累计充值金额≥2000",
      "keywords": ["充值", "累计", "金额"],
      "metric": "累计充值",
      "operator": ">=",
      "value": "2000"
    }
  ]
}
```

**实现步骤**：

1. **创建分解模块** (`src/core/queryDecomposer.js`)
   - 使用 LLM 进行轻量级意图拆解
   - Prompt 模板设计（不限制子意图类型）
   - JSON 输出解析和验证

2. **集成到意图识别流程**
   - 修改 `analyzeIntent` 函数
   - 在向量检索前调用分解器
   - 为每个 dataUnit 独立检索表

3. **表候选合并策略**
   - 覆盖多数据单元的表优先（Join友好）
   - 按置信度排序
   - 保留 Top-5 候选表

#### 3.1.3 关键代码结构

```
backend/src/core/
├── queryDecomposer.js          # 新增：查询分解器
│   ├── decomposeQueryDynamically()
│   ├── validateDecomposition()
│   └── buildDecompositionPrompt()
├── tableRetriever.js           # 新增：基于分解结果的表检索
│   ├── retrieveByDataUnits()
│   ├── mergeTableCandidates()
│   └── calculateTableScore()
└── nl2sqlEngine.js             # 修改：集成调用
    └── analyzeIntent()         # 调用分解器
```

#### 3.1.4 验收标准

- [ ] 复杂查询（≥3个筛选条件）能正确分解为数据单元
- [ ] 每个数据单元至少匹配到一个候选表
- [ ] 分解延迟 < 500ms

---

### Phase 2: 业务语义层（Week 2-3）

#### 3.2.1 目标
建立业务概念到物理表/字段的映射层，解决"老平台"、"累计充值"等业务语义识别问题

#### 3.2.2 技术方案

**配置文件**: `config/business-semantic-layer.json`

```json
{
  "version": "1.0.0",
  "concepts": {
    "老平台": {
      "aliases": ["旧平台", "老版本", "旧版本"],
      "description": "指平台标识为 old 的数据，对应 new_tzpingtaiold 数据库",
      "mappings": {
        "datasource": "new_tzpingtaiold",
        "platform_field": "platform_type",
        "platform_value": ["1", "2", "old"]
      },
      "priority": 1
    },
    "新平台": {
      "aliases": ["tzpingtai", "新系统"],
      "description": "指平台标识为 new 的数据",
      "mappings": {
        "datasource": "new_tzpingtai",
        "platform_field": "platform_type",
        "platform_value": ["0", "new"]
      }
    },
    "累计充值": {
      "aliases": ["累计付费", "总充值", "总付费"],
      "description": "玩家累计充值金额",
      "mappings": {
        "primary_table": "tzpingtai_tz_sdk_log_pf_order_summary",
        "fallback_table": "tzpingtai_tz_sdk_log_pf_order",
        "aggregation": "SUM(real_amount)",
        "field": "total_pay_amount",
        "preferred_source": "summary_table"
      }
    },
    "注册": {
      "aliases": ["新增", "首入", "signup"],
      "description": "用户在平台的注册行为",
      "mappings": {
        "primary_table": "tzpingtai_tz_sdk_log_pf_reg",
        "key_fields": ["create_time", "tz_account_id", "game_id"]
      }
    },
    "登录": {
      "aliases": ["活跃", "在线", "login", "active"],
      "description": "用户登录行为",
      "mappings": {
        "platform_table": "tzpingtai_tz_sdk_log_pf_login",
        "game_table": "tzpingtai_tz_sdk_log_game_act"
      }
    }
  },
  "query_patterns": {
    "玩家筛选+行为分析": {
      "description": "筛选符合条件的玩家并分析其行为",
      "required_concepts": ["注册"],
      "optional_concepts": ["登录", "充值", "发言"],
      "typical_tables": ["reg", "login", "order", "chat"],
      "join_keys": ["tz_account_id", "role_id", "game_id"]
    }
  }
}
```

**实现步骤**：

1. **创建语义层模块** (`src/core/semanticLayer.js`)
   - 加载和解析语义层配置
   - 业务概念匹配函数
   - 表推荐函数

2. **集成到检索流程**
   - 在 `decomposeQueryDynamically` 后调用语义匹配
   - 为匹配到的概念添加权重
   - 影响表候选排序

3. **动态表推荐**
   - 基于概念组合推荐表
   - 处理概念冲突（如同时提到"注册"和"登录"）

#### 3.2.3 关键代码结构

```javascript
// src/core/semanticLayer.js

class SemanticLayer {
  constructor(configPath) {
    this.concepts = this.loadConcepts(configPath);
  }

  // 匹配查询中的业务概念
  matchConcepts(userQuery) {
    const matched = [];
    for (const [name, config] of Object.entries(this.concepts)) {
      const score = this.calculateMatchScore(userQuery, config);
      if (score > 0.7) {
        matched.push({ name, score, config });
      }
    }
    return matched.sort((a, b) => b.score - a.score);
  }

  // 基于概念推荐表
  recommendTables(matchedConcepts) {
    const recommendations = new Map();
    
    for (const concept of matchedConcepts) {
      const tables = concept.config.mappings;
      for (const [key, tableName] of Object.entries(tables)) {
        if (key.includes('table')) {
          recommendations.set(tableName, {
            reason: concept.name,
            priority: concept.config.priority
          });
        }
      }
    }
    
    return recommendations;
  }
}
```

#### 3.2.4 验收标准

- [ ] "老平台"正确映射到 `new_tzpingtaiold` 相关表
- [ ] "累计充值"优先推荐汇总表而非原始表
- [ ] 支持别名识别（如"总付费"也能识别）

---

### Phase 3: 完善澄清机制（Week 3-4）

#### 3.3.1 目标
当检索置信度不足时，主动询问用户，避免盲目猜测

#### 3.3.2 技术方案

**触发澄清的场景**：

```javascript
// src/core/clarificationEngine.js

const CLARIFICATION_TRIGGERS = {
  // 场景1：关键数据单元无匹配表
  UNCOVERED_DATA_UNIT: {
    check: (decomposition, tableCandidates) => {
      return decomposition.dataUnits.some(unit => 
        !tableCandidates.some(t => t.covers.includes(unit.type))
      );
    },
    priority: 'HIGH',
    message: '以下数据需求无法匹配到具体表：{units}'
  },

  // 场景2：同类型数据匹配到多个表（歧义）
  TABLE_AMBIGUITY: {
    check: (decomposition, tableCandidates) => {
      const typeToTables = new Map();
      for (const candidate of tableCandidates) {
        for (const cover of candidate.covers) {
          if (!typeToTables.has(cover)) typeToTables.set(cover, []);
          typeToTables.get(cover).push(candidate.name);
        }
      }
      return [...typeToTables.entries()].filter(([_, tables]) => tables.length > 1);
    },
    priority: 'MEDIUM',
    message: '{dataType}可能来自以下表，请选择：{tables}'
  },

  // 场景3：聚合指标来源不明确
  AGGREGATION_SOURCE_UNCERTAIN: {
    check: (decomposition, tableCandidates) => {
      const aggUnits = decomposition.dataUnits.filter(u => u.type === '聚合指标');
      return aggUnits.some(unit => {
        const candidates = tableCandidates.filter(t => 
          t.covers.includes(unit.type)
        );
        // 同时存在原始表和汇总表
        const hasRaw = candidates.some(t => t.name.includes('log'));
        const hasSummary = candidates.some(t => 
          t.name.includes('summary') || t.name.includes('stat')
        );
        return hasRaw && hasSummary;
      });
    },
    priority: 'LOW',
    message: '请问"{metric}"需要实时计算还是使用预汇总数据？'
  },

  // 场景4：时间粒度不明确
  TIME_GRANULARITY_UNCERTAIN: {
    check: (decomposition) => {
      return decomposition.dataUnits.some(unit => 
        unit.type === '时间范围筛选' && 
        !unit.timeRange?.granularity
      );
    },
    priority: 'LOW',
    message: '时间统计维度需要按天、周还是月？'
  }
};
```

**澄清问题生成策略**：

```javascript
async function generateClarification(decomposition, tableCandidates, trigger) {
  const clarificationPrompt = `基于以下查询分析结果，生成友好的澄清问题：

原始查询："${decomposition.originalQuery}"

识别到的数据需求：
${decomposition.dataUnits.map(u => `- ${u.type}: ${u.description}`).join('\n')}

候选表：
${tableCandidates.map(t => `- ${t.name} (匹配: ${t.covers.join(', ')})`).join('\n')}

触发澄清的原因：${trigger.reason}

请生成：
1. 一个友好的澄清问题
2. 2-4个选项（如果适用）
3. 默认推荐（基于最可能的意图）

返回JSON格式：
{
  "question": "...",
  "options": ["选项1", "选项2", ...],
  "defaultOption": "推荐选项",
  "clarificationType": "table_selection|metric_source|time_granularity"
}`;

  const response = await llmService.simpleChat('', clarificationPrompt);
  return parseJSONResponse(response);
}
```

#### 3.3.3 关键代码结构

```
backend/src/core/
├── clarificationEngine.js        # 新增：澄清引擎
│   ├── checkClarificationNeeded()
│   ├── generateClarification()
│   ├── applyClarificationResult()
│   └── CLARIFICATION_TRIGGERS
└── nl2sqlEngine.js               # 修改：集成澄清判断
    └── processQuery()
        ├── 调用 checkClarificationNeeded
        ├── 如需要则生成澄清问题
        └── 保存澄清上下文
```

#### 3.3.4 验收标准

- [ ] 表歧义时主动询问而非随机选择
- [ ] 澄清问题友好且包含推荐选项
- [ ] 用户回答后能正确继续流程
- [ ] 澄清准确率 > 95%

---

### Phase 4: 多步推理与自我修正（Week 3-4）

**核心思想**：借鉴 OpenClaw 的 Plan → Act → Observe 循环，实现自我验证和错误恢复

#### 3.4.1 目标
- 实现 SQL 生成前的结构验证
- 执行失败后的自动诊断和重试
- 错误驱动的表重新发现

#### 3.4.2 技术方案

**多步推理链 (Reasoning Loop)**：

```javascript
// src/core/agenticEngine.js

class AgenticNL2SQLEngine {
  async processQuery(userQuery, context) {
    // Step 1: Planning - 规划阶段
    const plan = await this.planningPhase(userQuery, context);
    
    // Step 2: Schema Discovery - 动态发现Schema
    const schemaContext = await this.schemaDiscoveryPhase(plan);
    
    // Step 3: SQL Generation - 生成SQL
    let sqlResult = await this.generationPhase(plan, schemaContext);
    
    // Step 4: Verification - 验证阶段（自我修正关键）
    const verification = await this.verificationPhase(sqlResult);
    
    // Step 5: Recovery - 如验证失败，进入恢复流程
    if (!verification.success) {
      sqlResult = await this.recoveryPhase(verification.error, plan, schemaContext);
    }
    
    return sqlResult;
  }

  // 规划阶段：拆解任务
  async planningPhase(userQuery, context) {
    const planningPrompt = `分析以下查询，制定执行计划：

查询: "${userQuery}"

请输出：
1. 需要查询哪些数据实体？
2. 涉及哪些筛选条件？
3. 需要哪些聚合或计算？
4. 潜在的风险点（如歧义、缺失信息）

返回JSON格式：
{
  "entities": ["玩家", "充值记录"],
  "filters": [{"field": "game_id", "value": "67"}],
  "aggregations": ["累计充值"],
  "risks": ["老平台需要确认数据源"],
  "estimatedComplexity": "high"
}`;

    const response = await llmService.simpleChat('', planningPrompt);
    return parseJSONResponse(response);
  }

  // 验证阶段：执行前验证SQL结构
  async verificationPhase(sqlResult) {
    const checks = [];
    
    // Check 1: 语法验证（使用 SQL Parser）
    try {
      const parsed = sqlParser.parse(sqlResult.sql);
      checks.push({ type: 'syntax', passed: true });
    } catch (e) {
      checks.push({ type: 'syntax', passed: false, error: e.message });
    }
    
    // Check 2: 表存在性验证
    const tables = this.extractTablesFromSQL(sqlResult.sql);
    for (const table of tables) {
      const exists = await schemaLoader.getTable(table);
      checks.push({ 
        type: 'table_exists', 
        table, 
        passed: !!exists 
      });
    }
    
    // Check 3: 字段存在性验证
    const fields = this.extractFieldsFromSQL(sqlResult.sql);
    // ... 验证逻辑
    
    // Check 4: 执行计划验证（轻量级）
    try {
      await database.query(`EXPLAIN ${sqlResult.sql}`);
      checks.push({ type: 'explain', passed: true });
    } catch (e) {
      checks.push({ type: 'explain', passed: false, error: e.message });
    }
    
    const allPassed = checks.every(c => c.passed);
    return {
      success: allPassed,
      checks,
      error: allPassed ? null : this.summarizeErrors(checks)
    };
  }

  // 恢复阶段：错误诊断和重试
  async recoveryPhase(error, plan, schemaContext) {
    logger.info('进入恢复流程', { error: error.message });
    
    // 诊断错误类型
    const errorType = this.classifyError(error);
    
    switch (errorType) {
      case 'TABLE_NOT_FOUND':
        // 重新搜索表
        return await this.handleTableNotFound(error, plan, schemaContext);
        
      case 'COLUMN_NOT_FOUND':
        // 重新获取表结构
        return await this.handleColumnNotFound(error, plan, schemaContext);
        
      case 'SYNTAX_ERROR':
        // 请求LLM修正SQL
        return await this.handleSyntaxError(error, plan, schemaContext);
        
      case 'PERFORMANCE_RISK':
        // 优化SQL（如添加索引提示）
        return await this.handlePerformanceRisk(error, plan, schemaContext);
        
      default:
        // 无法自动恢复，返回错误
        throw new Error(`无法自动恢复: ${error.message}`);
    }
  }

  // 处理表不存在错误
  async handleTableNotFound(error, plan, schemaContext) {
    const missingTable = this.extractTableFromError(error);
    
    // 重新搜索替代表
    const alternatives = await schemaLoader.searchRelevantTables(
      missingTable, 
      3
    );
    
    // 请求LLM使用替代表重写SQL
    const recoveryPrompt = `原SQL中表 "${missingTable}" 不存在。

可能的替代表：
${alternatives.map(t => `- ${t.name}: ${t.description}`).join('\n')}

请使用替代表重写SQL，保持原查询逻辑不变。

原SQL: ${schemaContext.lastSQL}

返回新SQL和使用的表名。`;

    const response = await llmService.simpleChat('', recoveryPrompt);
    return parseJSONResponse(response);
  }
}
```

**自我修正触发条件**：

```javascript
const RECOVERY_TRIGGERS = {
  // 触发1: 表不存在
  TABLE_NOT_FOUND: {
    pattern: /Table .* doesn't exist|Unknown table/i,
    action: 'RESEARCH_TABLE',
    maxRetries: 2
  },
  
  // 触发2: 字段不存在
  COLUMN_NOT_FOUND: {
    pattern: /Unknown column|Invalid column name/i,
    action: 'RESEARCH_COLUMN',
    maxRetries: 2
  },
  
  // 触发3: 语法错误
  SYNTAX_ERROR: {
    pattern: /Syntax error|Parse error/i,
    action: 'REGENERATE_SQL',
    maxRetries: 1
  },
  
  // 触发4: 性能警告（执行时间过长）
  PERFORMANCE_RISK: {
    pattern: /Query timeout|Too many rows/i,
    action: 'OPTIMIZE_SQL',
    maxRetries: 1
  }
};
```

#### 3.4.3 关键代码结构

```
backend/src/core/
├── agenticEngine.js              # 新增：Agentic引擎主类
│   ├── planningPhase()           # 规划阶段
│   ├── schemaDiscoveryPhase()    # Schema发现阶段
│   ├── generationPhase()         # SQL生成阶段
│   ├── verificationPhase()       # 验证阶段
│   └── recoveryPhase()           # 恢复阶段
├── errorClassifier.js            # 新增：错误分类器
│   ├── classifyError()
│   └── RECOVERY_TRIGGERS
└── recoveryStrategies/           # 新增：恢复策略目录
    ├── tableNotFoundRecovery.js
    ├── columnNotFoundRecovery.js
    ├── syntaxErrorRecovery.js
    └── performanceOptimization.js
```

#### 3.4.4 预期效果

| 场景 | 优化前 | 优化后 |
|------|--------|--------|
| 表不存在错误 | 直接失败 | 自动搜索替代表并重试 |
| 字段不存在 | 直接失败 | 重新获取表结构并重试 |
| 语法错误 | 直接失败 | LLM自动修正 |
| 复杂查询成功率 | 60% | 85%+ |

---

## 4. 整合流程（四阶段完整版）

### 4.1 新流程架构

### 4.1 新流程架构（Agentic Workflow）

```
用户查询
    ↓
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: Planning + Tool-Augmented Schema Discovery        │
│ - LLM规划任务步骤                                           │
│ - 工具调用探索Schema（search_tables/describe_table）       │
│ - Level 1索引 → Level 2详情（按需加载）                     │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ Phase 2: Dynamic Intent Decomposition                       │
│ - 拆解为数据需求单元（Data Units）                          │
│ - 语义层匹配（老平台 → new_tzpingtaiold）                   │
│ - 每个Unit独立检索相关表                                    │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ Phase 3: Clarification + Confirmation                       │
│ - 检查检索置信度                                            │
│ - 低置信度时主动澄清（表歧义、指标来源等）                  │
│ - 高置信度时继续                                            │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│ Phase 4: Generation + Verification + Recovery               │
│ - 生成SQL                                                   │
│ - 验证SQL（语法、表存在性、执行计划）                       │
│ - 验证失败时自动恢复（搜索替代表、修正语法）                │
│ - 成功后返回结果                                            │
└─────────────────────────────────────────────────────────────┘
    ↓
返回结果
```

### 4.2 与OpenClaw架构对比

| 能力 | OpenClaw | 本方案（四阶段） |
|------|----------|-----------------|
| MCP/Tool Use | ✅ 完整协议 | ✅ 4个核心工具 |
| 动态Schema发现 | ✅ 按需加载 | ✅ Level 1→2分层 |
| 多步推理 | ✅ Plan→Act→Observe | ✅ Planning→Discovery→Generation→Verification |
| 自我修正 | ✅ 错误恢复 | ✅ Recovery Phase |
| 语义索引 | ✅ DDL+历史SQL | ✅ 业务语义层+向量检索 |
| 澄清机制 | ✅ 主动询问 | ✅ 置信度驱动澄清 |

**核心差异**：本方案在保持OpenClaw核心思想的同时，针对游戏运营数据场景做了简化，更易在现有架构上落地。

### 4.3 数据流图（Agentic版本）

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           USER QUERY                                    │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 1: Planning + Tool-Augmented Discovery                           │
│  ┌──────────────┐    ┌─────────────────────┐    ┌──────────────────┐   │
│  │ LLM Planning │───→│ Tool: search_tables │───→│ Level 1 Index    │   │
│  └──────────────┘    └─────────────────────┘    └──────────────────┘   │
│         ↓                                               ↓               │
│  ┌──────────────┐    ┌─────────────────────┐    ┌──────────────────┐   │
│  │ Task Steps   │←───│ Tool: describe_table│←───│ Level 2 Detail   │   │
│  │              │    │ (按需调用)          │    │ (按需加载)       │   │
│  └──────────────┘    └─────────────────────┘    └──────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 2: Dynamic Intent Decomposition                                  │
│  ┌─────────────────┐    ┌──────────────────┐    ┌──────────────────┐   │
│  │ Query           │───→│ Data Units       │───→│ Per-Unit         │   │
│  │ Decomposer      │    │ Extraction       │    │ Table Retrieval  │   │
│  └─────────────────┘    └──────────────────┘    └──────────────────┘   │
│         ↓                      ↓                        ↓               │
│  ┌─────────────────┐    ┌──────────────────┐    ┌──────────────────┐   │
│  │ Semantic Layer  │←───│ Concept Matching │←───│ Vector + Keyword │   │
│  │ (老平台→表映射) │    │ (业务术语识别)   │    │ Hybrid Search    │   │
│  └─────────────────┘    └──────────────────┘    └──────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 3: Clarification Engine                                          │
│  ┌─────────────────┐    ┌──────────────────┐    ┌──────────────────┐   │
│  │ Confidence      │───→│ Trigger          │───→│ Generate         │   │
│  │ Assessment      │    │ Clarification?   │    │ Question         │   │
│  └─────────────────┘    └──────────────────┘    └──────────────────┘   │
│         ↓ (高置信度)           ↓ (低置信度)                             │
│  ┌─────────────────┐           ↓ (用户回答后)   ┌──────────────────┐   │
│  │ Continue to     │←───────────────────────────│ Apply Answer     │   │
│  │ Phase 4         │                            │ Update Context   │   │
│  └─────────────────┘                            └──────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 4: Generation + Verification + Recovery                          │
│  ┌─────────────────┐    ┌──────────────────┐    ┌──────────────────┐   │
│  │ SQL Generation  │───→│ Verification     │───→│ Success?         │   │
│  │ (with context)  │    │ (语法/表/字段)   │    │                  │   │
│  └─────────────────┘    └──────────────────┘    └──────────────────┘   │
│         ↑ (重试)                 ↓ (失败)              ↓ (成功)        │
│  ┌─────────────────┐    ┌──────────────────┐    ┌──────────────────┐   │
│  │ Recovery        │←───│ Error            │    │ Return Result    │   │
│  │ (搜索替代表/    │    │ Classification   │    │                  │   │
│  │  修正语法)      │    │                  │    │                  │   │
│  └─────────────────┘    └──────────────────┘    └──────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 5. 实施计划（四阶段版）

### 5.1 时间线

| 周次 | 阶段 | 主要任务 | 交付物 | 关键里程碑 |
|------|------|---------|--------|-----------|
| Week 1 | Phase 1 | 创建 schemaTools.js（4个工具） | 工具层模块 | ✅ Prompt从50KB→3KB |
| Week 1 | Phase 1 | 实现 Level 1/2 分层加载 | 分层Schema加载 | |
| Week 1 | Phase 1 | 修改 LLM 调用为工具循环 | Tool-Augmented Prompt | |
| Week 2 | Phase 2 | 实现 queryDecomposer.js | 分解器模块 | |
| Week 2 | Phase 2 | 创建 semantic-layer.json | 业务语义配置 | ✅ "老平台"等业务概念可识别 |
| Week 2 | Phase 2 | 实现 semanticLayer.js | 语义层模块 | |
| Week 3 | Phase 3 | 实现 clarificationEngine.js | 澄清引擎 | ✅ 歧义时主动询问 |
| Week 3 | Phase 3 | 置信度评估算法 | 置信度计算 | |
| Week 4 | Phase 4 | 实现 agenticEngine.js | Agentic引擎 | ✅ 自我修正能力 |
| Week 4 | Phase 4 | 错误分类与恢复策略 | Recovery模块 | |
| Week 4 | - | 端到端集成测试 | 完整流程 | ✅ 复杂查询成功率85%+ |

### 5.2 风险评估

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|---------|
| LLM分解延迟过高 | 中 | 高 | 添加缓存、优化Prompt |
| 语义层配置维护成本 | 中 | 中 | 设计自动化更新机制 |
| 澄清过多影响体验 | 低 | 高 | 调低触发阈值、智能推荐 |
| 与现有功能冲突 | 低 | 高 | 充分回归测试 |

### 5.3 回滚策略

1. **Feature Flag 控制**：每个Phase独立开关
   ```javascript
   // config/feature-flags.js
   module.exports = {
     TOOL_AUGMENTED_SCHEMA: true,    // Phase 1
     DYNAMIC_INTENT_DECOMPOSITION: true,  // Phase 2
     CLARIFICATION_ENGINE: true,     // Phase 3
     AGENTIC_RECOVERY: true          // Phase 4
   };
   ```

2. **渐进式启用**：
   - Week 1: 仅内部测试启用Phase 1
   - Week 2: 小流量启用Phase 1-2
   - Week 3: 逐步启用Phase 3
   - Week 4: 全量启用所有Phase

3. **快速回滚**：配置热更新，发现问题5分钟内回滚

### 5.4 与现有架构兼容

```
现有流程                    新流程（可切换）
───────────                ───────────────
processQuery               processQuery
     ↓                           ↓
analyzeIntent    ──────→   agenticEngine.process
     ↓                           ↓
generateSQL                (内部四阶段)
     ↓                           ↓
executeSQL                      executeSQL
     ↓                           ↓
return                          return
```

**关键设计**：`nl2sqlEngine.js` 作为入口，根据Feature Flag决定调用旧流程或新Agentic流程

---

## 6. 评估方案

### 6.1 测试集构建

构建包含以下类型的测试用例：

```yaml
complex_queries:
  - id: CQ001
    query: "查询青木游戏老平台3月1日注册且累计充值2000以上的玩家"
    expected_tables:
      - new_tzqingmu_role
      - new_tzpingtaiold_pf_reg
      - new_tzpingtaiold_pf_order
    difficulty: medium
    
  - id: CQ002
    query: "帮我提取 game ID=67，老平台，注册时间2025年7月10日截止2026年3月3日，历史累计充值金额≥2000元，在3月1日有过登录行为，但是3月2日和3月3日连续2日未登录的玩家"
    expected_tables:
      - new_tzpingtaiold_pf_reg
      - new_tzpingtaiold_pf_order_summary
      - new_tzpingtaiold_pf_login
      - new_tzqingmu_chat_log
    difficulty: hard
    
  - id: CQ003
    query: "最近7天新注册玩家的留存率"
    expected_tables:
      - new_tzpingtai_pf_reg
      - new_tzpingtai_pf_login
    difficulty: easy
```

### 6.2 评估指标

```javascript
// 评估脚本
function evaluateComplexQuery(query, result) {
  return {
    // 表检索准确率
    tablePrecision: result.correctTables / result.retrievedTables,
    tableRecall: result.correctTables / result.expectedTables,
    tableF1: calculateF1(tablePrecision, tableRecall),
    
    // 澄清质量
    clarificationNeeded: result.clarificationTriggered,
    clarificationAccuracy: result.correctClarification / result.totalClarification,
    
    // 端到端成功率
    sqlExecutionSuccess: result.sqlExecuted,
    resultCorrectness: result.resultMatchesExpected
  };
}
```

---

## 7. 附录

### 7.1 相关文件

| 文件 | 说明 | Phase |
|------|------|-------|
| `backend/src/core/schemaTools.js` | Schema探索工具（4个工具） | Phase 1 |
| `backend/src/core/queryDecomposer.js` | 查询分解器 | Phase 2 |
| `backend/src/core/semanticLayer.js` | 语义层模块 | Phase 2 |
| `backend/src/core/tableRetriever.js` | 表检索器 | Phase 2 |
| `backend/src/core/clarificationEngine.js` | 澄清引擎 | Phase 3 |
| `backend/src/core/agenticEngine.js` | Agentic引擎主类 | Phase 4 |
| `backend/src/core/errorClassifier.js` | 错误分类器 | Phase 4 |
| `backend/src/core/recoveryStrategies/` | 恢复策略目录 | Phase 4 |
| `backend/config/business-semantic-layer.json` | 业务语义配置 | Phase 2 |
| `backend/config/feature-flags.js` | 功能开关配置 | All |
| `backend/src/core/nl2sqlEngine.js` | 引擎主文件（入口） | All |

### 7.2 参考文档

- [向量检索优化计划](./向量检索优化计划.md)
- [记忆系统优化计划](./记忆系统优化计划.md)
- [NL2SQL-进度追踪](./NL2SQL-进度追踪.md)

---

## 8. 决策记录

| 日期 | 决策 | 原因 | 替代方案 |
|------|------|------|---------|
| 2026-04-16 | 四阶段实施 | 融合OpenClaw思想，系统化升级 | 三阶段（缺少工具化） |
| 2026-04-16 | Tool-Augmented Schema | 解决50KB Prompt问题，实现按需加载 | 静态分层（不够灵活） |
| 2026-04-16 | 动态意图拆解 | 适应任意复杂查询，不预设模板 | 固定子意图模板 |
| 2026-04-16 | 业务语义层配置 | 解决"老平台"等业务概念映射 | 纯向量检索 |
| 2026-04-16 | Agentic Recovery | 实现自我修正，提升成功率 | 失败即终止 |
| 2026-04-16 | Feature Flag控制 | 渐进式上线，降低风险 | 全量发布 |

---

## 9. 快速开始（Phase 1 预览）

### 9.1 立即获得的效果

实施Phase 1后，您的查询处理将变为：

```
用户: "查询青木游戏老平台3月1日注册的玩家"

处理流程:
1. LLM接收3KB的Level 1索引（而非50KB全量Schema）
2. LLM调用工具: search_tables("青木") 
   → 返回 [new_tzqingmu_role, new_tzqingmu_reg]
3. LLM调用工具: search_knowledge("老平台")
   → 返回 {datasource: "new_tzpingtaiold"}
4. LLM调用工具: describe_table("new_tzqingmu_reg")
   → 返回该表详细字段
5. LLM生成SQL（基于精确获取的Schema）

Prompt大小: 3KB → 按需加载后约5KB（可控）
```

### 9.2 下一步行动

**选项A**: 立即开始Phase 1实施（推荐）
- 创建 `schemaTools.js`
- 实现4个核心工具
- 修改LLM调用为工具循环
- **预期时间**: 2-3天
- **预期效果**: Prompt大小降至3KB

**选项B**: 先进行技术验证
- 编写概念验证代码（PoC）
- 验证工具调用流程可行性
- 评估延迟影响

**选项C**: 调整优先级
- 根据业务紧急程度调整Phase顺序
- 例如：优先实施Phase 3澄清机制

---

## 10. 总结

### 核心改进

| 维度 | 当前状态 | 优化后（四阶段） |
|------|---------|-----------------|
| **Prompt大小** | 50KB（不可控） | 3KB起步，按需加载（可控） |
| **Schema发现** | 静态预加载 | 动态工具调用 |
| **复杂查询** | 单阶段直接生成 | 多阶段拆解+验证 |
| **错误处理** | 失败即终止 | 自动诊断+恢复 |
| **业务概念** | 无法识别 | 语义层映射 |
| **表检索** | Top-3静态 | 多策略动态 |

### 与OpenClaw对标

本方案在以下方面达到OpenClaw同等能力：
- ✅ 工具化Schema探索
- ✅ 分层按需加载
- ✅ 多步推理链
- ✅ 自我修正恢复
- ✅ 业务语义层

同时针对游戏运营场景做了优化：
- 简化MCP协议，4个核心工具即可覆盖80%场景
- 保留现有向量检索投资，增量升级
- Feature Flag控制，渐进式上线

---

**文档状态**: 已完善（v1.1.0）  
**建议下一步**: 开始Phase 1实施  
**预计总工期**: 4周  
**预期收益**: 复杂查询成功率从60%→85%+

---

**文档状态**: 草案  
**下次评审**: Week 1 结束  
**负责人**: 待分配
