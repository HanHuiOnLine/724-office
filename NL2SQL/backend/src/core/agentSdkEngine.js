/**
 * Agent SDK 引擎(批次 1)
 *
 * 职责:把 PoC 验证过的 Claude Agent SDK 接入路径搬到生产代码,作为 sseHandler.handleQuery
 * 可灰度切换的第三条引擎路径(优先级最高,失败自动降级到 agenticEngine / nl2sqlEngine)。
 *
 * 关键约束:
 *  - 对外契约对齐 agenticEngine(success/type/sql/data/executionTime/traceLog 等),前端协议零变更
 *  - onProgress step 名严格沿用 planning/generating/executing,前端 ChatView 已有 UI 渲染分支
 *  - permissionMode 用 'bypassPermissions':server 端 headless 无法响应 'default' 模式的权限交互
 *    会让会话挂死;allowedTools 白名单 + tools:[] 内置工具一刀切,安全边界靠白名单而非 permissionMode
 *  - 批次 1 没有 execute_sql 工具,SDK 只能产出 SQL 文本而无真实数据;返回结构里 data 用占位空表对象
 *    (`_placeholder: true`)兜底,前端无需为 null 单独写守护;批次 2 落 execute_sql 后改为真实数据
 *
 * 不在本批次范围:execute_sql(批次 2)、向量检索(批次 3)、澄清子链路(批次 5)
 */

const { query: sdkQuery } = require('@anthropic-ai/claude-agent-sdk');
const schemaToolsServer = require('./agentSdkTools');
const schemaLoader = require('./schemaLoader');
const logger = require('../utils/logger');

// ============================================
// 常量
// ============================================

/**
 * SDK 在 options 里识别的工具名。命名规则:mcp__<serverName>__<toolName>
 * 与 agentSdkTools/index.js 中 createSdkMcpServer({ name:'schema-tools' }) 严格对齐
 */
const ALLOWED_TOOLS = [
  'mcp__schema-tools__search_tables',
  'mcp__schema-tools__describe_table',
];

/**
 * 一次会话的最大轮数。批次 1 只有 search/describe 两类工具,
 * PoC 实测 8 轮就稳定收敛(search → describe → 也许再 describe → 总结)。
 * 批次 2 加 execute_sql 时调到 12-15
 */
const MAX_TURNS = 8;

/**
 * SDK 用的 Claude 模型名。注意:
 *   - 不能用项目的 LLM_MODEL(deepseek-ai/... 之类是 OpenAI 协议的网关模型,SDK 不认)
 *   - SDK 走 ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY / ANTHROPIC_MODEL 三件套,
 *     与 LLM_* 系列完全独立。三个环境变量必须显式配置(见 .env.example)
 *   - 默认 fallback 到 'claude-sonnet-4-6',与 PoC 一致
 */
function getSdkModel() {
  return process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
}

/**
 * 占位空表对象,批次 2 上线后由真实 execute_sql 数据替换
 * 加 _placeholder 标记便于前端识别"批次 1 还没真数据"的语义
 */
const PLACEHOLDER_DATA = Object.freeze({
  columns: [],
  rows: [],
  rowCount: 0,
  truncated: false,
  _placeholder: true,
});

// ============================================
// SystemPrompt 构造
// ============================================

/**
 * 构造给 Claude 的 system prompt。
 *
 * 必须传纯字符串。传 { type:'preset' } 会让 SDK 重新加载 Claude Code 的完整默认 prompt
 * (~25K token),前功尽弃,这是 PoC 踩过的坑
 */
function buildSystemPrompt() {
  const tableCount = schemaLoader.getAllTables().length;
  return `你是一个数据分析助手,连接到一个含 ${tableCount} 张表的业务数据库。
你看不到任何表的结构,必须通过工具按需探索。

可用工具:
1. search_tables(keyword, top_k=5) - 按关键词搜索表,返回表名/中文名/描述/字段数
2. describe_table(table_name, compact=true) - 获取表详情,compact 模式只返主键和关键字段

工作流程:
- 用户提需求 → 用 search_tables 找候选表 → 必要时 describe_table 看字段 → 用自然语言回答
- 一次最多描述 3 张表,避免浪费 token
- 找不到时直接说"未找到相关表",不要瞎猜表名`;
}

// ============================================
// 工具函数
// ============================================

