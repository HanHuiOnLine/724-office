# Phase 3 — 结果增强与交互

## 文档信息
- 版本：v1.0
- 日期：2026-04-24
- 优先级：P1（体验加分项）
- 前置依赖：Phase 2 完成
- 预计工时：3d

---

## 1. 目标

让数据「可交互、可导出、可分析」，从"看得到数据"升级为"用得好数据"：
- 表格支持列排序和文本筛选
- 支持 CSV/Excel 导出
- 数据概览卡片展示关键统计
- 智能总结增强为结构化分析

---

## 2. 任务分解

### P3-T1: 表格列排序 + 文本筛选（0.5d）

**目标**：数据表格支持按列排序和快速筛选

**修改文件**：
- `frontend/src/views/ChatView.vue`

**详细设计**：

#### 3.1.1 列排序

Element Plus `el-table` 原生支持 `sortable` 属性：

```vue
<el-table-column
  v-for="col in message.metadata.data.columns"
  :key="col"
  :prop="col"
  :label="col"
  show-overflow-tooltip
  min-width="120"
  sortable
/>
```

对于数值列，需启用远程排序以正确处理数字比较（避免 "9" > "10" 的字符串排序问题）：

```javascript
function sortMethod(a, b) {
  const va = a[sortProp];
  const vb = b[sortProp];
  // 尝试数值比较
  const na = Number(va);
  const nb = Number(vb);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  // 回退字符串比较
  return String(va).localeCompare(String(vb), 'zh-CN');
}
```

#### 3.1.2 全局文本筛选

在数据表格上方增加搜索框：

```vue
<div class="table-toolbar">
  <el-input
    v-model="getFilterText(message.id)"
    placeholder="搜索表格内容..."
    size="small"
    clearable
    prefix-icon="Search"
    class="table-filter"
    @input="(val) => handleFilterChange(message.id, val)"
  />
</div>
```

筛选逻辑：

```javascript
const filterTexts = ref({}); // { messageId: 'search text' }

function getFilteredRows(message) {
  const rows = getPagedRows(message);
  const filter = filterTexts.value[message.id]?.trim().toLowerCase();
  if (!filter) return rows;
  
  return rows.filter(row => {
    return Object.values(row).some(val => 
      String(val).toLowerCase().includes(filter)
    );
  });
}
```

**验证步骤**：
1. 点击列头排序 → 数据正确排序（数值列按大小，文本列按拼音）
2. 输入筛选文字 → 表格仅显示匹配行
3. 清空筛选 → 恢复全部数据

---

### P3-T2: CSV/Excel 导出（1d）

**目标**：支持将查询结果导出为 CSV 或 Excel 文件

**修改文件**：
- `frontend/src/views/ChatView.vue`
- `frontend/src/utils/exportHelper.js`（新增）

**详细设计**：

#### 3.2.1 导出工具模块

新建 `frontend/src/utils/exportHelper.js`：

```javascript
/**
 * 数据导出工具
 * 支持格式：CSV, XLSX
 */

// CSV 导出
export function exportToCSV(data, columns, filename = 'query-result') {
  const BOM = '\uFEFF'; // UTF-8 BOM，确保 Excel 正确识别中文
  const header = columns.join(',');
  const rows = data.map(row => 
    columns.map(col => {
      const val = row[col];
      if (val === null || val === undefined) return '';
      const str = String(val);
      // 包含逗号/引号/换行的字段需用双引号包裹
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }).join(',')
  );
  
  const csv = BOM + header + '\n' + rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, `${filename}.csv`);
}

// XLSX 导出（使用 SheetJS/xlsx 库）
export async function exportToExcel(data, columns, filename = 'query-result') {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.json_to_sheet(data, { header: columns });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '查询结果');
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
```

#### 3.2.2 导出按钮 UI

在数据概览卡片中增加导出按钮：

```vue
<div v-if="message.metadata?.data" class="data-summary-card">
  <!-- ... 现有概览信息 ... -->
  <div class="summary-actions">
    <el-dropdown @command="(cmd) => handleExport(message, cmd)">
      <el-button size="small" type="primary" plain>
        导出 <el-icon><ArrowDown /></el-icon>
      </el-button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="csv">导出 CSV</el-dropdown-item>
          <el-dropdown-item command="xlsx">导出 Excel</el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </div>
</div>
```

#### 3.2.3 导出处理函数

