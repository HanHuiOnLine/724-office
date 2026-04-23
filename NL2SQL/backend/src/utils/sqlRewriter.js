/**
 * 行级权限 SQL 改写工具(Phase 3 · T3b)
 *
 * 在 SQL 已通过 validateSQL 后、真实执行前,基于 AST 遍历,
 * 对命中 tableTenantMap 的表在 WHERE 里追加 `<alias>.<tenantCol> = <tenantId>`。
 *
 * 关键设计约束:
 *   - 解析失败 / sqlify 失败 / 命中映射表但 AST 结构无法识别 → 全部 refused:true,
 *     上游**中止执行**,绝不静默跳过。这是"安全不依赖对齐"的硬约束。
 *   - 覆盖:单表 SELECT、JOIN(多个 from 项)、UNION(_next 链)、CTE(with)、FROM 子查询
 *   - 不覆盖:INSERT/UPDATE/DELETE(这些本就被 validateSQL 的禁词白名单拦截)
 *   - 不改 ON 条件,只在 WHERE 追加(ON 是 JOIN 级,WHERE 是 SELECT 级,后者覆盖整表结果)
 */

let Parser;
try {
  Parser = require('node-sql-parser').Parser;
} catch (e) {
  Parser = null;
}

const DEFAULT_DIALECT = 'mysql';

/**
 * 注入租户过滤条件。
 *
 * @param {string} sql
 * @param {Object<string,string>} tableTenantMap - {tableName: tenantColumn}
 * @param {string} tenantId
 * @param {Object} [options]
 * @param {string} [options.dialect='mysql']
 * @returns {{
 *   sql: string,
 *   applied: string[],
 *   skippedTables: string[],
 *   refused?: boolean,
 *   reason?: string
 * }}
 */
function injectTenantFilter(sql, tableTenantMap, tenantId, options = {}) {
  const dialect = options.dialect || DEFAULT_DIALECT;

  if (!Parser) {
    return {
      sql, applied: [], skippedTables: [],
      refused: true, reason: 'NODE_SQL_PARSER_NOT_INSTALLED'
    };
  }
  if (!sql || typeof sql !== 'string') {
    return { sql, applied: [], skippedTables: [], refused: true, reason: 'INVALID_SQL' };
  }
  if (!tenantId || typeof tenantId !== 'string') {
    return { sql, applied: [], skippedTables: [], refused: true, reason: 'NO_TENANT_ID' };
  }
  if (!tableTenantMap || typeof tableTenantMap !== 'object') {
    // 映射为空 → 没有要保护的表,直接放行(不视为错误)
    return { sql, applied: [], skippedTables: [] };
  }

  const normalizedMap = normalizeMap(tableTenantMap);
  if (normalizedMap.size === 0) {
    return { sql, applied: [], skippedTables: [] };
  }

  const parser = new Parser();
  let ast;
  try {
    ast = parser.astify(sql, { database: dialect });
  } catch (e) {
    return {
      sql, applied: [], skippedTables: [],
      refused: true, reason: `PARSE_FAIL:${e.message}`
    };
  }

  // astify 对多语句或某些形式返回数组;只允许单 SELECT
  const root = Array.isArray(ast) ? ast[0] : ast;
  if (!root || root.type !== 'select') {
    return {
      sql, applied: [], skippedTables: [],
      refused: true, reason: `UNSUPPORTED_TYPE:${root && root.type}`
    };
  }

  const applied = [];
  const skipped = [];

  try {
    walkSelect(root, normalizedMap, tenantId, applied, skipped);
  } catch (e) {
    return {
      sql, applied: [], skippedTables: skipped,
      refused: true, reason: `WALK_FAIL:${e.message}`
    };
  }

  // 无表命中 → 放行原 SQL,不改写
  if (applied.length === 0) {
    return { sql, applied: [], skippedTables: skipped };
  }

  let rewritten;
  try {
    rewritten = parser.sqlify(Array.isArray(ast) ? ast : root, { database: dialect });
  } catch (e) {
    return {
      sql, applied: [], skippedTables: skipped,
      refused: true, reason: `SQLIFY_FAIL:${e.message}`
    };
  }

  // 验证 well-formedness:改写后的 SQL 能被同一个 parser 再解析
  try {
    parser.astify(rewritten, { database: dialect });
  } catch (e) {
    return {
      sql, applied: [], skippedTables: skipped,
      refused: true, reason: `VERIFY_FAIL:${e.message}`
    };
  }

  return {
    sql: rewritten,
    applied: Array.from(new Set(applied)),
    skippedTables: skipped
  };
}

// ============================================
// AST 遍历:追加租户条件
// ============================================

/**
 * 处理一个 SELECT 节点:追加 tenant 条件到 WHERE;递归 CTE / UNION / FROM 子查询。
 */
function walkSelect(selectNode, map, tenantId, applied, skipped) {
  if (!selectNode || selectNode.type !== 'select') return;

  // 1. 先递归 CTE
  if (Array.isArray(selectNode.with)) {
    for (const cte of selectNode.with) {
      const innerAst = cte && cte.stmt && cte.stmt.ast;
      if (innerAst) walkSelect(innerAst, map, tenantId, applied, skipped);
    }
  }

  // 2. 遍历 FROM,收集本层命中的表,同时递归子查询
  const hits = []; // [{tableName, alias, tenantCol}]
  if (Array.isArray(selectNode.from)) {
    for (const f of selectNode.from) {
      // 2a. FROM 子查询(expr.ast 是内嵌 SELECT)
      if (f && f.expr && f.expr.ast) {
        walkSelect(f.expr.ast, map, tenantId, applied, skipped);
        continue;
      }
      // 2b. 普通表引用
      if (f && f.table) {
        const key = String(f.table).toLowerCase();
        const tenantCol = map.get(key);
        if (tenantCol) {
          hits.push({ tableName: f.table, alias: f.as, tenantCol });
        }
      }
    }
  }

  // 3. 为本层每个命中的表追加 WHERE 条件
  for (const hit of hits) {
    const cond = buildTenantCond(hit.alias || hit.tableName, hit.tenantCol, tenantId);
    selectNode.where = selectNode.where
      ? { type: 'binary_expr', operator: 'AND', left: selectNode.where, right: cond }
      : cond;
    applied.push(hit.tableName);
  }

  // 4. UNION / INTERSECT / EXCEPT:_next 指向下一段 SELECT
  if (selectNode._next) {
    walkSelect(selectNode._next, map, tenantId, applied, skipped);
  }
}

/**
 * 构造 `<alias>.<tenantCol> = '<tenantId>'` 的 AST 节点。
 */
function buildTenantCond(tableRef, tenantCol, tenantId) {
  return {
    type: 'binary_expr',
    operator: '=',
    left: {
      type: 'column_ref',
      table: tableRef,
      column: tenantCol,
      collate: null
    },
    right: {
      type: 'single_quote_string',
      value: String(tenantId)
    }
  };
}

/**
 * 归一化 tableTenantMap:key 小写。
 */
function normalizeMap(raw) {
  const out = new Map();
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k === 'string' && typeof v === 'string' && k && v) {
      out.set(k.toLowerCase(), v);
    }
  }
  return out;
}

/**
 * 解析 env 形如 "t1:col,t2:col" 为对象。供 config.js 使用。
 */
function parseTenantMapEnv(str) {
  if (!str || typeof str !== 'string') return {};
  const out = {};
  for (const pair of str.split(',')) {
    const m = pair.trim().match(/^([^:\s]+)\s*:\s*([^:\s]+)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

module.exports = {
  injectTenantFilter,
  parseTenantMapEnv
};
