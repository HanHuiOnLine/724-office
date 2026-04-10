<template>
  <!-- 
    查询历史页面
    展示用户的查询记录
  -->
  <div class="history-container">
    <!-- 页面标题 -->
    <div class="page-header">
      <h2>查询历史</h2>
      <el-button :icon="Refresh" @click="loadHistory">刷新</el-button>
    </div>
    
    <!-- 筛选条件 -->
    <div class="filter-bar">
      <el-input
        v-model="filter.query"
        placeholder="搜索查询内容"
        :prefix-icon="Search"
        clearable
        style="width: 300px"
      />
      <el-select v-model="filter.status" placeholder="状态" clearable style="width: 120px">
        <el-option label="成功" value="success" />
        <el-option label="失败" value="failed" />
      </el-select>
      <el-date-picker
        v-model="filter.dateRange"
        type="daterange"
        range-separator="至"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        style="width: 240px"
      />
    </div>
    
    <!-- 历史列表 -->
    <div class="history-list">
      <el-skeleton v-if="loading" :rows="5" animated />
      
      <el-empty v-else-if="!filteredHistory.length" description="暂无查询记录" />
      
      <div v-else>
        <div
          v-for="item in filteredHistory"
          :key="item.id"
          class="history-item"
          @click="viewDetail(item)"
        >
          <!-- 查询内容 -->
          <div class="query-content">
            <div class="query-text">{{ item.natural_query }}</div>
            <div class="query-time">{{ formatTime(item.created_at) }}</div>
          </div>
          
          <!-- 状态 -->
          <div class="query-status">
            <el-tag :type="item.status === 'success' ? 'success' : 'danger'">
              {{ item.status === 'success' ? '成功' : '失败' }}
            </el-tag>
          </div>
          
          <!-- 执行信息 -->
          <div class="query-info">
            <span v-if="item.execution_time">{{ item.execution_time }}ms</span>
            <span v-if="item.row_count">{{ item.row_count }}条</span>
          </div>
          
          <!-- 操作 -->
          <div class="query-actions">
            <el-button text :icon="View" @click.stop="viewDetail(item)">查看</el-button>
            <el-button text :icon="CopyDocument" @click.stop="copyQuery(item)">复制</el-button>
          </div>
        </div>
        
        <!-- 分页 -->
        <div class="pagination">
          <el-pagination
            v-model:current-page="pagination.page"
            v-model:page-size="pagination.pageSize"
            :total="pagination.total"
            :page-sizes="[10, 20, 50]"
            layout="total, sizes, prev, pager, next"
            @size-change="handleSizeChange"
            @current-change="handlePageChange"
          />
        </div>
      </div>
    </div>
    
    <!-- 详情弹窗 -->
    <el-dialog
      v-model="detailVisible"
      title="查询详情"
      width="700px"
    >
      <div v-if="selectedItem" class="detail-content">
        <div class="detail-row">
          <label>查询内容：</label>
          <div class="detail-value">{{ selectedItem.natural_query }}</div>
        </div>
        
        <div class="detail-row">
          <label>生成SQL：</label>
          <pre class="sql-code">{{ selectedItem.generated_sql }}</pre>
        </div>
        
        <div class="detail-row">
          <label>状态：</label>
          <el-tag :type="selectedItem.status === 'success' ? 'success' : 'danger'">
            {{ selectedItem.status === 'success' ? '成功' : '失败' }}
          </el-tag>
        </div>
        
        <div v-if="selectedItem.error_message" class="detail-row">
          <label>错误信息：</label>
          <div class="error-message">{{ selectedItem.error_message }}</div>
        </div>
        
        <div class="detail-row">
          <label>执行时间：</label>
          <span>{{ selectedItem.execution_time }}ms</span>
        </div>
        
        <div class="detail-row">
          <label>返回行数：</label>
          <span>{{ selectedItem.row_count }}</span>
        </div>
        
        <div class="detail-row">
          <label>查询时间：</label>
          <span>{{ formatTime(selectedItem.created_at) }}</span>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
/**
 * 查询历史页面脚本
 */

// ============================================
// 导入依赖
// ============================================

// 从Vue导入响应式API
import { ref, computed, onMounted } from 'vue'
// 导入Element Plus图标
import { Refresh, Search, View, CopyDocument } from '@element-plus/icons-vue'
// 导入Element Plus消息组件
import { ElMessage } from 'element-plus'
// 导入日期处理库
import dayjs from 'dayjs'
// 导入API服务
import * as api from '../utils/api'

// ============================================
// 响应式状态
// ============================================

