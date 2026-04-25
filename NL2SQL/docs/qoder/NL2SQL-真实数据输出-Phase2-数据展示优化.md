# Phase 2 — 数据展示优化

## 文档信息
- 版本：v1.0
- 日期：2026-04-24
- 优先级：P0（用户可感知的核心体验）
- 前置依赖：Phase 1 完成
- 预计工时：2.5d

---

## 1. 目标

将前端从「SQL 代码优先」切换为「数据表格优先」：
- 数据表格默认展开、占据主要空间
- SQL 代码默认折叠为辅助信息
- 空结果和错误状态有友好提示
- 大数据集支持分页浏览

---

## 2. 当前问题详解

### 2.1 展示顺序问题

**文件**：`frontend/src/views/ChatView.vue:37-75`

当前展示顺序：
1. 文本内容（自然语言总结）— 默认展示
2. SQL 代码块 — 默认展开，带复制按钮
3. 数据表格 — 默认展示，但空间受限

**目标顺序**：
1. 数据概览卡片（行数/耗时/截断状态）
2. 数据表格 — 默认展开，主体空间
3. 自然语言总结 — 紧跟表格下方
4. SQL 代码块 — 默认折叠，点击展开

### 2.2 数据表格功能不足

当前 `el-table` 配置：
```vue
<el-table
  :data="message.metadata.data.rows"
  border
  size="small"
  max-height="300"   <!-- 固定300px，大数据集体验差 -->
>
```

**问题**：
- 无分页：1000行数据一次性渲染
- 无排序：无法按列排序
- 无筛选：无法快速定位
- 高度固定：不适合不同数据量

### 2.3 空结果无提示

当查询返回 `rows: []` 时，`el-table` 显示空表格，用户不清楚是"没数据"还是"加载中"。

### 2.4 历史消息兼容

旧消息的 metadata 格式可能不同：
- 旧 agentic 消息：`type:'sql_result'`，无 `data` 字段
- 旧 legacy 消息：`type:'result'`，可能有 `data` 但 `rows:[]`（DRY_RUN）
- 新消息：`type:'result'`，`data.rows` 非空

---

## 3. 任务分解

### P2-T1: ChatView 展示顺序重排 + SQL 折叠（0.5d）

**目标**：数据优先，SQL 折叠

**修改文件**：
- `frontend/src/views/ChatView.vue`

**详细设计**：

#### 3.1.1 新增数据概览卡片

在消息模板中，在文本内容之前增加数据概览卡片：

```vue
<!-- 数据概览卡片 -->
<div v-if="message.metadata?.data" class="data-summary-card">
  <div class="summary-item">
    <span class="summary-label">结果行数</span>
    <span class="summary-value">{{ message.metadata.data.rowCount || message.metadata.data.rows?.length || 0 }}</span>
  </div>
  <div class="summary-item" v-if="message.metadata.executionTime">
    <span class="summary-label">执行耗时</span>
    <span class="summary-value">{{ message.metadata.executionTime }}ms</span>
  </div>
  <div class="summary-item" v-if="message.metadata.data.truncated">
    <el-tag type="warning" size="small">结果已截断</el-tag>
  </div>
</div>
```

#### 3.1.2 数据表格上移，SQL 折叠

```vue
<!-- 数据表格（优先展示） -->
<div v-if="message.metadata?.data && message.metadata.data.rows?.length > 0" class="data-table">
  <!-- 表格组件，详见 P2-T3 -->
</div>

<!-- 空结果提示 -->
<div v-else-if="message.metadata?.data && message.metadata.data.rows?.length === 0" class="empty-result">
  <el-empty description="查询未返回数据" :image-size="60" />
</div>

<!-- 自然语言总结 -->
<div class="message-content markdown-body" v-html="renderContent(message)"></div>

<!-- SQL代码块（默认折叠） -->
<el-collapse v-if="message.metadata?.sql" class="sql-collapse">
  <el-collapse-item name="sql">
    <template #title>
      <span class="sql-toggle-title">查看生成的 SQL</span>
    </template>
    <div class="sql-block">
      <div class="sql-header">
        <span>SQL</span>
        <el-button text size="small" :icon="CopyDocument" @click="copySQL(message.metadata.sql)">
          复制
        </el-button>
      </div>
      <pre class="sql-code"><code v-html="renderSQLCode(message.metadata.sql)"></code></pre>
    </div>
  </el-collapse-item>
</el-collapse>
```

