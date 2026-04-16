/**
 * 澄清引擎模块（Phase 3: Clarification Engine）
 * 
 * 核心功能：
 * 1. 检测何时需要澄清（置信度不足时）
 * 2. 生成友好的澄清问题
 * 3. 应用用户的澄清回答
 */

// ============================================
// 导入依赖模块
// ============================================

const llmService = require('./llmService');
const logger = require('../utils/logger');

// ============================================
// 澄清触发条件定义
// ============================================

/**
 * 澄清触发器配置
 * 
 * 定义何时触发澄清的各种场景
 */
const CLARIFICATION_TRIGGERS = {
  // 场景1：关键数据单元无匹配表
  UNCOVERED_DATA_UNIT: {
    id: 'uncovered_data_unit',
    name: '数据单元无匹配表',
    check: (decomposition, tableCandidates) => {
      if (!decomposition?.dataUnits) return { triggered: false };
      
      const uncoveredUnits = decomposition.dataUnits.filter(unit => {
        const hasMatchingTable = tableCandidates.some(t => 
          t.units && t.units.includes(unit.id)
        );
        return !hasMatchingTable;
      });
      
      return {
        triggered: uncoveredUnits.length > 0,
        severity: 'HIGH',
        details: {
          uncoveredUnits: uncoveredUnits.map(u => ({
            id: u.id,
            type: u.type,
            description: u.description
          }))
        }
      };
    },
    priority: 1,
    messageTemplate: '以下数据需求无法匹配到具体表：{units}'
  },
  
  // 场景2：同类型数据匹配到多个表（歧义）
  TABLE_AMBIGUITY: {
    id: 'table_ambiguity',
    name: '表选择歧义',
    check: (decomposition, tableCandidates) => {
      if (!decomposition?.dataUnits || !tableCandidates) return { triggered: false };
      
      const typeToTables = new Map();
      
      for (const candidate of tableCandidates) {
        for (const unitId of (candidate.units || [])) {
          const unit = decomposition.dataUnits.find(u => u.id === unitId);
          if (unit) {
            const type = unit.type;
            if (!typeToTables.has(type)) {
              typeToTables.set(type, []);
            }
            typeToTables.get(type).push(candidate.table?.name || candidate.tableName);
          }
        }
      }
      
      const ambiguities = [];
      for (const [type, tables] of typeToTables.entries()) {
        if (tables.length > 1) {
          ambiguities.push({ type, tables: [...new Set(tables)] });
        }
      }
      
      return {
        triggered: ambiguities.length > 0,
        severity: 'MEDIUM',
        details: { ambiguities }
      };
    },
    priority: 2,
    messageTemplate: '{dataType}可能来自以下表，请选择：{tables}'
  },
  
  // 场景3：聚合指标来源不明确
  AGGREGATION_SOURCE_UNCERTAIN: {
    id: 'aggregation_source_uncertain',
    name: '聚合指标来源不明确',
    check: (decomposition, tableCandidates) => {
      if (!decomposition?.dataUnits) return { triggered: false };
      
      const aggUnits = decomposition.dataUnits.filter(u => 
        u.type && (u.type.includes('聚合') || u.type.includes('指标'))
      );
      
      const uncertainAggregations = aggUnits.filter(unit => {
        const candidates = tableCandidates.filter(t => 
          t.units && t.units.includes(unit.id)
        );
        
        // 检查是否同时存在原始表和汇总表
        const tableNames = candidates.map(c => c.table?.name || c.tableName || '');
        const hasRaw = tableNames.some(name => 
          name.includes('log') && !name.includes('summary') && !name.includes('stat')
        );
        const hasSummary = tableNames.some(name => 
          name.includes('summary') || name.includes('stat') || name.includes('report')
        );
        
        return hasRaw && hasSummary;
      });
      
      return {
        triggered: uncertainAggregations.length > 0,
        severity: 'LOW',
        details: {
          metrics: uncertainAggregations.map(u => u.metric || u.description)
        }
      };
    },
    priority: 3,
    messageTemplate: '请问"{metric}"需要实时计算还是使用预汇总数据？'
  },
  
  // 场景4：时间粒度不明确
  TIME_GRANULARITY_UNCERTAIN: {
    id: 'time_granularity_uncertain',
    name: '时间粒度不明确',
    check: (decomposition) => {
      if (!decomposition?.dataUnits) return { triggered: false };
      
      const timeUnits = decomposition.dataUnits.filter(unit => 
        unit.type && unit.type.includes('时间') && 
        unit.timeRange && 
        !unit.timeRange.granularity
      );
      
      return {
        triggered: timeUnits.length > 0,
        severity: 'LOW',
        details: {
          timeUnits: timeUnits.map(u => ({
            id: u.id,
            timeRange: u.timeRange
          }))
        }
      };
    },
    priority: 4,
    messageTemplate: '时间统计维度需要按天、周还是月？'
  },
  
  // 场景5：低置信度
  LOW_CONFIDENCE: {
    id: 'low_confidence',
    name: '置信度过低',
    check: (decomposition, tableCandidates, confidence) => {
      const threshold = 0.6;
      return {
        triggered: confidence < threshold,
        severity: confidence < 0.4 ? 'HIGH' : 'MEDIUM',
        details: {
          confidence,
          threshold
        }
      };
    },
    priority: 1,
    messageTemplate: '我对查询的理解不够准确，能否提供更多细节？'
  }
};

