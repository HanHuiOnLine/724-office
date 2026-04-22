# NL2SQL 核心模块优化实施计划

## 文档信息
- 版本：v1.1
- 日期：2026-04-21
- 适用范围：`backend/src/core`、`backend/src/memory`、`backend/src/utils`
- 目标：在不偏离现有项目方向的前提下，优先打通核心闭环（真实查询执行 + 主链路稳定性 + 复杂查询能力落地）

---

## 1. 目标与原则

### 1.1 优化目标
1. 打通真实提数闭环：从“可生成 SQL”升级为“可在真实数据源稳定执行并返回结果”。
2. 提升复杂查询成功率：将现有模块化能力（Schema 动态加载、语义层、澄清、Agentic）真正接入主链路。
3. 提升系统稳定性与可观测性：保证统计数据可信、日志可控、异常可追踪、风险可回滚。

### 1.2 优化原则
1. 先闭环、后增强：先解决核心路径“能用”，再做性能与体验增强。
2. 小步快跑：每个阶段可独立上线、可独立回滚。
3. 双轨验证：功能正确性 + 性能/稳定性指标同时验收。

---

## 2. 当前关键问题（聚焦）

### 2.1 P0 级（阻断核心价值）
1. `executeQuery` 仍为 mock 逻辑，真实数据库执行链路未接入。
2. `query_history` 仅见读取统计，缺少主流程写入，导致运营统计与自检数据失真。
3. `config.embedding.enabled` 在代码中作为开关使用，但配置中未定义该字段，导致相关分支可能长期不生效。
4. SSE 查询提交通道为异步触发，异常场景下错误反馈链路不完整，存在“前端提交成功但后台失败不可见”的风险。
5. 实体解析代码使用 `database.getConnection`，与当前数据库模块导出接口不一致，导致相关解析逻辑可能无法生效。
6. `summarizer` 存在摘要字符串二次赋值实现风险，可能触发运行时异常并影响长对话压缩。

### 2.2 P1 级（显著影响准确率与可维护性）
1. SQL 生成阶段仍有候选表硬截断（`top3` + `slice(0,5)`），与动态加载优化目标不一致。
2. Agentic 能力模块已实现但未接入主入口（主链路仍固定走 `nl2sqlEngine`）。
3. `llmService` 输出完整 Prompt 到控制台，存在敏感信息泄露与性能风险。
4. `nl2sqlEngine.js` 体量过大，职责过多，演进成本高。

### 2.3 P2 级（质量与效率）
1. 记忆和向量能力已具备，但命中与治理策略需要与主链路进一步对齐。
2. 缺少稳定的回归测试集与自动化验收脚本（目前主要为手工脚本）。
3. `memoryQueue` 缺少失败重试、死信处理和可恢复机制，极端情况下可能出现记忆写入丢失。
4. 数据安全增强项（行级权限、敏感字段脱敏、审计增强）尚未纳入明确里程碑推进。

---

## 3. 分阶段实施计划

## Phase 1（Week 1）核心闭环打通

### 任务
1. 接入真实数据库执行层，替换 `executeQuery` mock。
2. 在主流程补齐 `query_history` 写入（开始、成功、失败、耗时、row_count）。
3. 明确并统一 Embedding 开关策略（配置项与代码一致）。
4. 修复 SSE 异步错误反馈链路，确保提交、执行、失败状态可被前端准确感知。
5. 修复实体解析数据库接口不一致问题，确保实体映射逻辑可执行且可验证。
6. 修复 `summarizer` 运行时风险，确保长对话压缩路径稳定。

### 验收标准
1. 真实 SQL 可执行，且失败错误可返回明确原因。
2. `/api/stats` 与 `selfRepair` 查询统计值与实际请求一致。
3. Embedding 功能开关可控，日志中可确认分支命中。
4. SSE 提交后无“假成功”场景，失败状态在前端可见且可追踪。
5. 实体解析路径具备可复现测试用例（命中、歧义、未命中）。
6. 长会话压缩场景无摘要模块运行时异常。

### 风险与回滚
1. 风险：真实库连接导致慢查询和超时。
2. 回滚：保留 `DRY_RUN` 与 feature flag，异常时可快速切回只生成 SQL。

---

## Phase 2（Week 2）主链路准确率修复

### 任务
1. 落地 Schema 动态加载优化：去除固定 `slice(0,5)`，采用核心表保护 + 动态上限。
2. 统一表候选排序策略（向量分数 + 语义层推荐 + 关键词命中）。
3. 补齐复杂查询场景回归用例（多维过滤、行为序列、聚合+明细混合）。

