/**
 * LLM服务模块
 * 
 * 负责与LLM API通信，提供以下功能：
 * 1. 发送聊天请求（支持流式响应）
 * 2. 获取文本Embedding向量
 * 3. 管理API重试和错误处理
 * 4. 记录API调用日志
 */

// ============================================
// 导入依赖模块
// ============================================

// 导入Node.js内置的https模块，用于HTTPS请求
const https = require('https');
// 导入Node.js内置的http模块，用于HTTP请求
const http = require('http');
// 导入URL解析模块，用于解析API地址
const { URL } = require('url');
// 导入配置模块，获取LLM相关配置
const config = require('./config');
// 导入日志模块，记录API调用日志
const logger = require('../utils/logger');

// ============================================
// HTTP请求工具函数
// ============================================

/**
 * 发送HTTP POST请求
 * 底层HTTP请求封装，支持JSON数据和流式响应
 * 
 * @param {string} url - 请求URL
 * @param {Object} headers - 请求头
 * @param {Object} body - 请求体（JSON对象）
 * @param {boolean} stream - 是否使用流式响应
 * @param {number} timeout - 超时时间（毫秒）
 * @returns {Promise<Object>} 响应结果
 */
function httpPost(url, headers, body, stream = false, timeout = 60000) {
  // 返回Promise用于异步处理
  return new Promise((resolve, reject) => {
    // 解析URL，获取协议、主机、路径等信息
    const parsedUrl = new URL(url);
    // 根据协议选择http或https模块
    const httpModule = parsedUrl.protocol === 'https:' ? https : http;
    
    // 将请求体转换为JSON字符串
    const postData = JSON.stringify(body);
    
    // 构造请求选项
    const options = {
      // 请求方法为POST
      method: 'POST',
      // 主机名
      hostname: parsedUrl.hostname,
      // 端口号（默认80或443）
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      // 请求路径（包含查询参数）
      path: parsedUrl.pathname + parsedUrl.search,
      // 请求头
      headers: {
        // 内容类型为JSON
        'Content-Type': 'application/json',
        // 内容长度
        'Content-Length': Buffer.byteLength(postData),
        // 合并传入的自定义头
        ...headers
      },
      // 超时时间
      timeout: timeout
    };

    // console.log("HTTP POST Options:", options);
    
    // 创建HTTP请求
    const req = httpModule.request(options, (res) => {
      // 存储响应数据
      let data = '';
      
      // 设置响应编码为UTF-8
      res.setEncoding('utf8');
      
      // 监听数据接收事件
      res.on('data', (chunk) => {
        // 追加数据片段
        data += chunk;
        logger.debug(`收到数据块，当前总长度: ${data.length}`);
      });
      
      // 监听响应是否被截断（某些代理会截断长响应）
      res.on('aborted', () => {
        logger.warn('HTTP响应被异常终止');
      });
      
      // 监听响应结束事件
      res.on('end', () => {
        try {
          // 尝试解析JSON响应
          const jsonData = JSON.parse(data);
          // 检查HTTP状态码
          if (res.statusCode >= 200 && res.statusCode < 300) {
            // 成功，解析Promise
            resolve(jsonData);
          } else {
            // 失败，构造错误对象
            const error = new Error(`HTTP ${res.statusCode}: ${jsonData.error?.message || data}`);
            error.statusCode = res.statusCode;
            error.response = jsonData;
            reject(error);
          }
        } catch (parseError) {
          // JSON解析失败，记录原始响应用于调试
          logger.error(`JSON解析失败: ${parseError.message}`);
          logger.error(`响应总长度: ${data.length}`);
          // 检查是否包含truncated标记
          if (data.includes('truncated')) {
            logger.error('API响应包含"truncated"标记，说明服务器端截断了响应！');
            logger.error('请检查API服务器配置，增加响应大小限制，或更换Embedding API端点');
          }
          // 记录响应的前600字符，看看解析失败的位置
          logger.error(`响应前600字符: ${data.substring(0, 600)}`);
          // 检查响应是否包含多个JSON对象（可能是流式响应）
          if (data.includes('}{') || data.includes('}\n{')) {
            logger.error('响应似乎包含多个JSON对象，可能是流式响应格式');
          }
          // 记录响应的最后200字符，看看是否被截断
          logger.error(`响应最后200字符: ${data.substring(Math.max(0, data.length - 200))}`);
          reject(new Error(`响应解析失败: ${parseError.message}`));
        }
      });
    });
    
    // 监听请求错误事件
    req.on('error', (error) => {
      reject(new Error(`请求失败: ${error.message}`));
    });
    
    // 监听超时事件
    req.on('timeout', () => {
      // 中止请求
      req.destroy();
      reject(new Error('请求超时'));
    });
    
    // 写入请求体数据
    req.write(postData);
    // 结束请求
    req.end();
  });
}

