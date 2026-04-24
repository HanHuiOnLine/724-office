/**
 * NL2SQL 结果格式化模块（Phase 4 · 任务 A.5）
 *
 * 职责：
 * - 将 `executeQuery` 返回的结构化结果转换为自然语言总结
 * - 失败路径返回简短错误文本；成功路径调 LLM 生成关键数据点 + 趋势 + 异常描述
 */

const logger = require('../utils/logger');
const llmService = require('./llmService');

async function formatResult(result, originalQuery) {
  if (!result.success) {
    return `查询失败: ${result.error}`;
  }

  const prompt = `用户查询: "${originalQuery}"

查询结果:
- 返回行数: ${result.data.rowCount}
- 执行耗时: ${result.executionTime}ms
- 数据样例:
${JSON.stringify(result.data.rows.slice(0, 5), null, 2)}

请用自然语言总结查询结果，包括:
1. 关键数据点
2. 任何明显的趋势或异常
3. 是否需要进一步分析

保持简洁友好。`;

  try {
    const response = await llmService.simpleChat(prompt);
    return response.trim();
  } catch (error) {
    logger.error('格式化结果失败:', error);
    return `查询完成，返回 ${result.data.rowCount} 条数据，耗时 ${result.executionTime}ms。`;
  }
}

module.exports = {
  formatResult
};