#### 3.1.3 样式调整

```css
.data-summary-card {
  display: flex;
  gap: 16px;
  padding: 8px 12px;
  margin-bottom: 8px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
}

.data-table {
  margin-bottom: 8px;
}

.sql-collapse {
  margin-top: 8px;
  border: none;
}

.sql-toggle-title {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
```

**验证步骤**：
1. 发送查询，确认数据表格在上方，SQL 在下方折叠
2. 点击 SQL 折叠区展开查看
3. 刷新页面，确认展示顺序一致

---

### P2-T2: 空结果 / 执行失败友好提示（0.5d）

**目标**：所有终端状态都有清晰的视觉反馈

**修改文件**：
- `frontend/src/views/ChatView.vue`

**详细设计**：

#### 3.2.1 空结果提示

```vue
<div v-if="message.metadata?.data && message.metadata.data.rows?.length === 0" class="empty-result">
  <el-empty description="查询未返回数据" :image-size="60">
    <template #description>
      <p>查询执行成功，但未匹配到数据</p>
      <p class="empty-hint" v-if="message.metadata?.sql">可展开 SQL 检查查询条件</p>
    </template>
  </el-empty>
</div>
```

#### 3.2.2 执行失败提示

在 session.js 的 `handleSSEMessage` 中，对 `type:'result'` 但 `success:false` 的情况：

```javascript
// session.js handleSSEMessage result 分支
if (data.data.success === false) {
  addMessage({
    role: 'assistant',
    content: data.data.error || data.data.message || '查询执行失败',
    type: 'error',
    metadata: {
      sql: data.data.sql
    }
  });
  return;
}
```

ChatView 中为 error 类型消息增加图标提示：

```vue
<div v-if="message.type === 'error'" class="error-message">
  <el-icon class="error-icon"><CircleCloseFilled /></el-icon>
  <span>{{ message.content }}</span>
</div>
```

#### 3.2.3 截断提示

当 `truncated:true` 时，在数据概览卡片中显示警告标签，并在表格底部追加提示：

```vue
<div v-if="message.metadata?.data?.truncated" class="truncation-warning">
  <el-alert
    title="结果已被截断"
    :description="`仅展示前 ${message.metadata.data.rows?.length} 行，完整结果可能更多`"
    type="warning"
    :closable="false"
    show-icon
  />
</div>
```

**验证步骤**：
1. 输入不可能匹配的查询条件 → 看到空结果提示
2. 输入超大数据集查询 → 看到截断警告
3. 制造执行错误场景 → 看到错误提示

---

### P2-T3: 数据表格分页（1d）

**目标**：大数据集支持分页浏览，不卡顿

**修改文件**：
- `frontend/src/views/ChatView.vue`

**详细设计**：

#### 3.3.1 分页 el-table 实现

将当前一次性渲染改为前端分页：

```vue
<div v-if="message.metadata?.data && message.metadata.data.rows?.length > 0" class="data-table">
  <el-table
    :data="getPagedRows(message)"
    border
    size="small"
    :max-height="400"
    style="width: 100%"
  >
    <el-table-column
      v-for="col in message.metadata.data.columns"
      :key="col"
      :prop="col"
      :label="col"
      show-overflow-tooltip
      min-width="120"
    />
  </el-table>
  <el-pagination
    v-if="message.metadata.data.rows.length > pageSize"
    class="table-pagination"
    :current-page="getCurrentPage(message.id)"
    :page-size="pageSize"
    :page-sizes="[20, 50, 100, 200]"
    :total="message.metadata.data.rows.length"
    layout="total, sizes, prev, pager, next"
    @current-change="(page) => handlePageChange(message.id, page)"
    @size-change="(size) => handleSizeChange(message.id, size)"
  />
</div>
```

#### 3.3.2 分页状态管理

