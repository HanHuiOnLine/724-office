<template>
  <!-- 
    聊天页面视图
    实现自然语言数据查询的对话界面
  -->
  <div class="chat-container">
    <!-- 消息列表区域 -->
    <div ref="messagesContainer" class="messages-area">
      <!-- 欢迎消息 -->
      <div v-if="messages.length === 0" class="welcome-message">
        <el-icon class="welcome-icon"><ChatDotRound /></el-icon>
        <h3>有什么可以帮您的？</h3>
        <p>试着问我："查一下上个月的销售额"</p>
      </div>
      
      <!-- 消息列表 -->
      <div 
        v-for="(message, index) in messages" 
        :key="index"
        class="message-wrapper"
        :class="message.role"
      >
        <!-- 用户消息 -->
        <div v-if="message.role === 'user'" class="message user">
          <div class="message-content">
            {{ message.content }}
          </div>
        </div>
        
        <!-- 助手消息 -->
        <div v-else class="message assistant">
          <el-avatar :size="36" :icon="UserFilled" class="avatar" />
          <div class="message-body">
            <!-- 文本内容 -->
            <div class="message-content" v-html="renderContent(message)"></div>
            
            <!-- SQL代码块 -->
            <div v-if="message.metadata?.sql" class="sql-block">
              <div class="sql-header">
                <span>生成的SQL</span>
                <el-button 
                  text 
                  size="small" 
                  :icon="CopyDocument"
                  @click="copySQL(message.metadata.sql)"
                >
                  复制
                </el-button>
              </div>
              <pre class="sql-code"><code>{{ message.metadata.sql }}</code></pre>
            </div>
            
            <!-- 数据表格 -->
            <div v-if="message.metadata?.data" class="data-table">
              <el-table 
                :data="message.metadata.data.rows" 
                border
                size="small"
                max-height="300"
              >
                <el-table-column 
                  v-for="col in message.metadata.data.columns" 
                  :key="col"
                  :prop="col"
                  :label="col"
                  show-overflow-tooltip
                />
              </el-table>
            </div>
          </div>
        </div>
      </div>
      
      <!-- 正在输入指示器 -->
      <div v-if="isProcessing" class="typing-indicator">
        <el-avatar :size="36" :icon="UserFilled" class="avatar" />
        <div class="typing-dots">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>
    </div>
    
    <!-- 输入区域 -->
    <div class="input-area">
      <div class="input-wrapper">
        <el-input
          v-model="inputMessage"
          type="textarea"
          :rows="2"
          placeholder="输入您的数据查询需求，例如：查一下上个月的销售额"
          resize="none"
          @keydown.enter.prevent="handleEnter"
        />
        <div class="input-actions">
          <el-button 
            type="primary" 
            :icon="Promotion"
            :disabled="!inputMessage.trim() || isProcessing"
            @click="sendMessage"
          >
            发送
          </el-button>
        </div>
      </div>
      <div class="input-hint">
        按 Enter 发送，Shift + Enter 换行
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 聊天页面组件脚本
 */

// ============================================
// 导入依赖
// ============================================

// 从Vue导入响应式API和生命周期钩子
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
// 从Vue Router导入路由相关API
import { useRoute } from 'vue-router'
// 导入Element Plus图标
import { ChatDotRound, UserFilled, Promotion, CopyDocument } from '@element-plus/icons-vue'
// 导入Element Plus消息组件
import { ElMessage } from 'element-plus'
// 导入会话状态管理
import { useSessionStore } from '../stores/session'
// 导入marked库用于渲染Markdown
import { marked } from 'marked'

// ============================================
// 响应式状态
// ============================================

// 输入框内容
const inputMessage = ref('')
// 消息容器DOM引用，用于自动滚动
const messagesContainer = ref(null)

// ============================================
// 状态管理
// ============================================

// 获取会话状态管理store
const sessionStore = useSessionStore()
// 从store获取消息列表
const messages = sessionStore.messages
// 从store获取处理状态
const isProcessing = sessionStore.isProcessing

// ============================================
// 路由
// ============================================

// 获取当前路由信息
const route = useRoute()

// ============================================
// 方法
// ============================================

/**
 * 发送消息
 */
function sendMessage() {
  // 获取输入内容并去除首尾空白
  const content = inputMessage.value.trim()
  
  // 检查输入是否为空
  if (!content) return
  
  // 检查是否正在处理
  if (isProcessing.value) return
  
  // 通过WebSocket发送查询
  sessionStore.sendQuery(content)
  
  // 清空输入框
  inputMessage.value = ''
  
  // 滚动到底部
  scrollToBottom()
}

/**
 * 处理键盘事件
 * Enter发送，Shift+Enter换行
 */
function handleEnter(e) {
  // 如果按下了Shift键，允许换行
  if (e.shiftKey) {
    return
  }
  // 否则发送消息
  sendMessage()
}