// ============================================
// 重试机制
// ============================================

/**
 * 带重试机制的函数包装器
 * 当函数执行失败时，自动重试指定次数
 * 
 * @param {Function} fn - 要执行的函数
 * @param {number} maxRetries - 最大重试次数
 * @param {number} delay - 重试间隔（毫秒）
 * @returns {Promise<any>} 函数执行结果
 */
async function withRetry(fn, maxRetries = 3, delay = 1000) {
  // 记录最后一次错误
  let lastError;
  
  // 循环执行，最多重试maxRetries次
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // 尝试执行函数
      return await fn();
    } catch (error) {
      // 记录最后一次错误
      lastError = error;
      
      // 如果是最后一次尝试，不再重试
      if (attempt === maxRetries) {
        break;
      }
      
      // 记录重试日志
      logger.warn(`请求失败，${delay}ms后进行第${attempt + 1}次重试: ${error.message}`);
      
      // 等待指定时间后重试
      await sleep(delay);
    }
  }
  
  // 所有重试都失败，抛出最后一次错误
  throw lastError;
}

/**
 * 睡眠函数
 * 返回一个延迟指定时间的Promise
 * 
 * @param {number} ms - 延迟时间（毫秒）
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// LLM聊天功能
// ============================================

/**
 * 发送聊天请求到LLM API
 * 支持普通响应和流式响应
 * 
 * @param {Array} messages - 消息数组，格式：[{role, content}]
 * @param {Array} tools - 工具定义数组（可选）
 * @param {boolean} stream - 是否使用流式响应
 * @param {Function} onStream - 流式响应回调函数（可选）
 * @returns {Promise<Object>} LLM响应结果
 */
async function chat(messages, tools = null, stream = false, onStream = null) {
  // 记录开始调用日志
  logger.debug('调用LLM chat API', { messageCount: messages.length, stream });
  logger.trace('LLM chat请求详情', {
    model: config.llm.model,
    messageCount: messages.length,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content?.substring(0, 200) + (m.content?.length > 200 ? '...' : '')
    })),
    tools: tools?.map(t => t.function?.name),
    stream,
    max_tokens: 4096,
    temperature: 0.1
  });
  
  // 构造请求体
  const body = {
    // 使用的模型名称
    model: config.llm.model,
    // 消息历史
    messages: messages,
    // 最大生成token数
    max_tokens: 4096,
    // 温度参数，控制随机性（0-1，越低越确定）
    temperature: 0.1,
    // 是否使用流式响应
    stream: stream
  };
  
  // 如果有工具定义，添加到请求体
  if (tools && tools.length > 0) {
    body.tools = tools;
    // 强制模型使用工具（如果需要）
    // body.tool_choice = 'auto';
  }
  
  // 构造请求头
  const headers = {
    // 授权头，使用Bearer Token格式
    'Authorization': `Bearer ${config.llm.apiKey}`
  };
  
  // 构造完整API URL
  const url = `${config.llm.apiBase}/chat/completions`;
  
  // 使用重试机制发送请求
  return await withRetry(async () => {
    // 记录请求开始时间，用于计算耗时
    const startTime = Date.now();
    
    try {
      // 发送HTTP POST请求
      const response = await httpPost(url, headers, body, stream, config.llm.timeout);
      
      // 计算请求耗时
      const duration = Date.now() - startTime;
      logger.debug(`LLM请求完成，耗时: ${duration}ms`);
      
      // 记录响应详情
      const responseContent = response.choices?.[0]?.message?.content;
      logger.trace('LLM chat响应详情', {
        duration: `${duration}ms`,
        responseLength: responseContent?.length || 0,
        response: responseContent?.substring(0, 300) + (responseContent?.length > 300 ? '...' : ''),
        usage: response.usage,
        finishReason: response.choices?.[0]?.finish_reason
      });
      
      // 返回响应结果
      return response;
    } catch (error) {
      // 记录错误日志
      logger.error('LLM API调用失败:', error);
      throw error;
    }
  }, config.llm.maxRetries, config.llm.retryDelay);
}

