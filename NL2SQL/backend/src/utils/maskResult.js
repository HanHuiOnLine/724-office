/**
 * 结果脱敏工具(Phase 3 · T3a)
 *
 * 按列名规则对 SQL 查询结果行做脱敏,避免敏感字段(手机号/邮箱/身份证/密码/令牌)
 * 以明文经 SSE 回到前端。
 *
 * 设计选择:
 *   - 规则驱动:依据 config.security.masking.rules(列名 → 规则名),不改 schema-metadata.json
 *   - 纯函数 + immutable:返回新数组,不修改输入
 *   - 列名大小写不敏感:'Phone' / 'phone' / 'PHONE' 匹配同一条规则
 *   - 支持两种行 shape:对象 {col: val} 和数组 [val1, val2, ...](配合 columns 顺序)
 *   - null / undefined / 非字符串值 → 原样透传(不做处理)
 */

// ============================================
// 规则实现(纯函数)
// ============================================

/**
 * mid_4: 手机号中段 4 位打码。'13812345678' → '138****5678'。
 * 长度不足 8 时降级为 length_stars(全替换为 * 保留长度)。
 */
function maskMid4(v) {
  const s = String(v);
  if (s.length < 8) return '*'.repeat(s.length);
  return s.slice(0, 3) + '****' + s.slice(-4);
}

/**
 * domain_only: 邮箱本地部分打码。'alice@example.com' → '***@example.com'。
 * 无 @ 时降级为 redact。
 */
function maskDomainOnly(v) {
  const s = String(v);
  const at = s.indexOf('@');
  if (at < 0) return '***';
  return '***' + s.slice(at);
}

/**
 * head_tail: 保留首 6 + 尾 3,中间打码。'110101199001011234' → '110101*********234'。
 * 长度不足 10 时降级为 length_stars。
 */
function maskHeadTail(v) {
  const s = String(v);
  if (s.length < 10) return '*'.repeat(s.length);
  return s.slice(0, 6) + '*'.repeat(s.length - 9) + s.slice(-3);
}

/**
 * redact: 整体替换为 '***'。用于密码/令牌等完全无需展示的字段。
 */
function maskRedact() {
  return '***';
}

/**
 * first_1: 保留首字符,其余打码。'张三' → '张*'。
 */
function maskFirst1(v) {
  const s = String(v);
  if (s.length <= 1) return s;
  return s.slice(0, 1) + '*'.repeat(s.length - 1);
}

/**
 * last_4: 保留尾 4 位,其余打码。用于银行卡号等。
 */
function maskLast4(v) {
  const s = String(v);
  if (s.length <= 4) return s;
  return '*'.repeat(s.length - 4) + s.slice(-4);
}

/**
 * length_stars: 全替换为 *,但保留原长度。弱脱敏,仅用于长度有意义的字段。
 */
function maskLengthStars(v) {
  const s = String(v);
  return '*'.repeat(s.length);
}

const RULE_IMPL = {
  mid_4: maskMid4,
  domain_only: maskDomainOnly,
  head_tail: maskHeadTail,
  redact: maskRedact,
  first_1: maskFirst1,
  last_4: maskLast4,
  length_stars: maskLengthStars
};

// ============================================
// 主入口
// ============================================

/**
 * 归一化规则表:key 统一小写。
 * @param {Object} rules - {columnName: ruleName}
 * @returns {Map<string, string>}
 */
function normalizeRules(rules) {
  const map = new Map();
  if (!rules || typeof rules !== 'object') return map;
  for (const [col, rule] of Object.entries(rules)) {
    if (typeof col === 'string' && typeof rule === 'string' && RULE_IMPL[rule]) {
      map.set(col.toLowerCase(), rule);
    }
  }
  return map;
}

/**
 * 对单个值应用规则。null/undefined 透传。
 */
function applyRule(value, ruleName) {
  if (value === null || value === undefined) return value;
  const fn = RULE_IMPL[ruleName];
  if (!fn) return value;
  return fn(value);
}

/**
 * 对查询结果行做脱敏。返回新数组,不修改输入。
 *
 * @param {Array<Object>|Array<Array>} rows - 行数据
 * @param {Array<string>|Array<Object>} columns - 列定义,支持字符串数组或 {name} 对象数组
 * @param {Object} rules - 脱敏规则,{columnName: ruleName}
 * @returns {{rows: Array, maskedCells: number}}
 */
function maskRows(rows, columns, rules) {
  const ruleMap = normalizeRules(rules);
  if (!rows || !Array.isArray(rows) || rows.length === 0 || ruleMap.size === 0) {
    return { rows: rows || [], maskedCells: 0 };
  }

  // 规范化列名数组,支持 ['name', 'phone'] 或 [{name:'phone'}, ...]
  const colNames = (columns || []).map(c =>
    typeof c === 'string' ? c : (c && c.name) || ''
  );

  // 预计算哪些列需要脱敏:[index → ruleName]
  const colRuleByIndex = [];
  const colRuleByName = new Map();
  colNames.forEach((name, i) => {
    const rule = ruleMap.get(String(name).toLowerCase());
    if (rule) {
      colRuleByIndex[i] = rule;
      colRuleByName.set(name, rule);
    }
  });

  // 对象行:也需要检查对象本身的 keys(防止 columns 未提供但行里有敏感列)
  let maskedCells = 0;

  const newRows = rows.map(row => {
    if (Array.isArray(row)) {
      const newRow = row.slice();
      for (let i = 0; i < newRow.length; i++) {
        const rule = colRuleByIndex[i];
        if (!rule) continue;
        const masked = applyRule(newRow[i], rule);
        if (masked !== newRow[i]) maskedCells++;
        newRow[i] = masked;
      }
      return newRow;
    }
    if (row && typeof row === 'object') {
      const newRow = { ...row };
      for (const key of Object.keys(newRow)) {
        // 优先用 columns 推出的规则;否则直接按 key 小写查 ruleMap
        const rule = colRuleByName.get(key) || ruleMap.get(key.toLowerCase());
        if (!rule) continue;
        const masked = applyRule(newRow[key], rule);
        if (masked !== newRow[key]) maskedCells++;
        newRow[key] = masked;
      }
      return newRow;
    }
    return row;
  });

  return { rows: newRows, maskedCells };
}

module.exports = {
  maskRows,
  // 工具函数也导出,便于单测和其他模块单独调用
  maskMid4,
  maskDomainOnly,
  maskHeadTail,
  maskRedact,
  maskFirst1,
  maskLast4,
  maskLengthStars,
  RULE_IMPL
};