### 验收标准
1. 复杂查询的关键表召回率明显提升（至少不再因固定截断丢关键表）。
2. 澄清轮次下降，且澄清内容更聚焦缺失信息。
3. 新增回归用例通过率达到既定阈值（建议 ≥85%）。

### 风险与回滚
1. 风险：表候选过多导致 Prompt 膨胀、时延升高。
2. 回滚：保留动态上限和兜底限制，可快速收敛表数量。

---

## Phase 3（Week 3）Agentic 能力接入与安全收敛

### 任务
1. 将入口改为可切换引擎（legacy/agentic）并通过 feature flag 控制。
2. 为 Agentic 流程增加失败兜底（失败回退 legacy 流程）。
3. 移除/降级完整 Prompt 控制台输出，改为安全脱敏日志。
4. 纳入数据安全增强里程碑：实现敏感字段脱敏、行级权限控制基础能力、查询审计字段补全。

### 验收标准
1. 在灰度环境可切换 Agentic 流程，失败时可自动回退。
2. 日志中不再出现完整 Prompt 明文。
3. 功能切换不影响 SSE 与前端交互协议。
4. 敏感字段返回结果符合脱敏规则，行级权限策略在测试角色下生效，审计日志可追溯查询来源与执行信息。

### 风险与回滚
1. 风险：切换后行为不一致导致结果波动。
2. 回滚：一键关闭 Agentic 开关，回退到 legacy 主链路。

---

## Phase 4（Week 4）架构治理与质量保障

### 任务
1. 按职责拆分 `nl2sqlEngine.js`（意图、SQL 生成、执行、格式化、实体解析）。
2. 建立模块级单测 + 集成回归脚本（覆盖核心路径）。
3. 完善自修复：纳入 SQL 失败分类统计与可操作建议。
4. 增强 `memoryQueue`：增加失败重试（指数退避）、死信队列和运维可观测指标。

### 验收标准
1. 核心模块拆分后对外接口不变，功能无回归。
2. 关键路径具备自动化测试与可重复验收流程。
3. 自修复报告可反映真实失败类型与趋势。
4. 记忆写入失败可重试且可观测，不再出现“静默丢失”。

### 风险与回滚
1. 风险：重构期引入隐性回归。
2. 回滚：按模块粒度提交，逐步合并，每步可独立回退。

---

## 4. 指标体系（建议）

### 4.1 业务效果指标
1. 复杂查询一次成功率。
2. 表检索准确率（人工标注集）。
3. 平均澄清轮次。

### 4.2 工程质量指标
1. 查询全链路成功率（含真实执行）。
2. P95 响应时延。
3. SQL 验证拦截率与误拦截率。
4. 自修复任务成功率。

### 4.3 安全与稳定性指标
1. 日志脱敏覆盖率（Prompt、敏感字段）。
2. 慢查询占比。
3. 运行时内存稳定性（无持续性增长异常）。
4. 行级权限命中率与越权拦截率。
5. 敏感字段脱敏准确率。

---

## 5. 任务-代码文件映射表

## Phase 1（Week 1）核心闭环打通

| 任务 | 主要代码文件 | 建议改动点 |
|------|-------------|-----------|
| 接入真实数据库执行层，替换 mock | `backend/src/core/nl2sqlEngine.js`、`backend/src/core/config.js`、`backend/.env` | 在 `executeQuery` 中引入真实数据源执行逻辑；接入连接池与超时控制；保留 `DRY_RUN` 兜底；统一返回结构（success/error/executionTime/rowCount）。 |
| 补齐 `query_history` 写入 | `backend/src/core/nl2sqlEngine.js`、`backend/src/core/database.js` | 在主流程增加“开始/成功/失败”写入；补充 `generated_sql`、`execution_time`、`row_count`、`error_message` 字段；封装数据库 helper（如 `createQueryHistory/updateQueryHistoryStatus`）。 |
| 统一 Embedding 开关策略 | `backend/src/core/config.js`、`backend/src/core/nl2sqlEngine.js` | 在 `config.embedding` 增加 `enabled`；将向量相关分支统一以该开关判断；启动日志输出开关状态。 |
| 修复 SSE 异步错误反馈链路 | `backend/src/core/routes.js`、`backend/src/core/sseHandler.js` | `routes` 侧改为显式捕获 `handleQuery` 异常；`sseHandler` 内统一错误事件格式与回传；避免“提交成功但后台失败不可见”。 |
| 修复实体解析接口不一致 | `backend/src/core/nl2sqlEngine.js`、`backend/src/core/database.js` | 将 `database.getConnection` 统一为现有导出接口（如 `getDb` 或新增标准 query adapter）；补齐实体解析命中/歧义/未命中测试样例。 |
| 修复 `summarizer` 运行时风险 | `backend/src/memory/summarizer.js` | 修正摘要变量二次赋值实现（避免 `const` 重新赋值）；补充长对话压缩场景的防回归测试。 |

