<template>
  <!-- 
    评估页面
    展示向量化质量评估和历史记忆命中率统计
  -->
  <div class="evaluation-container">
    <!-- 页面头部 -->
    <div class="page-header">
      <h1 class="page-title">
        <el-icon><TrendCharts /></el-icon>
        系统评估
      </h1>
      <p class="page-desc">向量化质量评估与历史记忆命中率统计</p>
    </div>

    <!-- 配置状态提示 -->
    <el-alert
      v-if="!config.enabled"
      title="评估功能未启用"
      type="info"
      description="请在后端 .env 文件中设置 EVALUATION_ENABLED=true 以启用质量评估功能"
      show-icon
      :closable="false"
      class="config-alert"
    />

    <!-- 统计概览卡片 -->
    <div class="stats-overview">
      <el-row :gutter="20">
        <el-col :span="6">
          <el-card class="stat-card">
            <div class="stat-value">{{ vectorStats.schema.hitRate }}%</div>
            <div class="stat-label">Schema检索命中率</div>
            <div class="stat-detail">
              搜索: {{ vectorStats.schema.searches }} | 命中: {{ vectorStats.schema.hits }}
            </div>
          </el-card>
        </el-col>
        <el-col :span="6">
          <el-card class="stat-card">
            <div class="stat-value">{{ vectorStats.query.hitRate }}%</div>
            <div class="stat-label">查询历史命中率</div>
            <div class="stat-detail">
              搜索: {{ vectorStats.query.searches }} | 命中: {{ vectorStats.query.hits }}
            </div>
          </el-card>
        </el-col>
        <el-col :span="6">
          <el-card class="stat-card">
            <div class="stat-value">{{ memoryStats.overall.hitRate }}%</div>
            <div class="stat-label">长期记忆命中率</div>
            <div class="stat-detail">
              查询: {{ memoryStats.overall.totalQueries }} | 命中: {{ memoryStats.overall.totalHits }}
            </div>
          </el-card>
        </el-col>
        <el-col :span="6">
          <el-card class="stat-card actions">
            <el-button type="primary" @click="refreshStats" :loading="loading.stats">
              <el-icon><Refresh /></el-icon>
              刷新统计
            </el-button>
            <el-button @click="resetStats" :loading="loading.reset">
              <el-icon><Delete /></el-icon>
              重置数据
            </el-button>
          </el-card>
        </el-col>
      </el-row>
    </div>

    <!-- 详细统计 -->
    <div class="detail-stats">
      <el-row :gutter="20">
        <!-- 向量检索距离分布 -->
        <el-col :span="12">
          <el-card class="detail-card">
            <template #header>
              <div class="card-header">
                <span>向量检索距离分布</span>
                <el-tooltip content="距离越小表示相似度越高">
                  <el-icon><QuestionFilled /></el-icon>
                </el-tooltip>
              </div>
            </template>
            <div class="distribution-bars">
              <div class="dist-item">
                <span class="dist-label">极近 (&lt;0.3)</span>
                <el-progress 
                  :percentage="getDistPercentage('veryClose')" 
                  :color="'#67C23A'"
                  :show-text="false"
                />
                <span class="dist-value">{{ vectorStats.distanceDistribution.veryClose }}</span>
              </div>
              <div class="dist-item">
                <span class="dist-label">较近 (0.3-0.5)</span>
                <el-progress 
                  :percentage="getDistPercentage('close')" 
                  :color="'#95D475'"
                  :show-text="false"
                />
                <span class="dist-value">{{ vectorStats.distanceDistribution.close }}</span>
              </div>
              <div class="dist-item">
                <span class="dist-label">中等 (0.5-0.7)</span>
                <el-progress 
                  :percentage="getDistPercentage('moderate')" 
                  :color="'#E6A23C'"
                  :show-text="false"
                />
                <span class="dist-value">{{ vectorStats.distanceDistribution.moderate }}</span>
              </div>
              <div class="dist-item">
                <span class="dist-label">较远 (&gt;0.7)</span>
                <el-progress 
                  :percentage="getDistPercentage('far')" 
                  :color="'#F56C6C'"
                  :show-text="false"
                />
                <span class="dist-value">{{ vectorStats.distanceDistribution.far }}</span>
              </div>
            </div>
          </el-card>
        </el-col>

        <!-- 记忆类型命中率 -->
        <el-col :span="12">
          <el-card class="detail-card">
            <template #header>
              <div class="card-header">
                <span>记忆类型命中率</span>
              </div>
            </template>
            <div class="memory-types">
              <div 
                v-for="item in memoryStats.byType" 
                :key="item.type"
                class="memory-type-item"
              >
                <div class="type-info">
                  <span class="type-name">{{ getMemoryTypeName(item.type) }}</span>
                  <span class="type-count">命中: {{ item.hits }} / 未命中: {{ item.misses }}</span>
                </div>
                <div class="type-rate">
                  <el-progress 
                    :percentage="item.hitRate" 
                    :color="getHitRateColor(item.hitRate)"
                  />
                </div>
              </div>
            </div>
          </el-card>
        </el-col>
      </el-row>
    </div>

    <!-- 质量评估区域 -->
    <div class="quality-evaluation">
      <el-card>
        <template #header>
          <div class="card-header">
            <span>向量化质量评估</span>
            <el-button 
              type="primary" 
              @click="runEvaluation" 
              :loading="loading.evaluation"
              :disabled="!config.enabled"
            >
              <el-icon><VideoPlay /></el-icon>
              运行评估
            </el-button>
          </div>
        </template>

        <!-- 评估结果 -->
        <div v-if="evaluationResults.schema || evaluationResults.query" class="evaluation-results">
          <el-tabs type="border-card">
            <!-- Schema质量评估 -->
            <el-tab-pane label="Schema向量化质量">
              <div v-if="evaluationResults.schema" class="result-section">
                <div class="result-summary">
                  <el-row :gutter="20">
                    <el-col :span="6">
                      <div class="metric-box">
                        <div class="metric-value">{{ evaluationResults.schema.accuracy * 100 }}%</div>
                        <div class="metric-label">准确率</div>
                      </div>
                    </el-col>
                    <el-col :span="6">
                      <div class="metric-box">
                        <div class="metric-value">{{ evaluationResults.schema.avgPrecision }}</div>
                        <div class="metric-label">平均精确率</div>
                      </div>
                    </el-col>
                    <el-col :span="6">
                      <div class="metric-box">
                        <div class="metric-value">{{ evaluationResults.schema.avgRecall }}</div>
                        <div class="metric-label">平均召回率</div>
                      </div>
                    </el-col>
                    <el-col :span="6">
                      <div class="metric-box">
                        <div class="metric-value">{{ evaluationResults.schema.avgF1 }}</div>
                        <div class="metric-label">平均F1分数</div>
                      </div>
                    </el-col>
                  </el-row>
                </div>
                
                <el-divider />
                
                <div class="result-details">
                  <h4>详细结果</h4>
                  <el-table :data="evaluationResults.schema.details" style="width: 100%">
                    <el-table-column prop="query" label="查询" min-width="200" show-overflow-tooltip />
                    <el-table-column prop="precision" label="精确率" width="100">
                      <template #default="{ row }">
                        <el-tag :type="getScoreTagType(row.precision)">{{ row.precision }}</el-tag>
                      </template>
                    </el-table-column>
                    <el-table-column prop="recall" label="召回率" width="100">
                      <template #default="{ row }">
                        <el-tag :type="getScoreTagType(row.recall)">{{ row.recall }}</el-tag>
                      </template>
                    </el-table-column>
                    <el-table-column prop="f1Score" label="F1分数" width="100">
                      <template #default="{ row }">
                        <el-tag :type="getScoreTagType(row.f1Score)">{{ row.f1Score }}</el-tag>
                      </template>
                    </el-table-column>
                    <el-table-column prop="top1Correct" label="Top1命中" width="100">
                      <template #default="{ row }">
                        <el-icon v-if="row.top1Correct" color="#67C23A"><CircleCheck /></el-icon>
                        <el-icon v-else color="#F56C6C"><CircleClose /></el-icon>
                      </template>
                    </el-table-column>
                  </el-table>
                </div>
              </div>
            </el-tab-pane>

            <!-- 查询相似度评估 -->
            <el-tab-pane label="查询相似度评估">
              <div v-if="evaluationResults.query" class="result-section">
                <div class="result-summary">
                  <el-row :gutter="20">
                    <el-col :span="8">
                      <div class="metric-box">
                        <div class="metric-value">{{ evaluationResults.query.avgError }}</div>
                        <div class="metric-label">平均误差</div>
                      </div>
                    </el-col>
                    <el-col :span="8">
                      <div class="metric-box">
                        <div class="metric-value">{{ evaluationResults.query.highSimilarity }}</div>
                        <div class="metric-label">高相似度对</div>
                      </div>
                    </el-col>
                    <el-col :span="8">
                      <div class="metric-box">
                        <div class="metric-value">{{ evaluationResults.query.total }}</div>
                        <div class="metric-label">测试对总数</div>
                      </div>
                    </el-col>
                  </el-row>
                </div>
                
                <el-divider />
                
                <div class="result-details">
                  <h4>详细结果</h4>
                  <el-table :data="evaluationResults.query.details" style="width: 100%">
                    <el-table-column prop="query1" label="查询1" min-width="150" show-overflow-tooltip />
                    <el-table-column prop="query2" label="查询2" min-width="150" show-overflow-tooltip />
                    <el-table-column prop="expectedSimilarity" label="期望相似度" width="100" />
                    <el-table-column prop="actualSimilarity" label="实际相似度" width="100" />
                    <el-table-column prop="error" label="误差" width="100">
                      <template #default="{ row }">
                        <el-tag :type="row.error < 0.2 ? 'success' : row.error < 0.5 ? 'warning' : 'danger'">
                          {{ row.error }}
                        </el-tag>
                      </template>
                    </el-table-column>
                  </el-table>
                </div>
              </div>
            </el-tab-pane>
          </el-tabs>
        </div>

        <!-- 空状态 -->
        <el-empty 
          v-else 
          description='点击"运行评估"按钮开始质量评估'
          :image-size="120"
        />
      </el-card>
    </div>
  </div>