// 加载状态
const loading = ref(false)
// 历史记录列表
const historyList = ref([])
// 筛选条件
const filter = ref({
  query: '',
  status: '',
  dateRange: null
})
// 分页信息
const pagination = ref({
  page: 1,
  pageSize: 20,
  total: 0
})
// 详情弹窗显示状态
const detailVisible = ref(false)
// 选中的记录
const selectedItem = ref(null)

// ============================================
// 计算属性
// ============================================

/**
 * 过滤后的历史记录
 */
const filteredHistory = computed(() => {
  let result = historyList.value
  
  // 按查询内容筛选
  if (filter.value.query) {
    const query = filter.value.query.toLowerCase()
    result = result.filter(item => 
      item.natural_query.toLowerCase().includes(query)
    )
  }
  
  // 按状态筛选
  if (filter.value.status) {
    result = result.filter(item => item.status === filter.value.status)
  }
  
  // 按日期范围筛选
  if (filter.value.dateRange && filter.value.dateRange.length === 2) {
    const startDate = dayjs(filter.value.dateRange[0]).startOf('day')
    const endDate = dayjs(filter.value.dateRange[1]).endOf('day')
    result = result.filter(item => {
      const itemDate = dayjs(item.created_at)
      return itemDate.isAfter(startDate) && itemDate.isBefore(endDate)
    })
  }
  
  return result
})

// ============================================
// 方法
// ============================================

/**
 * 加载查询历史
 */
async function loadHistory() {
  loading.value = true
  
  try {
    const response = await api.getQueryHistory({
      limit: pagination.value.pageSize,
      offset: (pagination.value.page - 1) * pagination.value.pageSize
    })
    
    historyList.value = response.history || []
    pagination.value.total = response.count || 0
  } catch (error) {
    console.error('加载查询历史失败:', error)
    ElMessage.error('加载失败')
  } finally {
    loading.value = false
  }
}

/**
 * 格式化时间
 * @param {string} time - 时间字符串
 * @returns {string} 格式化后的时间
 */
function formatTime(time) {
  return dayjs(time).format('YYYY-MM-DD HH:mm:ss')
}

/**
 * 查看详情
 * @param {Object} item - 历史记录项
 */
function viewDetail(item) {
  selectedItem.value = item
  detailVisible.value = true
}

/**
 * 复制查询
 * @param {Object} item - 历史记录项
 */
function copyQuery(item) {
  navigator.clipboard.writeText(item.natural_query).then(() => {
    ElMessage.success('查询内容已复制')
  })
}

/**
 * 处理分页大小变化
 * @param {number} size - 每页条数
 */
function handleSizeChange(size) {
  pagination.value.pageSize = size
  loadHistory()
}

/**
 * 处理页码变化
 * @param {number} page - 当前页码
 */
function handlePageChange(page) {
  pagination.value.page = page
  loadHistory()
}

// ============================================
// 生命周期钩子
// ============================================

onMounted(() => {
  loadHistory()
})
</script>

<style scoped>
/**
 * 组件样式
 */

/* 页面容器 */
.history-container {
  padding: 24px;
}

/* 页面标题 */
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.page-header h2 {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
}

/* 筛选栏 */
.filter-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 24px;
  padding: 16px;
  background-color: #f5f7fa;
  border-radius: 8px;
}

/* 历史列表 */
.history-list {
  background-color: #ffffff;
  border-radius: 8px;
}

/* 历史项 */
.history-item {
  display: flex;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid #e4e7ed;
  cursor: pointer;
  transition: background-color 0.2s;
}

.history-item:hover {
  background-color: #f5f7fa;
}

/* 查询内容 */
.query-content {
  flex: 1;
}

.query-text {
  font-size: 14px;
  color: #303133;
  margin-bottom: 4px;
}

.query-time {
  font-size: 12px;
  color: #909399;
}

/* 状态 */
.query-status {
  width: 80px;
  text-align: center;
}

/* 执行信息 */
.query-info {
  width: 150px;
  text-align: center;
  color: #606266;
  font-size: 13px;
}

.query-info span {
  margin: 0 8px;
}

/* 操作按钮 */
.query-actions {
  width: 150px;
  text-align: right;
}

/* 分页 */
.pagination {
  display: flex;
  justify-content: flex-end;
  padding: 16px;
}

/* 详情内容 */
.detail-content {
  padding: 16px;
}

.detail-row {
  margin-bottom: 16px;
}

.detail-row label {
  display: block;
  font-weight: 600;
  color: #606266;
  margin-bottom: 8px;
}

.detail-value {
  padding: 12px;
  background-color: #f5f7fa;
  border-radius: 4px;
}

.sql-code {
  padding: 12px;
  background-color: #f5f7fa;
  border-radius: 4px;
  font-family: 'Courier New', monospace;
  font-size: 13px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.error-message {
  padding: 12px;
  background-color: #fef0f0;
  color: #f56c6c;
  border-radius: 4px;
}
</style>