```javascript
// 响应式状态
const pageSize = ref(50);
const pageStates = ref({}); // { messageId: { page: 1, size: 50 } }

function getCurrentPage(messageId) {
  return pageStates.value[messageId]?.page || 1;
}

function getPagedRows(message) {
  const rows = message.metadata?.data?.rows || [];
  const page = getCurrentPage(message.id);
  const size = pageStates.value[message.id]?.size || pageSize.value;
  const start = (page - 1) * size;
  return rows.slice(start, start + size);
}

function handlePageChange(messageId, page) {
  if (!pageStates.value[messageId]) {
    pageStates.value[messageId] = { page: 1, size: pageSize.value };
  }
  pageStates.value[messageId].page = page;
}

function handleSizeChange(messageId, size) {
  if (!pageStates.value[messageId]) {
    pageStates.value[messageId] = { page: 1, size };
  }
  pageStates.value[messageId].size = size;
  pageStates.value[messageId].page = 1;
}
```

#### 3.3.3 性能考虑

对于 1000 行数据：
- 前端分页：每次渲染 50 行 → 性能良好
- 如需虚拟滚动（>5000行）：引入 `el-table-v2`（虚拟化表格），暂不在本阶段实施

**验证步骤**：
1. 查询返回 500+ 行数据 → 确认默认每页 50 行，可翻页
2. 切换每页行数 → 确认表格更新
3. 同一对话多条查询结果 → 确认分页状态独立
4. 刷新页面 → 确认分页状态重置（预期行为）

---

### P2-T4: 历史消息数据回显兼容（0.5d）

**目标**：旧格式消息（`sql_result` / DRY_RUN空数据）正常展示

**修改文件**：
- `frontend/src/stores/session.js`
- `frontend/src/views/ChatView.vue`

**详细设计**：

#### 3.4.1 消息加载兼容

`session.js` 的 `loadMessages` 从数据库加载历史消息时，需处理多种 metadata 格式：

```javascript
// 标准化消息 metadata
function normalizeMessageMetadata(msg) {
  const meta = msg.metadata || {};
  
  // 兼容旧 sql_result 类型
  if (msg.message_type === 'sql_result' || msg.type === 'sql_result') {
    return {
      ...msg,
      type: msg.type || 'result',
      metadata: {
        sql: meta.sql,
        data: meta.data || null,  // 旧消息可能没有 data
        executionTime: meta.executionTime
      }
    };
  }
  
  return msg;
}
```

#### 3.4.2 ChatView 展示兼容

模板中的条件判断已使用可选链，对缺失字段有天然防御：

```vue
<!-- 只有 data 存在且 rows 非空才展示表格 -->
<div v-if="message.metadata?.data && message.metadata.data.rows?.length > 0">
```

旧消息没有 `data` 或 `rows` 为空 → 不展示表格，仅展示文本/SQL，符合预期。

**验证步骤**：
1. 数据库中有旧格式消息 → 刷新页面不报错
2. 旧消息只显示 SQL 和文本，不显示空表格
3. 新消息正常显示数据表格

---

## 4. 文件变更清单

| 文件 | 变更类型 | 任务 |
|------|---------|------|
| `frontend/src/views/ChatView.vue` | 展示顺序+分页+提示 | P2-T1/T2/T3 |
| `frontend/src/stores/session.js` | metadata兼容+executionTime透传 | P2-T4 |
| `frontend/src/styles/global.css` | 新增数据概览/分页样式 | P2-T1/T3 |

---

## 5. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 展示顺序切换用户不适应 | SQL 折叠仍可一键展开 |
| 分页状态与消息绑定增加内存 | 使用 Map + 惰性初始化，开销极小 |
| 旧消息 metadata 格式多样 | 可选链 + 默认值兜底 |

**回滚方案**：恢复 ChatView 模板中组件的原始顺序，移除分页组件。

---

## 6. 验收标准

1. ✅ 数据表格在消息中优先展示（在文本和 SQL 之前）
2. ✅ SQL 代码默认折叠，可展开
3. ✅ 空结果有友好提示，错误有明确反馈
4. ✅ 大数据集支持分页（每页 20/50/100/200 可选）
5. ✅ 截断结果有警告提示
6. ✅ 历史消息正常回显，不报错
