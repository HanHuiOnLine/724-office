/**
 * NL2SQL 实体解析模块（Phase 4 · 任务 A.2）
 *
 * 职责：
 * - 业务关键词到表的映射（`inferTablesFromQuery`）
 * - 实体名称到 ID 的映射（`resolveEntity`：查询 SR 库 game_list / channel_list）
 * - 意图内实体解析（`resolveEntitiesInIntent`，含长期记忆 + DB 模糊匹配 + 歧义澄清）
 * - 平台术语识别（`resolvePlatformInIntent`：新/老平台 → datasource）
 * - 上下文别名学习（`learnEntityAliasFromContext`）
 */

const logger = require('../utils/logger');
const schemaLoader = require('./schemaLoader');
const database = require('./database');
const srDatabase = require('./srDatabase');
const longTermMemory = require('../memory/longTermMemory');

// ============================================
// 业务关键词映射（用于智能表检索）
// ============================================

let BUSINESS_KEYWORD_TABLE_MAP = {};

function initializeBusinessKeywordMap() {
  try {
    BUSINESS_KEYWORD_TABLE_MAP = schemaLoader.getBusinessKeywordMappings();
    logger.info('[NL2SQL] 业务关键词映射初始化完成', {
      keywordCount: Object.keys(BUSINESS_KEYWORD_TABLE_MAP).length
    });
  } catch (error) {
    logger.error('[NL2SQL] 初始化业务关键词映射失败:', error);
    BUSINESS_KEYWORD_TABLE_MAP = {};
  }
}

function getBusinessKeywordMap() {
  if (Object.keys(BUSINESS_KEYWORD_TABLE_MAP).length === 0) {
    initializeBusinessKeywordMap();
  }
  return BUSINESS_KEYWORD_TABLE_MAP;
}

function inferTablesFromQuery(query) {
  if (!query) return [];

  const normalizedQuery = query.toLowerCase();
  const inferredTables = new Set();

  const keywordMap = getBusinessKeywordMap();

  for (const [keyword, tables] of Object.entries(keywordMap)) {
    if (normalizedQuery.includes(keyword.toLowerCase())) {
      tables.forEach(table => inferredTables.add(table));
    }
  }

  return [...inferredTables];
}

// ============================================
// 实体解析：名称 → ID 映射（查询 SR 业务库）
// ============================================

/**
 * 实体检索 - 尝试将模糊描述（如游戏名称）映射到具体ID
 */
async function resolveEntity(entityName, entityType) {
  logger.info('尝试解析实体', { entityName, entityType });

  if (!srDatabase.isReady()) {
    logger.warn('SR 数据源未就绪，跳过实体解析');
    return { found: false, reason: 'SR_DB_NOT_READY' };
  }

  try {
    let sql;
    if (entityType === 'game') {
      sql = `SELECT game_id AS id, game_name AS name FROM game_list WHERE game_name LIKE ? LIMIT 5`;
    } else if (entityType === 'channel') {
      sql = `SELECT channel_id AS id, channel_name AS name FROM channel_list WHERE channel_name LIKE ? LIMIT 5`;
    } else {
      return { found: false };
    }

    const { rows: results } = await srDatabase.executeQuery(sql, [`%${entityName}%`]);

    if (results && results.length > 0) {
      const exactMatch = results.find(r => r.name === entityName);
      if (exactMatch) {
        return {
          found: true,
          id: exactMatch.id,
          name: exactMatch.name,
          confidence: 1.0
        };
      }
      return {
        found: true,
        id: results[0].id,
        name: results[0].name,
        confidence: 0.7,
        alternatives: results.slice(1).map(r => ({ id: r.id, name: r.name }))
      };
    }

    return { found: false };
  } catch (error) {
    logger.error('实体解析失败:', error);
    return { found: false, error: error.message };
  }
}

// ============================================
// 上下文别名学习
// ============================================

/**
 * 从上下文中学习实体别名
 * 当用户在澄清中提供映射关系时（如"青木是游戏名称"），自动学习
 */
