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
  // Phase 3: 引擎入口切换 & 安全收敛
  // ============================================

  /**
   * 【Phase 3 · T1】Agentic 引擎失败自动回退 legacy
   * 反向开关,默认 true(紧急情况设 FF_AGENTIC_AUTO_FALLBACK=false 关闭)
   * 设 false 时 agentic 失败会直接抛给前端,便于排障
   */
  AGENTIC_AUTO_FALLBACK: process.env.FF_AGENTIC_AUTO_FALLBACK === 'false' ? false : true,

  /**
   * 【Phase 3 · T3a】结果脱敏
   * 反向开关,默认 true。启用后 executeQuery 返回前按 config.security.masking.rules 对敏感列脱敏
   * 紧急关闭:FF_RESULT_MASKING=false
   */
  RESULT_MASKING: process.env.FF_RESULT_MASKING === 'false' ? false : true,

  /**
   * 【Phase 3 · T3b】行级权限(RLS)SQL 改写
   * 正向开关,默认 false。启用后需同时:
   *   - 设 RLS_ENABLED=true
   *   - 填写 RLS_TABLE_TENANT_MAP(例 "orders:tenant_id,users:tenant_id")
   *   - 请求带 X-Tenant-Id header
   * 最高风险项:Parser 解析失败 / 映射配错时会硬拒 SQL 执行。新表默认不保护,需 opt-in
   */
  RLS_ENFORCEMENT: process.env.FF_RLS_ENFORCEMENT === 'true' || false,

  /**
   * 【Phase 3 · T3c】扩展审计字段写入(query_history 的 user_role/tenant_id/…/rls_applied)
   * 反向开关,默认 true。字段 NULL-safe,紧急情况才关闭
   */
  AUDIT_LOG_EXTENDED: process.env.FF_AUDIT_LOG_EXTENDED === 'false' ? false : true,

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
  // Agent SDK 引擎(批次 1)
  // ============================================

  /**
   * 【批次 1】是否启用 Claude Agent SDK 引擎(优先级最高的引擎路径)
   * 启用后 sseHandler.handleQuery 会优先走 agentSdkEngine,失败自动降级到 agentic / legacy
   * 默认关闭,通过 FF_USE_AGENT_SDK=true 打开
   */
  USE_AGENT_SDK: process.env.FF_USE_AGENT_SDK === 'true' || false,

  /**
   * 【批次 1】SDK 引擎灰度比例(0-100,基于 userId 稳定哈希)
   * 0=关闭,100=全量;FF_USE_AGENT_SDK 必须同时为 true 才生效
   * 仅控制是否进入 SDK 路径,失败仍按 fallback 链降级
   */
  AGENT_SDK_GRAY_PCT: (() => {
    const raw = parseInt(process.env.FF_AGENT_SDK_GRAY_PCT || '0', 10);
    if (Number.isNaN(raw)) return 0;
    return Math.max(0, Math.min(100, raw));
  })(),
  
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
 * 【批次 1】基于 userId 的稳定哈希,用于 SDK 灰度判定
 *
 * 同一 userId 多次进同一引擎,避免会话内引擎切换造成的体感不一致
 * 算法选 djb2 简化版,字符串可空(走 'anonymous')
 *
 * @param {string} s
 * @returns {number} 非负 int
 */
function simpleHash(s) {
  let h = 0;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0; // 强制 32 位
  }
  return Math.abs(h);
}

/**
 * 【批次 1】判定本次请求是否走 SDK 引擎
 *
 * 三步走:
 *   1. FF_USE_AGENT_SDK 总闸,关则一律 false
 *   2. AGENT_SDK_GRAY_PCT >= 100 全开;<= 0 全关
 *   3. 中间值按 simpleHash(userId) % 100 命中比例
 *
 * @param {string|null|undefined} userId
 * @returns {boolean}
 */
function useAgentSdk(userId) {
  if (featureFlags.DISABLE_ALL_FEATURES) return false;
  if (!featureFlags.USE_AGENT_SDK) return false;
  const pct = featureFlags.AGENT_SDK_GRAY_PCT;
  if (pct >= 100) return true;
  if (pct <= 0) return false;
  return simpleHash(userId || 'anonymous') % 100 < pct;
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

  // 【批次 1】SDK 引擎灰度判定
  useAgentSdk,
  simpleHash,

  // 日志
  logFeatureFlags
};
