# NL2SQL长期记忆系统

<cite>
**本文档引用的文件**
- [longTermMemory.js](file://NL2SQL/backend/src/memory/longTermMemory.js)
- [vectorStore.js](file://NL2SQL/backend/src/memory/vectorStore.js)
- [summarizer.js](file://NL2SQL/backend/src/memory/summarizer.js)
- [memoryMaintenance.js](file://NL2SQL/backend/src/memory/memoryMaintenance.js)
- [nl2sqlEngine.js](file://NL2SQL/backend/src/core/nl2sqlEngine.js)
- [schemaLoader.js](file://NL2SQL/backend/src/core/schemaLoader.js)
- [database.js](file://NL2SQL/backend/src/core/database.js)
- [config.js](file://NL2SQL/backend/src/core/config.js)
- [app.js](file://NL2SQL/backend/src/app.js)
- [logger.js](file://NL2SQL/backend/src/utils/logger.js)
- [tokenBudget.js](file://NL2SQL/backend/src/utils/tokenBudget.js)
- [schema-metadata.json](file://NL2SQL/backend/config/schema-metadata.json)
- [package.json](file://NL2SQL/backend/package.json)
</cite>

## 更新摘要
**变更内容**
- 优化用户偏好管理，增强LLM智能分析功能，支持更精细的偏好提取
- 改进字段别名映射逻辑，新增datasource类型映射支持
- 增强游戏类型映射支持，优化平台术语学习机制
- 优化数据库访问模式，改进向量存储和查询历史管理

## 目录
1. [简介](#简介)
2. [项目结构](#项目结构)
3. [核心组件](#核心组件)
4. [架构概览](#架构概览)
5. [详细组件分析](#详细组件分析)
6. [依赖关系分析](#依赖关系分析)
7. [性能考虑](#性能考虑)
8. [故障排除指南](#故障排除指南)
9. [结论](#结论)

## 简介

NL2SQL长期记忆系统是一个基于三层记忆架构的智能数据查询系统，专门设计用于自然语言到SQL的转换。该系统通过机器学习和向量检索技术，实现了用户查询习惯的智能学习和长期记忆管理。

系统采用分层设计：
- **第一层：会话记忆** - 短期对话上下文
- **第二层：长期记忆** - 用户偏好和查询模式（本系统重点）
- **第三层：检索记忆** - 向量数据库中的语义检索

**更新** 系统现已新增智能对话摘要系统，能够自动压缩长时间对话历史，将早期对话压缩为摘要，保留近期对话原文。同时增强了向量存储功能，新增查询分类和重要性评分机制，支持更精细的查询管理和检索优化。

该系统能够智能识别用户的查询模式、字段别名、常用指标和维度偏好，并通过机器学习算法进行智能提炼和存储。

## 项目结构

NL2SQL系统采用模块化架构，主要分为以下几个核心模块：

```mermaid
graph TB
subgraph "后端核心模块"
A[应用入口 app.js]
B[配置管理 config.js]
C[数据库管理 database.js]
D[日志系统 logger.js]
E[Token预算管理 tokenBudget.js]
end
subgraph "核心引擎"
F[NL2SQL引擎 nl2sqlEngine.js]
G[Schema加载 schemaLoader.js]
end
subgraph "记忆系统"
H[长期记忆 longTermMemory.js]
I[向量存储 vectorStore.js]
J[对话摘要 summarizer.js]
K[记忆维护 memoryMaintenance.js]
end
subgraph "外部依赖"
L[LanceDB向量数据库]
M[SQLite数据库]
N[LLM服务]
end
A --> B
A --> C
A --> D
A --> E
A --> F
F --> G
F --> H
F --> J
H --> I
H --> C
I --> L
C --> M
F --> N
J --> N
```

**图表来源**
- [app.js:1-238](file://NL2SQL/backend/src/app.js#L1-L238)
- [config.js:1-377](file://NL2SQL/backend/src/core/config.js#L1-L377)

**章节来源**
- [app.js:1-238](file://NL2SQL/backend/src/app.js#L1-L238)
- [package.json:1-28](file://NL2SQL/backend/package.json#L1-L28)

## 核心组件

### 智能对话摘要模块

**新增** 智能对话摘要模块是系统的新功能，负责长对话历史的自动摘要和压缩，将早期对话压缩为摘要，保留近期对话原文。

#### 主要功能特性

1. **对话历史分割**：
   - 基于轮数阈值（默认8轮）触发摘要
   - 保留最近对话轮数（默认4轮）不参与摘要
   - 智能计算需要摘要和保留的消息数量

2. **LLM驱动摘要生成**：
   - 使用系统提示词指导摘要生成
   - 保留用户查询意图和关键需求
   - 保留已确认的重要信息（如game_id、时间范围等）
   - 保留用户偏好设置和业务规则

3. **智能压缩策略**：
   - 内存缓存机制，避免重复生成摘要
   - 增量更新摘要，支持新对话的融合
   - 基于轮数间隔的更新策略

4. **配置管理**：
   - 可配置的触发阈值、保留轮数、最大Token数
   - 环境变量支持，便于部署配置

**章节来源**
- [summarizer.js:1-518](file://NL2SQL/backend/src/memory/summarizer.js#L1-L518)

### 增强向量存储模块

**更新** 向量存储模块现已增强，新增查询分类和重要性评分机制，提供更精细的查询管理和检索优化。

#### 核心功能增强

1. **查询类型分类**：
   - 数据查询（DATA_QUERY）
   - 定义/解释查询（DEFINITION）
   - 对比查询（COMPARISON）
   - 趋势查询（TREND）
   - 澄清回复（CLARIFICATION）
   - 跟进查询（FOLLOW_UP）
   - 新话题（NEW_TOPIC）

2. **重要性评分机制**：
   - 基于意图复杂度、成功状态、维度指标数量等因素
   - 成功查询额外加分
   - 多维度、多指标查询更有价值
   - 高置信度查询加分
   - 上下文查询更有学习价值

3. **增强元数据构建**：
   - 计算查询重要性评分
   - 分类查询类型
   - 记录查询复杂度
   - 存储执行信息
   - 生成意图摘要

**章节来源**
- [vectorStore.js:1-759](file://NL2SQL/backend/src/memory/vectorStore.js#L1-L759)

### 长期记忆管理模块

长期记忆管理模块是系统的核心组件，负责用户长期记忆的提取、存储、检索和维护。该模块实现了智能筛选策略，确保只有有价值的查询模式才会被存储。

#### 主要功能特性

1. **智能筛选策略**：
   - 置信度阈值过滤（≥0.7）
   - 排除一次性查询
   - 高频模式识别（7天内≥2次）
   - 高价值模板识别（维度≥2且指标≥1）

2. **偏好类型分类**：
   - 查询模式（query_pattern）
   - 字段别名（field_alias）
   - 指标偏好（metric_preference）
   - 维度偏好（dimension_preference）

3. **LLM智能分析**：
   - 字段别名映射识别
   - 分析习惯提取
   - 业务逻辑定义识别
   - 通用知识过滤

**更新** 新增平台术语学习功能，支持用户对"新平台"/"老平台"等术语的个性化映射学习，特别增强了datasource类型的字段别名学习能力。

4. **即时学习功能**：
   - 从澄清轮中提取映射关系
   - 支持Markdown表格格式的游戏ID映射
   - 支持键值对格式的平台映射
   - 支持显式声明的映射关系

**章节来源**
- [longTermMemory.js:1-1141](file://NL2SQL/backend/src/memory/longTermMemory.js#L1-L1141)

### 记忆维护模块

记忆维护模块负责长期记忆的定期压缩、清理和维护，实现分级保留策略。

#### 分级保留策略

1. **高频偏好（≥10次）**：永久保留
2. **中频偏好（3-9次）**：90天未用则清理
3. **低频偏好（<3次）**：30天未用则清理
4. **字段别名**：365天未用则清理

#### 高级功能

1. **相似模式合并**：合并高度相似的查询模式
2. **记忆健康报告**：生成系统记忆使用统计
3. **自动清理机制**：定期清理过期记忆

**章节来源**
- [memoryMaintenance.js:1-415](file://NL2SQL/backend/src/memory/memoryMaintenance.js#L1-L415)

## 架构概览

NL2SQL长期记忆系统采用分层架构设计，各层之间职责清晰，耦合度低。

```mermaid
graph TB
subgraph "用户界面层"
UI[前端Vue应用]
end
subgraph "API网关层"
API[RESTful API]
SSE[SSE实时通信]
end
subgraph "业务逻辑层"
CORE[核心引擎]
MEM[记忆系统]
SCHEMA[Schema管理]
SUM[对话摘要]
end
subgraph "数据持久化层"
DB[SQLite数据库]
VDB[LanceDB向量库]
FS[文件系统]
end
subgraph "外部服务"
LLM[LLM服务]
DS[数据源]
end
UI --> API
API --> CORE
API --> MEM
API --> SCHEMA
CORE --> DB
CORE --> LLM
CORE --> SUM
MEM --> DB
MEM --> VDB
SCHEMA --> DB
SCHEMA --> VDB
CORE --> DS
MEM --> FS
SUM --> LLM
```

**图表来源**
- [app.js:78-158](file://NL2SQL/backend/src/app.js#L78-L158)
- [nl2sqlEngine.js:1-2492](file://NL2SQL/backend/src/core/nl2sqlEngine.js#L1-L2492)

系统架构特点：

1. **模块化设计**：每个组件都有明确的职责边界
2. **可扩展性**：支持插件式扩展和自定义工具
3. **容错性**：具备优雅降级和错误处理机制
4. **性能优化**：采用缓存、向量化等技术提升性能
5. **智能压缩**：对话历史自动压缩，优化上下文管理

## 详细组件分析

### NL2SQL核心引擎

**更新** NL2SQL核心引擎现已集成智能对话摘要功能，在处理长对话时自动进行历史压缩，优化上下文管理和性能。

#### 意图识别流程

```mermaid
sequenceDiagram
participant U as 用户
participant E as 引擎
participant S as 对话摘要
participant L as LLM服务
participant M as 长期记忆
participant V as 向量存储
participant D as 数据库
U->>E : 输入自然语言查询
E->>E : 检查对话轮数
E->>S : 智能压缩历史如需要
S-->>E : 返回压缩后的历史
E->>M : 加载用户偏好
E->>V : 获取Schema信息
E->>L : 分析查询意图
L-->>E : 返回意图分析结果
E->>E : 实体解析和映射
E->>D : 执行SQL查询
D-->>E : 返回查询结果
E->>U : 输出自然语言结果
E->>M : 存储查询偏好
```

**图表来源**
- [nl2sqlEngine.js:1865-1896](file://NL2SQL/backend/src/core/nl2sqlEngine.js#L1865-L1896)

#### 对话历史压缩流程

系统在对话轮数达到阈值时自动触发压缩：

1. **轮数检查**：检测当前对话轮数是否达到触发阈值（默认8轮）
2. **智能压缩**：使用summarizer模块进行历史压缩
3. **缓存优化**：检查缓存避免重复生成摘要
4. **历史融合**：将摘要与近期对话融合

**章节来源**
- [nl2sqlEngine.js:1850-2049](file://NL2SQL/backend/src/core/nl2sqlEngine.js#L1850-L2049)

### Schema元数据管理系统

Schema元数据管理系统负责加载和管理数据表的Schema信息，为查询意图识别提供上下文支持。

#### Schema向量化流程

```mermaid
flowchart LR
A[Schema配置文件] --> B[加载Schema数据]
B --> C[构建查找映射]
C --> D[向量化处理]
D --> E[存储到向量库]
E --> F[语义搜索]
G[用户查询] --> H[获取Embedding]
H --> I[向量搜索]
I --> J[返回相关表]
```

**图表来源**
- [schemaLoader.js:69-122](file://NL2SQL/backend/src/core/schemaLoader.js#L69-L122)
- [schemaLoader.js:195-290](file://NL2SQL/backend/src/core/schemaLoader.js#L195-L290)

**章节来源**
- [schemaLoader.js:1-1071](file://NL2SQL/backend/src/core/schemaLoader.js#L1-L1071)

### 数据库管理系统

数据库管理系统负责会话历史、查询日志等数据的持久化存储，使用SQLite轻量级数据库。

#### 数据表设计

```mermaid
erDiagram
SESSIONS {
TEXT id PK
TEXT user_id
TEXT title
DATETIME created_at
DATETIME updated_at
TEXT status
}
MESSAGES {
INTEGER id PK
TEXT session_id FK
TEXT role
TEXT content
TEXT type
TEXT metadata
DATETIME created_at
}
USER_PREFERENCES {
INTEGER id PK
TEXT user_id
TEXT preference_type
TEXT content
INTEGER usage_count
DATETIME last_used_at
DATETIME created_at
DATETIME updated_at
}
QUERY_HISTORY {
INTEGER id PK
INTEGER session_id
TEXT user_id
TEXT natural_query
TEXT generated_sql
TEXT status
TEXT result
TEXT error_message
INTEGER execution_time
INTEGER row_count
DATETIME created_at
DATETIME executed_at
}
SESSIONS ||--o{ MESSAGES : contains
SESSIONS ||--o{ QUERY_HISTORY : contains
```

**图表来源**
- [database.js:39-189](file://NL2SQL/backend/src/core/database.js#L39-L189)

**章节来源**
- [database.js:1-850](file://NL2SQL/backend/src/core/database.js#L1-L850)

### 增强向量存储功能

**更新** 向量存储模块现已增强，新增查询分类和重要性评分机制，提供更精细的查询管理和检索优化。

#### 查询分类机制

系统能够智能识别和分类不同类型的查询：

1. **定义/解释查询**：识别"什么是"、"定义"、"意思"等关键词
2. **对比查询**：识别"对比"、"比较"、"vs"等关键词
3. **趋势查询**：识别"趋势"、"走势"、"变化"等关键词
4. **澄清回复**：识别简短回复和确认信息
5. **跟进查询**：识别依赖上下文的"那"、"还有"等开头
6. **新话题**：识别长查询且高置信度的新话题

#### 重要性评分算法

重要性评分综合考虑多个因素：

1. **基础分**：0.5（所有查询的基础价值）
2. **成功状态**：成功查询额外+0.1
3. **维度数量**：每增加一个维度最多+0.15
4. **指标数量**：每增加一个指标最多+0.15
5. **筛选条件**：每增加一个筛选条件最多+0.1
6. **置信度**：高置信度查询额外+0.1
7. **上下文查询**：需要理解上下文的查询额外+0.05

**章节来源**
- [vectorStore.js:38-193](file://NL2SQL/backend/src/memory/vectorStore.js#L38-L193)

### 长期记忆增强功能

**更新** 系统新增了强大的平台术语学习功能，能够智能识别和学习用户对平台术语的个性化映射。

#### 平台术语学习机制

系统现在能够学习用户对"新平台"/"老平台"等术语的个性化映射：

1. **术语识别**：自动识别用户查询中的平台术语
2. **映射学习**：将用户术语映射到相应的数据库标识
3. **智能存储**：支持datasource类型的字段别名学习
4. **自动应用**：在后续查询中自动使用学习到的映射

#### 即时学习功能

系统支持从澄清轮中提取映射关系：

1. **Markdown表格学习**：支持游戏ID映射表格的学习
2. **键值对学习**：支持"新平台：new_tzpingtai"等格式
3. **显式声明学习**：支持"华夏对应 game_id=88"等声明
4. **平台映射学习**：专门支持"新平台"/"老平台"的数据库标识映射

**章节来源**
- [longTermMemory.js:828-965](file://NL2SQL/backend/src/memory/longTermMemory.js#L828-L965)

## 依赖关系分析

系统采用模块化设计，各组件之间的依赖关系清晰明确。

```mermaid
graph TD
subgraph "核心依赖"
A[express] --> B[HTTP服务器]
C[vectordb] --> D[LanceDB客户端]
E[sqlite3] --> F[SQLite数据库]
G[dayjs] --> H[时间处理]
I[node-cron] --> J[定时任务]
K[llmService] --> L[LLM服务]
M[tokenBudget] --> N[Token预算管理]
end
subgraph "内部模块依赖"
O[app.js] --> P[config.js]
O --> Q[database.js]
O --> R[vectorStore.js]
O --> S[routes.js]
T[nl2sqlEngine.js] --> U[schemaLoader.js]
T --> V[longTermMemory.js]
T --> W[summarizer.js]
T --> X[database.js]
Y[summarizer.js] --> Z[llmService.js]
Y --> AA[tokenBudget.js]
V --> AB[database.js]
V --> AC[llmService.js]
V --> AD[config.js]
AE[memoryMaintenance.js] --> AF[database.js]
AE --> AG[config.js]
AH[schemaLoader.js] --> AI[vectorStore.js]
AH --> AJ[llmService.js]
AK[vectorStore.js] --> AL[config.js]
end
subgraph "配置依赖"
AM[config.js] --> AN[LLM配置]
AM --> AO[数据库配置]
AM --> AP[向量数据库配置]
AM --> AQ[安全配置]
AM --> AR[对话摘要配置]
end
```

**图表来源**
- [package.json:10-20](file://NL2SQL/backend/package.json#L10-L20)
- [app.js:39-50](file://NL2SQL/backend/src/app.js#L39-L50)

### 外部服务集成

系统通过LLM服务实现智能查询意图识别和偏好提取：

1. **LLM API集成**：支持OpenAI兼容的API服务
2. **Embedding服务**：文本向量化处理
3. **向量检索**：基于语义相似度的查询推荐
4. **对话摘要**：LLM驱动的对话历史压缩

**章节来源**
- [config.js:60-87](file://NL2SQL/backend/src/core/config.js#L60-L87)

## 性能考虑

### 缓存策略

系统实现了多层次的缓存机制：

1. **Schema缓存**：Schema元数据缓存，支持过期检查
2. **向量缓存**：向量数据库连接缓存
3. **查询结果缓存**：常用查询结果缓存
4. **摘要缓存**：对话摘要内存缓存（默认30分钟过期）

### 性能优化措施

1. **批量处理**：向量嵌入获取采用批量处理，提高效率
2. **索引优化**：数据库表建立适当的索引
3. **内存管理**：合理控制内存使用，避免内存泄漏
4. **异步处理**：大量使用Promise和async/await
5. **智能压缩**：对话历史自动压缩，减少Token消耗

### 扩展性设计

1. **插件系统**：支持动态加载自定义工具
2. **配置驱动**：通过配置文件控制各种行为
3. **模块化架构**：易于添加新功能和修改现有功能
4. **环境变量支持**：便于不同环境的配置管理

## 故障排除指南

### 常见问题及解决方案

#### 向量数据库初始化失败

**问题症状**：
- 启动时出现向量数据库初始化错误
- 语义搜索功能不可用

**解决方案**：
1. 检查LanceDB依赖是否正确安装
2. 验证向量数据库路径权限
3. 确认磁盘空间充足

#### LLM服务连接失败

**问题症状**：
- 意图识别功能异常
- 偏好提取失败
- 对话摘要生成失败

**解决方案**：
1. 检查LLM API密钥配置
2. 验证网络连接
3. 确认API服务可用性

#### 数据库连接问题

**问题症状**：
- 会话历史无法保存
- 查询日志丢失

**解决方案**：
1. 检查SQLite数据库文件权限
2. 验证数据库文件完整性
3. 确认磁盘空间充足

#### 对话摘要缓存问题

**问题症状**：
- 摘要缓存失效
- 重复生成摘要
- 内存占用过高

**解决方案**：
1. 检查缓存过期时间设置
2. 验证缓存清理机制
3. 监控内存使用情况

**章节来源**
- [logger.js:283-293](file://NL2SQL/backend/src/utils/logger.js#L283-L293)

### 日志分析

系统提供了完善的日志记录功能，支持多级别日志输出：

1. **调试日志**：详细的操作流程记录
2. **信息日志**：系统状态和关键事件
3. **警告日志**：潜在问题的预警
4. **错误日志**：异常情况的详细记录

**章节来源**
- [logger.js:1-318](file://NL2SQL/backend/src/utils/logger.js#L1-L318)

## 结论

NL2SQL长期记忆系统是一个功能完整、架构清晰的智能数据查询系统。通过三层记忆架构设计，系统能够有效学习和利用用户查询习惯，提供个性化的查询体验。

### 系统优势

1. **智能化程度高**：通过LLM实现智能查询意图识别和偏好提取
2. **可扩展性强**：模块化设计支持功能扩展和定制
3. **性能优异**：采用向量化和缓存技术提升查询效率
4. **可靠性强**：完善的错误处理和监控机制
5. **智能压缩**：对话历史自动压缩，优化上下文管理
6. **精细分类**：查询分类和重要性评分机制

**更新** 新增的智能对话摘要功能大大增强了系统的长期对话管理能力，现在系统能够自动压缩长时间对话历史，将早期对话压缩为摘要，保留近期对话原文。增强的向量存储功能提供了更精细的查询分类和重要性评分，支持更智能的查询管理和检索优化。

### 技术特色

1. **三层记忆架构**：从短期到长期的记忆管理
2. **语义检索能力**：基于向量相似度的智能搜索
3. **智能偏好学习**：自动识别和存储用户查询习惯
4. **分级保留策略**：智能清理过期记忆，优化存储空间
5. **平台术语学习**：支持用户个性化平台术语映射
6. **对话历史压缩**：LLM驱动的智能对话管理
7. **查询分类机制**：精细化的查询类型识别
8. **重要性评分**：基于多因素的查询价值评估

### 发展方向

1. **增强学习算法**：改进偏好提取的准确性和效率
2. **多模态支持**：支持图片、语音等多种输入方式
3. **实时协作**：支持多用户实时协作查询
4. **边缘计算**：支持在边缘设备上部署
5. **智能缓存优化**：进一步优化缓存策略和内存使用

该系统为自然语言数据查询提供了一个完整的解决方案，具有良好的实用价值和推广前景。