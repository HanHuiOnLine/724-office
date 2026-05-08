/**
 * MCP 工具:search_tables —— 按关键词在 schema 中搜表
 *
 * 来源:backend/poc/agent-sdk-poc/src/schemaTools.ts(关键字评分版)
 * 数据源:backend/src/core/schemaLoader.js 已加载的全量表(应用启动时由 app.js 调 load() 装入)
 *
 * 评分规则(沿用 PoC,出问题先来这里调权重):
 *   - 表英文名命中  +2
 *   - 表中文名命中  +1
 *   - 表描述命中    +1
 *   - 任一字段名命中(全表封顶 +1,防 'id' 这种通用词爆分) +1
 */

const { tool } = require('@anthropic-ai/claude-agent-sdk');
const { z } = require('zod');
const schemaLoader = require('../schemaLoader');
const logger = require('../../utils/logger');

const SCORE_NAME_HIT = 2;
const SCORE_NAME_CN_HIT = 1;
const SCORE_DESC_HIT = 1;
const SCORE_FIELD_HIT = 1;

function containsKeyword(text, keywordLower) {
  if (!text) return false;
  return String(text).toLowerCase().includes(keywordLower);
}

function scoreTable(table, keywordLower) {
  let score = 0;
  if (containsKeyword(table.name, keywordLower)) score += SCORE_NAME_HIT;
  if (containsKeyword(table.name_cn, keywordLower)) score += SCORE_NAME_CN_HIT;
  if (containsKeyword(table.description, keywordLower)) score += SCORE_DESC_HIT;

  const fields = Array.isArray(table.fields) ? table.fields : [];
  const anyFieldHit = fields.some(
    (f) =>
      containsKeyword(f && f.name, keywordLower) ||
      containsKeyword(f && f.name_cn, keywordLower)
  );
  if (anyFieldHit) score += SCORE_FIELD_HIT;
  return score;
}

const searchTablesTool = tool(
  'search_tables',
  '按关键词搜索数据库中相关的表。返回 top_k 条匹配结果,每条含表名、中文名、描述、字段数。',
  {
    keyword: z.string().describe("搜索关键词,例如 '注册' / '订单' / '支付'"),
    top_k: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe('返回前 K 条结果,默认 5,最大 20'),
  },
  async (args) => {
    const keyword = String(args.keyword || '').trim();
    const topK = args.top_k != null ? args.top_k : 5;

    if (keyword === '') {
      logger.debug('[agentSdkTools] search_tables: 收到空关键词');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              count: 0,
              tables: [],
              note: '请提供有效的搜索关键词',
            }),
          },
        ],
      };
    }

    const keywordLower = keyword.toLowerCase();
    const allTables = schemaLoader.getAllTables();

    const scored = allTables
      .map((table) => ({ table, score: scoreTable(table, keywordLower) }))
      .filter((entry) => entry.score > 0);

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, topK);

    logger.info(
      `[agentSdkTools] search_tables keyword="${keyword}" matched=${scored.length} returning=${top.length}`
    );

    if (top.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              count: 0,
              tables: [],
              suggestion: '尝试更通用的关键词,例如 注册/订单/支付/用户/登录',
            }),
          },
        ],
      };
    }

    const tables = top.map(({ table, score }) => ({
      name: table.name,
      name_cn: table.name_cn || '',
      description: String(table.description || '').slice(0, 100),
      field_count: Array.isArray(table.fields) ? table.fields.length : 0,
      score,
    }));

    return {
      content: [
        { type: 'text', text: JSON.stringify({ count: tables.length, tables }) },
      ],
    };
  }
);

module.exports = { searchTablesTool };
