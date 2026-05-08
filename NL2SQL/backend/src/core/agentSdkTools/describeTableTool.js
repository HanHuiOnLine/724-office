/**
 * MCP 工具:describe_table —— 拿到指定表的字段详情
 *
 * 来源:backend/poc/agent-sdk-poc/src/schemaTools.ts
 * compact=true(默认)只返主键 / 外键 / CRITICAL_FIELD_NAMES 命中的字段,省 token;
 * compact=false 返回全部字段。
 *
 * 表不存在时返回软错误(text 内 JSON 含 error/suggestion),不要 throw —— 抛出会让 SDK
 * 的 agent loop 直接挂掉。
 */

const { tool } = require('@anthropic-ai/claude-agent-sdk');
const { z } = require('zod');
const schemaLoader = require('../schemaLoader');
const logger = require('../../utils/logger');

const CRITICAL_FIELD_NAMES = new Set([
  'create_time',
  'user_id',
  'order_id',
  'tz_account_id',
  'game_id',
  'role_id',
  'channel_id',
]);

function isCriticalField(f) {
  return (
    f.is_primary === true ||
    f.foreign_key !== undefined ||
    CRITICAL_FIELD_NAMES.has(f.name)
  );
}

function formatField(f) {
  const out = {
    name: f.name,
    name_cn: f.name_cn || '',
    type: f.type,
    description: String(f.description || '').slice(0, 80),
  };
  if (f.is_primary) out.is_primary = true;
  if (f.foreign_key) out.foreign_key = f.foreign_key;
  return out;
}

const describeTableTool = tool(
  'describe_table',
  '获取指定表的字段详情。compact=true(默认)只返回主键/外键/关键字段;compact=false 返回全部字段。',
  {
    table_name: z.string().describe('表的英文名,通常先调 search_tables 拿到'),
    compact: z
      .boolean()
      .optional()
      .describe('是否紧凑模式,默认 true。看完整字段时传 false'),
  },
  async (args) => {
    const tableName = String(args.table_name || '').trim();
    const compact = args.compact != null ? args.compact : true;

    const table = schemaLoader.getTable(tableName);

    if (!table) {
      logger.info(`[agentSdkTools] describe_table: 表 "${tableName}" 不存在`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `表 "${tableName}" 不存在`,
              suggestion: '请先用 search_tables 找到正确的表名再试',
            }),
          },
        ],
      };
    }

    const fields = Array.isArray(table.fields) ? table.fields : [];
    const fieldsToReturn = compact ? fields.filter(isCriticalField) : fields;

    const result = {
      name: table.name,
      name_cn: table.name_cn || '',
      description: table.description || '',
      field_count: fields.length,
      shown_count: fieldsToReturn.length,
      mode: compact ? 'compact' : 'full',
      fields: fieldsToReturn.map(formatField),
    };

    logger.info(
      `[agentSdkTools] describe_table table="${tableName}" mode=${result.mode} shown=${result.shown_count}/${result.field_count}`
    );

    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

module.exports = { describeTableTool };