async function learnEntityAliasFromContext(userId, userQuery, intent, lastAssistantMsg) {
  try {
    if (!intent.filters || intent.filters.length === 0) {
      return;
    }

    for (const filter of intent.filters) {
      if (filter.original_name && filter.field && filter.value) {
        let fieldType = 'filter';
        if (filter.field === 'game_id') fieldType = 'game';
        else if (filter.field === 'channel_id') fieldType = 'channel';

        logger.info('[别名学习] 检测到实体映射，准备学习', {
          userId,
          userTerm: filter.original_name,
          schemaField: `${filter.field}=${filter.value}`,
          fieldType
        });

        if (filter.field === 'game_id' || filter.field === 'channel_id') {
          const result = await longTermMemory.learnFieldAlias(
            userId,
            filter.original_name,
            filter.value,
            fieldType
          );

          if (result) {
            logger.info('[别名学习] ✅ 实体映射学习成功（直接映射）', {
              userId,
              userTerm: filter.original_name,
              targetValue: filter.value,
              field: filter.field
            });
          }
        } else {
          const result = await longTermMemory.learnFieldAlias(
            userId,
            filter.original_name,
            filter.field,
            fieldType
          );

          if (result) {
            logger.info('[别名学习] ✅ 字段别名学习成功', {
              userId,
              userTerm: filter.original_name,
              schemaField: filter.field
            });
          }
        }
      }
    }
  } catch (error) {
    logger.error('[别名学习] 学习实体别名失败:', error);
  }
}

// ============================================
// 意图内实体解析
// ============================================

/**
 * 从意图中解析实体（游戏名、渠道名等）
 * 优先使用长期记忆中学习的别名，同时依赖LLM已识别的filters
 */
async function resolveEntitiesInIntent(intent, userQuery, userId) {
  try {
    const hasGameIdFilter = intent.filters?.some(f => f.field === 'game_id');

    if (hasGameIdFilter) {
      logger.debug('[实体解析] LLM已识别game_id，跳过实体解析');
      return;
    }

    const matchedEntities = [];

    if (userId) {
      try {
        const fieldAliases = await database.getFieldAliases(userId);

        for (const alias of fieldAliases) {
          const content = typeof alias.content === 'string' ? JSON.parse(alias.content) : alias.content;

          if (content.user_term && userQuery.includes(content.user_term)) {
            let gameId = null;

            if (content.schema_field === 'game_id' || content.field_type === 'game') {
              const valueAlias = fieldAliases.find(a => {
                const vc = typeof a.content === 'string' ? JSON.parse(a.content) : a.content;
                return vc.user_term === `${content.user_term}_value`;
              });

              if (valueAlias) {
                const vc = typeof valueAlias.content === 'string' ? JSON.parse(valueAlias.content) : valueAlias.content;
                gameId = vc.schema_field;
              }
            }

            if (!gameId && !isNaN(Number(content.schema_field))) {
              gameId = content.schema_field;
            }

            if (gameId) {
              logger.info(`[实体解析] ✅ 使用长期记忆映射: ${content.user_term} -> game_id=${gameId}`);

              matchedEntities.push({
                field: 'game_id',
                op: '=',
                value: gameId,
                original_name: content.user_term,
                matchSource: 'long_term_memory'
              });
            }
          }
        }
      } catch (e) {
        logger.debug('[实体解析] 加载用户别名失败:', e.message);
      }
    }

    try {
      if (srDatabase.isReady() && matchedEntities.length === 0) {
        const potentialNames = extractPotentialEntityNames(userQuery);

        if (potentialNames.length > 0) {
          const likeConditions = potentialNames.map(() => 'game_name LIKE ?').join(' OR ');
          const likeParams = potentialNames.map(name => `%${name}%`);

          const { rows: results } = await srDatabase.executeQuery(
            `SELECT game_id AS id, game_name AS name
             FROM game_list
             WHERE ${likeConditions}
             LIMIT 20`,
            likeParams
          );

          if (results && results.length > 0) {
            for (const name of potentialNames) {
              const nameLower = name.toLowerCase();

              const candidates = results.filter(r =>
                r.name.toLowerCase().includes(nameLower)
              );

              if (candidates.length === 1) {
                matchedEntities.push({
                  field: 'game_id',
                  op: '=',
                  value: String(candidates[0].id),
                  original_name: candidates[0].name,
                  matchSource: 'database_fuzzy'
                });
              } else if (candidates.length > 1) {
                const exactMatch = candidates.find(r =>
                  r.name.toLowerCase() === nameLower
                );

                if (exactMatch) {
                  matchedEntities.push({
                    field: 'game_id',
                    op: '=',
                    value: String(exactMatch.id),
                    original_name: exactMatch.name,
                    matchSource: 'database_exact'
                  });
                } else {
                  logger.info(`[实体解析] ⚠️ 发现歧义匹配: "${name}" 对应多个游戏`, {
                    candidates: candidates.slice(0, 3).map(c => ({id: c.id, name: c.name}))
                  });

                  if (!intent.clarification_needed) {
                    intent.clarification_needed = [];
                  }
                  intent.clarification_needed.push({
                    type: 'ambiguous_entity',
                    entityType: 'game',
                    userTerm: name,
                    options: candidates.slice(0, 3).map(c => ({
                      id: c.id,
                      name: c.name,
                      value: String(c.id)
                    }))
                  });
                }
              }
            }
          }
        }
      }
    } catch (error) {
      logger.debug('[实体解析] 数据库模糊匹配失败:', error.message);
    }

    if (matchedEntities.length > 0) {
      if (!intent.filters) {
        intent.filters = [];
      }

      const existingGameIds = new Set(
        intent.filters
          .filter(f => f.field === 'game_id')
          .map(f => f.value)
      );

      for (const entity of matchedEntities) {
        if (!existingGameIds.has(entity.value)) {
          intent.filters.push(entity);
          existingGameIds.add(entity.value);
        }
      }

      logger.info(`[实体解析] ✅ 共解析 ${matchedEntities.length} 个实体`, {
        entities: matchedEntities.map(e => ({name: e.original_name, id: e.value}))
      });
    }

  } catch (error) {
    logger.error('[实体解析] 解析失败:', error);
  }
}

