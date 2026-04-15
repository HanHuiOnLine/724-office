# NL2SQL 自然语言提数工具 - 进度追踪

> 本文档记录系统当前实现状态与剩余任务，作为开发进度指引
> 最后更新：2026-04-15

---

## 📊 总体完成度

| 阶段 | 状态 | 完成度 |
|------|------|--------|
| 阶段一：MVP（基础架构） | 🟢 基本完成 | 90% |
| 阶段二：核心功能 | 🟡 部分完成 | 85% |
| 阶段三：增强功能 | 🟡 部分完成 | 60% |
| 阶段四：完善优化 | ⚪ 未开始 | 0% |

---

## 🟢 已完成功能

### 1. 基础架构
- [x] Node.js + Express 后端服务
- [x] WebSocket 实时通信（流式响应）
- [x] Vue3 + Element Plus 前端框架
- [x] SQLite 会话存储
- [x] 日志系统

### 2. NL2SQL 核心引擎
- [x] 意图识别（支持上下文理解）
- [x] 澄清机制（信息不足时主动询问）
- [x] SQL 生成（基于 LLM）
- [x] SQL 安全验证（只读检查、白名单、LIMIT限制）
- [x] 结果格式化（自然语言总结）

### 3. Schema 管理
- [x] JSON 配置文件加载
- [x] 表/字段/指标/维度定义
- [x] LanceDB 向量存储集成
- [x] 语义搜索相关表

### 4. 三层记忆系统 - Layer 1
- [x] 会话历史存储（SQLite）
- [x] 多轮对话上下文支持

### 5. 前端界面
- [x] 聊天界面（支持 Markdown、SQL高亮）
- [x] 数据表格展示
- [x] 处理状态指示器（进度条、加载动画）
- [x] Schema 查看页面
- [x] 历史记录页面框架

### 6. 自修复机制（框架）
- [x] 定时任务调度（node-cron）
- [x] 每日自检任务框架
- [x] 会话清理任务

---

## 🔴 高优先级任务（影响核心功能）

### 1. 三层记忆系统 - Layer 2（长期记忆）⭐⭐⭐
**状态**：🟢 已实现  
**文件**：`backend/src/memory/longTermMemory.js`, `backend/src/core/database.js`

**任务清单**：
- [x] 实现用户查询偏好自动提取（支持LLM智能分析和逻辑判断双模式）
- [x] 实现字段别名映射学习（支持游戏映射、数据源映射、字段别名）
- [x] 实现常用查询模板存储（自动提取+手动存储）
- [x] 在意图识别时读取用户偏好（getUserPreferencesForIntent）
- [x] 定期压缩和更新长期记忆（memoryMaintenance定时任务）
- [x] 澄清轮即时学习（extractMappingsFromText支持Markdown表格、键值对、显式声明）

**存储结构**：
```json
{
  "type": "query_pattern",
  "user_id": "user_123",
  "pattern": {
    "name": "月度销售报表",
    "dimensions": ["month", "region"],
    "metrics": ["销售额", "订单数"],
    "default_time_range": "最近30天"
  }
}
```

---

### 3. 查询历史向量化 ⭐⭐⭐
**状态**：🟢 已实现  
**文件**：`backend/src/memory/vectorStore.js`, `backend/src/core/nl2sqlEngine.js`

**任务清单**：
- [x] 在 `processQuery` 完成后调用 `addQueryVector`（带增强元数据）
- [x] 实现相似查询推荐功能（searchSimilarQueries）
- [x] 在意图识别阶段检索相似历史查询（已集成到意图识别流程）
- [x] 优化向量检索的准确性和性能（支持重要性评分、查询类型分类、复杂度分析）

---

## 🟡 中优先级任务（增强体验）

### 4. 结果可视化 ⭐⭐
**状态**：仅支持表格展示

**任务清单**：
- [ ] 集成图表库（ECharts / AntV）
- [ ] 实现柱状图组件
- [ ] 实现折线图组件
- [ ] 实现饼图组件
- [ ] 智能图表推荐逻辑（根据数据特征推荐图表类型）
- [ ] 异常数据标注
- [ ] 前端图表导出功能

**前端文件**：
- `frontend/src/views/ChatView.vue` - 添加图表展示区域
- 新建 `frontend/src/components/ChartViewer.vue`

---

### 5. SQL 验证与测试工具 ⭐⭐
**状态**：需要验证 AI 生成 SQL 的准确性

**任务清单**：
- [ ] 创建 SQL 测试用例库
- [ ] 实现 SQL 语法验证工具
- [ ] 实现 SQL 与意图对比验证
- [ ] 添加 SQL 执行计划分析
- [ ] 创建批量测试脚本
- [ ] 生成 SQL 准确性报告

**说明**：在连接真实数据库前，需确保 AI 生成的 SQL 质量达标

---

### 6. 数据安全增强 ⭐⭐
**状态**：基础验证已做，高级功能未实现

