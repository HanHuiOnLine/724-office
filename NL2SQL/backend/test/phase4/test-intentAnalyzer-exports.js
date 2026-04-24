/**
 * Phase 4 · 任务 A.1 单测:intentAnalyzer 导出契约 + checkIntentComplete 纯逻辑
 * 运行:node backend/test/phase4/test-intentAnalyzer-exports.js
 */

const path = require('path');
const intentAnalyzer = require(path.resolve(__dirname, '../../src/core/intentAnalyzer'));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

console.log('\n[intentAnalyzer 导出]');
const expected = [
  'analyzeIntent', 'checkIntentComplete', 'enrichIntentWithClarificationContext',
  'extractDefaultOptionsFromClarification', 'generateClarification',
  'getCoreHighFrequencyTables', 'getDialogueSummary',
  'getRelevantTablesForIntent', 'isAffirmativeClarificationReply',
  'mergeIntent', 'updateIntentWithLLM'
];
for (const name of expected) {
  ok(typeof intentAnalyzer[name] === 'function', `${name} 是函数`);
}

// ========================================
// checkIntentComplete 分支
// ========================================
console.log('\n[checkIntentComplete]');

const intent1 = { time_range: {value: '昨天'}, metrics: ['收入金额'], confidence: 0.9 };
const r1 = intentAnalyzer.checkIntentComplete(intent1, []);
ok(r1.complete === true && r1.missing.length === 0, '完整意图 → complete=true');

const intent2 = { metrics: ['收入金额'], confidence: 0.9 };
const r2 = intentAnalyzer.checkIntentComplete(intent2, []);
ok(r2.complete === false && r2.missing.includes('time_range'), '缺 time_range → missing 包含 time_range');

const intent3 = { time_range: {value: '昨天'}, confidence: 0.9 };
const r3 = intentAnalyzer.checkIntentComplete(intent3, []);
ok(r3.complete === false && r3.missing.includes('metrics'), '缺 metrics → missing 包含 metrics');

const intent4 = { time_range: {value: '昨天'}, metrics: ['收入金额'], confidence: 0.5 };
const r4 = intentAnalyzer.checkIntentComplete(intent4, []);
ok(r4.complete === false && r4.missing.includes('confidence'), '低置信度 → missing 包含 confidence');

// pending confirmation: 历史有 clarify + missingSlots,当前 intent 未解决
const intent5 = { time_range: {value: '昨天'}, metrics: ['收入金额'], confidence: 0.9 };
const historyWithPending = [
  { role: 'assistant', type: 'clarify', content: '请提供游戏ID?', metadata: { missingSlots: ['game_id'] } }
];
const r5 = intentAnalyzer.checkIntentComplete(intent5, historyWithPending);
ok(r5.complete === false && r5.pendingConfirmations.includes('game_id'),
  '历史有未解决的 game_id 槽位 → pendingConfirmations');

// pending 已在 filters 中解决
const intent6 = {
  time_range: {value: '昨天'}, metrics: ['收入金额'], confidence: 0.9,
  filters: [{field: 'game_id', op: '=', value: '30'}]
};
const r6 = intentAnalyzer.checkIntentComplete(intent6, historyWithPending);
ok(r6.complete === true, 'filters 中已有 game_id → complete');

// confirm_default 分支:跳过 pending 检查
const intent7 = {
  time_range: {value: '昨天'}, metrics: ['收入金额'], confidence: 0.9,
  clarification_context: { answerType: 'confirm_default', confirmedSlots: ['game_id'] }
};
const r7 = intentAnalyzer.checkIntentComplete(intent7, historyWithPending);
ok(r7.complete === true, 'answerType=confirm_default + confirmedSlots 非空 → 跳过 pending 检查');

// ========================================
// isAffirmativeClarificationReply
// ========================================
console.log('\n[isAffirmativeClarificationReply]');
ok(intentAnalyzer.isAffirmativeClarificationReply('是') === true, '"是" → true');
ok(intentAnalyzer.isAffirmativeClarificationReply('OK') === true, '"OK" → true');
ok(intentAnalyzer.isAffirmativeClarificationReply('都确认了') === true, '"都确认了" → true');
ok(intentAnalyzer.isAffirmativeClarificationReply('按默认即可') === true, '"按默认即可" → true');
ok(intentAnalyzer.isAffirmativeClarificationReply('不是') === false, '"不是" → false');
ok(intentAnalyzer.isAffirmativeClarificationReply('') === false, '空串 → false');
ok(intentAnalyzer.isAffirmativeClarificationReply('game_id=30') === false, '非确认文本 → false');

// ========================================
// getDialogueSummary
// ========================================
console.log('\n[getDialogueSummary]');
const sumEmpty = intentAnalyzer.getDialogueSummary([]);
ok(sumEmpty === '', '空 history → 空串');
const history = [
  { role: 'user', content: '你好', type: 'text' },
  { role: 'assistant', content: '需要澄清', type: 'clarify' }
];
const sumStr = intentAnalyzer.getDialogueSummary(history, 10);
ok(sumStr.includes('用户') && sumStr.includes('助手'), '含角色标签');
ok(sumStr.includes('(clarify)'), '含 type 标签');

// ========================================
// extractDefaultOptionsFromClarification
// ========================================
console.log('\n[extractDefaultOptionsFromClarification]');
ok(intentAnalyzer.extractDefaultOptionsFromClarification(null).length === 0, 'null → []');
const msg1 = { metadata: { defaultOptions: [{label: 'A'}, {value: 'B'}] } };
const opts1 = intentAnalyzer.extractDefaultOptionsFromClarification(msg1);
ok(opts1.length === 2 && opts1[0] === 'A' && opts1[1] === 'B', '结构化 metadata → label/value');
const msg2 = { content: '选项: 昨天（默认），前天（默认）' };
const opts2 = intentAnalyzer.extractDefaultOptionsFromClarification(msg2);
ok(opts2.length >= 1, '文本解析也能命中（默认）');

// ========================================
console.log('\n--------');
console.log(`结果: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