</template>

<script setup>
/**
 * 评估页面脚本
 * 
 * 功能：
 * 1. 展示运行时统计（向量检索命中率、记忆命中率）
 * 2. 执行向量化质量评估
 * 3. 展示评估结果
 */

import { ref, onMounted, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  TrendCharts,
  Refresh,
  Delete,
  VideoPlay,
  QuestionFilled,
  CircleCheck,
  CircleClose
} from '@element-plus/icons-vue'
import { evaluationApi } from '../utils/api'

// ============================================
// 响应式状态
// ============================================

const loading = ref({
  stats: false,
  reset: false,
  evaluation: false
})

const config = ref({
  enabled: false,
  trackStats: false
})

const vectorStats = ref({
  schema: { searches: 0, hits: 0, hitRate: 0 },
  query: { searches: 0, hits: 0, hitRate: 0 },
  distanceDistribution: {
    veryClose: 0,
    close: 0,
    moderate: 0,
    far: 0
  }
})

const memoryStats = ref({
  overall: { hitRate: 0, totalQueries: 0, totalHits: 0 },
  byType: []
})

const evaluationResults = ref({
  schema: null,
  query: null
})

// ============================================
// 计算属性
// ============================================

const totalDistCount = computed(() => {
  const dist = vectorStats.value.distanceDistribution
  return dist.veryClose + dist.close + dist.moderate + dist.far
})