/**
 * 从查询中提取潜在实体名称
 */
function extractPotentialEntityNames(query) {
  if (!query) return [];

  const names = new Set();

  const chineseMatches = query.match(/[一-龥]{2,10}/g);
  if (chineseMatches) {
    chineseMatches.forEach(match => names.add(match));
  }

  const englishMatches = query.match(/[a-zA-Z]{2,15}/g);
  if (englishMatches) {
    englishMatches.forEach(match => names.add(match.toLowerCase()));
  }

  const quotedMatches = query.match(/[""']([^""']{1,20})[""']/g);
  if (quotedMatches) {
    quotedMatches.forEach(match => {
      const cleanName = match.replace(/[""']/g, '').trim();
      if (cleanName.length >= 2) {
        names.add(cleanName);
        names.add(cleanName);
      }
    });
  }

  return Array.from(names);
}

// ============================================
// 平台术语解析
// ============================================

/**
 * 平台术语解析 - 从查询中识别"新平台"/"老平台"并映射到数据库标识
 */
async function resolvePlatformInIntent(intent, userQuery, userId) {
  try {
    const queryLower = userQuery.toLowerCase();

    if (userId) {
      try {
        const fieldAliases = await database.getFieldAliases(userId);

        for (const alias of fieldAliases) {
          const content = typeof alias.content === 'string' ? JSON.parse(alias.content) : alias.content;

          if (content.field_type === 'datasource' && content.user_term && content.schema_field) {
            if (queryLower.includes(content.user_term.toLowerCase())) {
              logger.info(`[平台解析] ✅ 使用长期记忆映射: ${content.user_term} -> datasource=${content.schema_field}`);

              if (!intent.filters) {
                intent.filters = [];
              }

              const existingFilter = intent.filters.find(f => f.field === 'datasource');
              if (!existingFilter) {
                intent.filters.push({
                  field: 'datasource',
                  op: '=',
                  value: content.schema_field,
                  original_name: content.user_term
                });
              }
              return;
            }
          }
        }
      } catch (e) {
        logger.debug('[平台解析] 加载用户datasource映射失败:', e.message);
      }
    }

    const platformMappings = [
      { term: '老平台', datasource: 'new_tzpingtaiold' },
      { term: '新平台', datasource: 'new_tzpingtai' }
    ];

    for (const mapping of platformMappings) {
      if (queryLower.includes(mapping.term)) {
        logger.info(`[平台解析] ✅ 使用硬编码映射: ${mapping.term} -> datasource=${mapping.datasource}`);

        if (!intent.filters) {
          intent.filters = [];
        }

        const existingFilter = intent.filters.find(f => f.field === 'datasource');
        if (!existingFilter) {
          intent.filters.push({
            field: 'datasource',
            op: '=',
            value: mapping.datasource,
            original_name: mapping.term
          });
        }
        return;
      }
    }

  } catch (error) {
    logger.error('[平台解析] 解析失败:', error);
  }
}

module.exports = {
  resolveEntity,
  resolveEntitiesInIntent,
  resolvePlatformInIntent,
  inferTablesFromQuery,
  extractPotentialEntityNames,
  getBusinessKeywordMap,
  learnEntityAliasFromContext
};
