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
        :key="message.id || index"
        class="message-wrapper"
        :class="message.role"
      >
        <!-- 用户消息 -->
        <div v-if="message.role === 'user'" class="message user">
          <div class="message-content" :class="{ collapsed: isLongContent(message.content) && !isExpanded(message.id) }">
            {{ message.content }}
          </div>
          <div v-if="isLongContent(message.content)" class="expand-toggle" @click="toggleExpand(message.id)">
            <el-icon>
              <ArrowUp v-if="isExpanded(message.id)" />
              <ArrowDown v-else />
            </el-icon>
          </div>
        </div>
        
        <!-- 助手消息 -->
        <div v-else class="message assistant">
          <el-avatar :size="36" :icon="UserFilled" class="avatar" />
          <div class="message-body">
            <!-- 文本内容 -->
            <div class="message-content markdown-body" v-html="renderContent(message)"></div>
            
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
              <pre class="sql-code"><code v-html="renderSQLCode(message.metadata.sql)"></code></pre>
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

            <!-- 澄清选项 -->
            <div v-if="message.type === 'clarification' && message.metadata?.clarification" class="clarification-block">
              <div v-if="message.metadata.explanation" class="clarification-hint">
                {{ message.metadata.explanation }}
              </div>
              <div class="clarification-options">
                <el-button
                  v-for="opt in (message.metadata.clarification.options || [])"
                  :key="opt"
                  size="small"
                  :type="opt === message.metadata.clarification.defaultOption ? 'primary' : 'default'"
                  :disabled="isProcessing || answeredClarifications.has(message.id)"
                  @click="answerClarification(message, opt)"
                >
                  {{ opt }}
                </el-button>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- 处理状态指示器 -->
      <div v-if="isProcessing" class="processing-indicator">
        <el-avatar :size="36" :icon="UserFilled" class="avatar" />
        <div class="processing-body">
          <!-- 进度状态显示 -->
          <div v-if="processingStatus" class="processing-status">
            <el-icon class="status-icon"><Loading /></el-icon>
            <span class="status-text">{{ processingStatus }}</span>
          </div>
          <!-- 打字动画 -->
          <div v-else class="typing-dots">
            <span></span>
            <span></span>
            <span></span>
          </div>
          <!-- 进度条 -->
          <div v-if="processingProgress > 0" class="progress-bar">
            <div class="progress-fill" :style="{ width: processingProgress + '%' }"></div>
          </div>
        </div>
      </div>
    </div>
    
    <!-- 输入区域 -->
    <div class="input-area">
      <div class="input-wrapper">
        <el-input
          v-model="inputMessage"
          type="textarea"
          :rows="4"
          placeholder="输入您的数据查询需求，例如：查一下上个月的销售额"
          resize="none"
          @keydown.enter="handleEnter"
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
import { ref, onMounted, onUnmounted, nextTick, watch, computed } from 'vue'
// 从Vue Router导入路由相关API
import { useRoute } from 'vue-router'
// 导入Element Plus图标
import { ChatDotRound, UserFilled, Promotion, CopyDocument, Loading, ArrowUp, ArrowDown } from '@element-plus/icons-vue'
// 导入Element Plus消息组件
import { ElMessage } from 'element-plus'
// 导入会话状态管理
import { useSessionStore } from '../stores/session'
// 导入Markdown渲染工具
import { renderMarkdown, renderSQL } from '../utils/markdownRenderer'

// ============================================
// 响应式状态
// ============================================

// 输入框内容
const inputMessage = ref('')
// 消息容器DOM引用，用于自动滚动
const messagesContainer = ref(null)
// 展开状态的消息ID集合
const expandedMessages = ref(new Set())
// 已回答的澄清消息ID集合（防止重复点击）
const answeredClarifications = ref(new Set())
// 内容长度阈值（超过此长度显示折叠按钮）
const COLLAPSE_THRESHOLD = 200

// ============================================
// 状态管理
// ============================================

