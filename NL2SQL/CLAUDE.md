# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目简介

NL2SQL 自然语言提数工具：让非技术人员通过自然语言查询 SR 系统数据库，后端将自然语言转换为 SQL 并执行返回结果。

## 开发命令

```bash
# 后端开发（热重载，端口 3000）
cd backend && npm run dev

# 前端开发（Vite，端口 5173）
cd frontend && npm run dev

# 前端构建
cd frontend && npm run build

# 后端生产启动
cd backend && npm start
```

前端通过 Vite 代理将 `/api` 请求转发到 `http://localhost:3000`，无需手动配置跨域。

## 环境配置

启动前将 `backend/.env.example` 复制为 `backend/.env` 并填写以下必填项：

```
LLM_API_BASE=    # 兼容 OpenAI 格式的 API 地址（如 DeepSeek）
LLM_API_KEY=     # API 密钥
LLM_MODEL=       # 主模型（如 deepseek-chat）
EMBEDDING_MODEL= # Embedding 模型
SR_DATABASE_URL= # 目标数据库连接串（只读）
```

`SCHEMA_REVECTORIZE=true` 可强制在启动时重新生成向量索引（Schema 变更后使用）。

## 整体架构

```
前端 Vue3 (5173)
  │ SSE 长连接
后端 Express (3000)
  ├── SSE Handler      → 管理流式连接，接收用户消息，调用引擎
  ├── NL2SQL Engine    → 核心：意图识别 → Schema检索 → SQL生成 → 验证 → 执行 → 格式化
  ├── Agentic Engine   → 四阶段 Agentic 工作流（功能开关控制）
  ├── LLM Service      → 封装所有 LLM API 调用（chat + embedding）
  ├── Schema Loader    → 加载 schema-metadata.json，向量化并存入 LanceDB
  └── Memory System    → 三层记忆（会话历史/向量检索/长期记忆）

数据层
  ├── SQLite (data/sessions.db)   → 会话、查询历史、长期记忆存储
  ├── LanceDB (data/vectordb/)    → Schema 和查询历史的向量索引
  └── SR 数据库（只读）            → 业务数据源（MySQL）
```

## 后端核心模块

### `src/core/`

| 文件 | 职责 |
|------|------|
| `config.js` | 统一配置入口，所有模块从此读取配置而非直接读 `process.env` |
| `nl2sqlEngine.js` | 核心引擎（~100KB），包含意图分析、Schema 检索、SQL 生成、验证、执行全流程 |
| `agenticEngine.js` | 四阶段 Agentic 工作流：Phase 1 工具化 Schema 探索 → Phase 2 动态意图拆解 → Phase 3 澄清 → Phase 4 生成+验证+修复 |
| `llmService.js` | LLM API 客户端（支持流式/非流式），用原生 https 模块实现，无第三方 SDK 依赖 |
| `sseHandler.js` | SSE 连接管理，一个 sessionId 支持多标签页连接 |
| `schemaLoader.js` | 从 `config/schema-metadata.json` 加载表结构，按需向量化存入 LanceDB |
| `schemaTools.js` | 供 LLM 调用的 Schema 探索工具集（Phase 1 Tool Loop 使用） |
| `toolLoop.js` | 实现 LLM 工具调用循环，最多迭代 5 次（Phase 1） |
| `queryDecomposer.js` | 将复杂查询拆解为独立数据需求单元（Phase 2） |
| `clarificationEngine.js` | 检测置信度不足时触发澄清问题（Phase 3） |
| `semanticLayer.js` | 业务语义层：将"老平台"等业务术语映射到物理表/字段（配置文件：`config/business-semantic-layer.json`） |
| `selfRepair.js` | node-cron 定时任务，执行健康检查和记忆维护 |

### `src/memory/`

| 文件 | 职责 |
|------|------|
| `vectorStore.js` | LanceDB 封装，存储 Schema 向量和查询历史向量，支持语义相似度搜索 |
| `longTermMemory.js` | 长期记忆：用 LLM 提炼用户查询中的字段别名、查询模式等偏好，存入 SQLite |
| `summarizer.js` | 长对话自动摘要，超过阈值轮数后压缩早期历史 |
| `memoryQueue.js` | 异步记忆写入队列，避免阻塞主流程 |
| `memoryMaintenance.js` | 定期清理过期记忆、去重等维护任务 |

### `src/utils/`

| 文件 | 职责 |
|------|------|
| `tokenBudget.js` | 估算 Token 用量，防止上下文窗口溢出，自动触发摘要或截断 |
| `evaluation.js` | 向量检索命中率、记忆命中率等运行时统计（由 `EVALUATION_ENABLED` 开关控制） |
| `logger.js` | 结构化日志，输出到文件和控制台 |

## 功能开关（Feature Flags）

`config/feature-flags.js` 通过环境变量控制四个 Phase 的功能，支持渐进式启用和快速回滚：

