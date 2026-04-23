/**
 * 请求上下文提取工具(Phase 3 · T1)
 *
 * 从 HTTP 请求中抽取标准化的上下文对象,透传给引擎和 query_history 审计字段。
 *
 * 设计选择:
 *   - Header 透传模式(无鉴权中间件,信任上游网关)
 *   - 4 个标准 header: X-User-Id / X-User-Role / X-Tenant-Id / X-Request-Source
 *   - 头缺失时使用兜底默认值,不抛异常
 *   - user_id 兼容 Phase 1 的 query param 写法
 */

/**
 * 从 HTTP 请求中提取上下文。
 *
 * @param {import('express').Request} req
 * @returns {{
 *   userId: string,          // 默认 'anonymous'
 *   userRole: string,        // 默认 'user'
 *   tenantId: string|null,   // 缺失时 null(RLS 会据此拒绝执行)
 *   requestSource: string,   // 默认 'web'
 *   requestIp: string|null
 * }}
 */
function extractContext(req) {
  const h = (req && req.headers) || {};
  const q = (req && req.query) || {};
  const b = (req && req.body) || {};

  return {
    userId:
      pickHeader(h, 'x-user-id') ||
      q.user_id ||
      b.user_id ||
      'anonymous',
    userRole:
      pickHeader(h, 'x-user-role') || 'user',
    tenantId:
      pickHeader(h, 'x-tenant-id') || null,
    requestSource:
      pickHeader(h, 'x-request-source') || 'web',
    requestIp:
      (req && (req.ip || (req.connection && req.connection.remoteAddress))) || null
  };
}

/**
 * 合并两个 context 对象。extra 中的非 undefined 字段覆盖 base。
 */
function mergeIntoContext(base = {}, extra = {}) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Header 值规范化:去空白、数组取首个、忽略空串。
 * Express 下 header 名统一小写。
 */
function pickHeader(headers, name) {
  const raw = headers[name];
  if (raw === undefined || raw === null) return null;
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

module.exports = {
  extractContext,
  mergeIntoContext
};
