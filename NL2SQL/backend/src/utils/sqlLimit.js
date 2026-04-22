/**
 * SQL LIMIT 注入工具
 *
 * - hasOuterLimit(sql): 判断 SQL 最外层是否已带 LIMIT(忽略末尾 `;` 和空白)
 * - ensureLimit(sql, maxRows): 未带 LIMIT 时追加 `LIMIT <maxRows>`,已带则原样返回
 *
 * 设计要点:
 *   1. 仅匹配 SQL 末尾的 LIMIT,避免把子查询/列名中的 "LIMIT" 误判
 *   2. 支持 `LIMIT n` / `LIMIT n, m` / `LIMIT n OFFSET m` 三种合法尾形
 *   3. 允许末尾 1+ 个分号和任意空白
 */

// 例如匹配:"LIMIT 1000", "limit 10, 20", "LIMIT 50 OFFSET 100", 后允许分号+空白
const OUTER_LIMIT_RE = /\blimit\s+\d+(\s*,\s*\d+|\s+offset\s+\d+)?\s*;*\s*$/i;

function hasOuterLimit(sql) {
  if (!sql || typeof sql !== 'string') return false;
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  return OUTER_LIMIT_RE.test(trimmed);
}

function ensureLimit(sql, maxRows) {
  if (!sql || typeof sql !== 'string') {
    return { sql, injected: false };
  }
  if (!Number.isFinite(maxRows) || maxRows <= 0) {
    return { sql, injected: false };
  }
  if (hasOuterLimit(sql)) {
    return { sql, injected: false };
  }
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  return { sql: `${trimmed} LIMIT ${maxRows}`, injected: true };
}

module.exports = { hasOuterLimit, ensureLimit };