```javascript
import { exportToCSV, exportToExcel } from '../utils/exportHelper';

function handleExport(message, format) {
  const data = message.metadata?.data;
  if (!data || !data.rows?.length) {
    ElMessage.warning('无数据可导出');
    return;
  }
  
  const timestamp = new Date().toISOString().slice(0, 10);
  const filename = `query-result-${timestamp}`;
  
  if (format === 'csv') {
    exportToCSV(data.rows, data.columns, filename);
  } else if (format === 'xlsx') {
    exportToExcel(data.rows, data.columns, filename);
  }
}
```

#### 3.2.4 依赖安装

```bash
cd frontend
npm install xlsx --save
```

**验证步骤**：
1. 查询数据 → 点击导出 CSV → 文件下载，Excel 打开中文正常
2. 查询数据 → 点击导出 Excel → 文件下载，格式正确
3. 空结果 → 导出按钮不可用或提示"无数据"

---

### P3-T3: 数据概览卡片增强（0.5d）

**目标**：概览卡片自动展示数值列的关键统计

**修改文件**：
- `frontend/src/views/ChatView.vue`
- `frontend/src/utils/dataAnalyzer.js`（新增）

**详细设计**：

#### 3.3.1 数据分析工具

新建 `frontend/src/utils/dataAnalyzer.js`：

```javascript
/**
 * 查询结果数据分析工具
 * 自动检测数值列并计算统计指标
 */

export function analyzeData(rows, columns) {
  if (!rows || !rows.length || !columns) return null;
  
  const numericColumns = [];
  const stats = {};
  
  columns.forEach(col => {
    const values = rows.map(r => Number(r[col])).filter(v => !isNaN(v));
    if (values.length > rows.length * 0.5) { // >50% 为数值则视为数值列
      numericColumns.push(col);
      stats[col] = {
        min: Math.min(...values),
        max: Math.max(...values),
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        sum: values.reduce((a, b) => a + b, 0),
        count: values.length
      };
    }
  });
  
  return {
    totalRows: rows.length,
    numericColumns,
    stats
  };
}
```

#### 3.3.2 概览卡片增强

```vue
<div v-if="message.metadata?.data" class="data-summary-card">
  <div class="summary-item">
    <span class="summary-label">总行数</span>
    <span class="summary-value">{{ message.metadata.data.rowCount || message.metadata.data.rows?.length }}</span>
  </div>
  <div class="summary-item" v-if="message.metadata.executionTime">
    <span class="summary-label">耗时</span>
    <span class="summary-value">{{ message.metadata.executionTime }}ms</span>
  </div>
  <div class="summary-item" v-if="message.metadata.data.truncated">
    <el-tag type="warning" size="small">已截断</el-tag>
  </div>
  <!-- 数值列关键统计 -->
  <div v-for="col in getDataAnalysis(message)?.numericColumns?.slice(0, 3)" :key="col" class="summary-item">
    <span class="summary-label">{{ col }}</span>
    <span class="summary-value">
      合计: {{ formatNumber(getDataAnalysis(message).stats[col].sum) }}
      均值: {{ formatNumber(getDataAnalysis(message).stats[col].avg) }}
    </span>
  </div>
</div>
```

```javascript
import { analyzeData } from '../utils/dataAnalyzer';

const dataAnalysisCache = ref({});

function getDataAnalysis(message) {
  if (dataAnalysisCache.value[message.id]) {
    return dataAnalysisCache.value[message.id];
  }
  const data = message.metadata?.data;
  if (!data?.rows?.length) return null;
  const analysis = analyzeData(data.rows, data.columns);
  dataAnalysisCache.value[message.id] = analysis;
  return analysis;
}

function formatNumber(num) {
  if (num === undefined || num === null) return '-';
  if (Number.isInteger(num)) return num.toLocaleString();
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
```

**验证步骤**：
1. 查询含数值列 → 概览卡片显示合计/均值
2. 查询纯文本列 → 不显示数值统计
3. 多个数值列 → 最多展示前 3 个

---

### P3-T4: 智能总结增强（1d）

**目标**：resultFormatter 从"简单总结"升级为"结构化分析报告"

**修改文件**：
- `backend/src/core/resultFormatter.js`

**详细设计**：

#### 3.4.1 增强 Prompt 结构

当前 Prompt（`resultFormatter.js:17-30`）仅要求"总结查询结果"。增强为结构化输出：

