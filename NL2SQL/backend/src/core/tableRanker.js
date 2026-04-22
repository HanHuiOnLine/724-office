/**
 * 表候选统一打分与排序(Phase 2 / UNIFIED_RANKER)
 *
 * 职责:融合 4 类信号 → 归一化 → 核心表保护 + 上限 8 截断
 *   - vectorResults:   向量检索(含 searchSchemaSmart 的 priorityScore)
 *   - semanticTables:  业务语义层推荐(priority 1-3 + score 0-1)
 *   - keywordMatches:  关键词命中计数
 *   - explicitTables:  SQL 中显式提到的表名
 *   - inferredTables:  从 query 推断的相关表(固定加成)
 *
 * 打分公式(归一化到 0-100):
 *   baseScore = 0.45*V + 0.30*S + 0.15*K + 0.10*E  (上限 100)
 *   + 核心表加成 +30 / 推断加成 +15                 (最终上限 ≈ 145)
 *
 * 核心表定义: scope ∈ {platform_core, report}  (见 utils/tableScope)
 *
 * 选择策略:
 *   1. 核心表按分数排序,全部保留(但不超过 cap)
 *   2. 剩余名额从非核心表按分数补足,总数 ≤ cap (默认 8)
 *   3. cores 为空但 explicitTables 非空时,explicitTables[0] 置顶(兜底)
 *
 * feature flag: UNIFIED_RANKER (默认 true, 设 FF_UNIFIED_RANKER=false 回退到老逻辑)
 */

const featureFlags = require('../../config/feature-flags');
const { isCoreTable } = require('../utils/tableScope');

const SCORE_WEIGHTS = {
  vector: 0.45,
  semantic: 0.30,
  keyword: 0.15,
  explicit: 0.10
};

const CORE_BOOST = 30;
const INFERRED_BOOST = 15;
const CORE_CAP = 8;

const VECTOR_SCORE_MAX = 160;   // searchSchemaSmart priorityScore 理论上限
const KEYWORD_SCORE_MAX = 10;   // 关键词累计匹配次数的有效上限

/**
 * 归一化向量分(0-160 → 0-100)
 */
function normalizeVector(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, VECTOR_SCORE_MAX) / VECTOR_SCORE_MAX * 100;
}

/**
 * 归一化语义层(priority 1-3 + score 0-1 → 0-100)
 * priority=1 得 70 分基础 + score*30,priority=3 得 0 分基础
 */
function normalizeSemantic(priority, score) {
  const p = Number.isFinite(priority) ? priority : 3;
  const s = Number.isFinite(score) ? score : 0;
  const priorityPart = Math.max(0, (4 - p) / 3) * 70;
  const scorePart = Math.max(0, Math.min(s, 1)) * 30;
  return priorityPart + scorePart;
}

/**
 * 归一化关键词分(累计匹配次数 → 0-100)
 */
function normalizeKeyword(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, KEYWORD_SCORE_MAX) / KEYWORD_SCORE_MAX * 100;
}

/**
 * 合并多源信号到 { tableName -> {sources, fields} } 映射
 */
function buildCandidateMap(signals) {
  const map = new Map();

  const upsert = (name) => {
    if (!name || typeof name !== 'string') return null;
    if (!map.has(name)) {
      map.set(name, {
        name,
        vectorRaw: 0,
        semanticPriority: null,
        semanticScore: 0,
        keywordRaw: 0,
        explicit: false,
        inferred: false,
        scope: null,
        sources: []
      });
    }
    return map.get(name);
  };

  // 向量结果
  for (const r of signals.vectorResults || []) {
    const name = r && (r.name || (r.metadata && r.metadata.name));
    const entry = upsert(name);
    if (!entry) continue;
    if (Number.isFinite(r.priorityScore)) {
      entry.vectorRaw = Math.max(entry.vectorRaw, r.priorityScore);
    }
    if (r.metadata && r.metadata.scope) entry.scope = r.metadata.scope;
    if (!entry.sources.includes('vector')) entry.sources.push('vector');
  }

  // 语义层推荐
  for (const r of signals.semanticTables || []) {
    const name = r && (r.tableName || r.name);
    const entry = upsert(name);
    if (!entry) continue;
    const p = Number.isFinite(r.priority) ? r.priority : 3;
    if (entry.semanticPriority === null || p < entry.semanticPriority) {
      entry.semanticPriority = p;
    }
    if (Number.isFinite(r.score) && r.score > entry.semanticScore) {
      entry.semanticScore = r.score;
    }
    if (!entry.sources.includes('semantic')) entry.sources.push('semantic');
  }

  // 关键词命中
  for (const r of signals.keywordMatches || []) {
    const name = r && r.name;
    const entry = upsert(name);
    if (!entry) continue;
    const s = Number.isFinite(r.score) ? r.score : 1;
    entry.keywordRaw += s;
    if (!entry.sources.includes('keyword')) entry.sources.push('keyword');
  }

  // 显式表名
  for (const name of signals.explicitTables || []) {
    const entry = upsert(name);
    if (!entry) continue;
    entry.explicit = true;
    if (!entry.sources.includes('explicit')) entry.sources.push('explicit');
  }

  // 推断表(来自 inferTablesFromQuery)
  for (const name of signals.inferredTables || []) {
    const entry = upsert(name);
    if (!entry) continue;
    entry.inferred = true;
    if (!entry.sources.includes('inferred')) entry.sources.push('inferred');
  }

  return map;
}

