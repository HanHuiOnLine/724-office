/**
 * 工具循环处理器模块（Phase 1: Tool-Augmented Schema Discovery）
 * 
 * 实现 LLM 的工具调用循环：
 * 1. 发送带有工具定义的Prompt给LLM
 * 2. 解析LLM的工具调用请求
 * 3. 执行工具调用
 * 4. 将结果返回给LLM
 * 5. 循环直到LLM不再调用工具
 */

// ============================================
// 导入依赖模块
// ============================================

const llmService = require('./llmService');
const schemaTools = require('./schemaTools');
const schemaLoader = require('./schemaLoader');
const logger = require('../utils/logger');
const config = require('./config');

// ============================================
// 配置常量
// ============================================

/**
 * 工具循环的最大迭代次数
 * 防止无限循环
 */
const MAX_TOOL_ITERATIONS = 5;

/**
 * 工具循环超时时间（毫秒）
 */
const TOOL_LOOP_TIMEOUT = 60000;

// ============================================
// 工具循环处理器
// ============================================

/**
 * 执行工具循环
 * 
 * 核心流程：
 * 1. 构建初始Prompt（包含Level 1索引和工具定义）
 * 2. 调用LLM
 * 3. 如果LLM请求工具调用，执行工具并返回结果
 * 4. 重复步骤2-3，直到LLM返回最终结果或达到最大迭代次数
 * 
 * @param {string} userQuery - 用户查询
 * @param {Object} options - 选项
 * @param {Array} options.history - 对话历史
 * @param {string} options.userId - 用户ID
 * @param {boolean} options.useLevel1Index - 是否使用Level 1索引
 * @returns {Promise<Object>} 处理结果
 */
async function executeToolLoop(userQuery, options = {}) {
  const {
    history = [],
    userId = null,
    useLevel1Index = true
  } = options;
  
  logger.info('[ToolLoop] 开始工具循环', {
    query: userQuery,
    historyLength: history.length,
    useLevel1Index
  });
  
  const startTime = Date.now();
  const toolCallLog = []; // 记录所有工具调用
  
  try {
    // 构建初始消息
    const messages = buildInitialMessages(userQuery, history, useLevel1Index);
    
    let iteration = 0;
    let lastResponse = null;
    
    // 工具循环
    while (iteration < MAX_TOOL_ITERATIONS) {
      iteration++;
      
      logger.debug(`[ToolLoop] 第 ${iteration} 次迭代`);
      
      // 调用LLM（带工具定义）
      const response = await llmService.chat(
        messages,
        schemaTools.TOOL_DEFINITIONS,
        false, // 不使用流式响应
        null
      );
      
      lastResponse = response;
      const message = response.choices?.[0]?.message;
      
      // 检查是否有工具调用
      const toolCalls = schemaTools.parseToolCalls(response);
      
      if (toolCalls.length === 0) {
        // 没有工具调用，返回最终结果
        logger.info('[ToolLoop] 工具循环完成', {
          iterations: iteration,
          totalToolCalls: toolCallLog.length,
          duration: Date.now() - startTime
        });
        
        return {
          success: true,
          content: message?.content || '',
          iterations: iteration,
          toolCalls: toolCallLog,
          duration: Date.now() - startTime
        };
      }
      
      // 有工具调用，执行工具
      logger.debug(`[ToolLoop] 检测到 ${toolCalls.length} 个工具调用`);
      
      // 将助手消息添加到历史
      messages.push({
        role: 'assistant',
        content: message?.content || '',
        tool_calls: response.choices[0].message.tool_calls
      });
      
      // 执行每个工具调用
      for (const toolCall of toolCalls) {
        const { id, name, args } = toolCall;
        
        logger.debug(`[ToolLoop] 执行工具: ${name}`, args);
        
        // 执行工具
        const toolResult = await schemaTools.executeTool(name, args);
        
        // 记录工具调用
        toolCallLog.push({
          iteration,
          id,
          name,
          args,
          result: toolResult
        });
        
        // 将工具结果添加到消息历史
        messages.push({
          role: 'tool',
          tool_call_id: id,
          name: name,
          content: JSON.stringify(toolResult)
        });
      }
      
      // 检查超时
      if (Date.now() - startTime > TOOL_LOOP_TIMEOUT) {
        logger.warn('[ToolLoop] 工具循环超时');
        break;
      }
    }
    
    // 达到最大迭代次数，返回最后的结果
    logger.warn('[ToolLoop] 达到最大迭代次数', {
      iterations: iteration,
      totalToolCalls: toolCallLog.length
    });
    
    return {
      success: true,
      content: lastResponse?.choices?.[0]?.message?.content || '',
      iterations: iteration,
      toolCalls: toolCallLog,
      duration: Date.now() - startTime,
      warning: '达到最大迭代次数'
    };
    
  } catch (error) {
    logger.error('[ToolLoop] 工具循环失败:', error);
    return {
      success: false,
      error: error.message,
      toolCalls: toolCallLog,
      duration: Date.now() - startTime
    };
  }
}

