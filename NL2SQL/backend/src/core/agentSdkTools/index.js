/**
 * MCP server 汇总入口 —— 把所有 schema 工具打包成一个 MCP server,供 SDK options.mcpServers 注册
 *
 * 命名约定:server name = 'schema-tools',工具调用 ID 为 'mcp__schema-tools__<tool>'
 * 修改 server name 会破坏 agentSdkEngine.allowedTools 白名单,改时务必同步两处。
 *
 * 批次 1:仅 search_tables / describe_table(关键字版)
 * 批次 3:把 searchTablesTool 替换为向量检索版(复用 vectorStore.searchSchemaSmart)
 */

const { createSdkMcpServer } = require('@anthropic-ai/claude-agent-sdk');
const { searchTablesTool } = require('./searchTablesTool');
const { describeTableTool } = require('./describeTableTool');

const schemaToolsServer = createSdkMcpServer({
  name: 'schema-tools',
  version: '1.0.0',
  tools: [searchTablesTool, describeTableTool],
});

module.exports = schemaToolsServer;
