<template>
  <!-- 
    Schema查看页面
    完整展示数据表结构信息
  -->
  <div class="schema-page">
    <!-- 页面标题 -->
    <div class="page-header">
      <h2>数据Schema</h2>
      <el-button :icon="Refresh" @click="loadSchema">刷新</el-button>
    </div>
    
    <!-- 统计信息 -->
    <div class="stats-bar">
      <el-statistic title="表数量" :value="schemaData.tables.length" />
      <el-statistic title="指标数量" :value="schemaData.metrics.length" />
      <el-statistic title="维度数量" :value="schemaData.dimensions.length" />
    </div>
    
    <!-- 标签页 -->
    <el-tabs v-model="activeTab" class="schema-tabs">
      <!-- 表结构标签页 -->
      <el-tab-pane label="表结构" name="tables">
        <div class="tab-content-wrapper">
          <div class="table-list">
          <el-card
            v-for="table in schemaData.tables"
            :key="table.name"
            class="table-card"
            shadow="hover"
          >
            <template #header>
              <div class="table-header">
                <div class="table-title">
                  <span class="table-name">{{ table.name }}</span>
                  <span v-if="table.name_cn" class="table-name-cn">{{ table.name_cn }}</span>
                </div>
                <el-tag size="small">{{ table.fields.length }}个字段</el-tag>
              </div>
            </template>
            
            <p v-if="table.description" class="table-desc">{{ table.description }}</p>
            
            <el-table :data="table.fields" size="small" border>
              <el-table-column prop="name" label="字段名" width="150">
                <template #default="{ row }">
                  <code>{{ row.name }}</code>
                  <el-tag v-if="row.is_primary" size="small" type="danger" class="field-tag">主键</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="name_cn" label="中文名" width="120" />
              <el-table-column prop="type" label="类型" width="120">
                <template #default="{ row }">
                  <el-tag size="small" type="info">{{ row.type }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="description" label="描述" show-overflow-tooltip />
            </el-table>
          </el-card>
          </div>
        </div>
      </el-tab-pane>
      
      <!-- 指标标签页 -->
      <el-tab-pane label="指标" name="metrics">
        <div class="tab-content-wrapper">
          <el-table :data="schemaData.metrics" border>
            <el-table-column prop="name" label="指标名" width="150" />
            <el-table-column prop="name_cn" label="中文名" width="150" />
            <el-table-column prop="definition" label="定义">
              <template #default="{ row }">
                <code>{{ row.definition }}</code>
              </template>
            </el-table-column>
            <el-table-column prop="description" label="描述" />
            <el-table-column prop="unit" label="单位" width="100" />
          </el-table>
        </div>
      </el-tab-pane>
      
      <!-- 维度标签页 -->
      <el-tab-pane label="维度" name="dimensions">
        <div class="tab-content-wrapper">
          <el-table :data="schemaData.dimensions" border>
            <el-table-column prop="name" label="维度名" width="150" />
            <el-table-column prop="name_cn" label="中文名" width="150" />
            <el-table-column prop="fields" label="字段">
              <template #default="{ row }">
                <el-tag
                  v-for="field in row.fields"
                  :key="field"
                  size="small"
                  class="field-tag"
                >
                  {{ field }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="granularities" label="粒度">
              <template #default="{ row }">
                <el-tag
                  v-for="g in row.granularities"
                  :key="g"
                  size="small"
                  type="success"
                  class="field-tag"
                >
                  {{ g }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>
      
      <!-- 关系标签页 -->
      <el-tab-pane label="表关系" name="relations">
        <div class="tab-content-wrapper">
          <el-table :data="schemaData.relationships" border>
            <el-table-column prop="from" label="从表" width="200">
              <template #default="{ row }">
                <code>{{ row.from }}</code>
              </template>
            </el-table-column>
            <el-table-column width="100" align="center">
              <template #default>
                <el-icon><Right /></el-icon>
              </template>
            </el-table-column>
            <el-table-column prop="to" label="到表" width="200">
              <template #default="{ row }">
                <code>{{ row.to }}</code>
              </template>
            </el-table-column>
            <el-table-column prop="type" label="关系类型" width="120">
              <template #default="{ row }">
                <el-tag size="small">{{ row.type }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="description" label="描述" />
          </el-table>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
/**
 * Schema查看页面脚本
 */

// ============================================
// 导入依赖
// ============================================

// 从Vue导入响应式API
import { ref, onMounted } from 'vue'
// 导入Element Plus图标
import { Refresh, Right } from '@element-plus/icons-vue'
// 导入API服务
import * as api from '../utils/api'

// ============================================
// 响应式状态
// ============================================

// 当前激活的标签页
const activeTab = ref('tables')
// Schema数据
const schemaData = ref({
  tables: [],
  relationships: [],
  metrics: [],
  dimensions: []
})

// ============================================
// 方法
// ============================================

/**
 * 加载Schema数据
 */
async function loadSchema() {
  try {
    const data = await api.getSchema()
    schemaData.value = data
  } catch (error) {
    console.error('加载Schema失败:', error)
  }
}

// ============================================
// 生命周期钩子
// ============================================

onMounted(() => {
  loadSchema()
})
</script>

<style scoped>
/**
 * 组件样式
 */

/* 页面容器 */
.schema-page {
  padding: 24px;
  height: 100vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* 标签页容器 */
.schema-tabs {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

:deep(.el-tabs__content) {
  flex: 1;
  overflow: hidden;
}

:deep(.el-tab-pane) {
  height: 100%;
}

/* 标签页内容滚动容器 */
.tab-content-wrapper {
  height: calc(100vh - 260px);
  overflow-y: auto;
  padding-right: 8px;
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

/* 统计栏 */
.stats-bar {
  display: flex;
  gap: 48px;
  margin-bottom: 24px;
  padding: 24px;
  background-color: #f5f7fa;
  border-radius: 8px;
}

/* 表列表 */
.table-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(500px, 1fr));
  gap: 24px;
}

/* 表卡片 */
.table-card {
  margin-bottom: 0;
}

.table-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.table-title {
  display: flex;
  align-items: center;
  gap: 12px;
}

.table-name {
  font-weight: 600;
  font-size: 16px;
}

.table-name-cn {
  color: #606266;
  font-size: 14px;
}

.table-desc {
  color: #606266;
  font-size: 14px;
  margin-bottom: 16px;
  padding: 8px 12px;
  background-color: #f5f7fa;
  border-radius: 4px;
}

/* 字段标签 */
.field-tag {
  margin-left: 8px;
}

/* 代码样式 */
code {
  background-color: #f5f7fa;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: 'Courier New', monospace;
  font-size: 12px;
}
</style>
