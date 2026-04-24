/**
 * Phase 4 · 任务 A.6 硬拦截:nl2sqlEngine.js exports 契约冻结
 *
 * 断言 `require('./nl2sqlEngine')` 的导出符号表与 Phase 3 完全一致,拆分不回归。
 * 运行:node backend/test/phase4/test-nl2sql-facade.js
 * 零外部依赖。
 */

const assert = require('assert');
const path = require('path');

const engine = require(path.resolve(__dirname, '../../src/core/nl2sqlEngine'));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

console.log('\n[nl2sqlEngine exports 契约]');

const EXPECTED = [
  'NL2SQLError',
  'analyzeIntent',
  'checkIntentComplete',
  'executeQuery',
  'formatResult',
  'generateClarification',
  'generateSQL',
  'processQuery',
  'resolveEntity',
  'updateIntentWithLLM',
  'validateSQL'
];

const actual = Object.keys(engine).sort();
ok(JSON.stringify(actual) === JSON.stringify(EXPECTED),
  `exports 符号表 == Phase 3 (实际: ${actual.join(',')})`);

for (const name of EXPECTED) {
  if (name === 'NL2SQLError') {
    ok(typeof engine[name] === 'function', `${name} 是类 (function)`);
  } else {
    ok(typeof engine[name] === 'function', `${name} 是函数`);
  }
}

// NL2SQLError 基本行为
console.log('\n[NL2SQLError]');
const err = new engine.NL2SQLError('VALIDATION', 'test', { foo: 1 }, true);
ok(err instanceof Error, 'NL2SQLError 继承 Error');
ok(err.type === 'VALIDATION', 'type 字段');
ok(err.isRecoverable === true, 'isRecoverable 字段');
ok(err.details.foo === 1, 'details 字段');
ok(typeof err.toLogObject === 'function', 'toLogObject 方法');
ok(err.toLogObject().errorType === 'VALIDATION', 'toLogObject 返回结构');

const entErr = engine.NL2SQLError.entityResolution('青木', 'game', 'not_found');
ok(entErr.type === 'ENTITY_RESOLUTION' && entErr.isRecoverable === true,
  'static entityResolution() 返回 ENTITY_RESOLUTION 可恢复错误');

const valErr = engine.NL2SQLError.sqlValidation('SELECT 1', 'no limit');
ok(valErr.type === 'VALIDATION' && valErr.isRecoverable === false,
  'static sqlValidation() 返回 VALIDATION 不可恢复错误');

// 拆分后子模块 require 连通性
console.log('\n[子模块 require 连通性]');
const intentAnalyzer = require(path.resolve(__dirname, '../../src/core/intentAnalyzer'));
const entityResolver = require(path.resolve(__dirname, '../../src/core/entityResolver'));
const sqlGenerator   = require(path.resolve(__dirname, '../../src/core/sqlGenerator'));
const sqlExecutor    = require(path.resolve(__dirname, '../../src/core/sqlExecutor'));
const resultFormatter= require(path.resolve(__dirname, '../../src/core/resultFormatter'));

ok(engine.analyzeIntent === intentAnalyzer.analyzeIntent,
  'nl2sqlEngine.analyzeIntent 直接等于 intentAnalyzer.analyzeIntent (同一引用)');
ok(engine.resolveEntity === entityResolver.resolveEntity,
  'nl2sqlEngine.resolveEntity === entityResolver.resolveEntity');
ok(engine.generateSQL === sqlGenerator.generateSQL,
  'nl2sqlEngine.generateSQL === sqlGenerator.generateSQL');
ok(engine.validateSQL === sqlExecutor.validateSQL,
  'nl2sqlEngine.validateSQL === sqlExecutor.validateSQL');
ok(engine.executeQuery === sqlExecutor.executeQuery,
  'nl2sqlEngine.executeQuery === sqlExecutor.executeQuery');
ok(engine.formatResult === resultFormatter.formatResult,
  'nl2sqlEngine.formatResult === resultFormatter.formatResult');

// ========================================
console.log('\n--------');
console.log(`结果: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