// ============================================
// 方法
// ============================================

/**
 * 获取距离分布百分比
 */
function getDistPercentage(type) {
  if (totalDistCount.value === 0) return 0
  return Math.round((vectorStats.value.distanceDistribution[type] / totalDistCount.value) * 100)
}

/**
 * 获取记忆类型中文名称
 */
function getMemoryTypeName(type) {
  const names = {
    field_alias: '字段别名',
    query_pattern: '查询模式',
    metric_preference: '指标偏好',
    dimension_preference: '维度偏好'
  }
  return names[type] || type
}

/**
 * 根据命中率获取颜色
 */
function getHitRateColor(rate) {
  if (rate >= 80) return '#67C23A'
  if (rate >= 50) return '#E6A23C'
  return '#F56C6C'
}

/**
 * 根据分数获取标签类型
 */
function getScoreTagType(score) {
  if (score >= 0.8) return 'success'
  if (score >= 0.5) return 'warning'
  return 'danger'
}

/**
 * 刷新统计数据
 */
async function refreshStats() {
  loading.value.stats = true
  try {
    const res = await evaluationApi.getStats()
    if (res.success) {
      const data = res.data
      vectorStats.value = data.vectorSearch
      memoryStats.value = data.longTermMemory
      config.value = data.config
      ElMessage.success('统计数据已刷新')
    }
  } catch (error) {
    console.error('刷新统计失败:', error)
    ElMessage.error('刷新统计失败')
  } finally {
    loading.value.stats = false
  }
}

