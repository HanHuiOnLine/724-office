<template>
  <!-- 
    首页视图
    展示欢迎信息和快速开始入口
  -->
  <div class="home-container">
    <!-- 欢迎区域 -->
    <div class="welcome-section">
      <el-icon class="welcome-icon"><DataLine /></el-icon>
      <h1 class="welcome-title">自然语言提数工具</h1>
      <p class="welcome-subtitle">
        通过自然语言描述，智能生成SQL查询，快速获取数据洞察
      </p>
      
      <!-- 快速开始按钮 -->
      <div class="quick-start">
        <el-button 
          type="primary" 
          size="large" 
          :icon="ChatDotRound"
          @click="startChat"
        >
          开始对话
        </el-button>
        <el-button 
          size="large" 
          :icon="Grid"
          @click="viewSchema"
        >
          查看数据Schema
        </el-button>
      </div>
    </div>
    
    <!-- 功能特性 -->
    <div class="features-section">
      <h2 class="section-title">功能特性</h2>
      <div class="features-grid">
        <!-- 特性1 -->
        <div class="feature-card">
          <el-icon class="feature-icon"><ChatLineRound /></el-icon>
          <h3 class="feature-title">自然语言查询</h3>
          <p class="feature-desc">
            无需编写SQL，用自然语言描述数据需求，系统自动理解并生成查询
          </p>
        </div>
        
        <!-- 特性2 -->
        <div class="feature-card">
          <el-icon class="feature-icon"><Cpu /></el-icon>
          <h3 class="feature-title">智能澄清</h3>
          <p class="feature-desc">
            当需求不明确时，系统会主动询问，确保理解准确
          </p>
        </div>
        
        <!-- 特性3 -->
        <div class="feature-card">
          <el-icon class="feature-icon"><Lock /></el-icon>
          <h3 class="feature-title">安全可靠</h3>
          <p class="feature-desc">
            只读查询，严格权限控制，保障数据安全
          </p>
        </div>
        
        <!-- 特性4 -->
        <div class="feature-card">
          <el-icon class="feature-icon"><TrendCharts /></el-icon>
          <h3 class="feature-title">可视化展示</h3>
          <p class="feature-desc">
            支持表格、图表等多种方式展示查询结果
          </p>
        </div>
      </div>
    </div>
    
    <!-- 使用示例 -->
    <div class="examples-section">
      <h2 class="section-title">使用示例</h2>
      <div class="examples-list">
        <div 
          v-for="example in examples" 
          :key="example"
          class="example-item"
          @click="useExample(example)"
        >
          <el-icon><ArrowRight /></el-icon>
          <span>{{ example }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 首页组件脚本
 */

// ============================================
// 导入依赖
// ============================================

// 导入Vue Router
import { useRouter } from 'vue-router'
// 导入Element Plus消息组件
import { ElMessage } from 'element-plus'
// 导入Element Plus图标
import { 
  DataLine, 
  ChatDotRound, 
  Grid, 
  ChatLineRound, 
  Cpu, 
  Lock, 
  TrendCharts,
  ArrowRight 
} from '@element-plus/icons-vue'
// 导入会话状态管理
import { useSessionStore } from '../stores/session'

// ============================================
// 响应式数据
// ============================================

/**
 * 使用示例列表
 */
const examples = [
  '查一下上个月的销售额',
  '各地区的订单数量对比',
  'VIP用户的平均消费金额',
  '最近7天的销售趋势'
]

// ============================================
// 路由和状态管理
// ============================================

// 获取路由实例
const router = useRouter()
// 获取会话状态管理
const sessionStore = useSessionStore()

// ============================================
// 方法
// ============================================

/**
 * 开始对话
 * 创建新会话并跳转到聊天页面
 */
async function startChat() {
  try {
    // 创建新会话
    const sessionId = await sessionStore.createSession()
    // 跳转到聊天页面
    router.push(`/chat/${sessionId}`)
  } catch (error) {
    ElMessage.error('创建会话失败，请重试')
    console.error('创建会话失败:', error)
  }
}

/**
 * 查看数据Schema
 */
function viewSchema() {
  router.push('/schema')
}

/**
 * 使用示例
 * @param {string} example - 示例文本
 */
async function useExample(example) {
  try {
    // 创建新会话
    const sessionId = await sessionStore.createSession()
    // 跳转到聊天页面
    router.push(`/chat/${sessionId}`)
    // 注意：实际发送示例需要在ChatView组件中处理
  } catch (error) {
    ElMessage.error('创建会话失败，请重试')
    console.error('创建会话失败:', error)
  }
}
</script>

<style scoped>
/**
 * 组件样式
 */

/* 首页容器 */
.home-container {
  height: 100%;
  overflow-y: auto;
  padding: 40px;
}

/* 欢迎区域 */
.welcome-section {
  text-align: center;
  padding: 60px 0;
  border-bottom: 1px solid #e4e7ed;
}

.welcome-icon {
  font-size: 80px;
  color: #409eff;
  margin-bottom: 24px;
}

.welcome-title {
  font-size: 36px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 16px;
}

.welcome-subtitle {
  font-size: 18px;
  color: #606266;
  margin-bottom: 32px;
}

.quick-start {
  display: flex;
  justify-content: center;
  gap: 16px;
}

/* 功能特性区域 */
.features-section {
  padding: 60px 0;
  border-bottom: 1px solid #e4e7ed;
}

.section-title {
  text-align: center;
  font-size: 24px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 40px;
}

.features-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 24px;
  max-width: 1000px;
  margin: 0 auto;
}

.feature-card {
  text-align: center;
  padding: 32px 24px;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  transition: all 0.3s;
}

.feature-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  transform: translateY(-2px);
}

.feature-icon {
  font-size: 48px;
  color: #409eff;
  margin-bottom: 16px;
}

.feature-title {
  font-size: 18px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 8px;
}

.feature-desc {
  font-size: 14px;
  color: #606266;
  line-height: 1.6;
}

/* 使用示例区域 */
.examples-section {
  padding: 60px 0;
}

.examples-list {
  max-width: 600px;
  margin: 0 auto;
}

.example-item {
  display: flex;
  align-items: center;
  padding: 16px 20px;
  margin-bottom: 12px;
  background-color: #f5f7fa;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.3s;
}

.example-item:hover {
  background-color: #ecf5ff;
  color: #409eff;
}

.example-item .el-icon {
  margin-right: 12px;
}
</style>