/**
 * 发送简单的单轮对话请求
 * 用于快速获取LLM响应，无需维护消息历史
 * 
 * @param {string} prompt - 用户输入的提示词
 * @param {string} systemPrompt - 系统提示词（可选）
 * @returns {Promise<string>} LLM生成的文本内容
 */
async function simpleChat(prompt, systemPrompt = null) {
  logger.trace('simpleChat调用', {
    hasSystemPrompt: !!systemPrompt,
    systemPromptLength: systemPrompt?.length || 0,
    promptLength: prompt?.length || 0,
    prompt: prompt?.substring(0, 100) + (prompt?.length > 100 ? '...' : '')
  });
  
  // 构造消息数组
  const messages = [];
  
  // 如果有系统提示词，添加到消息数组开头
  if (systemPrompt) {
    messages.push({
      role: 'system',
      content: systemPrompt
    });
  }
  
  // 添加用户消息
  messages.push({
    role: 'user',
    content: prompt
  });
  
  // 调用chat函数
  const response = await chat(messages);
  
  // 提取并返回生成的内容
  // OpenAI格式响应：choices[0].message.content
  const content = response.choices?.[0]?.message?.content || '';
  
  logger.trace('simpleChat结果', {
    contentLength: content.length,
    content: content?.substring(0, 200) + (content?.length > 200 ? '...' : '')
  });
  
  return content;
}

// ============================================
// Embedding功能
// ============================================

/**
 * 获取文本的Embedding向量
 * 用于语义检索和相似度计算
 * 
 * @param {string|Array<string>} input - 要嵌入的文本（字符串或字符串数组）
 * @returns {Promise<Array<number>>} Embedding向量（一维数组）
 */
async function getEmbedding(input) {
  // 记录开始调用日志
  logger.debug('调用Embedding API', { inputType: typeof input });
  
  // 确保输入是数组格式
  const inputArray = Array.isArray(input) ? input : [input];
  
  // 构造请求体
  const body = {
    // 使用的Embedding模型
    model: config.embedding.model,
    // 输入文本数组
    input: inputArray,
    // 指定向量维度（某些模型支持）
    dimensions: config.embedding.dimension
  };
  
  // 构造请求头
  const headers = {
    'Authorization': `Bearer ${config.llm.apiKey}`
  };
  
  // 构造完整API URL
  const url = `${config.llm.apiBase}/embeddings`;
  
  // 使用重试机制发送请求
  return await withRetry(async () => {
    // 记录请求开始时间
    const startTime = Date.now();
    
    try {
      // 发送HTTP POST请求
      const response = await httpPost(url, headers, body, false, config.embedding.timeout);
      
      // 计算请求耗时
      const duration = Date.now() - startTime;
      logger.debug(`Embedding请求完成，耗时: ${duration}ms`);
      
      // 提取Embedding向量
      // OpenAI格式响应：data[0].embedding
      if (response.data && response.data.length > 0) {
        // 如果输入是单个字符串，返回单个向量
        if (!Array.isArray(input)) {
          return response.data[0].embedding;
        }
        // 如果输入是数组，返回向量数组
        return response.data.map(item => item.embedding);
      }
      
      throw new Error('Embedding API返回空数据');
    } catch (error) {
      logger.error('Embedding API调用失败:', error);
      throw error;
    }
  }, config.llm.maxRetries, config.llm.retryDelay);
}

// ============================================
// 工具定义辅助函数
// ============================================

/**
 * 构造工具定义对象
 * 用于定义LLM可以调用的工具（函数）
 * 
 * @param {string} name - 工具名称
 * @param {string} description - 工具描述
 * @param {Object} parameters - 参数定义（JSON Schema格式）
 * @param {Array<string>} required - 必需参数列表
 * @returns {Object} 工具定义对象
 */
function createToolDefinition(name, description, parameters, required = []) {
  return {
    // 工具类型为function
    type: 'function',
    function: {
      // 工具名称
      name: name,
      // 工具描述，帮助LLM理解何时使用
      description: description,
      // 参数定义
      parameters: {
        // 参数类型为object
        type: 'object',
        // 参数属性定义
        properties: parameters,
        // 必需参数列表
        required: required
      }
    }
  };
}

// ============================================
// 导出模块
// ============================================

module.exports = {
  // 核心功能
  chat,
  simpleChat,
  getEmbedding,
  // 工具定义辅助
  createToolDefinition,
  // 工具函数
  withRetry,
  sleep
};
