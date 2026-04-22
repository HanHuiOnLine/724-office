/**
 * 表作用域(scope)推断 & 核心表判定工具
 *
 * 从 vectorStore.js 抽出,供 tableRanker / schemaLoader 共用,避免循环依赖。
 *
 * 核心表定义(用户确认):
 *   scope ∈ { 'platform_core', 'report' }  →  isCoreTable = true
 *   - platform_core:  tzpingtai_tz_sdk_*  平台核心 SDK 日志表
 *   - report:         dwd_*  /  new_tzpt.*  /  new_tzbigdata_dm.*  大数据报表
 */

function inferScopeSubtype(tableName, originalScope) {
  if (!tableName || typeof tableName !== 'string') {
    return originalScope || 'unknown';
  }

  // 先判断 new_ 前缀的表
  if (tableName.startsWith('new_')) {
    const dbMatch = tableName.match(/^new_(\w+?)\./);
    if (dbMatch) {
      const dbName = dbMatch[1];
      if (dbName === 'tzpingtai')          return 'platform_newdb';
      if (dbName === 'tzpingtaiold')       return 'platform_olddb';
      if (dbName === 'external_tables')    return 'external';
      if (dbName === 'tzpt' || dbName === 'tzbigdata_dm') return 'report';
      return 'game_' + dbName.replace(/^tz/, '');
    }
  }

  // 非 new_ 前缀
  if (tableName.startsWith('dwd_'))                return 'report';
  if (tableName.startsWith('tzpingtai_tz_sdk_'))   return 'platform_core';
  if (tableName.startsWith('tzpingtai_'))          return 'platform_other';

  return originalScope || 'unknown';
}

function isCoreTable(tableName, originalScope = null) {
  const scope = inferScopeSubtype(tableName, originalScope);
  return scope === 'platform_core' || scope === 'report';
}

module.exports = { inferScopeSubtype, isCoreTable };
