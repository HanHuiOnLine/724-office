/**
 * 功能开关配置（Phase 1: Feature Flag Control）
 * 
 * 用于渐进式启用新功能，支持快速回滚
 */

// ============================================
// 功能开关定义
// ============================================

/**
 * 功能开关配置
 * 
 * 每个Phase独立开关，可以单独启用或禁用
 */
const featureFlags = {
  // ============================================
  // Phase 1: 工具化Schema探索
  // ============================================
  
  /**
   * 是否启用工具化Schema探索
   * 启用后，LLM可以主动调用工具探索Schema
   */
  TOOL_AUGMENTED_SCHEMA: process.env.FF_TOOL_AUGMENTED_SCHEMA === 'true' || false,
  
  /**
   * 是否启用Level 1/2分层加载
   * 启用后，初始Prompt使用Level 1索引，按需加载Level 2详情
   */
  SCHEMA_LAYERED_LOADING: process.env.FF_SCHEMA_LAYERED_LOADING === 'true' || false,
  
  /**
   * 是否启用工具循环模式
   * 启用后，LLM可以进行多轮工具调用
   */
  TOOL_LOOP_MODE: process.env.FF_TOOL_LOOP_MODE === 'true' || false,
  
  // ============================================
  // Phase 2: 动态意图拆解
  // ============================================
  
  /**
   * 是否启用动态意图拆解
   * 启用后，复杂查询会被拆解为多个数据需求单元
   */
  DYNAMIC_INTENT_DECOMPOSITION: process.env.FF_DYNAMIC_INTENT_DECOMPOSITION === 'true' || false,
  
  /**
   * 是否启用业务语义层
   * 启用后，"老平台"等业务术语可以被正确映射
   */
  BUSINESS_SEMANTIC_LAYER: process.env.FF_BUSINESS_SEMANTIC_LAYER === 'true' || false,
  
  // ============================================
  // Phase 3: 澄清机制
  // ============================================
  
  /**
   * 是否启用澄清引擎
   * 启用后，当检索置信度不足时会主动询问用户
   */
  CLARIFICATION_ENGINE: process.env.FF_CLARIFICATION_ENGINE === 'true' || false,
  
  // ============================================
  // Phase 4: 多步推理与自我修正
  // ============================================
  
  /**
   * 是否启用Agentic引擎
   * 启用后，使用四阶段Agentic工作流
   */
  AGENTIC_ENGINE: process.env.FF_AGENTIC_ENGINE === 'true' || false,
  
  /**
   * 是否启用自我修正恢复
   * 启用后，SQL执行失败时自动尝试修复
   */
  AUTO_RECOVERY: process.env.FF_AUTO_RECOVERY === 'true' || false,

  // ============================================
  // Phase 2 增强: 统一表候选打分(Unified Ranker)
  // ============================================

  /**
   * 【Phase 2】统一表候选排序器
   * 启用后：融合向量分/语义层/关键词/核心表加权到单一打分函数,去除 slice(0,5) 硬截断
   * 默认 true (紧急回滚时设 FF_UNIFIED_RANKER=false 回退到老 Set+slice(0,5) 行为)
   */
  UNIFIED_RANKER: process.env.FF_UNIFIED_RANKER === 'false' ? false : true,
  
  // ============================================
  // 全局开关
  // ============================================
  
  /**
   * 是否启用所有新功能（谨慎使用）
   * 设置为true后，所有功能开关都将被强制启用
   */
  ENABLE_ALL_FEATURES: process.env.FF_ENABLE_ALL === 'true' || false,
  
  /**
   * 是否禁用所有新功能（紧急回滚使用）
   * 设置为true后，所有功能开关都将被强制禁用
   */
  DISABLE_ALL_FEATURES: process.env.FF_DISABLE_ALL === 'true' || false
};

// ============================================
// 开关检查函数
// ============================================

/**
 * 检查功能开关是否启用
 * 
 * @param {string} flagName - 功能开关名称
 * @returns {boolean} 是否启用
 */
function isEnabled(flagName) {
  // 全局禁用优先
  if (featureFlags.DISABLE_ALL_FEATURES) {
    return false;
  }
  
  // 全局启用次之
  if (featureFlags.ENABLE_ALL_FEATURES) {
    return true;
  }
  
  // 返回具体开关的值
  return featureFlags[flagName] || false;
}

/**
 * 获取所有功能开关状态
 * 
 * @returns {Object} 功能开关状态对象
 */
function getAllFlags() {
  const status = {};
  
  for (const [key, value] of Object.entries(featureFlags)) {
    // 跳过全局开关
    if (key === 'ENABLE_ALL_FEATURES' || key === 'DISABLE_ALL_FEATURES') {
      continue;
    }
    
    status[key] = isEnabled(key);
  }
  
  return status;
}

/**
 * 检查是否应该使用Agentic工作流
 * 综合判断多个开关
 * 
 * @returns {boolean} 是否使用Agentic工作流
 */
function shouldUseAgenticWorkflow() {
  // 如果启用了Agentic引擎，使用新的四阶段工作流
  if (isEnabled('AGENTIC_ENGINE')) {
    return true;
  }
  
  // 如果启用了工具循环模式，使用工具增强的工作流
  if (isEnabled('TOOL_LOOP_MODE')) {
    return true;
  }
  
  return false;
}

/**
 * 检查是否应该使用分层Schema加载
 * 
 * @returns {boolean} 是否使用分层加载
 */
function shouldUseLayeredSchema() {
  return isEnabled('SCHEMA_LAYERED_LOADING') || isEnabled('TOOL_AUGMENTED_SCHEMA');
}

/**
 * 获取当前启用的Phase列表
 * 
 * @returns {Array<string>} 启用的Phase列表
 */
function getEnabledPhases() {
  const phases = [];
  
  if (isEnabled('TOOL_AUGMENTED_SCHEMA') || 
      isEnabled('SCHEMA_LAYERED_LOADING') || 
      isEnabled('TOOL_LOOP_MODE')) {
    phases.push('Phase 1: 工具化Schema探索');
  }
  
  if (isEnabled('DYNAMIC_INTENT_DECOMPOSITION') || 
      isEnabled('BUSINESS_SEMANTIC_LAYER')) {
    phases.push('Phase 2: 动态意图拆解');
  }
  
  if (isEnabled('CLARIFICATION_ENGINE')) {
    phases.push('Phase 3: 澄清机制');
  }
  
  if (isEnabled('AGENTIC_ENGINE') || isEnabled('AUTO_RECOVERY')) {
    phases.push('Phase 4: 多步推理与自我修正');
  }
  
  return phases;
}

// ============================================
// 日志输出
// ============================================

/**
 * 打印功能开关状态
 */
function logFeatureFlags() {
  console.log('\n========================================');
  console.log('功能开关状态');
  console.log('========================================');
  
  const status = getAllFlags();
  
  for (const [key, value] of Object.entries(status)) {
    console.log(`  ${key}: ${value ? '✅ 启用' : '❌ 禁用'}`);
  }
  
  const enabledPhases = getEnabledPhases();
  if (enabledPhases.length > 0) {
    console.log('\n启用的新功能:');
    enabledPhases.forEach(phase => console.log(`  - ${phase}`));
  } else {
    console.log('\n当前使用原有流程');
  }
  
  console.log('========================================\n');
}

// ============================================
// 导出模块
// ============================================

module.exports = {
  // 功能开关值
  ...featureFlags,
  
  // 检查函数
  isEnabled,
  getAllFlags,
  shouldUseAgenticWorkflow,
  shouldUseLayeredSchema,
  getEnabledPhases,
  
  // 日志
  logFeatureFlags
};
