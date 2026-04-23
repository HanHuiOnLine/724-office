/**
 * API服务模块
 * 
 * 封装所有与后端API的通信，包括：
 * 1. HTTP REST API调用
 * 2. 请求/响应拦截
 * 3. 错误处理
 */

// ============================================
// 导入依赖
// ============================================

// 导入axios HTTP客户端
import axios from 'axios'

// ============================================
// 创建axios实例
// ============================================

/**
 * 创建axios实例
 * 配置基础URL和超时时间
 */
const apiClient = axios.create({
  // 基础URL，所有请求都会加上这个前缀
  baseURL: '/api',
  // 请求超时时间（毫秒）
  timeout: 30000,
  // 请求头
  headers: {
    'Content-Type': 'application/json'
  }
})

// ============================================
// 请求拦截器
// ============================================

/**
 * 请求拦截器
 * 在请求发送前执行，可以添加token等
 */
apiClient.interceptors.request.use(
  (config) => {
    // 可以在这里添加认证token
    // const token = localStorage.getItem('token')
    // if (token) {
    //   config.headers.Authorization = `Bearer ${token}`
    // }
    return config
  },
  (error) => {
    // 请求错误处理
    return Promise.reject(error)
  }
)

// ============================================
// 响应拦截器
// ============================================

/**
 * 响应拦截器
 * 在收到响应后执行，统一处理错误
 */
apiClient.interceptors.response.use(
  (response) => {
    // 直接返回响应数据
    return response.data
  },
  (error) => {
    // 统一错误处理
    if (error.response) {
      // 服务器返回了错误状态码
      console.error('API错误:', error.response.data)
      return Promise.reject(error.response.data)
    } else if (error.request) {
      // 请求发送但没有收到响应
      console.error('网络错误:', error.request)
      return Promise.reject({ error: '网络连接失败' })
    } else {
      // 请求配置出错
      console.error('请求错误:', error.message)
      return Promise.reject({ error: error.message })
    }
  }
)

// ============================================
// 健康检查API
// ============================================

/**
 * 获取健康状态
 * @returns {Promise<Object>} 健康状态信息
 */
export function getHealth() {
  return apiClient.get('/health')
}

/**
 * 获取详细健康状态
 * @returns {Promise<Object>} 详细健康信息
 */
export function getHealthDetail() {
  return apiClient.get('/health/detail')
}

// ============================================
// Schema API
// ============================================

/**
 * 获取完整Schema
 * @returns {Promise<Object>} Schema信息
 */
export function getSchema() {
  return apiClient.get('/schema')
}

/**
 * 获取表详情
 * @param {string} tableName - 表名
 * @returns {Promise<Object>} 表详情
 */
export function getTableDetail(tableName) {
  return apiClient.get(`/schema/tables/${tableName}`)
}

/**
 * 搜索Schema
 * @param {string} query - 搜索关键词
 * @param {number} limit - 结果数量限制
 * @returns {Promise<Object>} 搜索结果
 */
export function searchSchema(query, limit = 5) {
  return apiClient.get('/schema/search', {
    params: { q: query, limit }
  })
}

// ============================================
// 会话 API
// ============================================

/**
 * 获取会话列表
 * @returns {Promise<Object>} 会话列表
 */
export function getSessions() {
  // 使用固定用户ID，实际应该从登录状态获取
  return apiClient.get('/users/anonymous/sessions')
}

/**
 * 创建新会话
 * @returns {Promise<Object>} 创建的会话信息
 */
export function createSession() {
  return apiClient.post('/sessions', {
    user_id: 'anonymous',
    title: '新会话'
  })
}

/**
 * 获取会话信息
 * @param {string} sessionId - 会话ID
 * @returns {Promise<Object>} 会话信息
 */
export function getSession(sessionId) {
  return apiClient.get(`/sessions/${sessionId}`)
}

/**
 * 获取会话消息
 * @param {string} sessionId - 会话ID
 * @param {number} limit - 消息数量限制
 * @returns {Promise<Object>} 消息列表
 */
export function getSessionMessages(sessionId, limit = 50) {
  return apiClient.get(`/sessions/${sessionId}/messages`, {
    params: { limit }
  })
}

/**
 * 删除会话
 * @param {string} sessionId - 会话ID
 * @returns {Promise<Object>} 删除结果
 */
export function deleteSession(sessionId) {
  return apiClient.delete(`/sessions/${sessionId}`)
}

// ============================================
// 查询历史 API
// ============================================

/**
 * 获取查询历史
 * @param {Object} params - 查询参数
 * @returns {Promise<Object>} 查询历史列表
 */
export function getQueryHistory(params = {}) {
  return apiClient.get('/queries/history', { params })
}

// ============================================
// 统计 API
// ============================================

/**
 * 获取统计信息
 * @returns {Promise<Object>} 统计信息
 */
export function getStats() {
  return apiClient.get('/stats')
}

// ============================================
// 配置 API
// ============================================

/**
 * 获取配置信息
 * @returns {Promise<Object>} 配置信息
 */
export function getConfig() {
  return apiClient.get('/config')
}

// ============================================
// SSE API
// ============================================

/**
 * 发送查询请求
 * 通过HTTP POST发送查询，结果通过SSE推送
 *
 * @param {string} sessionId - 会话ID
 * @param {string} query - 查询内容
 * @returns {Promise<Object>} 提交结果
 */
export function sendQuery(sessionId, query) {
  return apiClient.post('/sse/query', {
    session_id: sessionId,
    query: query
  })
}

/**
 * 批次 B:提交澄清回答
 * 对应后端 POST /api/sse/clarify-answer,结果仍通过原 SSE 流推回
 *
 * @param {string} sessionId - 会话ID
 * @param {number} parentMessageId - 父澄清消息的自增 id(来自 SSE clarification 事件 message_id)
 * @param {string} option - 用户回答(选项文本或自由输入)
 * @returns {Promise<Object>} 提交结果
 */
export function sendClarifyAnswer(sessionId, parentMessageId, option) {
  return apiClient.post('/sse/clarify-answer', {
    session_id: sessionId,
    parent_message_id: parentMessageId,
    option: option
  })
}

// ============================================
// 评估 API
// ============================================

/**
 * 评估相关API
 */
export const evaluationApi = {
  /**
   * 获取运行时统计报告
   * @returns {Promise<Object>} 统计报告
   */
  getStats() {
    return apiClient.get('/evaluation/stats')
  },

  /**
   * 重置统计数据
   * @returns {Promise<Object>} 重置结果
   */
  resetStats() {
    return apiClient.post('/evaluation/stats/reset')
  },

  /**
   * 获取评估配置
   * @returns {Promise<Object>} 配置信息
   */
  getConfig() {
    return apiClient.get('/evaluation/config')
  },

  /**
   * 执行Schema向量化质量评估
   * @param {Array} testQueries - 自定义测试查询（可选）
   * @returns {Promise<Object>} 评估结果
   */
  evaluateSchemaQuality(testQueries = null) {
    return apiClient.post('/evaluation/schema-quality', testQueries ? { testQueries } : {})
  },

  /**
   * 执行查询历史向量化质量评估
   * @param {Array} testPairs - 自定义测试对（可选）
   * @returns {Promise<Object>} 评估结果
   */
  evaluateQueryQuality(testPairs = null) {
    return apiClient.post('/evaluation/query-quality', testPairs ? { testPairs } : {})
  }
}
