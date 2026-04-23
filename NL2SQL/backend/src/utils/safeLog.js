/**
 * 日志脱敏工具（Phase 3 · T2）
 *
 * 提供 hash / 首尾片段摘要,用于替代完整 Prompt / 用户 query 明文日志。
 * 核心原则:
 *   - 永远不直接 console.log 完整 prompt(包含用户数据)
 *   - 正常运行时 debug 级别也只打摘要
 *   - 需要真实排障时用 LOG_PROMPT_FULL=true 临时开启完整输出
 */

const crypto = require('crypto');

/**
 * 对文本计算 SHA-1 前 8 位,用于日志中区分不同 Prompt。
 * 空/非字符串输入返回固定标记,不抛异常。
 *
 * @param {string} text - 待 hash 文本
 * @returns {string} 8 字符 hex,或 'empty' / 'nonstr'
 */
function hashPrompt(text) {
  if (text === null || text === undefined || text === '') return 'empty';
  if (typeof text !== 'string') return 'nonstr';
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);
}

/**
 * 把 Prompt / query 摘要为 { length, hash, head, tail }。
 * 短文本(head+tail 覆盖全文)省略 tail,避免冗余。
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.head=60] - 保留开头字符数
 * @param {number} [options.tail=60] - 保留结尾字符数
 * @returns {{length:number, hash:string, head?:string, tail?:string}}
 */
function summarizePrompt(text, options = {}) {
  const head = options.head ?? 60;
  const tail = options.tail ?? 60;

  if (text === null || text === undefined) {
    return { length: 0, hash: 'empty' };
  }
  if (typeof text !== 'string') {
    return { length: 0, hash: 'nonstr' };
  }

  const length = text.length;
  const out = { length, hash: hashPrompt(text) };

  if (length === 0) return out;
  out.head = text.slice(0, head);
  if (length > head + tail) {
    out.tail = text.slice(-tail);
  }
  return out;
}

/**
 * 检查是否启用完整 Prompt 日志输出(调试逃生门)。
 * 仅 dev 环境临时开启,不进入 feature-flags 体系。
 */
function isPromptFullLoggingEnabled() {
  return process.env.LOG_PROMPT_FULL === 'true';
}

module.exports = {
  hashPrompt,
  summarizePrompt,
  isPromptFullLoggingEnabled
};
