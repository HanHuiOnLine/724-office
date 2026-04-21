/**
 * 统一 LLM 响应解析器
 *
 * 提供从 LLM 文本响应中提取 JSON 和 SQL 的标准化方法。
 * 替代散布在 nl2sqlEngine / longTermMemory / agenticEngine /
 * queryDecomposer / toolLoop 中的 6 处重复实现。
 */

const logger = require('./logger');

/**
 * 从 LLM 响应中解析 JSON 对象
 *
 * 策略顺序：
 *   1. 直接 JSON.parse
 *   2. 提取 ```json ... ``` 代码块
 *   3. 提取最外层花括号（非贪婪匹配）
 *
 * @param {string} response - LLM 原始响应文本
 * @param {string} [context=''] - 调用上下文描述（用于日志）
 * @returns {Object} 解析后的 JSON 对象
 * @throws {Error} 三种策略均失败时抛出
 */
function parseJSON(response, context = '') {
  if (!response || typeof response !== 'string') {
    throw new Error(`${context ? `[${context}] ` : ''}无法解析JSON响应: 输入为空`);
  }

  // 策略 1：直接解析
  try {
    return JSON.parse(response);
  } catch (_) {
    // fall through
  }

  // 策略 2：提取 ```json ... ``` 代码块
  const codeBlockMatch = response.match(/```json\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch (_) {
      // fall through
    }
  }

  // 策略 3：提取花括号内容
  // 使用函数式方法寻找匹配的 { } 对，而非贪婪正则
  const jsonStr = extractBalancedJSON(response);
  if (jsonStr) {
    try {
      return JSON.parse(jsonStr);
    } catch (_) {
      // fall through
    }
  }

  const preview = response.substring(0, 150).replace(/\n/g, '\\n');
  throw new Error(`${context ? `[${context}] ` : ''}无法解析JSON响应: ${preview}`);
}

/**
 * 从文本中提取第一个平衡的 JSON 对象字符串
 * 正确处理嵌套花括号和字符串内的花括号
 *
 * @param {string} text - 源文本
 * @returns {string|null} 提取到的 JSON 字符串，或 null
 */
function extractBalancedJSON(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.substring(start, i + 1);
      }
    }
  }

  return null;
}

/**
 * 从 LLM 响应中提取 SQL 语句
 *
 * 策略顺序：
 *   1. 从 JSON 响应的 sql 字段提取
 *   2. 从 ```sql ... ``` 代码块提取
 *   3. 正则匹配 SELECT 语句
 *
 * @param {string} response - LLM 原始响应文本
 * @returns {string} 提取到的 SQL，或空字符串
 */
function extractSQL(response) {
  if (!response) return '';

  // 策略 1：尝试从 JSON 中提取 sql 字段
  try {
    const json = parseJSON(response);
    if (json.sql) return json.sql.trim();
  } catch (_) {
    // fall through
  }

  // 策略 2：提取 ```sql ... ``` 代码块
  const sqlBlockMatch = response.match(/```sql\s*([\s\S]*?)```/);
  if (sqlBlockMatch) {
    return sqlBlockMatch[1].trim();
  }

  // 策略 3：正则匹配 SELECT 语句
  const sqlMatch = response.match(/SELECT[\s\S]+?(?=(?:\n\n|```|$))/i);
  if (sqlMatch) {
    return sqlMatch[0].trim();
  }

  return '';
}

module.exports = { parseJSON, extractSQL };
