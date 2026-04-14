# 智能记忆系统 (memory.py)

<cite>
**本文档引用的文件**
- [memory.py](file://memory.py)
- [llm.py](file://llm.py)
- [README.md](file://README.md)
- [config.example.json](file://config.example.json)
- [tools.py](file://tools.py)
- [xiaowang.py](file://xiaowang.py)
</cite>

## 更新摘要
**变更内容**
- 新增与NL2SQL长期记忆系统的区别说明，避免概念混淆
- 强调7/24办公室AI代理系统的三层记忆管道架构
- 明确区分两套不同的记忆管理策略和应用场景

## 目录
1. [简介](#简介)
2. [系统定位与区别](#系统定位与区别)
3. [项目结构](#项目结构)
4. [核心组件](#核心组件)
5. [架构概览](#架构概览)
6. [详细组件分析](#详细组件分析)
7. [依赖关系分析](#依赖关系分析)
8. [性能考虑](#性能考虑)
9. [故障排除指南](#故障排除指南)
10. [结论](#结论)
11. [附录](#附录)

## 简介

智能记忆系统是7/24办公室AI代理系统的核心组成部分，采用三层记忆管道设计，实现了从短期记忆到长期记忆再到检索记忆的完整记忆管理流程。该系统集成了LanceDB向量数据库，支持语义相似度计算和查询优化，提供了高效的记忆压缩、去重和检索功能。

**重要区别**：本系统与NL2SQL长期记忆系统不同，后者专注于数据查询场景的用户偏好记忆管理，而本系统服务于通用AI代理的多模态记忆需求。

系统的主要特点包括：
- **三层记忆管道**：短期记忆（会话历史）、长期记忆（压缩事实）和检索记忆（向量搜索）
- **LanceDB集成**：嵌入式向量数据库，无需独立服务
- **语义相似度计算**：基于余弦相似度的智能去重
- **异步压缩处理**：后台线程处理记忆压缩，不影响主流程
- **零延迟缓存**：为硬件/语音通道提供预计算的记忆摘要

## 系统定位与区别

### 7/24办公室AI代理智能记忆系统

本系统专为通用AI代理设计，提供跨领域的记忆管理能力：

```mermaid
graph TB
subgraph "AI代理智能记忆系统"
XW[xiaowang.py<br/>AI代理入口]
LLM[llm.py<br/>对话处理]
MEM[memory.py<br/>三层记忆管道]
TOOLS[tools.py<br/>工具接口]
end
subgraph "存储层"
LDB[LanceDB<br/>向量数据库]
FS[文件系统<br/>会话历史]
end
XW --> MEM
MEM --> LLM
MEM --> LDB
MEM --> FS
```

**图表来源**
- [xiaowang.py:71-76](file://xiaowang.py#L71-L76)
- [llm.py:328-346](file://llm.py#L328-L346)
- [memory.py:40-86](file://memory.py#L40-L86)

### NL2SQL长期记忆系统对比

NL2SQL系统专注于数据查询场景的记忆管理：

```mermaid
graph TB
subgraph "NL2SQL长期记忆系统"
N1[nl2sqlEngine.js<br/>查询引擎]
N2[longTermMemory.js<br/>偏好记忆]
N3[vectorStore.js<br/>向量存储]
end
subgraph "存储层"
DB[SQLite<br/>结构化存储]
VDB[LanceDB<br/>向量数据库]
end
N1 --> N2
N2 --> DB
N3 --> VDB
```

**关键差异**：
- **应用场景**：AI代理 vs 数据查询
- **存储方式**：向量数据库 vs 结构化数据库
- **记忆类型**：通用事实 vs 查询偏好
- **管理策略**：语义去重 vs 使用频率分级

## 项目结构

智能记忆系统在整体项目中的位置和作用如下：

```mermaid
graph TB
subgraph "核心模块"
XW[xiaowang.py<br/>入口点]
LLM[llm.py<br/>工具使用循环]
MEM[memory.py<br/>记忆系统]
TOOLS[tools.py<br/>工具注册]
end
subgraph "配置"
CFG[config.example.json<br/>配置文件]
end
subgraph "存储"
LDB[LanceDB<br/>向量数据库]
FS[文件系统<br/>会话历史]
end
XW --> LLM
XW --> MEM
XW --> TOOLS
LLM --> MEM
MEM --> LDB
LLM --> FS
CFG --> XW
CFG --> MEM
```

**图表来源**
- [xiaowang.py:71-76](file://xiaowang.py#L71-L76)
- [llm.py:328-346](file://llm.py#L328-L346)
- [memory.py:40-86](file://memory.py#L40-L86)

**章节来源**
- [README.md:23-66](file://README.md#L23-L66)
- [xiaowang.py:55-76](file://xiaowang.py#L55-L76)

## 核心组件

智能记忆系统包含以下核心组件：

### 1. 初始化组件
- **配置加载**：从config.json中读取记忆系统配置
- **LanceDB连接**：建立向量数据库连接
- **表结构初始化**：创建或打开memories表

### 2. 记忆压缩组件
- **对话格式化**：将消息列表转换为对话文本
- **LLM结构化提取**：使用提示词模板提取关键事实
- **向量化处理**：调用嵌入API生成向量表示

### 3. 去重组件
- **余弦相似度计算**：比较新记忆与现有记忆的相似度
- **阈值过滤**：根据相似度阈值跳过重复记忆

### 4. 检索组件
- **向量搜索**：用户消息嵌入到向量空间进行搜索
- **结果格式化**：将检索到的记忆格式化为可读文本
- **零延迟缓存**：硬件/语音通道的快速响应

**章节来源**
- [memory.py:28-34](file://memory.py#L28-L34)
- [memory.py:40-86](file://memory.py#L40-L86)
- [memory.py:121-146](file://memory.py#L121-L146)
- [memory.py:294-360](file://memory.py#L294-L360)

## 架构概览

智能记忆系统采用三层记忆管道架构，每层都有明确的功能分工：

```mermaid
flowchart TD
subgraph "短期记忆 (Session)"
SM1[最近40条消息<br/>JSON文件存储]
SM2[溢出触发压缩]
end
subgraph "长期记忆 (Compressed)"
CM1[LLM结构化提取]
CM2[向量化处理]
CM3[去重过滤]
CM4[LanceDB存储]
end
subgraph "检索记忆 (Retrieval)"
RM1[用户消息嵌入]
RM2[LanceDB向量搜索]
RM3[Top-K结果返回]
RM4[零延迟缓存]
end
SM1 --> SM2 --> CM1
CM1 --> CM2 --> CM3 --> CM4
RM1 --> RM2 --> RM3 --> RM4
RM4 --> SM1
```

**图表来源**
- [README.md:71-84](file://README.md#L71-L84)
- [llm.py:103-106](file://llm.py#L103-L106)
- [memory.py:294-360](file://memory.py#L294-L360)

### 数据流分析

记忆系统的数据流遵循以下模式：

1. **短期记忆阶段**：用户消息保存在会话文件中，达到阈值后触发压缩
2. **长期记忆阶段**：后台线程异步处理，LLM提取结构化事实并存储
3. **检索记忆阶段**：用户查询时进行向量搜索，返回最相关的记忆

**章节来源**
- [llm.py:103-106](file://llm.py#L103-L106)
- [memory.py:121-146](file://memory.py#L121-L146)
- [memory.py:88-118](file://memory.py#L88-L118)

## 详细组件分析

### 初始化组件

初始化过程负责建立记忆系统的基础设施：

```mermaid
sequenceDiagram
participant XW as xiaowang.py
participant MEM as memory.py
participant LDB as LanceDB
participant FS as 文件系统
XW->>MEM : init(config, llm_config, db_path)
MEM->>MEM : 检查配置启用状态
MEM->>MEM : 验证嵌入API密钥
MEM->>LDB : 连接数据库
LDB-->>MEM : 返回连接对象
MEM->>LDB : 打开或创建memories表
LDB-->>MEM : 返回表对象
MEM->>FS : 创建种子数据
FS-->>MEM : 确认存储成功
MEM-->>XW : 初始化完成
```

**图表来源**
- [memory.py:40-86](file://memory.py#L40-L86)
- [xiaowang.py:71-76](file://xiaowang.py#L71-L76)

初始化的关键步骤包括：
- 配置验证和启用检查
- LanceDB连接建立
- 表结构初始化和种子数据创建
- 全局状态变量设置

**章节来源**
- [memory.py:40-86](file://memory.py#L40-L86)
- [config.example.json:28-38](file://config.example.json#L28-L38)

### 记忆压缩组件

记忆压缩是三层管道的核心处理逻辑：

```mermaid
flowchart TD
A[接收溢出消息] --> B[过滤有效消息]
B --> C[格式化对话文本]
C --> D[检查长度阈值]
D --> |不足| E[跳过压缩]
D --> |满足| F[构建压缩提示词]
F --> G[调用LLM提取结构化记忆]
G --> H[提取事实列表]
H --> I[向量化处理]
I --> J[余弦相似度去重]
J --> K[存储到LanceDB]
E --> L[结束]
K --> L
```

**图表来源**
- [memory.py:121-146](file://memory.py#L121-L146)
- [memory.py:294-360](file://memory.py#L294-L360)

压缩过程的具体实现：

1. **消息过滤**：只保留用户和助手的有效文本消息
2. **对话格式化**：将消息转换为结构化的对话文本
3. **LLM提取**：使用专门的提示词模板提取结构化记忆
4. **向量化**：调用嵌入API生成向量表示
5. **去重处理**：通过余弦相似度比较避免重复存储

**章节来源**
- [memory.py:121-146](file://memory.py#L121-L146)
- [memory.py:294-360](file://memory.py#L294-L360)

### 去重算法

去重算法基于余弦相似度计算，确保记忆库的质量和效率：

```mermaid
flowchart TD
A[新记忆向量] --> B[查询LanceDB最近邻]
B --> C[计算相似度]
C --> D{相似度 > 阈值?}
D --> |是| E[跳过存储]
D --> |否| F[存储新记忆]
E --> G[记录去重信息]
F --> H[更新记忆库]
G --> I[继续处理下一个]
H --> I
```

**图表来源**
- [memory.py:320-338](file://memory.py#L320-L338)
- [memory.py:284-292](file://memory.py#L284-L292)

去重算法的关键参数：
- **相似度阈值**：默认0.92，可根据需求调整
- **距离计算**：使用1 - _distance作为相似度
- **异常处理**：去重查询失败不应阻塞存储过程

**章节来源**
- [memory.py:320-338](file://memory.py#L320-L338)
- [config.example.json:37](file://config.example.json#L37)

### 检索组件

检索组件提供语义相似度搜索功能：

```mermaid
sequenceDiagram
participant User as 用户
participant LLM as llm.py
participant MEM as memory.py
participant LDB as LanceDB
User->>LLM : 用户消息
LLM->>MEM : retrieve(query, session_key)
MEM->>MEM : 调用嵌入API
MEM->>LDB : 向量搜索
LDB-->>MEM : 返回Top-K结果
MEM->>MEM : 过滤种子数据
MEM-->>LLM : 格式化记忆文本
LLM-->>User : 包含记忆上下文的回复
```

**图表来源**
- [llm.py:337-346](file://llm.py#L337-L346)
- [memory.py:88-118](file://memory.py#L88-L118)

检索过程的特点：
- **同步处理**：检索操作是同步的，确保上下文完整性
- **结果过滤**：自动过滤种子数据和低质量结果
- **格式化输出**：将检索到的记忆转换为易读的文本格式

**章节来源**
- [llm.py:337-346](file://llm.py#L337-L346)
- [memory.py:88-118](file://memory.py#L88-L118)

### 零延迟缓存

为硬件/语音通道提供快速响应的缓存机制：

```mermaid
flowchart LR
A[首次检索] --> B[生成记忆摘要]
B --> C[存储到缓存]
C --> D[硬件通道请求]
D --> E[直接返回缓存]
E --> F[后续请求]
F --> G[直接返回缓存]
H[内存更新] --> I[清除相关缓存]
I --> J[等待下次请求]
```

**图表来源**
- [memory.py:148-151](file://memory.py#L148-L151)

缓存机制的优势：
- **硬件优化**：为语音和硬件通道提供零延迟响应
- **状态管理**：维护session_key到记忆摘要的映射
- **更新策略**：内存更新时自动清理相关缓存

**章节来源**
- [memory.py:148-151](file://memory.py#L148-L151)

## 依赖关系分析

智能记忆系统与其他模块的依赖关系：

```mermaid
graph TB
subgraph "外部依赖"
LDB[LanceDB]
EMB[嵌入API]
LLM[LLM提供商]
end
subgraph "内部模块"
MEM[memory.py]
LLM_MOD[llm.py]
TOOLS[tools.py]
XW[xiaowang.py]
end
XW --> MEM
XW --> LLM_MOD
LLM_MOD --> MEM
TOOLS --> MEM
MEM --> LDB
MEM --> EMB
MEM --> LLM
```

**图表来源**
- [memory.py:58](file://memory.py#L58)
- [memory.py:158-187](file://memory.py#L158-L187)
- [memory.py:228-281](file://memory.py#L228-L281)

### 外部依赖分析

1. **LanceDB**：嵌入式向量数据库，提供高效的向量搜索能力
2. **嵌入API**：支持任何OpenAI兼容的嵌入服务
3. **LLM提供商**：用于记忆压缩的结构化提取

### 内部依赖分析

1. **llm.py集成**：会话管理和记忆检索的紧密集成
2. **tools.py工具**：提供记忆检索的工具接口
3. **xiaowang.py初始化**：系统启动时的统一初始化

**章节来源**
- [memory.py:58](file://memory.py#L58)
- [memory.py:158-187](file://memory.py#L158-L187)
- [memory.py:228-281](file://memory.py#L228-L281)

## 性能考虑

智能记忆系统在设计时充分考虑了性能优化：

### 存储策略

1. **分层存储**：短期记忆使用轻量级文件存储，长期记忆使用高效的向量数据库
2. **异步处理**：压缩过程在后台线程执行，不影响主流程响应
3. **批量操作**：支持批量向量搜索和存储，提高I/O效率

### 查询优化

1. **Top-K限制**：默认返回5个最相关的结果，平衡准确性和性能
2. **早期过滤**：在数据库层面过滤种子数据和无效结果
3. **缓存机制**：硬件通道的零延迟缓存减少重复计算

### 内存管理

1. **渐进式压缩**：只有溢出的消息才会被压缩，避免不必要的处理
2. **阈值控制**：相似度阈值防止重复存储，保持数据库大小可控
3. **异常容错**：去重查询失败不会影响存储过程

**章节来源**
- [config.example.json:36-37](file://config.example.json#L36-L37)
- [memory.py:121-146](file://memory.py#L121-L146)
- [memory.py:320-338](file://memory.py#L320-L338)

## 故障排除指南

### 常见问题及解决方案

1. **初始化失败**
   - 检查嵌入API密钥是否正确配置
   - 确认LanceDB依赖已正确安装
   - 验证数据库路径权限

2. **检索无结果**
   - 检查嵌入API是否正常工作
   - 验证记忆库中是否有足够的数据
   - 调整相似度阈值参数

3. **压缩失败**
   - 检查LLM提供商配置
   - 验证消息格式是否符合要求
   - 查看日志获取详细错误信息

### 日志分析

系统提供了详细的日志记录，包括：
- 初始化状态信息
- 压缩进度和结果
- 检索操作详情
- 错误和异常情况

**章节来源**
- [memory.py:84](file://memory.py#L84)
- [memory.py:116](file://memory.py#L116)
- [memory.py:360](file://memory.py#L360)

## 结论

智能记忆系统通过三层记忆管道设计，实现了高效、智能的记忆管理。系统的核心优势包括：

1. **架构清晰**：三层管道各司其职，逻辑清晰
2. **性能优秀**：异步处理、缓存机制和查询优化
3. **易于扩展**：模块化设计，便于功能增强
4. **可靠性高**：完善的错误处理和异常容错

该系统为AI代理提供了强大的记忆能力，支持长期学习和智能回忆，是构建真正智能代理的重要基础。

**重要提醒**：本系统与NL2SQL长期记忆系统在设计理念、存储方式和应用场景上存在根本差异，应根据具体需求选择合适的记忆管理方案。

## 附录

### 配置参数说明

| 参数名 | 类型 | 默认值 | 描述 |
|--------|------|--------|------|
| enabled | boolean | true | 是否启用记忆系统 |
| embedding_api.api_base | string | https://api.openai.com/v1 | 嵌入API基础URL |
| embedding_api.api_key | string | 无 | 嵌入API密钥 |
| embedding_api.model | string | text-embedding-3-small | 嵌入模型名称 |
| embedding_api.dimension | integer | 1024 | 嵌入向量维度 |
| retrieve_top_k | integer | 5 | 检索返回的Top-K数量 |
| similarity_threshold | float | 0.92 | 去重相似度阈值 |

### 使用示例

虽然本节不包含具体代码内容，但可以提供使用路径参考：

- **初始化记忆系统**：[memory.py:40-86](file://memory.py#L40-L86)
- **添加记忆**：通过会话溢出触发压缩，参见[llm.py:103-106](file://llm.py#L103-L106)
- **查询记忆**：使用工具函数，参见[tools.py:809-813](file://tools.py#L809-L813)
- **清理操作**：系统自动管理，无需手动干预

**章节来源**
- [config.example.json:28-38](file://config.example.json#L28-L38)
- [tools.py:809-813](file://tools.py#L809-L813)