// ============================================
// 核心函数：检查是否需要澄清
// ============================================

/**
 * 检查是否需要澄清
 * 
 * @param {Object} decomposition - 查询分解结果
 * @param {Array} tableCandidates - 表候选列表
 * @param {number} confidence - 置信度分数
 * @returns {Object} 检查结果
 */
function checkClarificationNeeded(decomposition, tableCandidates, confidence = 0.8) {
  const triggers = [];
  
  // 检查所有触发条件
  for (const [key, trigger] of Object.entries(CLARIFICATION_TRIGGERS)) {
    const result = trigger.check(decomposition, tableCandidates, confidence);
    
    if (result.triggered) {
      triggers.push({
        id: trigger.id,
        name: trigger.name,
        severity: result.severity,
        priority: trigger.priority,
        messageTemplate: trigger.messageTemplate,
        details: result.details
      });
    }
  }
  
  // 按优先级排序
  triggers.sort((a, b) => a.priority - b.priority);
  
  // 只返回最高优先级的触发（避免一次问太多问题）
  const needsClarification = triggers.length > 0;
  const topTrigger = triggers[0];
  
  return {
    needsClarification,
    triggers,
    topTrigger,
    summary: {
      totalTriggers: triggers.length,
      highSeverity: triggers.filter(t => t.severity === 'HIGH').length,
      topPriority: topTrigger?.priority
    }
  };
}

// ============================================
// 核心函数：生成澄清问题
// ============================================

/**
 * 生成澄清问题
 * 
 * @param {Object} decomposition - 查询分解结果
 * @param {Array} tableCandidates - 表候选列表
 * @param {Object} trigger - 触发器
 * @returns {Promise<Object>} 澄清问题
 */
async function generateClarification(decomposition, tableCandidates, trigger) {
  logger.debug('[ClarificationEngine] 生成澄清问题', { trigger: trigger?.id });
  
  try {
    // 构建澄清问题Prompt
    const clarificationPrompt = buildClarificationPrompt(decomposition, tableCandidates, trigger);
    
    // 调用LLM生成澄清问题
    const response = await llmService.simpleChat('', clarificationPrompt);
    
    // 解析响应
    const clarification = parseClarificationResponse(response, trigger);
    
    logger.info('[ClarificationEngine] 澄清问题生成完成', {
      triggerId: trigger?.id,
      questionType: clarification.clarificationType
    });
    
    return clarification;
    
  } catch (error) {
    logger.error('[ClarificationEngine] 澄清问题生成失败:', error);
    
    // 返回默认澄清问题
    return createDefaultClarification(trigger);
  }
}

/**
 * 构建澄清问题Prompt
 */
function buildClarificationPrompt(decomposition, tableCandidates, trigger) {
  const dataUnitsText = decomposition?.dataUnits?.map(u => 
    `- ${u.type}: ${u.description}`
  ).join('\n') || '无';
  
  const tablesText = tableCandidates?.slice(0, 5).map(t => 
    `- ${t.table?.name || t.tableName}: ${t.table?.description || ''}`
  ).join('\n') || '无';
  
  return `基于以下查询分析结果，生成友好的澄清问题。

原始查询："${decomposition?.originalQuery || '未知'}"

识别到的数据需求：
${dataUnitsText}

候选表：
${tablesText}

触发澄清的原因：${trigger?.name || '未知'}
详细信息：${JSON.stringify(trigger?.details || {})}

请生成：
1. 一个友好的澄清问题
2. 2-4个选项（如果适用）
3. 默认推荐（基于最可能的意图）

返回JSON格式：
{
  "question": "澄清问题文本",
  "options": ["选项1", "选项2", "选项3"],
  "defaultOption": "推荐选项",
  "clarificationType": "table_selection|metric_source|time_granularity|general",
  "explanation": "为什么需要澄清"
}`;
}

/**
 * 解析澄清问题响应
 */
function parseClarificationResponse(response, trigger) {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    logger.warn('[ClarificationEngine] 解析失败:', e);
  }
  
  return createDefaultClarification(trigger);
}

/**
 * 创建默认澄清问题
 */
