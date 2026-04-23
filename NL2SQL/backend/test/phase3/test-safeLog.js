/**
 * Phase 3 / T2 单测:safeLog(hashPrompt / summarizePrompt / isPromptFullLoggingEnabled)
 *
 * 运行:node backend/test/phase3/test-safeLog.js
 * 无外部依赖,原生 assert。
 */

const assert = require('assert');
const path = require('path');

const safeLog = require(path.resolve(__dirname, '../../src/utils/safeLog'));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

// ========================================
// hashPrompt
// ========================================
console.log('\n[hashPrompt]');

ok(safeLog.hashPrompt('') === 'empty', '空字符串 → empty');
ok(safeLog.hashPrompt(null) === 'empty', 'null → empty');
ok(safeLog.hashPrompt(undefined) === 'empty', 'undefined → empty');
ok(safeLog.hashPrompt(123) === 'nonstr', '数字 → nonstr');
ok(safeLog.hashPrompt({a:1}) === 'nonstr', '对象 → nonstr');

const h1 = safeLog.hashPrompt('hello');
ok(/^[a-f0-9]{8}$/.test(h1), `非空字符串返回 8 位 hex: ${h1}`);

const h2 = safeLog.hashPrompt('hello');
ok(h1 === h2, '相同输入 hash 稳定');

const h3 = safeLog.hashPrompt('world');
ok(h1 !== h3, '不同输入 hash 不同');

// ========================================
// summarizePrompt
// ========================================
console.log('\n[summarizePrompt]');

const empty = safeLog.summarizePrompt('');
ok(empty.length === 0 && empty.hash === 'empty' && !empty.head, '空串 → length=0, hash=empty, 无 head/tail');

const nullRes = safeLog.summarizePrompt(null);
ok(nullRes.length === 0 && nullRes.hash === 'empty', 'null → length=0 hash=empty');

const nonstr = safeLog.summarizePrompt(42);
ok(nonstr.length === 0 && nonstr.hash === 'nonstr', '非字符串 → length=0 hash=nonstr');

const short = safeLog.summarizePrompt('abc');
ok(short.length === 3 && short.head === 'abc' && !short.tail, '短文本:head 覆盖全文,无 tail');

// 恰好 head+tail 长度
const mid = safeLog.summarizePrompt('x'.repeat(120), { head: 60, tail: 60 });
ok(mid.length === 120 && mid.head.length === 60 && !mid.tail, '长度=head+tail 时不输出 tail(避免重复)');

// 超过 head+tail
const long = 'A'.repeat(80) + 'MIDDLE_SECRET' + 'B'.repeat(80);
const longRes = safeLog.summarizePrompt(long, { head: 60, tail: 60 });
ok(longRes.length === long.length, '长度正确');
ok(longRes.head === 'A'.repeat(60), '头 60 字符精确');
ok(longRes.tail === 'B'.repeat(60), '尾 60 字符精确');
ok(!longRes.head.includes('MIDDLE_SECRET') && !longRes.tail.includes('MIDDLE_SECRET'), '中段敏感内容不出现在 head/tail');

// 自定义 head/tail
const custom = safeLog.summarizePrompt('abcdefghijklmnopqrstuvwxyz', { head: 3, tail: 3 });
ok(custom.head === 'abc' && custom.tail === 'xyz', '自定义 head=3/tail=3 生效');

// hash 稳定性
ok(safeLog.summarizePrompt('hello').hash === safeLog.hashPrompt('hello'), 'summarize.hash 与 hashPrompt 一致');

// ========================================
// isPromptFullLoggingEnabled
// ========================================
console.log('\n[isPromptFullLoggingEnabled]');

const originalEnv = process.env.LOG_PROMPT_FULL;

delete process.env.LOG_PROMPT_FULL;
ok(safeLog.isPromptFullLoggingEnabled() === false, 'env 未设置 → false');

process.env.LOG_PROMPT_FULL = 'false';
ok(safeLog.isPromptFullLoggingEnabled() === false, 'env=false → false');

process.env.LOG_PROMPT_FULL = 'true';
ok(safeLog.isPromptFullLoggingEnabled() === true, 'env=true → true');

process.env.LOG_PROMPT_FULL = 'TRUE';
ok(safeLog.isPromptFullLoggingEnabled() === false, 'env=TRUE(大写) → false(严格字符串对比)');

// 恢复环境
if (originalEnv === undefined) delete process.env.LOG_PROMPT_FULL;
else process.env.LOG_PROMPT_FULL = originalEnv;

// ========================================
// 汇总
// ========================================
console.log(`\n--------\n结果: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