/**
 * 对单个候选表计算 finalScore
 */
function scoreCandidate(entry) {
  const V = normalizeVector(entry.vectorRaw);
  const S = entry.semanticPriority === null
    ? 0
    : normalizeSemantic(entry.semanticPriority, entry.semanticScore);
  const K = normalizeKeyword(entry.keywordRaw);
  const E = entry.explicit ? 100 : 0;

  const baseScore =
    SCORE_WEIGHTS.vector * V +
    SCORE_WEIGHTS.semantic * S +
    SCORE_WEIGHTS.keyword * K +
    SCORE_WEIGHTS.explicit * E;

  const core = isCoreTable(entry.name, entry.scope);
  const coreBonus = core ? CORE_BOOST : 0;
  const inferredBonus = entry.inferred ? INFERRED_BOOST : 0;

  const finalScore = baseScore + coreBonus + inferredBonus;

  const reasons = [];
  if (V > 0) reasons.push(`vector=${V.toFixed(1)}`);
  if (S > 0) reasons.push(`semantic=${S.toFixed(1)}(p=${entry.semanticPriority})`);
  if (K > 0) reasons.push(`keyword=${K.toFixed(1)}`);
  if (E > 0) reasons.push('explicit');
  if (core) reasons.push('+core');
  if (entry.inferred) reasons.push('+inferred');

  return {
    name: entry.name,
    finalScore,
    isCore: core,
    reasons,
    sources: entry.sources.slice()
  };
}

/**
 * 核心表保护 + cap 截断
 */
function selectWithProtection(ranked, cap, explicitTables) {
  const sorted = ranked.slice().sort((a, b) => b.finalScore - a.finalScore);
  const cores  = sorted.filter(r => r.isCore);
  const others = sorted.filter(r => !r.isCore);

  const coreSelected = cores.slice(0, cap);
  const remaining = cap - coreSelected.length;
  const otherSelected = remaining > 0 ? others.slice(0, remaining) : [];

  let selected = [...coreSelected, ...otherSelected].map(r => r.name);

  // 兜底:cores 为空且 selected 未包含任何 explicitTables[0] 时,置顶 explicit[0]
  if (coreSelected.length === 0 && explicitTables && explicitTables.length > 0) {
    const head = explicitTables[0];
    if (head && !selected.includes(head)) {
      selected = [head, ...selected].slice(0, cap);
    }
  }

  return selected;
}

/**
 * 老逻辑兜底(FF_UNIFIED_RANKER=false 时使用)
 * 行为 = 原 nl2sqlEngine.js:1641 的 Set 合并 + slice(0,5)
 */
function legacySelect(signals) {
  const names = new Set([
    ...(signals.vectorResults || []).map(r => r && (r.name || r.metadata?.name)).filter(Boolean),
    ...(signals.inferredTables || []),
    ...(signals.semanticTables || []).map(r => r && (r.tableName || r.name)).filter(Boolean),
    ...(signals.explicitTables || [])
  ]);
  const selected = Array.from(names).slice(0, 5);
  return {
    ranked: selected.map((name, i) => ({
      name, finalScore: 100 - i, isCore: false, reasons: ['legacy'], sources: ['legacy']
    })),
    selected,
    debug: { legacy: true, totalCandidates: names.size }
  };
}

/**
 * 主入口
 *
 * @param {string} query - 原始查询(仅用于日志)
 * @param {Object} signals - 见文件头注释
 * @param {Object} options - { cap = CORE_CAP }
 * @returns {{ranked: Array, selected: Array<string>, debug: Object}}
 */
function rank(query, signals = {}, options = {}) {
  if (!featureFlags.isEnabled('UNIFIED_RANKER')) {
    return legacySelect(signals);
  }

  const cap = Number.isFinite(options.cap) && options.cap > 0 ? options.cap : CORE_CAP;

  const candidateMap = buildCandidateMap(signals);
  const ranked = Array.from(candidateMap.values()).map(scoreCandidate);
  ranked.sort((a, b) => b.finalScore - a.finalScore);

  const selected = selectWithProtection(ranked, cap, signals.explicitTables);

  const coreCount = ranked.filter(r => r.isCore && selected.includes(r.name)).length;

  return {
    ranked,
    selected,
    debug: {
      totalCandidates: ranked.length,
      coreCount,
      nonCoreCount: selected.length - coreCount,
      cap,
      query: (query || '').slice(0, 80)
    }
  };
}

module.exports = {
  rank,
  isCoreTable,
  SCORE_WEIGHTS,
  CORE_BOOST,
  INFERRED_BOOST,
  CORE_CAP
};