function callProgress(onProgress, payload) {
  if (typeof onProgress === 'function') {
    try {
      onProgress(payload);
    } catch (e) {
      logger.warn('[agentSdkEngine] onProgress 回调异常', { err: e.message });
    }
  }
}

/**
 * 从 LLM 自然语言回复中抽 SQL。
 * 优先匹配带 sql 语言标的 fenced code block,回落到任意 fenced block。
 * 抽不到时返回 null(批次 1 允许,因为暂时不执行)
 */
function extractSql(text) {
  if (!text || typeof text !== 'string') return null;
  const sqlFence = /```sql\s*([\s\S]*?)```/i.exec(text);
  if (sqlFence && sqlFence[1].trim()) return sqlFence[1].trim();
  const anyFence = /```[a-zA-Z]*\s*([\s\S]*?)```/.exec(text);
  if (anyFence && anyFence[1].trim()) {
    const candidate = anyFence[1].trim();
    if (/\bselect\b/i.test(candidate)) return candidate;
  }
  return null;
}

/**
 * 把 message.usage 里我们关心的几个字段挑出来,避免把整个 SDK 内部对象返给前端
 */
function pickUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
    cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
  };
}

// ============================================
// SDK 消息流消费
// ============================================

/**
 * 把 SDK 的 AsyncIterable<SDKMessage> 转成 agenticEngine 兼容的返回结构
 *
 * 消息映射:
 *   system/init       → onProgress({step:'planning'})  + traceLog phase:'planning'
 *   assistant/text    → onProgress({step:'generating', message: text}) + 累积助手回复
 *   assistant/tool_use→ onProgress({step:'executing'}) + traceLog phase:'schema_discovery'
 *                       同时根据工具入参侧写记录 selectedTables
 *   result/success    → 终止,组装 type:'result' 返回
 *   result/error      → 终止,组装 type:'error' 返回
 *
 * @param {AsyncIterable} session - SDK query() 返回值
 * @param {Function|null} onProgress
 * @param {{ startTime: number, traceLog: any[] }} ctx
 * @returns {Promise<Object>}
 */
async function consumeSdkStream(session, onProgress, ctx) {
  const { startTime, traceLog } = ctx;

  // 累积态:从 assistant/text 拼接整段回复,从 tool_use 收集涉及的表名
  let assistantText = '';
  const selectedTablesSet = new Set();
  const toolCalls = [];

  for await (const message of session) {
    // ---- system/init: SDK 启动元数据,这里只用作 progress 提示 ----
    if (message.type === 'system' && message.subtype === 'init') {
      const loadedTools = Array.isArray(message.tools) ? message.tools : [];
      const mcpServers = Array.isArray(message.mcp_servers) ? message.mcp_servers : [];
      callProgress(onProgress, {
        step: 'planning',
        message: '初始化 SDK 会话...',
      });
      traceLog.push({
        phase: 'planning',
        result: {
          loadedTools,
          mcpServers,
          model: message.model || null,
        },
      });
      logger.debug('[agentSdkEngine] SDK init', {
        loadedToolCount: loadedTools.length,
        mcpServerCount: mcpServers.length,
      });
      continue;
    }

    // ---- assistant: 文本片段或工具调用 ----
    if (message.type === 'assistant' && message.message && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          assistantText += block.text;
          callProgress(onProgress, {
            step: 'generating',
            message: block.text,
          });
        } else if (block.type === 'tool_use') {
          toolCalls.push({ name: block.name, input: block.input });
          // 从 describe_table 调用的入参里收集表名,作为 selectedTables 的近似
          if (block.name === 'mcp__schema-tools__describe_table' && block.input && block.input.table_name) {
            selectedTablesSet.add(String(block.input.table_name));
          }
          callProgress(onProgress, {
            step: 'executing',
            message: `调用工具 ${block.name}`,
            toolName: block.name,
            toolInput: block.input,
          });
          traceLog.push({
            phase: 'schema_discovery',
            result: { tool: block.name, input: block.input },
          });
        }
      }
      continue;
    }

    // ---- result: 会话终止 ----
    if (message.type === 'result') {
      const usage = pickUsage(message.usage);
      const durationMs = Date.now() - startTime;

      if (message.subtype === 'success') {
        const finalText = typeof message.result === 'string' && message.result
          ? message.result
          : assistantText;
        const sql = extractSql(finalText);
        traceLog.push({
          phase: 'generation',
          result: { sql, usage, sdkDurationMs: message.duration_ms || null },
        });
        logger.info('[agentSdkEngine] SDK 会话成功', {
          sqlExtracted: !!sql,
          toolCallCount: toolCalls.length,
          cacheCreation: usage && usage.cache_creation_input_tokens,
          cacheRead: usage && usage.cache_read_input_tokens,
        });
        return {
          success: true,
          type: 'result',
          sql,
          explanation: finalText,
          selectedTables: Array.from(selectedTablesSet),
          data: { ...PLACEHOLDER_DATA },
          executionTime: durationMs,
          traceLog,
          duration: durationMs,
          engineUsed: 'agent-sdk',
          usage,
        };
      }

      // result/error 或其他终止子类型
      const errMsg =
        (message.error && (message.error.message || message.error.type)) ||
        (typeof message.result === 'string' ? message.result : null) ||
        `SDK result subtype=${message.subtype}`;
      logger.warn('[agentSdkEngine] SDK 会话异常终止', {
        subtype: message.subtype,
        errMsg,
      });
      return {
        success: false,
        type: 'error',
        error: errMsg,
        errorCode: 'SDK_RESULT_ERROR',
        sql: null,
        data: null,
        traceLog,
        duration: durationMs,
        engineUsed: 'agent-sdk',
        usage,
      };
    }

    // 其他类型(user 消息等)忽略
  }

  // 流结束但没收到 result 消息,视为异常
  logger.warn('[agentSdkEngine] SDK 流结束未收到 result');
  return {
    success: false,
    type: 'error',
    error: 'SDK stream ended without result',
    errorCode: 'SDK_STREAM_INCOMPLETE',
    sql: null,
    data: null,
    traceLog,
    duration: Date.now() - startTime,
    engineUsed: 'agent-sdk',
  };
}