/**
 * 渲染消息内容
 * 将Markdown转为HTML
 */
function renderContent(message) {
  if (!message.content) return ''
  
  // 使用marked将Markdown转为HTML
  // 注意：实际生产环境需要做好XSS防护
  return marked(message.content)
}

/**
 * 复制SQL到剪贴板
 */
function copySQL(sql) {
  // 使用Clipboard API复制文本
  navigator.clipboard.writeText(sql).then(() => {
    ElMessage.success('SQL已复制到剪贴板')
  }).catch(() => {
    ElMessage.error('复制失败')
  })
}

/**
 * 滚动消息列表到底部
 */
function scrollToBottom() {
  // 使用nextTick确保DOM已更新
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

// ============================================
// 生命周期钩子
// ============================================

/**
 * 组件挂载时执行
 */
onMounted(() => {
  // 获取路由参数中的会话ID
  const sessionId = route.params.sessionId
  
  if (sessionId) {
    // 设置当前会话
    sessionStore.setCurrentSession(sessionId)
    // 连接WebSocket
    sessionStore.connectWebSocket()
  }
  
  // 滚动到底部
  scrollToBottom()
})

/**
 * 组件卸载时执行
 */
onUnmounted(() => {
  // 断开WebSocket连接
  sessionStore.disconnectWebSocket()
})

// ============================================
// 监听器
// ============================================

/**
 * 监听消息变化，自动滚动到底部
 */
watch(messages, () => {
  scrollToBottom()
}, { deep: true })

/**
 * 监听处理状态变化
 */
watch(isProcessing, (newVal) => {
  if (!newVal) {
    // 处理完成，滚动到底部
    scrollToBottom()
  }
})
</script>

<style scoped>
/**
 * 组件样式
 */

/* 聊天容器 */
.chat-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: #ffffff;
}

/* 消息列表区域 */
.messages-area {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  padding-bottom: 100px;
}

/* 欢迎消息 */
.welcome-message {
  text-align: center;
  padding: 60px 20px;
  color: #909399;
}

.welcome-icon {
  font-size: 64px;
  color: #409eff;
  margin-bottom: 20px;
}

.welcome-message h3 {
  font-size: 24px;
  font-weight: 500;
  color: #303133;
  margin-bottom: 12px;
}

/* 消息包装器 */
.message-wrapper {
  margin-bottom: 20px;
}

.message-wrapper.user {
  display: flex;
  justify-content: flex-end;
}

/* 消息气泡 */
.message {
  max-width: 80%;
}

.message.user .message-content {
  background-color: #409eff;
  color: white;
  padding: 12px 16px;
  border-radius: 8px 8px 2px 8px;
  word-break: break-word;
}

.message.assistant {
  display: flex;
  align-items: flex-start;
}

.message.assistant .avatar {
  margin-right: 12px;
  background-color: #409eff;
}

.message-body {
  flex: 1;
  background-color: #f4f4f5;
  padding: 12px 16px;
  border-radius: 8px;
  border-top-left-radius: 2px;
}

.message-content {
  color: #303133;
  line-height: 1.6;
}

/* SQL代码块 */
.sql-block {
  margin-top: 12px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  overflow: hidden;
}

.sql-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background-color: #f5f7fa;
  border-bottom: 1px solid #dcdfe6;
  font-size: 12px;
  color: #606266;
}

.sql-code {
  margin: 0;
  padding: 12px;
  background-color: #fafafa;
  font-family: 'Courier New', monospace;
  font-size: 13px;
  overflow-x: auto;
}

/* 数据表格 */
.data-table {
  margin-top: 12px;
}

/* 正在输入指示器 */
.typing-indicator {
  display: flex;
  align-items: center;
  margin-bottom: 20px;
}

.typing-indicator .avatar {
  margin-right: 12px;
  background-color: #409eff;
}

.typing-dots {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 12px 16px;
  background-color: #f4f4f5;
  border-radius: 8px;
}

.typing-dots span {
  width: 8px;
  height: 8px;
  background-color: #909399;
  border-radius: 50%;
  animation: typing 1.4s infinite ease-in-out both;
}

.typing-dots span:nth-child(1) {
  animation-delay: -0.32s;
}

.typing-dots span:nth-child(2) {
  animation-delay: -0.16s;
}

@keyframes typing {
  0%, 80%, 100% {
    transform: scale(0);
  }
  40% {
    transform: scale(1);
  }
}

/* 输入区域 */
.input-area {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 20px;
  background-color: #ffffff;
  border-top: 1px solid #e4e7ed;
}

.input-wrapper {
  display: flex;
  gap: 12px;
  max-width: 800px;
  margin: 0 auto;
}

.input-wrapper .el-textarea {
  flex: 1;
}

.input-actions {
  display: flex;
  align-items: flex-end;
}

.input-hint {
  text-align: center;
  margin-top: 8px;
  font-size: 12px;
  color: #909399;
}
</style>