/**
 * 重置统计数据
 */
async function resetStats() {
  try {
    await ElMessageBox.confirm('确定要重置所有统计数据吗？', '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
    
    loading.value.reset = true
    const res = await evaluationApi.resetStats()
    if (res.success) {
      ElMessage.success('统计数据已重置')
      await refreshStats()
    }
  } catch (error) {
    if (error !== 'cancel') {
      console.error('重置统计失败:', error)
      ElMessage.error('重置统计失败')
    }
  } finally {
    loading.value.reset = false
  }
}

/**
 * 运行质量评估
 */
async function runEvaluation() {
  loading.value.evaluation = true
  evaluationResults.value = { schema: null, query: null }
  
  try {
    // 并行执行两个评估
    const [schemaRes, queryRes] = await Promise.all([
      evaluationApi.evaluateSchemaQuality(),
      evaluationApi.evaluateQueryQuality()
    ])
    
    if (schemaRes.success) {
      evaluationResults.value.schema = schemaRes.data
    }
    if (queryRes.success) {
      evaluationResults.value.query = queryRes.data
    }
    
    ElMessage.success('评估完成')
  } catch (error) {
    console.error('评估失败:', error)
    ElMessage.error('评估失败: ' + (error.message || '未知错误'))
  } finally {
    loading.value.evaluation = false
  }
}

// ============================================
// 生命周期
// ============================================

onMounted(() => {
  refreshStats()
})
</script>

<style scoped>
.evaluation-container {
  padding: 24px;
  max-width: 1400px;
  margin: 0 auto;
  height: 100%;
  overflow-y: auto;
}

.page-header {
  margin-bottom: 24px;
}

.page-title {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 24px;
  font-weight: 600;
  color: #303133;
  margin: 0 0 8px 0;
}

.page-desc {
  color: #909399;
  margin: 0;
}

.config-alert {
  margin-bottom: 24px;
}

.stats-overview {
  margin-bottom: 24px;
}

.stat-card {
  text-align: center;
  height: 140px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.stat-card.actions {
  display: flex;
  flex-direction: column;
  gap: 12px;
  justify-content: center;
  align-items: center;
}

.stat-value {
  font-size: 32px;
  font-weight: 700;
  color: #409eff;
  line-height: 1;
  margin-bottom: 8px;
}

.stat-label {
  font-size: 14px;
  color: #606266;
  margin-bottom: 8px;
}

.stat-detail {
  font-size: 12px;
  color: #909399;
}

.detail-stats {
  margin-bottom: 24px;
}

.detail-card {
  height: 100%;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
}

.card-header .el-icon {
  margin-left: 8px;
  color: #909399;
  cursor: help;
}

.distribution-bars {
  padding: 16px 0;
}

.dist-item {
  display: flex;
  align-items: center;
  margin-bottom: 16px;
  gap: 12px;
}

.dist-item:last-child {
  margin-bottom: 0;
}

.dist-label {
  width: 100px;
  font-size: 14px;
  color: #606266;
  flex-shrink: 0;
}

.dist-value {
  width: 50px;
  text-align: right;
  font-size: 14px;
  color: #909399;
  flex-shrink: 0;
}

.dist-item .el-progress {
  flex: 1;
}

.memory-types {
  padding: 8px 0;
}

.memory-type-item {
  margin-bottom: 20px;
}

.memory-type-item:last-child {
  margin-bottom: 0;
}

.type-info {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
}

.type-name {
  font-size: 14px;
  color: #303133;
  font-weight: 500;
}

.type-count {
  font-size: 12px;
  color: #909399;
}

.quality-evaluation {
  margin-bottom: 24px;
}

.evaluation-results {
  margin-top: 20px;
}

.result-summary {
  padding: 16px 0;
}

.metric-box {
  text-align: center;
  padding: 16px;
  background-color: #f5f7fa;
  border-radius: 8px;
}

.metric-value {
  font-size: 28px;
  font-weight: 700;
  color: #409eff;
  line-height: 1;
  margin-bottom: 8px;
}

.metric-label {
  font-size: 14px;
  color: #606266;
}

.result-details {
  padding: 16px 0;
}

.result-details h4 {
  margin: 0 0 16px 0;
  font-size: 16px;
  color: #303133;
}
</style>