/**
 * 构建初始消息
 * 
 * @param {string} userQuery - 用户查询
 * @param {Array} history - 对话历史
 * @param {boolean} useLevel1Index - 是否使用Level 1索引
 * @returns {Array} 消息数组
 */
function buildInitialMessages(userQuery, history, useLevel1Index) {
  const messages = [];
  
  // 系统提示词
  let systemPrompt = buildSystemPrompt(useLevel1Index);
  
  messages.push({
    role: 'system',
    content: systemPrompt
  });
  
  // 添加对话历史（最近5轮）
  if (history && history.length > 0) {
    const recentHistory = history.slice(-5);
    for (const msg of recentHistory) {
      messages.push({
        role: msg.role,
        content: msg.content
      });
    }
  }
  
  // 添加当前查询
  messages.push({
    role: 'user',
    content: userQuery
  });
  
  return messages;
}

/**
 * 构建系统提示词
 * 
 * @param {boolean} useLevel1Index - 是否使用Level 1索引
 * @returns {string} 系统提示词
 */
function buildSystemPrompt(useLevel1Index) {
  let prompt = `你是一位数据分析专家，负责将自然语言查询转换为SQL。

## 核心任务
1. 理解用户的数据查询需求
2. 使用可用工具探索数据库Schema
3. 生成正确的SQL查询语句

## 可用工具
你有以下工具可以探索数据库结构：

1. search_tables(keyword: string) -> Table[]
   用途：根据关键词搜索相关表
   示例：search_tables("注册") -> [{name: "pf_reg", comment: "..."}]

2. describe_table(tableName: string) -> SchemaDetail
   用途：获取指定表的详细字段信息
   示例：describe_table("pf_reg") -> {fields: [...]}

3. search_knowledge(concept: string) -> ConceptMapping[]
   用途：查询业务概念的定义和映射
   示例：search_knowledge("老平台") -> {datasource: "new_tzpingtaiold"}

4. peek_table(tableName: string, limit: number) -> Row[]
   用途：查看表的结构预览
   示例：peek_table("pf_reg", 3) -> [{...}]

## 工作流程
1. 先使用 search_tables 找到可能相关的表
2. 对不确定的表，使用 describe_table 或 peek_table 验证
3. 遇到业务术语（如"老平台"），使用 search_knowledge 查询映射
4. 确认所有需要的表后，生成SQL

## 输出格式
完成工具探索后，请按以下格式输出：

{
  "thought": "分析过程：我需要找哪些表？",
  "selected_tables": ["表名1", "表名2"],
  "sql": "SELECT ...",
  "explanation": "SQL说明"
}
`;

  // 如果使用Level 1索引，添加表列表
  if (useLevel1Index) {
    const level1Index = schemaTools.getLevel1Index();
    const tableList = level1Index.slice(0, 50).map(t => 
      `- ${t.name} (${t.name_cn}): ${t.description}`
    ).join('\n');
    
    prompt += `\n## 可用表列表（Level 1索引）
以下是数据库中所有可用的表，仅包含表名和简要描述：

${tableList}

**提示**：如果需要查看某个表的详细字段，请使用 describe_table 工具。
`;
  }
  
  return prompt;
}

// ============================================
// 意图识别工具循环
// ============================================

/**
 * 使用工具循环进行意图识别
 * 
 * @param {string} userQuery - 用户查询
 * @param {Array} history - 对话历史
 * @param {string} userId - 用户ID
 * @returns {Promise<Object>} 意图识别结果
 */
async function analyzeIntentWithTools(userQuery, history = [], userId = null) {
  logger.debug('[ToolLoop] 开始工具增强的意图识别', { query: userQuery });
  
  try {
    // 使用工具循环处理
    const result = await executeToolLoop(userQuery, {
      history,
      userId,
      useLevel1Index: true
    });
    
    if (!result.success) {
      return {
        success: false,
        error: result.error,
        intent: null
      };
    }
    
    // 解析意图
    const intent = parseIntentFromResponse(result.content);
    
    return {
      success: true,
      intent,
      toolCalls: result.toolCalls,
      iterations: result.iterations
    };
    
  } catch (error) {
    logger.error('[ToolLoop] 意图识别失败:', error);
    return {
      success: false,
      error: error.message,
      intent: null
    };
  }
}

