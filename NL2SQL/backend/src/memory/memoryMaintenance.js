/**
 * 记忆维护模块
 * 
 * 负责长期记忆的定期压缩、清理和维护
 * 实现分级保留策略：
 * - 高频(≥10次)：永久保留
 * - 中频(3-9次)：90天未用则清理
 * - 低频(<3次)：30天未用则清理
 * - 字段别名：365天未用则清理
 */

// ============================================
// 导入依赖模块
// ============================================

const database = require('../core/database');
const logger = require('../utils/logger');
const config = require('../core/config');

// ============================================
// 常量定义（从配置读取）
// ============================================

const CLEANUP_RULES = {
  // 高频偏好：永久保留（不清理）
  HIGH_USAGE: {
    minUsage: 10,
    ttlDays: config.longTermMemory?.retention?.highUsage ?? null
  },
  // 中频偏好：90天未用清理
  MEDIUM_USAGE: {
    minUsage: 3,
    maxUsage: 9,
    ttlDays: config.longTermMemory?.retention?.mediumUsage ?? 90
  },
  // 低频偏好：30天未用清理
  LOW_USAGE: {
    minUsage: 0,
    maxUsage: 2,
    ttlDays: config.longTermMemory?.retention?.lowUsage ?? 30
  },
  // 字段别名：365天未用清理（用户习惯较稳定）
  FIELD_ALIAS: {
    ttlDays: config.longTermMemory?.retention?.fieldAlias ?? 365
  }
};

const PREFERENCE_TYPES = {
  QUERY_PATTERN: 'query_pattern',
  FIELD_ALIAS: 'field_alias',
  METRIC_PREFERENCE: 'metric_preference',
  DIMENSION_PREFERENCE: 'dimension_preference'
};

// ============================================
// 核心功能：记忆压缩与清理
// ============================================

/**
 * 压缩用户长期记忆
 * 按使用频率分级保留：
 * - 高频(≥10次)：永久保留
 * - 中频(3-9次)：90天未用则清理
 * - 低频(<3次)：30天未用则清理
 * 
 * @param {string} userId - 用户ID（可选，不传则处理所有用户）
 * @returns {Promise<Object>} 清理统计
 */
async function compressUserMemory(userId = null) {
  const stats = {
    usersProcessed: 0,
    deleted: {
      mediumUsage: 0,
      lowUsage: 0,
      fieldAlias: 0,
      total: 0
    },
    retained: {
      highUsage: 0,
      total: 0
    }
  };
  
  try {
    // 获取需要处理的用户列表
    let users;
    if (userId) {
      users = [{ user_id: userId }];
    } else {
      // 获取30天未更新的用户（避免频繁扫描所有用户）
      users = await database.query(
        `SELECT DISTINCT user_id FROM user_preferences 
         WHERE updated_at < datetime('now', '-30 days')
         OR last_used_at < datetime('now', '-30 days')`
      );
    }
    
    logger.info('开始压缩用户长期记忆', { userCount: users.length });
    
    for (const user of users) {
      const uid = user.user_id;
      const userStats = await compressSingleUser(uid);
      
      stats.usersProcessed++;
      stats.deleted.mediumUsage += userStats.deleted.mediumUsage;
      stats.deleted.lowUsage += userStats.deleted.lowUsage;
      stats.deleted.fieldAlias += userStats.deleted.fieldAlias;
      stats.deleted.total += userStats.deleted.total;
      stats.retained.highUsage += userStats.retained.highUsage;
      stats.retained.total += userStats.retained.total;
    }
    
    logger.info('记忆压缩完成', { stats });
    return stats;
    
  } catch (error) {
    logger.error('压缩用户记忆失败:', error);
    throw error;
  }
}

/**
 * 压缩单个用户的记忆
 * @param {string} userId - 用户ID
 * @returns {Promise<Object>} 用户清理统计
 */