## Phase 2（Week 2）主链路准确率修复

| 任务 | 主要代码文件 | 建议改动点 |
|------|-------------|-----------|
| 去除固定表截断，落地动态加载 | `backend/src/core/nl2sqlEngine.js`、`backend/src/core/schemaLoader.js` | 替换 `slice(0,5)` 固定截断；加入核心表保护、动态上限与截断日志；保留兜底上限防止 Prompt 膨胀。 |
| 统一表候选排序策略 | `backend/src/core/nl2sqlEngine.js`、`backend/src/memory/vectorStore.js`、`backend/src/core/semanticLayer.js` | 建立统一打分函数（向量分、语义映射、关键词命中、核心表加权）；排序逻辑集中到单处，避免多处分叉。 |
| 建立复杂查询回归集 | `backend/test/`（新增） 、`docs/NL2SQL复杂查询优化计划.md`（可追加样例） | 建立复杂查询样例集（多维筛选、行为序列、聚合+明细）；输出召回表、生成 SQL、执行结果三段式断言。 |

## Phase 3（Week 3）Agentic 接入与安全收敛

| 任务 | 主要代码文件 | 建议改动点 |
|------|-------------|-----------|
| 引擎入口可切换（legacy/agentic） | `backend/src/core/sseHandler.js`、`backend/src/app.js`、`backend/config/feature-flags.js`、`backend/src/core/agenticEngine.js` | 引入引擎注入或工厂选择；按 feature flag 切流；保留失败自动回退到 legacy。 |
| Prompt 日志安全化 | `backend/src/core/llmService.js`、`backend/src/utils/logger.js` | 去掉完整 Prompt `console.log`；改为长度、摘要、哈希等脱敏日志；保留 debug 级别可控开关。 |
| 数据安全增强（脱敏/行级权限/审计） | `backend/src/core/nl2sqlEngine.js`、`backend/src/core/schemaLoader.js`、`backend/src/core/config.js`、`backend/src/core/routes.js` | 结果脱敏规则落地；基于用户角色/租户注入行级过滤；补充审计字段（请求来源、用户、耗时、执行状态）。 |

## Phase 4（Week 4）架构治理与质量保障

| 任务 | 主要代码文件 | 建议改动点 |
|------|-------------|-----------|
| 拆分 `nl2sqlEngine.js` | `backend/src/core/nl2sqlEngine.js`、`backend/src/core/`（新增模块） | 按职责拆分为 `intentAnalyzer`、`sqlGenerator`、`sqlExecutor`、`resultFormatter`、`entityResolver`；原入口仅保留编排。 |
| 测试体系建设 | `backend/test/`、`backend/package.json` | 增加单测/集成测试脚本；接入最小回归流水（核心路径、异常路径、安全路径）。 |
| 自修复增强 | `backend/src/core/selfRepair.js`、`backend/src/core/database.js` | 增加 SQL 失败分类维度与趋势统计；输出可执行优化建议；打通与 `query_history` 数据关联。 |
| `memoryQueue` 可靠性增强 | `backend/src/memory/memoryQueue.js`、`backend/src/memory/longTermMemory.js` | 增加重试（指数退避）、最大重试次数、死信队列与告警日志；失败操作可追踪、可补偿。 |

---

## 6. 交付清单

1. 主链路真实执行可用（非 mock）。
2. Query 历史写入与统计可用。
3. 动态 Schema 选择策略落地。
4. Agentic 与 legacy 双引擎可切换。
5. SSE 异常反馈与实体解析稳定性修复落地。
6. 日志安全策略与数据安全策略落地（脱敏、行级权限、审计）。
7. 模块拆分、记忆队列可靠性增强与测试基线建立。

---

## 7. 里程碑结论

本计划以“先打通价值闭环、再做能力升级”为主线：  
先确保系统真正可提数，再将复杂查询与 Agentic 能力稳定接入，最后完成架构治理和测试体系建设。  
按该顺序推进，可在控制风险的前提下，持续提升准确率、稳定性和可维护性。
