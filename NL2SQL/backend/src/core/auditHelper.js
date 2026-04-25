/**
 * NL2SQL 真实数据输出 · 批次 D1
 * 审计摘要工具：把 sqlExecutor.executeQuery 的 data 压缩成可入库的摘要，
 * 用于替代原先在 query_history.result 中存储 rows.slice(0, 20) 的做法，
 * 避免业务行数据落库（数据最小化）。
 *
 * 纯函数、无 I/O，便于单测。
 */

const crypto = require('crypto');

/**
 * 把 executeQuery 返回的 data 压缩为审计摘要
 * @param {Object} data - 来源 sqlExecutor.executeQuery().data
 * @param {Array<string>} [data.columns]
 * @param {Array<Object>} [data.rows]
 * @param {number} [data.rowCount]
 * @param {boolean} [data.truncated]
 * @returns {{ columns: Array<string>, rowCount: number, truncated: boolean, sampleHash: string }}
 *
 * sampleHash 取 rows 前 5 行 JSON 序列化后的 sha256 前 16 字符；
 * 仅用于事后抽样比对，不还原业务内容。空 rows → sampleHash = ''。
 */
function summarizeResultForAudit(data) {
  const safe = data && typeof data === 'object' ? data : {};
  const columns = Array.isArray(safe.columns) ? safe.columns : [];
  const rows = Array.isArray(safe.rows) ? safe.rows : [];
  const rowCount = typeof safe.rowCount === 'number' ? safe.rowCount : rows.length;
  const truncated = !!safe.truncated;

  let sampleHash = '';
  if (rows.length > 0) {
    const sample = rows.slice(0, 5);
    sampleHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(sample))
      .digest('hex')
      .slice(0, 16);
  }

  return { columns, rowCount, truncated, sampleHash };
}

module.exports = {
  summarizeResultForAudit
};