async function compressSingleUser(userId) {
  const stats = {
    deleted: { mediumUsage: 0, lowUsage: 0, fieldAlias: 0, total: 0 },
    retained: { highUsage: 0, total: 0 }
  };
  
  try {
    // 1. 清理中频偏好(3-9次)：90天未用清理（跳过置顶记忆）
    const mediumCutoff = new Date(Date.now() - CLEANUP_RULES.MEDIUM_USAGE.ttlDays * 86400000).toISOString();
    const mediumResult = await database.run(
      `DELETE FROM user_preferences
       WHERE user_id = ?
       AND usage_count >= ? AND usage_count <= ?
       AND last_used_at < ?
       AND is_pinned = 0`,
      [userId, CLEANUP_RULES.MEDIUM_USAGE.minUsage, CLEANUP_RULES.MEDIUM_USAGE.maxUsage, mediumCutoff]
    );
    stats.deleted.mediumUsage = mediumResult.changes;
    stats.deleted.total += mediumResult.changes;
    
    // 2. 清理低频偏好(<3次)：30天未用清理（跳过置顶记忆）
    const lowCutoff = new Date(Date.now() - CLEANUP_RULES.LOW_USAGE.ttlDays * 86400000).toISOString();
    const lowResult = await database.run(
      `DELETE FROM user_preferences
       WHERE user_id = ?
       AND usage_count <= ?
       AND last_used_at < ?
       AND is_pinned = 0`,
      [userId, CLEANUP_RULES.LOW_USAGE.maxUsage, lowCutoff]
    );
    stats.deleted.lowUsage = lowResult.changes;
    stats.deleted.total += lowResult.changes;
    
    // 3. 清理字段别名：365天未用清理（跳过置顶记忆）
    const aliasCutoff = new Date(Date.now() - CLEANUP_RULES.FIELD_ALIAS.ttlDays * 86400000).toISOString();
    const aliasResult = await database.run(
      `DELETE FROM user_preferences
       WHERE user_id = ?
       AND preference_type = ?
       AND last_used_at < ?
       AND is_pinned = 0`,
      [userId, PREFERENCE_TYPES.FIELD_ALIAS, aliasCutoff]
    );
    stats.deleted.fieldAlias = aliasResult.changes;
    stats.deleted.total += aliasResult.changes;
    
    // 4. 统计保留的高频偏好
    const retainedResult = await database.queryOne(
      `SELECT COUNT(*) as count FROM user_preferences 
       WHERE user_id = ? AND usage_count >= ?`,
      [userId, CLEANUP_RULES.HIGH_USAGE.minUsage]
    );
    stats.retained.highUsage = retainedResult?.count || 0;
    
    // 5. 统计总保留数
    const totalResult = await database.queryOne(
      `SELECT COUNT(*) as count FROM user_preferences WHERE user_id = ?`,
      [userId]
    );
    stats.retained.total = totalResult?.count || 0;
    
    logger.debug(`用户 ${userId} 记忆压缩完成`, { stats });
    return stats;
    
  } catch (error) {
    logger.error(`压缩用户 ${userId} 记忆失败:`, error);
    return stats;
  }
}

// ============================================
// 高级功能：相似模式合并
// ============================================

/**
 * 合并相似的查询模式
 * 当多个模式维度/指标高度重合时，合并为一个更通用的模式
 * @param {string} userId - 用户ID
 * @returns {Promise<number>} 合并的模式数量
 */
async function mergeSimilarPatterns(userId) {
  try {
    // 获取用户的所有查询模式
    const patterns = await database.query(
      `SELECT * FROM user_preferences 
       WHERE user_id = ? AND preference_type = ?`,
      [userId, PREFERENCE_TYPES.QUERY_PATTERN]
    );
    
    if (patterns.length < 2) return 0;
    
    // 解析content
    const parsedPatterns = patterns.map(p => ({
      ...p,
      content: p.content ? JSON.parse(p.content) : null
    })).filter(p => p.content);
    
    // 找出相似的模式对
    const toMerge = [];
    for (let i = 0; i < parsedPatterns.length; i++) {
      for (let j = i + 1; j < parsedPatterns.length; j++) {
        const p1 = parsedPatterns[i];
        const p2 = parsedPatterns[j];
        
        if (arePatternsSimilar(p1.content, p2.content)) {
          toMerge.push([p1, p2]);
        }
      }
    }
    
    // 执行合并
    let mergedCount = 0;
    for (const [p1, p2] of toMerge) {
      await mergePatternPair(p1, p2);
      mergedCount++;
    }
    
    logger.debug(`合并相似模式完成`, { userId, mergedCount });
    return mergedCount;
    
  } catch (error) {
    logger.error('合并相似模式失败:', error);
    return 0;
  }
}

/**
 * 判断两个模式是否相似
 * @param {Object} p1 - 模式1
 * @param {Object} p2 - 模式2
 * @returns {boolean} 是否相似
 */