/**
 * 从响应中解析意图
 * 
 * @param {string} content - LLM响应内容
 * @returns {Object} 意图对象
 */
function parseIntentFromResponse(content) {
  try {
    // 尝试提取JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      
      // 转换为标准意图格式
      return {
        original_query: parsed.original_query || '',
        thought: parsed.thought || '',
        tables: parsed.selected_tables || [],
        sql: parsed.sql || '',
        explanation: parsed.explanation || '',
        confidence: parsed.confidence || 0.8,
        time_range: parsed.time_range || null,
        filters: parsed.filters || [],
        metrics: parsed.metrics || [],
        dimensions: parsed.dimensions || []
      };
    }
  } catch (e) {
    logger.warn('[ToolLoop] 意图解析失败:', e);
  }
  
  // 无法解析，返回基本意图
  return {
    original_query: '',
    thought: content,
    tables: [],
    sql: '',
    explanation: '',
    confidence: 0.5
  };
}

// ============================================
// SQL生成工具循环
// ============================================

/**
 * 使用工具循环生成SQL
 * 
 * @param {Object} intent - 意图对象
 * @param {Array} history - 对话历史
 * @param {string} userId - 用户ID
 * @returns {Promise<Object>} SQL生成结果
 */
async function generateSQLWithTools(intent, history = [], userId = null) {
  logger.debug('[ToolLoop] 开始工具增强的SQL生成', { tables: intent.tables });
  
  try {
    // 构建SQL生成的Prompt
    const sqlPrompt = buildSQLPrompt(intent);
    
    // 使用工具循环处理
    const result = await executeToolLoop(sqlPrompt, {
      history,
      userId,
      useLevel1Index: false // SQL生成时不需要Level 1索引
    });
    
    if (!result.success) {
      return {
        success: false,
        error: result.error,
        sql: null
      };
    }
    
    // 解析SQL
    const sqlResult = parseSQLFromResponse(result.content);
    
    return {
      success: true,
      sql: sqlResult.sql,
      explanation: sqlResult.explanation,
      toolCalls: result.toolCalls,
      iterations: result.iterations
    };
    
  } catch (error) {
    logger.error('[ToolLoop] SQL生成失败:', error);
    return {
      success: false,
      error: error.message,
      sql: null
    };
  }
}

/**
 * 构建SQL生成Prompt
 * 
 * @param {Object} intent - 意图对象
 * @returns {string} SQL生成Prompt
 */
function buildSQLPrompt(intent) {
  return `基于以下意图分析，生成SQL查询语句。

## 意图分析
- 原始查询: ${intent.original_query || ''}
- 推理过程: ${intent.thought || ''}
- 目标表: ${(intent.tables || []).join(', ')}
- 时间范围: ${JSON.stringify(intent.time_range || {})}
- 筛选条件: ${JSON.stringify(intent.filters || [])}
- 指标: ${(intent.metrics || []).join(', ')}
- 维度: ${(intent.dimensions || []).join(', ')}

## 任务
请生成符合要求的SQL查询语句。

## 输出格式
{
  "sql": "SELECT ...",
  "explanation": "SQL说明"
}
`;
}

/**
 * 从响应中解析SQL
 * 
 * @param {string} content - LLM响应内容
 * @returns {Object} SQL结果
 */
function parseSQLFromResponse(content) {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        sql: parsed.sql || '',
        explanation: parsed.explanation || ''
      };
    }
  } catch (e) {
    logger.warn('[ToolLoop] SQL解析失败:', e);
  }
  
  // 尝试直接提取SQL
  const sqlMatch = content.match(/SELECT[\s\S]+?(?=(?:\n\n|```|$))/i);
  if (sqlMatch) {
    return {
      sql: sqlMatch[0].trim(),
      explanation: ''
    };
  }
  
  return {
    sql: '',
    explanation: content
  };
}

// ============================================
// 导出模块
// ============================================

module.exports = {
  // 核心函数
  executeToolLoop,
  analyzeIntentWithTools,
  generateSQLWithTools,
  
  // 辅助函数
  buildInitialMessages,
  buildSystemPrompt,
  parseIntentFromResponse,
  parseSQLFromResponse,
  
  // 配置
  MAX_TOOL_ITERATIONS,
  TOOL_LOOP_TIMEOUT
};
