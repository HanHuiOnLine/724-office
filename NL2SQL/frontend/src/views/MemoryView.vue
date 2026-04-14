<template>
  <div class="memory-view">
    <div class="memory-header">
      <h1>长期记忆管理</h1>
      <div class="user-selector">
        <label>用户ID:</label>
        <input v-model="userId" type="text" placeholder="anonymous" />
        <button @click="loadMemoryData" class="btn-primary">加载数据</button>
      </div>
    </div>

    <div v-if="loading" class="loading">
      <div class="spinner"></div>
      <span>加载中...</span>
    </div>

    <div v-else-if="error" class="error-message">
      {{ error }}
    </div>

    <div v-else-if="memoryData" class="memory-content">
      <!-- 统计卡片 -->
      <div class="stats-cards">
        <div class="stat-card">
          <div class="stat-value">{{ memoryData.total_count }}</div>
          <div class="stat-label">总记录数</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ groupedData.field_alias?.length || 0 }}</div>
          <div class="stat-label">字段别名</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ groupedData.query_pattern?.length || 0 }}</div>
          <div class="stat-label">查询模式</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ groupedData.metric_preference?.length || 0 }}</div>
          <div class="stat-label">常用指标</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ groupedData.dimension_preference?.length || 0 }}</div>
          <div class="stat-label">常用维度</div>
        </div>
      </div>

      <!-- 类型筛选 -->
      <div class="type-filter">
        <button 
          v-for="type in memoryTypes" 
          :key="type.value"
          :class="['filter-btn', { active: selectedType === type.value }]"
          @click="selectedType = type.value"
        >
          {{ type.label }} ({{ groupedData[type.value]?.length || 0 }})
        </button>
      </div>

      <!-- 字段别名表格 -->
      <div v-if="selectedType === 'field_alias'" class="memory-section">
        <h2>字段别名映射</h2>
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>用户术语</th>
                <th>映射类型</th>
                <th>目标值</th>
                <th>使用次数</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in groupedData.field_alias" :key="item.id">
                <td>{{ item.id }}</td>
                <td class="highlight">{{ item.content?.user_term }}</td>
                <td>
                  <span :class="['type-badge', item.content?.field_type || 'unknown']">
                    {{ item.content?.field_type || 'unknown' }}
                  </span>
                </td>
                <td class="highlight-value">{{ item.content?.schema_field }}</td>
                <td>{{ item.usage_count }}</td>
                <td>{{ formatDate(item.created_at) }}</td>
                <td>
                  <button @click="deleteItem(item.id)" class="btn-delete">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 查询模式表格 -->
      <div v-if="selectedType === 'query_pattern'" class="memory-section">
        <h2>查询模式</h2>
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>模式名称</th>
                <th>维度</th>
                <th>指标</th>
                <th>使用次数</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in groupedData.query_pattern" :key="item.id">
                <td>{{ item.id }}</td>
                <td>{{ item.content?.name }}</td>
                <td>{{ item.content?.dimensions?.join(', ') }}</td>
                <td>{{ item.content?.metrics?.join(', ') }}</td>
                <td>{{ item.usage_count }}</td>
                <td>
                  <button @click="deleteItem(item.id)" class="btn-delete">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 常用指标表格 -->
      <div v-if="selectedType === 'metric_preference'" class="memory-section">
        <h2>常用指标</h2>
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>指标名称</th>
                <th>使用次数</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in groupedData.metric_preference" :key="item.id">
                <td>{{ item.id }}</td>
                <td>{{ item.content?.field_name }}</td>
                <td>{{ item.usage_count }}</td>
                <td>
                  <button @click="deleteItem(item.id)" class="btn-delete">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 常用维度表格 -->
      <div v-if="selectedType === 'dimension_preference'" class="memory-section">
        <h2>常用维度</h2>
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>维度名称</th>
                <th>使用次数</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in groupedData.dimension_preference" :key="item.id">
                <td>{{ item.id }}</td>
                <td>{{ item.content?.field_name }}</td>
                <td>{{ item.usage_count }}</td>
                <td>
                  <button @click="deleteItem(item.id)" class="btn-delete">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 原始数据查看 -->
      <div class="memory-section">
        <h2>原始数据 (JSON)</h2>
        <div class="json-viewer">
          <pre>{{ JSON.stringify(memoryData.data?.all || [], null, 2) }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import axios from 'axios'

const userId = ref('anonymous')
const loading = ref(false)
const error = ref(null)
const memoryData = ref(null)
const selectedType = ref('field_alias')

const memoryTypes = [
  { value: 'field_alias', label: '字段别名' },
  { value: 'query_pattern', label: '查询模式' },
  { value: 'metric_preference', label: '常用指标' },
  { value: 'dimension_preference', label: '常用维度' }
]

const groupedData = computed(() => {
  return memoryData.value?.data?.grouped || {}
})

const loadMemoryData = async () => {
  loading.value = true
  error.value = null
  
  try {
    const response = await axios.get(`/api/preferences/${userId.value}/raw`)
    if (response.data.success) {
      memoryData.value = response.data
    } else {
      error.value = response.data.error || '加载失败'
    }
  } catch (err) {
    error.value = err.response?.data?.error || err.message || '请求失败'
  } finally {
    loading.value = false
  }
}

const deleteItem = async (id) => {
  if (!confirm('确定要删除这条记录吗？')) return
  
  try {
    const response = await axios.delete(`/api/preferences/${id}`)
    if (response.data.success) {
      await loadMemoryData()
    } else {
      alert('删除失败: ' + response.data.error)
    }
  } catch (err) {
    alert('删除失败: ' + (err.response?.data?.error || err.message))
  }
}

const formatDate = (dateStr) => {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  return date.toLocaleString('zh-CN')
}

onMounted(() => {
  loadMemoryData()
})
</script>

<style scoped>
.memory-view {
  padding: 20px;
  max-width: 1400px;
  margin: 0 auto;
  height: 100vh;
  overflow-y: auto;
  box-sizing: border-box;
}

.memory-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid #e0e0e0;
}