// ============================================
// 公开入口
// ============================================

/**
 * 跑一次 SDK agent 会话
 *
 * @param {string} userQuery - 用户自然语言查询
 * @param {Object} [context] - { sessionId, userId, userRole, tenantId, history, ... }
 *   兼容 sseHandler.handleQuery 的 context 形态;批次 1 实际只用作日志/审计兜底
 * @param {Function} [onProgress] - SSE 进度回调,签名同 agenticEngine
 * @returns {Promise<Object>} 与 agenticEngine.processQuery 同形的返回结构
 */
async function runQuery(userQuery, context = {}, onProgress = null) {
  const startTime = Date.now();
  const traceLog = [];

  logger.info('[agentSdkEngine] 开始处理查询', {
    query: userQuery,
    sessionId: context && context.sessionId,
    userId: context && context.userId,
  });

  let session;
  try {
    session = sdkQuery({
      prompt: userQuery,
      options: {
        model: getSdkModel(),
        mcpServers: { 'schema-tools': schemaToolsServer },
        allowedTools: ALLOWED_TOOLS,
        tools: [],
        skills: [],
        agents: {},
        settingSources: [],
        maxTurns: MAX_TURNS,
        permissionMode: 'bypassPermissions',
        systemPrompt: buildSystemPrompt(),
      },
    });
  } catch (err) {
    logger.error('[agentSdkEngine] SDK query() 启动失败', { err: err.message });
    return {
      success: false,
      type: 'error',
      error: err.message,
      errorCode: 'SDK_RUN_FAILED',
      sql: null,
      data: null,
      traceLog,
      duration: Date.now() - startTime,
      engineUsed: 'agent-sdk',
    };
  }

  try {
    return await consumeSdkStream(session, onProgress, { startTime, traceLog });
  } catch (err) {
    logger.error('[agentSdkEngine] 消费 SDK 流失败', { err: err.message });
    return {
      success: false,
      type: 'error',
      error: err.message,
      errorCode: 'SDK_RUN_FAILED',
      sql: null,
      data: null,
      traceLog,
      duration: Date.now() - startTime,
      engineUsed: 'agent-sdk',
    };
  }
}

module.exports = {
  runQuery,
  // 暴露内部用于单元测试
  __test__: {
    consumeSdkStream,
    extractSql,
    pickUsage,
    buildSystemPrompt,
    PLACEHOLDER_DATA,
    MAX_TURNS,
    ALLOWED_TOOLS,
  },
};