**任务清单**：
- [ ] 行级权限控制（根据用户角色限制数据范围）
- [ ] 敏感字段脱敏（手机号、身份证等）
- [ ] 完善审计日志（记录查询来源、IP、耗时）
- [ ] 异常查询检测（防止数据爬取）
- [ ] 查询结果缓存加密

**涉及文件**：
- `backend/src/core/schemaLoader.js` - 添加敏感字段标记
- `backend/src/core/nl2sqlEngine.js` - 添加脱敏逻辑
- `backend/src/core/config.js` - 添加权限配置

---

### 7. 自修复机制完善 ⭐⭐
**状态**：🟡 框架完成，基础功能已实现  

**任务清单**：
- [x] 每日健康报告生成（performDailyCheck - 检查数据库、向量库、查询统计、内存等）
- [x] 会话清理任务（cleanupSessions - 自动归档过期会话）
- [x] 统计信息收集（collectStats - 定期收集系统运行数据）
- [x] 记忆维护任务（performMemoryMaintenance - 调用memoryMaintenance压缩记忆）
- [ ] SQL 生成失败案例分析
- [ ] 自动分类错误类型（Schema不匹配、语法错误等）
- [ ] Prompt 自动优化（根据失败案例调整）
- [ ] 管理员通知功能（邮件/企业微信）
- [ ] 慢查询自动优化建议

**涉及文件**：`backend/src/core/selfRepair.js`

---

## ⚪ 低优先级任务（锦上添花）

### 8. 前端优化
- [ ] 查询历史页面完整功能实现
- [ ] 移动端适配优化
- [ ] 深色模式支持
- [ ] 消息搜索功能
- [ ] 会话导出（PDF/Markdown）

### 9. 性能优化
- [ ] SQL 查询缓存（Redis）
- [ ] 向量检索性能优化
- [ ] 前端懒加载和虚拟滚动
- [ ] 数据库连接池优化

### 10. 用户反馈收集
- [ ] 查询结果点赞/点踩
- [ ] 错误反馈收集
- [ ] 用户满意度调查
- [ ] A/B 测试框架

### 11. 运维与监控
- [ ] Prometheus 指标暴露
- [ ] Grafana 监控面板
- [ ] 链路追踪（OpenTelemetry）
- [ ] 自动化部署脚本

### 12. 真实数据库连接 ⭐
**状态**：🔴 当前使用模拟数据，待 SQL 质量验证通过后实施  
**文件**：`backend/src/core/nl2sqlEngine.js` (第1700-1750行)

**前置条件**：
- [ ] SQL 验证与测试工具完成
- [ ] AI 生成 SQL 准确性达到预期标准

**任务清单**：
- [ ] 实现 MySQL/PostgreSQL 数据库连接
- [ ] 配置数据源连接池
- [ ] 替换 `executeQuery` 中的 mock 数据逻辑
- [ ] 添加数据库连接健康检查
- [ ] 实现查询超时控制

**技术要点**：
```javascript
// 当前问题代码
async function executeQuery(sql) {
  // TODO: 这里需要实现实际的数据源连接和查询
  // 目前使用模拟数据演示
  const mockResult = {...};
}
```

---

## 📁 相关文件索引

### 后端核心文件
| 文件路径 | 说明 | 状态 |
|---------|------|------|
| `backend/src/core/nl2sqlEngine.js` | NL2SQL核心引擎 | 需完善 executeQuery |
| `backend/src/core/schemaLoader.js` | Schema管理 | 基本完整 |
| `backend/src/core/sseHandler.js` | SSE流式处理 | 基本完整 |
| `backend/src/core/database.js` | SQLite数据库 | 需完善Layer2 |
| `backend/src/memory/vectorStore.js` | 向量存储 | 需完善查询历史存储 |
| `backend/src/core/selfRepair.js` | 自修复机制 | 框架完成，功能待实现 |
| `backend/src/core/routes.js` | REST API | 基本完整 |

### 前端核心文件
| 文件路径 | 说明 | 状态 |
|---------|------|------|
| `frontend/src/views/ChatView.vue` | 聊天界面 | 需添加图表展示 |
| `frontend/src/views/SchemaView.vue` | Schema查看 | 基本完整 |
| `frontend/src/views/HistoryView.vue` | 历史记录 | 需完善功能 |
| `frontend/src/stores/session.js` | 会话状态管理 | 基本完整 |

---

## 🎯 近期建议（接下来2周）

### Week 1
1. **实现 SQL 验证与测试工具** - 创建测试用例库，验证 AI 生成 SQL 质量
2. **结果可视化基础版** - 集成 ECharts 展示柱状图/折线图

### Week 2
3. **数据安全增强** - 实现敏感字段脱敏、行级权限控制
4. **自修复机制完善** - SQL失败案例分析、Prompt自动优化

---

## 📝 备注

- 需求文档参考：`docs/自然语言提数工具需求文档.md`
- 项目架构遵循原 7/24 Office AI Agent 设计
- 技术栈：Node.js + Vue3 + LanceDB + SQLite
