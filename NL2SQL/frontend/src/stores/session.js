/**
 * 会话状态管理Store
 * 
 * 使用Pinia管理会话相关的状态，包括：
 * 1. 会话列表
 * 2. 当前会话
 * 3. 消息历史
 * 4. SSE连接
 */

// ============================================
// 导入依赖
// ============================================

// 从pinia导入定义store的函数
import { defineStore } from 'pinia'
// 从vue导入响应式API
import { ref, computed } from 'vue'
// 导入UUID生成函数
import { v4 as uuidv4 } from 'uuid'
// 导入API服务
import * as api from '../utils/api'

// ============================================
// 定义Store
// ============================================

/**
 * 定义会话状态管理Store
 * 第一个参数是Store的唯一ID
 * 第二个参数是Store的定义函数
 */
export const useSessionStore = defineStore('session', () => {
  // ==========================================
  // State（状态）
  // ==========================================
  
  /**
   * 会话列表
   * 存储所有会话的数组
   */
  const sessions = ref([])
  
  /**
   * 当前会话ID
   */
  const currentSessionId = ref(null)
  
  /**
   * 当前会话的消息列表
   */
  const messages = ref([])
  
  /**
   * SSE连接实例
   */
  const sseConnection = ref(null)
  
  /**
   * 连接状态
   */
  const isConnected = ref(false)
  
  /**
   * 是否正在处理请求
   */
  const isProcessing = ref(false)
  
  /**
   * 处理状态文本
   */
  const processingStatus = ref('')
  
  /**
   * 处理进度 (0-100)
   */
  const processingProgress = ref(0)
  
  // ==========================================
  // Getters（计算属性）
  // ==========================================
  
  /**
   * 当前会话信息
   */
  const currentSession = computed(() => {
    return sessions.value.find(s => s.id === currentSessionId.value) || null
  })
  
  /**
   * 当前会话的消息数量
   */
  const messageCount = computed(() => messages.value.length)
  
  // ==========================================
  // Actions（方法）
  // ==========================================
  
  /**
   * 加载会话列表
   * 从后端API获取用户的所有会话
   */
  async function loadSessions() {
    try {
      // 调用API获取会话列表
      const response = await api.getSessions()
      // 更新会话列表
      sessions.value = response.sessions || []
    } catch (error) {
      console.error('加载会话列表失败:', error)
    }
  }
  
  /**
   * 创建新会话
   * @returns {string} 新会话的ID
   */
  async function createSession() {
    try {
      // 调用API创建会话
      const response = await api.createSession()
      const sessionId = response.id
      
      // 添加到会话列表
      sessions.value.unshift(response)
      
      // 设置为当前会话
      currentSessionId.value = sessionId
      
      // 清空消息列表
      messages.value = []
      
      return sessionId
    } catch (error) {
      console.error('创建会话失败:', error)
      throw error
    }
  }
  
  /**
   * 设置当前会话
   * @param {string} sessionId - 会话ID
   */
  async function setCurrentSession(sessionId) {
    // 如果已经是当前会话，不做任何操作
    if (currentSessionId.value === sessionId) {
      return
    }
    
    // 更新当前会话ID
    currentSessionId.value = sessionId
    
    // 加载该会话的消息历史
    await loadMessages(sessionId)
  }
  
  /**
   * 加载会话消息
   * @param {string} sessionId - 会话ID
   */
  async function loadMessages(sessionId) {
    try {
      // 调用API获取消息历史
      const response = await api.getSessionMessages(sessionId)
      // 更新消息列表
      messages.value = response.messages || []
    } catch (error) {
      console.error('加载消息失败:', error)
      messages.value = []
    }
  }
  
  /**
   * 添加消息到当前会话
   * @param {Object} message - 消息对象
   */
  function addMessage(message) {
    messages.value.push(message)
  }
  
  /**
   * 连接SSE
   * 建立与后端的Server-Sent Events连接
   */
  function connectSSE() {
    // 如果已有连接，先关闭
    if (sseConnection.value) {
      sseConnection.value.close()
    }
    
    // 构建SSE URL
    const sseUrl = `/api/sse/stream?session_id=${currentSessionId.value}`
    
    // 创建SSE连接
    const eventSource = new EventSource(sseUrl)
    
    // 连接建立时
    eventSource.onopen = () => {
      console.log('SSE连接已建立')
      isConnected.value = true
    }
    
    // 收到消息时
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        handleSSEMessage(data)
      } catch (error) {
        console.error('解析SSE消息失败:', error)
      }
    }
    
    // 连接错误时
    eventSource.onerror = (error) => {
      console.error('SSE错误:', error)
      isConnected.value = false
    }
    
    // 保存连接实例
    sseConnection.value = eventSource
  }
  
  /**
   * 处理SSE消息
   * @param {Object} data - 消息数据
   */
  function handleSSEMessage(data) {
    switch (data.type) {
      case 'connected':
        // 连接成功
        console.log('服务器连接成功:', data.data)
        break
        
      case 'processing':
        // 开始处理
        processingStatus.value = data.data?.message || '正在处理...'
        processingProgress.value = 0
        console.log('开始处理:', data.data)
        break
        
      case 'progress':
        // 进度更新
        if (data.data) {
          processingStatus.value = data.data.message || data.data.stage || '处理中...'
          processingProgress.value = data.data.progress || 0
        }
        console.log('进度更新:', data.data)
        break
        
      case 'result':
        // 查询结果
        isProcessing.value = false
        processingStatus.value = ''
        processingProgress.value = 0
        addMessage({
          role: 'assistant',
          content: data.data.message,
          type: data.data.type,
          metadata: {
            sql: data.data.sql,
            data: data.data.data
          }
        })
        break
        
      case 'clarify':
        // 需要澄清
        isProcessing.value = false
        processingStatus.value = ''
        processingProgress.value = 0
        addMessage({
          role: 'assistant',
          content: data.data.message,
          type: 'clarify'
        })
        break
        
      case 'error':
        // 错误消息
        isProcessing.value = false
        processingStatus.value = ''
        processingProgress.value = 0
        addMessage({
          role: 'assistant',
          content: data.data.message,
          type: 'error'
        })
        break
        
      default:
        console.log('收到消息:', data)
    }
  }
  
  /**
   * 发送查询请求
   * @param {string} query - 用户查询
   */
  async function sendQuery(query) {
    // 检查SSE连接
    if (!sseConnection.value || sseConnection.value.readyState !== EventSource.OPEN) {
      console.error('SSE未连接')
      return
    }
    
    // 添加用户消息到列表
    addMessage({
      role: 'user',
      content: query,
      type: 'text'
    })
    
    // 标记正在处理
    isProcessing.value = true
    
    try {
      // 通过HTTP POST发送查询请求
      await api.sendQuery(currentSessionId.value, query)
    } catch (error) {
      console.error('发送查询失败:', error)
      isProcessing.value = false
      addMessage({
        role: 'assistant',
        content: '发送查询失败，请稍后重试',
        type: 'error'
      })
    }
  }
  
  /**
   * 关闭SSE连接
   */
  function disconnectSSE() {
    if (sseConnection.value) {
      sseConnection.value.close()
      sseConnection.value = null
      isConnected.value = false
    }
  }
  
  /**
   * 删除会话
   * @param {string} sessionId - 会话ID
   */
  async function deleteSession(sessionId) {
    try {
      // 调用API删除会话
      await api.deleteSession(sessionId)
      
      // 从本地列表中移除
      const index = sessions.value.findIndex(s => s.id === sessionId)
      if (index > -1) {
        sessions.value.splice(index, 1)
      }
      
      // 如果删除的是当前会话，清空当前会话
      if (currentSessionId.value === sessionId) {
        currentSessionId.value = null
        messages.value = []
        disconnectSSE()
      }
      
      return true
    } catch (error) {
      console.error('删除会话失败:', error)
      throw error
    }
  }
  
  // ==========================================
  // 导出
  // ==========================================
  
  return {
    // State
    sessions,
    currentSessionId,
    messages,
    isConnected,
    isProcessing,
    processingStatus,
    processingProgress,
    // Getters
    currentSession,
    messageCount,
    // Actions
    loadSessions,
    createSession,
    setCurrentSession,
    loadMessages,
    addMessage,
    connectSSE,
    sendQuery,
    disconnectSSE,
    deleteSession
  }
})