function createDefaultClarification(trigger) {
  const templates = {
    'uncovered_data_unit': {
      question: '部分数据需求无法匹配到具体表，能否提供更多细节？',
      options: ['提供更多信息', '简化查询', '继续尝试'],
      defaultOption: '提供更多信息',
      clarificationType: 'general'
    },
    'table_ambiguity': {
      question: '检测到多个可能的数据来源，请确认您需要的数据类型：',
      options: ['详细数据', '汇总数据', '不确定，帮我选择'],
      defaultOption: '详细数据',
      clarificationType: 'table_selection'
    },
    'aggregation_source_uncertain': {
      question: '聚合指标可以使用不同数据源计算，您需要：',
      options: ['实时计算（更准确）', '预汇总数据（更快）', '自动选择'],
      defaultOption: '自动选择',
      clarificationType: 'metric_source'
    },
    'time_granularity_uncertain': {
      question: '时间维度需要按什么粒度统计？',
      options: ['按天', '按周', '按月', '自动选择'],
      defaultOption: '按天',
      clarificationType: 'time_granularity'
    },
    'low_confidence': {
      question: '我对您的查询理解不够准确，能否提供更多细节？',
      options: ['重新描述', '提供示例', '继续尝试'],
      defaultOption: '继续尝试',
      clarificationType: 'general'
    }
  };
  
  const template = templates[trigger?.id] || templates['low_confidence'];
  
  return {
    ...template,
    triggerId: trigger?.id,
    explanation: `触发条件: ${trigger?.name || '未知'}`
  };
}

// ============================================
// 核心函数：应用澄清结果
// ============================================

/**
 * 应用澄清结果
 * 
 * @param {Object} decomposition - 原始分解结果
 * @param {Object} clarification - 澄清问题
 * @param {string} userAnswer - 用户回答
 * @returns {Object} 更新后的分解结果
 */
function applyClarificationResult(decomposition, clarification, userAnswer) {
  logger.debug('[ClarificationEngine] 应用澄清结果', {
    clarificationType: clarification?.clarificationType,
    answer: userAnswer
  });
  
  // 创建分解结果的副本
  const updatedDecomposition = JSON.parse(JSON.stringify(decomposition));
  
  // 根据澄清类型应用结果
  switch (clarification?.clarificationType) {
    case 'table_selection':
      applyTableSelection(updatedDecomposition, clarification, userAnswer);
      break;
      
    case 'metric_source':
      applyMetricSource(updatedDecomposition, clarification, userAnswer);
      break;
      
    case 'time_granularity':
      applyTimeGranularity(updatedDecomposition, clarification, userAnswer);
      break;
      
    default:
      // 一般性澄清，添加到备注
      updatedDecomposition.clarificationNote = userAnswer;
  }
  
  // 标记已澄清
  updatedDecomposition.clarified = true;
  updatedDecomposition.clarificationHistory = updatedDecomposition.clarificationHistory || [];
  updatedDecomposition.clarificationHistory.push({
    question: clarification?.question,
    answer: userAnswer,
    timestamp: new Date().toISOString()
  });
  
  return updatedDecomposition;
}

/**
 * 应用表选择澄清
 */
function applyTableSelection(decomposition, clarification, userAnswer) {
  // 如果用户选择了特定表类型，更新偏好
  if (userAnswer.includes('详细') || userAnswer.includes('明细')) {
    decomposition.preferSummaryTable = false;
  } else if (userAnswer.includes('汇总') || userAnswer.includes('统计')) {
    decomposition.preferSummaryTable = true;
  }
}

/**
 * 应用指标来源澄清
 */
function applyMetricSource(decomposition, clarification, userAnswer) {
  if (userAnswer.includes('实时') || userAnswer.includes('准确')) {
    decomposition.metricSource = 'realtime';
  } else if (userAnswer.includes('预汇总') || userAnswer.includes('快')) {
    decomposition.metricSource = 'summary';
  } else {
    decomposition.metricSource = 'auto';
  }
}

/**
 * 应用时间粒度澄清
 */
function applyTimeGranularity(decomposition, clarification, userAnswer) {
  // 更新所有时间单元的粒度
  for (const unit of decomposition.dataUnits || []) {
    if (unit.timeRange) {
      if (userAnswer.includes('天') || userAnswer.includes('日')) {
        unit.timeRange.granularity = 'day';
      } else if (userAnswer.includes('周')) {
        unit.timeRange.granularity = 'week';
      } else if (userAnswer.includes('月')) {
        unit.timeRange.granularity = 'month';
      } else {
        unit.timeRange.granularity = 'auto';
      }
    }
  }
}

// ============================================
// 导出模块
// ============================================

module.exports = {
  // 触发器配置
  CLARIFICATION_TRIGGERS,
  
  // 核心函数
  checkClarificationNeeded,
  generateClarification,
  applyClarificationResult,
  
  // 辅助函数
  createDefaultClarification
};