// 获取会话状态管理store
const sessionStore = useSessionStore()
// 从store获取消息列表 - 使用computed保持响应式
const messages = computed(() => sessionStore.messages)
// 从store获取处理状态 - 使用computed保持响应式
const isProcessing = computed(() => sessionStore.isProcessing)
// 从store获取处理状态文本
const processingStatus = computed(() => sessionStore.processingStatus)
// 从store获取处理进度
const processingProgress = computed(() => sessionStore.processingProgress)

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
  
  // 通过SSE发送查询
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
  // 如果按下了Shift键，允许换行（不阻止默认行为）
  if (e.shiftKey) {
    return
  }
  // 阻止默认行为（防止插入换行符）
  e.preventDefault()
  // 发送消息
  sendMessage()
}

/**
 * 判断内容是否需要折叠显示
 * @param {string} content - 消息内容
 * @returns {boolean} 是否需要折叠
 */
function isLongContent(content) {
  return content && content.length > COLLAPSE_THRESHOLD
}

/**
 * 判断消息是否已展开
 * @param {string} messageId - 消息ID
 * @returns {boolean} 是否已展开
 */
function isExpanded(messageId) {
  return expandedMessages.value.has(messageId)
}

/**
 * 切换消息展开/折叠状态
 * @param {string} messageId - 消息ID
 */
function toggleExpand(messageId) {
  if (expandedMessages.value.has(messageId)) {
    expandedMessages.value.delete(messageId)
  } else {
    expandedMessages.value.add(messageId)
  }
}

/**
 * 渲染消息内容
 * 将Markdown转为HTML
 */
function renderContent(message) {
  if (!message.content) return ''
  
  // 使用markdown-it渲染Markdown
  return renderMarkdown(message.content)
}

/**
 * 渲染SQL代码
 * 使用Shiki进行代码高亮
 */
function renderSQLCode(sql) {
  if (!sql) return ''
  
  return renderSQL(sql)
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
 * 回答澄清问题:批次 B 改为调用 sendClarifyAnswer,把 option 作为对该澄清消息的接续,
 * 后端据 message.id 取父消息 metadata 恢复 decomposition。
 * 若 message.id 缺失(老消息或渲染异常),回退走 sendQuery 兜底。
 */
function answerClarification(message, option) {
  if (!option || isProcessing.value) return
  answeredClarifications.value.add(message.id)
  if (message.id != null) {
    sessionStore.sendClarifyAnswer(message.id, option)
  } else {
    sessionStore.sendQuery(option)
  }
  scrollToBottom()
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
  // 初始化当前会话
  initSession()
  
  // 滚动到底部
  scrollToBottom()
})

/**
 * 组件卸载时执行
 */
onUnmounted(() => {
  // 断开SSE连接
  sessionStore.disconnectSSE()
})

/**
 * 初始化会话
 * 设置当前会话并连接SSE
 */
async function initSession() {
  // 获取路由参数中的会话ID
  const sessionId = route.params.sessionId
  
  if (sessionId) {
    // 设置当前会话
    await sessionStore.setCurrentSession(sessionId)
    // 连接SSE
    sessionStore.connectSSE()
    // 滚动到底部
    scrollToBottom()
  }
}

// ============================================
// 监听器
// ============================================

/**
 * 监听路由参数变化，切换会话时重新初始化
 */
watch(() => route.params.sessionId, (newSessionId, oldSessionId) => {
  if (newSessionId && newSessionId !== oldSessionId) {
    // 断开旧连接
    sessionStore.disconnectSSE()
    // 初始化新会话
    initSession()
  }
})

// ============================================
// 监听器
// ============================================

/**
 * 监听消息变化，自动滚动到底部
 */
watch(() => sessionStore.messages, () => {
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
  position: relative;
}

/* 消息列表区域 */
.messages-area {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  padding-bottom: 160px;
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
  max-width: 70%;
}

.message.user {
  max-width: 70%;
}

.message.user .message-content {
  background-color: #409eff;
  color: white;
  padding: 12px 16px;
  border-radius: 12px 12px 2px 12px;
  word-break: break-word;
  display: inline-block;
  max-width: 100%;
}

.message.user .message-content.collapsed {
  max-height: 120px;
  overflow: hidden;
  position: relative;
}

.message.user .message-content.collapsed::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 40px;
  background: linear-gradient(transparent, rgba(64, 158, 255, 0.9));
}