```bash
FF_TOOL_AUGMENTED_SCHEMA=true      # Phase 1: LLM 主动调用工具探索 Schema
FF_SCHEMA_LAYERED_LOADING=true     # Phase 1: 分层加载（Level1索引 + 按需 Level2 详情）
FF_TOOL_LOOP_MODE=true             # Phase 1: 多轮工具调用循环
FF_DYNAMIC_INTENT_DECOMPOSITION=true  # Phase 2: 复杂查询拆解为数据单元
FF_BUSINESS_SEMANTIC_LAYER=true    # Phase 2: 业务语义映射
FF_CLARIFICATION_ENGINE=true       # Phase 3: 低置信度时触发澄清
FF_AGENTIC_ENGINE=true             # Phase 4: 完整 Agentic 工作流
FF_AUTO_RECOVERY=true              # Phase 4: SQL 执行失败自动修复
FF_ENABLE_ALL=true                 # 全部启用（慎用）
FF_DISABLE_ALL=true                # 全部禁用（紧急回滚）
```

所有开关默认关闭，未设置开关时走 `nl2sqlEngine.js` 的传统流程。

## Schema 配置文件

- `backend/config/schema-metadata.json`（~1.2MB）：主 Schema 文件，定义所有表结构、字段、关系、业务关键词。启动时读取并向量化。
- `backend/config/schema-metadata.example.json`：结构示例和说明文档。
- `backend/config/business-semantic-layer.json`：业务语义映射（业务概念 → 物理表/字段）。

修改这两个 JSON 文件后，需设置 `SCHEMA_REVECTORIZE=true` 重启后端使向量索引更新生效。

## 前端结构

- `src/views/ChatView.vue` — 主对话界面，SSE 流式展示
- `src/views/MemoryView.vue` — 长期记忆管理
- `src/views/EvaluationView.vue` — 系统评估与统计
- `src/views/HistoryView.vue` / `SchemaView.vue` — 历史和 Schema 浏览
- `src/stores/session.js` — Pinia store，管理会话列表和当前会话状态
- `src/router/index.js` — Vue Router 路由配置

## 关键数据流

1. 前端通过 `GET /api/sse/stream?session_id=xxx` 建立 SSE 长连接
2. 用户发消息 → `POST /api/sse/message` → `sseHandler` 接收
3. 引擎判断：若 `FF_AGENTIC_ENGINE=true` → `agenticEngine`，否则 → `nl2sqlEngine`
4. 引擎执行：意图识别 → 向量检索相关表 → 构建 Prompt → LLM 生成 SQL → 验证（白名单/语法）→ 执行 → 格式化 → SSE 推送结果
5. 成功查询异步触发长期记忆提炼（`memoryQueue`）

### 澄清分支（批次 B 后）

命中澄清触发器时走独立子链路，避免二轮 query 脱离原需求：

1. 第一轮引擎返回 `type='clarification'` 时，`sseHandler.persistAgenticMessages` 把
   `{ clarification, originalQuery, decomposition, tableCandidates(slice 0-8, 仅 name/score) }`
   写入 assistant 消息的 metadata；`addMessage` 返回的 `id` 回写到 `tagged.message_id` 随 SSE
   `result` 事件推给前端。
2. 前端把 `message.id = data.data.message_id` 保留在 clarification 消息对象上；用户点选或输入
   回答后调 `POST /api/sse/clarify-answer { session_id, parent_message_id, option }`。
3. `sseHandler.handleClarifyAnswer` 通过 `database.getMessage` 读回父消息 metadata，组装 history
   `[原 query, 澄清问题, 用户回答]`，调 `agenticEngine.resumeFromClarification`。
4. `resumeFromClarification`：`applyClarificationResult`（含 `applyUncoveredDataUnit` 从回答
   抽 `field=value` 和 `int_keyN` / `typeid` 等物理字段回写 dataUnits） → `retrieveTablesByDataUnits`
   → `generationPhase` → `verificationPhase`，失败时 `recoveryPhase`。
5. 结果通过 `engineUsed='agentic-resume'` 广播到原 SSE 流，对前端协议零新增。

降级路径：父消息 metadata 缺失（老会话）或 `message.id` 为空（老前端）时，自动回退到原
`handleQuery` / `sendQuery` 流程。

## API 端点

| 端点 | 说明 |
|------|------|
| `GET /api/health` | 健康检查 |
| `GET /api/schema` | 获取 Schema 元数据 |
| `GET /api/sse/stream` | 建立 SSE 连接（需 `?session_id=` 参数） |
| `POST /api/sse/message` | 发送用户消息 |
| `POST /api/sse/clarify-answer` | 澄清回答接续（批次 B，需 `parent_message_id`） |
| `GET/POST /api/sessions` | 会话管理 |
| `GET /api/history` | 查询历史 |
| `GET/DELETE /api/memory` | 长期记忆管理 |
| `GET /api/evaluation` | 评估统计数据 |