function arePatternsSimilar(p1, p2) {
  // 维度重合度 > 70%
  const dims1 = p1.dimensions || [];
  const dims2 = p2.dimensions || [];
  const dimOverlap = dims1.filter(d => dims2.includes(d)).length;
  const dimSimilarity = dimOverlap / Math.max(dims1.length, dims2.length);
  
  // 指标重合度 > 70%
  const metrics1 = p1.metrics || [];
  const metrics2 = p2.metrics || [];
  const metricOverlap = metrics1.filter(m => metrics2.includes(m)).length;
  const metricSimilarity = metricOverlap / Math.max(metrics1.length, metrics2.length);
  
  // 时间范围类型相同
  const timeMatch = p1.default_time_range?.type === p2.default_time_range?.type;
  
  return dimSimilarity > 0.7 && metricSimilarity > 0.7 && timeMatch;
}

/**
 * 合并两个模式
 * @param {Object} p1 - 模式1
 * @param {Object} p2 - 模式2
 */
async function mergePatternPair(p1, p2) {
  // 合并维度（去重）
  const mergedDims = [...new Set([...(p1.content.dimensions || []), ...(p2.content.dimensions || [])])];
  
  // 合并指标（去重）
  const mergedMetrics = [...new Set([...(p1.content.metrics || []), ...(p2.content.metrics || [])])];
  
  // 合并使用次数
  const mergedUsage = p1.usage_count + p2.usage_count;
  
  // 更新p1为合并后的模式
  const mergedContent = {
    ...p1.content,
    dimensions: mergedDims,
    metrics: mergedMetrics,
    merged_from: [p2.id]
  };
  
  await database.run(
    `UPDATE user_preferences 
     SET content = ?, usage_count = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [JSON.stringify(mergedContent), mergedUsage, p1.id]
  );
  
  // 删除p2
  await database.run(
    'DELETE FROM user_preferences WHERE id = ?',
    [p2.id]
  );
  
  logger.debug('合并模式', { kept: p1.id, removed: p2.id });
}

// ============================================
// 统计与报告
// ============================================

/**
 * 获取用户记忆统计
 * @param {string} userId - 用户ID
 * @returns {Promise<Object>} 统计信息
 */
async function getUserMemoryStats(userId) {
  try {
    const stats = await database.query(
      `SELECT 
        preference_type,
        COUNT(*) as count,
        AVG(usage_count) as avg_usage,
        MAX(usage_count) as max_usage,
        MIN(last_used_at) as oldest_use
       FROM user_preferences 
       WHERE user_id = ?
       GROUP BY preference_type`,
      [userId]
    );
    
    const total = await database.queryOne(
      'SELECT COUNT(*) as count FROM user_preferences WHERE user_id = ?',
      [userId]
    );
    
    return {
      total: total?.count || 0,
      byType: stats
    };
    
  } catch (error) {
    logger.error('获取用户记忆统计失败:', error);
    return { total: 0, byType: [] };
  }
}

/**
 * 生成系统记忆健康报告
 * @returns {Promise<Object>} 健康报告
 */
async function generateHealthReport() {
  try {
    // 总体统计
    const totalStats = await database.queryOne(
      `SELECT 
        COUNT(*) as total_preferences,
        COUNT(DISTINCT user_id) as total_users,
        AVG(usage_count) as avg_usage
       FROM user_preferences`
    );
    
    // 按类型统计
    const typeStats = await database.query(
      `SELECT 
        preference_type,
        COUNT(*) as count
       FROM user_preferences
       GROUP BY preference_type`
    );
    
    // 需要清理的数量预估
    const toCleanup = await database.queryOne(
      `SELECT COUNT(*) as count FROM user_preferences
       WHERE (usage_count < 3 AND last_used_at < datetime('now', '-30 days'))
       OR (usage_count >= 3 AND usage_count < 10 AND last_used_at < datetime('now', '-90 days'))`
    );
    
    return {
      summary: totalStats,
      byType: typeStats,
      maintenance: {
        estimatedCleanup: toCleanup?.count || 0,
        lastCleanup: new Date().toISOString()
      }
    };
    
  } catch (error) {
    logger.error('生成健康报告失败:', error);
    return null;
  }
}

// ============================================
// 导出模块
// ============================================

module.exports = {
  // 核心功能
  compressUserMemory,
  compressSingleUser,
  mergeSimilarPatterns,
  
  // 统计与报告
  getUserMemoryStats,
  generateHealthReport,
  
  // 常量
  CLEANUP_RULES,
  PREFERENCE_TYPES
};