.expand-toggle {
  display: flex;
  justify-content: center;
  align-items: center;
  margin-top: 4px;
  padding: 4px;
  cursor: pointer;
  color: #409eff;
  font-size: 14px;
  border-radius: 4px;
  transition: background-color 0.2s;
}

.expand-toggle:hover {
  background-color: #ecf5ff;
}

.message.assistant {
  display: flex;
  align-items: flex-start;
  max-width: 85%;
}

.message.assistant .avatar {
  margin-right: 12px;
  background-color: #409eff;
  flex-shrink: 0;
}

.message-body {
  flex: 1;
  background-color: #f4f4f5;
  padding: 12px 16px;
  border-radius: 12px;
  border-top-left-radius: 2px;
  min-width: 0;
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

.clarification-block {
  margin-top: 12px;
  padding: 12px;
  background-color: #f0f9ff;
  border: 1px solid #bae0ff;
  border-radius: 6px;
}

.clarification-hint {
  font-size: 12px;
  color: #606266;
  margin-bottom: 8px;
}

.clarification-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* 处理状态指示器 */
.processing-indicator {
  display: flex;
  align-items: flex-start;
  margin-bottom: 20px;
}

.processing-indicator .avatar {
  margin-right: 12px;
  background-color: #409eff;
}

.processing-body {
  flex: 1;
  background-color: #f4f4f5;
  padding: 12px 16px;
  border-radius: 8px;
  border-top-left-radius: 2px;
}

.processing-status {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #606266;
  font-size: 14px;
}

.processing-status .status-icon {
  animation: rotating 2s linear infinite;
  color: #409eff;
}

@keyframes rotating {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.progress-bar {
  margin-top: 8px;
  height: 4px;
  background-color: #e4e7ed;
  border-radius: 2px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #409eff, #79bbff);
  border-radius: 2px;
  transition: width 0.3s ease;
}

.typing-dots {
  display: flex;
  align-items: center;
  gap: 4px;
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

/* Markdown 样式 */
.markdown-body {
  line-height: 1.8;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4),
.markdown-body :deep(h5),
.markdown-body :deep(h6) {
  margin-top: 16px;
  margin-bottom: 12px;
  font-weight: 600;
  color: #303133;
}

.markdown-body :deep(h1) { font-size: 1.5em; }
.markdown-body :deep(h2) { font-size: 1.3em; }
.markdown-body :deep(h3) { font-size: 1.1em; }

.markdown-body :deep(p) {
  margin: 8px 0;
}

.markdown-body :deep(code) {
  background-color: #f5f7fa;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: 'Courier New', monospace;
  font-size: 0.9em;
  color: #e83e8c;
}

.markdown-body :deep(pre) {
  background-color: #282c34;
  padding: 16px;
  border-radius: 6px;
  overflow-x: auto;
  margin: 12px 0;
}

.markdown-body :deep(pre code) {
  background-color: transparent;
  padding: 0;
  color: #abb2bf;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 8px 0;
  padding-left: 24px;
}

.markdown-body :deep(li) {
  margin: 4px 0;
}

.markdown-body :deep(blockquote) {
  border-left: 4px solid #409eff;
  margin: 12px 0;
  padding: 8px 16px;
  background-color: #f5f7fa;
  color: #606266;
}

.markdown-body :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 12px 0;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid #dcdfe6;
  padding: 8px 12px;
  text-align: left;
}

.markdown-body :deep(th) {
  background-color: #f5f7fa;
  font-weight: 600;
}

.markdown-body :deep(a) {
  color: #409eff;
  text-decoration: none;
}

.markdown-body :deep(a:hover) {
  text-decoration: underline;
}

.markdown-body :deep(.mermaid) {
  text-align: center;
  margin: 16px 0;
}

.markdown-body :deep(.katex) {
  font-size: 1.1em;
}

.markdown-body :deep(.katex-display) {
  margin: 16px 0;
  overflow-x: auto;
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
  box-sizing: border-box;
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