```javascript
const prompt = `用户查询: "${originalQuery}"

查询结果:
- 返回行数: ${result.data.rowCount}
- 执行耗时: ${result.executionTime}ms
- 是否截断: ${result.data.truncated ? '是（仅展示部分数据）' : '否'}
- 列名: ${result.data.columns.join(', ')}
- 数据样例:
${JSON.stringify(result.data.rows.slice(0, 10), null, 2)}

请按以下结构输出分析报告：

1. **查询结论**：用一句话概括核心发现
2. **关键数据**：列出3-5个最重要的数据点（带数值）
3. **数据分布**：如有分组列，描述各组占比；如有数值列，描述范围/均值
4. **异常/趋势**：任何明显异常值、下降/上升趋势
5. **建议**：是否需要进一步查询，推荐什么方向

规则：
- 必须引用真实数据，不要编造数字
- 保持简洁，总长度不超过 200 字
- 如果数据为空，只说"未查到数据"即可`;
```

#### 3.4.2 降级策略增强

```javascript
// LLM 调用失败时的降级文本
function getFallbackSummary(result, originalQuery) {
  const rows = result.data.rows || [];
  const cols = result.data.columns || [];
  const rowCount = result.data.rowCount || rows.length;
  
  if (rowCount === 0) {
    return `查询完成，未返回数据。`;
  }
  
  let summary = `查询完成，返回 ${rowCount} 条数据`;
  if (result.data.truncated) {
    summary += `（结果已截断）`;
  }
  summary += `，耗时 ${result.executionTime}ms。`;
  summary += `\n\n列: ${cols.join(', ')}`;
  
  return summary;
}
```

#### 3.4.3 结果缓存

为相同查询结果避免重复调用 LLM：

```javascript
const formatCache = new Map();

async function formatResult(result, originalQuery) {
  if (!result.success) {
    return `查询失败: ${result.error}`;
  }

  // 缓存 key: SQL + rowCount 的组合
  const cacheKey = `${result.data?.rowCount}_${originalQuery}`;
  if (formatCache.has(cacheKey)) {
    return formatCache.get(cacheKey);
  }

  try {
    const response = await llmService.simpleChat(prompt);
    const formatted = response.trim();
    formatCache.set(cacheKey, formatted);
    // 限制缓存大小
    if (formatCache.size > 100) {
      const firstKey = formatCache.keys().next().value;
      formatCache.delete(firstKey);
    }
    return formatted;
  } catch (error) {
    logger.error('格式化结果失败:', error);
    return getFallbackSummary(result, originalQuery);
  }
}
```

**验证步骤**：
1. 查询含数值数据 → 总结包含关键数值和统计
2. 查询空结果 → 返回"未查到数据"
3. LLM 不可用 → 降级为基础文本摘要
4. 重复查询相同条件 → 第二次不额外调用 LLM

---

## 4. 文件变更清单

| 文件 | 变更类型 | 任务 |
|------|---------|------|
| `frontend/src/views/ChatView.vue` | 排序+筛选+导出+概览 | P3-T1/T2/T3 |
| `frontend/src/utils/exportHelper.js` | 新增 | P3-T2 |
| `frontend/src/utils/dataAnalyzer.js` | 新增 | P3-T3 |
| `backend/src/core/resultFormatter.js` | Prompt增强+缓存 | P3-T4 |
| `frontend/package.json` | 增加 xlsx 依赖 | P3-T2 |

---

## 5. 风险与回滚

| 风险 | 缓解 |
|------|------|
| xlsx 库体积较大（~500KB） | 使用动态 import()，按需加载 |
| 大数据集前端排序/筛选卡顿 | 限制排序/筛选在当前页数据 |
| LLM 总结增强增加延迟 | 缓存 + 异步渲染 |
| 数值列自动检测误判 | 50% 阈值 + 可配置 |

**回滚方案**：移除排序/筛选/导出组件，恢复 resultFormatter 原始 Prompt。

---

## 6. 验收标准

1. ✅ 点击列头可排序，数值列按大小排序
2. ✅ 搜索框输入文字可筛选表格内容
3. ✅ 点击"导出"按钮可下载 CSV/Excel
4. ✅ 概览卡片展示数值列合计/均值
5. ✅ 智能总结包含关键数据点和趋势分析
6. ✅ LLM 不可用时降级为基础摘要
