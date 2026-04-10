<template>
  <!-- 
    Schema查看组件
    以弹窗形式展示数据表结构信息
  -->
  <el-dialog
    v-model="visible"
    title="数据Schema"
    width="800px"
    :close-on-click-modal="false"
  >
    <!-- 搜索框 -->
    <div class="schema-search">
      <el-input
        v-model="searchQuery"
        placeholder="搜索表名或字段..."
        :prefix-icon="Search"
        clearable
      />
    </div>
    
    <!-- Schema内容 -->
    <div class="schema-content">
      <!-- 加载状态 -->
      <el-skeleton v-if="loading" :rows="6" animated />
      
      <!-- 空状态 -->
      <el-empty v-else-if="!schemaData.tables.length" description="暂无Schema数据" />
      
      <!-- 表列表 -->
      <div v-else class="schema-tables">
        <el-collapse v-model="activeTables">
          <el-collapse-item
            v-for="table in filteredTables"
            :key="table.name"
            :title="tableTitle(table)"
            :name="table.name"
          >
            <!-- 表描述 -->
            <p v-if="table.description" class="table-description">
              {{ table.description }}
            </p>
            
            <!-- 字段列表 -->
            <el-table :data="table.fields" size="small" border>
              <!-- 字段名 -->
              <el-table-column prop="name" label="字段名" width="150">
                <template #default="{ row }">
                  <code>{{ row.name }}</code>
                  <el-tag v-if="row.is_primary" size="small" type="danger" class="field-tag">
                    主键
                  </el-tag>
                </template>
              </el-table-column>
              
              <!-- 中文名 -->
              <el-table-column prop="name_cn" label="中文名" width="120" />
              
              <!-- 类型 -->
              <el-table-column prop="type" label="类型" width="120">
                <template #default="{ row }">
                  <el-tag size="small" type="info">{{ row.type }}</el-tag>
                </template>
              </el-table-column>
              
              <!-- 描述 -->
              <el-table-column prop="description" label="描述" show-overflow-tooltip />
            </el-table>
            
            <!-- 关联关系 -->
            <div v-if="getTableRelations(table.name).length" class="table-relations">
              <h4>关联关系</h4>
              <el-tag
                v-for="rel in getTableRelations(table.name)"
                :key="rel.from + rel.to"
                size="small"
                class="relation-tag"
              >
                {{ formatRelation(rel) }}
              </el-tag>
            </div>
          </el-collapse-item>
        </el-collapse>
      </div>
    </div>
  </el-dialog>
</template>

<script setup>
/**
 * Schema查看组件脚本
 */

// ============================================
// 导入依赖
// ============================================

// 从Vue导入响应式API
import { ref, computed, watch } from 'vue'
// 导入Element Plus图标
import { Search } from '@element-plus/icons-vue'
// 导入API服务
import * as api from '../utils/api'

// ============================================
// Props和Emits
// ============================================

/**
 * 定义组件属性
 */
const props = defineProps({
  // 控制弹窗显示/隐藏
  modelValue: {
    type: Boolean,
    default: false
  }
})

/**
 * 定义组件事件
 */
const emit = defineEmits(['update:modelValue'])

// ============================================
// 响应式状态
// ============================================

// 弹窗显示状态（使用计算属性实现v-model）
const visible = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
})

// 加载状态
const loading = ref(false)
// Schema数据
const schemaData = ref({
  tables: [],
  relationships: [],
  metrics: [],
  dimensions: []
})
// 搜索关键词
const searchQuery = ref('')
// 当前展开的表
const activeTables = ref([])

// ============================================
// 计算属性
// ============================================

/**
 * 过滤后的表列表
 * 根据搜索关键词筛选
 */
const filteredTables = computed(() => {
  // 如果没有搜索关键词，返回所有表
  if (!searchQuery.value.trim()) {
    return schemaData.value.tables
  }
  
  // 搜索关键词转小写
  const query = searchQuery.value.toLowerCase()
  
  // 过滤表
  return schemaData.value.tables.filter(table => {
    // 搜索表名
    if (table.name.toLowerCase().includes(query)) return true
    // 搜索中文名
    if (table.name_cn?.toLowerCase().includes(query)) return true
    // 搜索描述
    if (table.description?.toLowerCase().includes(query)) return true
    // 搜索字段
    if (table.fields.some(field => 
      field.name.toLowerCase().includes(query) ||
      field.name_cn?.toLowerCase().includes(query)
    )) return true
    
    return false
  })
})

// ============================================
// 方法
// ============================================

/**
 * 加载Schema数据
 */
async function loadSchema() {
  loading.value = true
  
  try {
    // 调用API获取Schema
    const data = await api.getSchema()
    schemaData.value = data
    
    // 默认展开第一个表
    if (data.tables.length > 0) {
      activeTables.value = [data.tables[0].name]
    }
  } catch (error) {
    console.error('加载Schema失败:', error)
  } finally {
    loading.value = false
  }
}

/**
 * 获取表的关联关系
 * @param {string} tableName - 表名
 * @returns {Array} 关联关系数组
 */
function getTableRelations(tableName) {
  return schemaData.value.relationships.filter(rel =>
    rel.from.startsWith(tableName) || rel.to.startsWith(tableName)
  )
}

/**
 * 格式化关联关系显示
 * @param {Object} relation - 关联关系对象
 * @returns {string} 格式化后的字符串
 */
function formatRelation(relation) {
  const fromTable = relation.from.split('.')[0]
  const toTable = relation.to.split('.')[0]
  return `${fromTable} → ${toTable}`
}

/**
 * 生成表标题
 * @param {Object} table - 表对象
 * @returns {string} 表标题
 */
function tableTitle(table) {
  if (table.name_cn) {
    return `${table.name_cn} (${table.name})`
  }
  return table.name
}

// ============================================
// 监听器
// ============================================

/**
 * 监听弹窗显示状态
 * 当弹窗打开时加载Schema数据
 */
watch(visible, (newVal) => {
  if (newVal && schemaData.value.tables.length === 0) {
    loadSchema()
  }
})
</script>

<style scoped>
/**
 * 组件样式
 */

/* 搜索框 */
.schema-search {
  margin-bottom: 20px;
}

/* Schema内容区域 */
.schema-content {
  max-height: 500px;
  overflow-y: auto;
}

/* 表描述 */
.table-description {
  color: #606266;
  font-size: 14px;
  margin-bottom: 12px;
  padding: 8px 12px;
  background-color: #f5f7fa;
  border-radius: 4px;
}

/* 字段标签 */
.field-tag {
  margin-left: 8px;
}

/* 关联关系 */
.table-relations {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #e4e7ed;
}

.table-relations h4 {
  font-size: 14px;
  color: #303133;
  margin-bottom: 12px;
}

.relation-tag {
  margin-right: 8px;
  margin-bottom: 8px;
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