.memory-header h1 {
  margin: 0;
  font-size: 24px;
  color: #333;
}

.user-selector {
  display: flex;
  align-items: center;
  gap: 12px;
}

.user-selector label {
  font-weight: 500;
  color: #666;
}

.user-selector input {
  padding: 8px 12px;
  border: 1px solid #d0d0d0;
  border-radius: 4px;
  font-size: 14px;
  width: 150px;
}

.btn-primary {
  padding: 8px 16px;
  background: #1890ff;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
}

.btn-primary:hover {
  background: #40a9ff;
}

.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px;
  color: #666;
}

.spinner {
  width: 24px;
  height: 24px;
  border: 2px solid #e0e0e0;
  border-top-color: #1890ff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.error-message {
  padding: 20px;
  background: #fff2f0;
  border: 1px solid #ffccc7;
  border-radius: 4px;
  color: #cf1322;
}

.stats-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}

.stat-card {
  background: white;
  padding: 20px;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  text-align: center;
}

.stat-value {
  font-size: 32px;
  font-weight: bold;
  color: #1890ff;
  line-height: 1;
}

.stat-label {
  margin-top: 8px;
  color: #666;
  font-size: 14px;
}

.type-filter {
  display: flex;
  gap: 8px;
  margin-bottom: 24px;
  flex-wrap: wrap;
}

.filter-btn {
  padding: 8px 16px;
  border: 1px solid #d0d0d0;
  background: white;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s;
}

.filter-btn:hover {
  border-color: #1890ff;
  color: #1890ff;
}

.filter-btn.active {
  background: #1890ff;
  color: white;
  border-color: #1890ff;
}

.memory-section {
  background: white;
  padding: 20px;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  margin-bottom: 24px;
}

.memory-section h2 {
  margin: 0 0 16px 0;
  font-size: 18px;
  color: #333;
}

.table-container {
  overflow-x: auto;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

.data-table th,
.data-table td {
  padding: 12px;
  text-align: left;
  border-bottom: 1px solid #e8e8e8;
}

.data-table th {
  background: #fafafa;
  font-weight: 600;
  color: #333;
}

.data-table tr:hover {
  background: #f5f5f5;
}

.highlight {
  font-weight: 600;
  color: #1890ff;
}

.highlight-value {
  font-family: monospace;
  background: #f6ffed;
  padding: 4px 8px;
  border-radius: 4px;
  color: #52c41a;
}

.type-badge {
  display: inline-block;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  text-transform: uppercase;
}

.type-badge.game {
  background: #e6f7ff;
  color: #1890ff;
}

.type-badge.channel {
  background: #f6ffed;
  color: #52c41a;
}

.type-badge.datasource {
  background: #fff7e6;
  color: #fa8c16;
}

.type-badge.unknown {
  background: #f5f5f5;
  color: #999;
}

.btn-delete {
  padding: 4px 12px;
  background: #ff4d4f;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.btn-delete:hover {
  background: #ff7875;
}

.json-viewer {
  background: #f6f8fa;
  padding: 16px;
  border-radius: 4px;
  overflow-x: auto;
}

.json-viewer pre {
  margin: 0;
  font-family: 'Monaco', 'Menlo', monospace;
  font-size: 12px;
  line-height: 1.5;
  color: #333;
}
</style>
