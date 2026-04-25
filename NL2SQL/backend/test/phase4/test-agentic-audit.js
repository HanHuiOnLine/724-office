/**
 * Phase 4 · 任务 E 单测:agenticEngine 审计写入
 *
 * 历史:任务 E 阶段 agentic 不执行 SQL,只在 success===true 写 markQueryHistorySuccess,
 *       失败交给 legacy fallback 写入,避免双写。
 * 批次 D2 起:agentic 通过 executionPhase 真实执行 SQL,失败也是"真实失败"(执行错误),
 *       因此 D2 起成功/失败都由 agentic 写入审计:
 *         - 成功:markQueryHistorySuccess 携带真实 executionTime / rowCount /
 *                summarizeResultForAudit(data)
 *         - 失败:markQueryHistoryFailure 携带真实 executionTime / errorCode
 *       与 legacy fallback 各写各的(不同 historyId),不构成同一记录的双写。
 *
 * 这里复用真实 agenticEngine 不现实(它会调 LLM)。所以本测试直接验证
 * "processQuery 内部的审计段落代码存在且语义正确",通过 fs.readFileSync 扫描源码模式。
 *
 * 运行:node backend/test/phase4/test-agentic-audit.js
 */

const path = require('path');
const fs = require('fs');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

const agenticPath = path.resolve(__dirname, '../../src/core/agenticEngine.js');
const src = fs.readFileSync(agenticPath, 'utf8');

console.log('\n[审计段落存在]');
ok(/Phase 4.*任务 E/.test(src), '源码含 Phase 4 · 任务 E 标记');
ok(/批次 D2/.test(src), '源码含批次 D2 标记');
ok(/database\.createQueryHistory/.test(src), '调用 createQueryHistory');
ok(/database\.markQueryHistorySuccess/.test(src), '调用 markQueryHistorySuccess');
ok(/database\.markQueryHistoryFailure/.test(src), '调用 markQueryHistoryFailure (D2)');

// 【D2 新合同】成功路径:type='result' 时写 markQueryHistorySuccess
const successBlockMatch = src.match(/execResult\.success[\s\S]{0,2000}markQueryHistorySuccess/);
ok(successBlockMatch !== null, '成功路径(execResult.success)写 markQueryHistorySuccess');

// 【D2 新合同】成功路径携带真实值与 summarizeResultForAudit
ok(/executionTime:\s*execResult\.executionTime/.test(src), 'markQueryHistorySuccess 写真实 executionTime');
ok(/rowCount:\s*\(execResult\.data && execResult\.data\.rowCount\)/.test(src),
  'markQueryHistorySuccess 写真实 rowCount');
ok(/summarizeResultForAudit\(execResult\.data\)/.test(src),
  'result 字段使用 summarizeResultForAudit(data)');
ok(/require\(['"]\.\/auditHelper['"]\)/.test(src), '顶部 require auditHelper (D1)');
ok(/require\(['"]\.\/sqlExecutor['"]\)/.test(src), '顶部 require sqlExecutor (D2)');

// 【D2 新合同】失败路径:写 markQueryHistoryFailure 携带真实 executionTime / errorCode
const failureBlockMatch = src.match(/markQueryHistoryFailure[\s\S]{0,800}errorCode:\s*execResult\.errorCode/);
ok(failureBlockMatch !== null, '失败路径写 markQueryHistoryFailure(含真实 errorCode)');

// 审计入参(成功/失败两侧均应携带)
ok(/userRole:\s*context\.userRole/.test(src), 'userRole 从 context 传入');
ok(/tenantId:\s*context\.tenantId/.test(src), 'tenantId 从 context 传入');
ok(/requestSource:\s*context\.requestSource/.test(src), 'requestSource 从 context 传入');
ok(/requestIp:\s*context\.requestIp/.test(src), 'requestIp 从 context 传入');
ok(/fallbackUsed:\s*false/.test(src), 'fallbackUsed 固定 false(agentic 独立路径)');
ok(/rlsApplied:\s*context\.rlsApplied/.test(src), 'rlsApplied 透传 context.rlsApplied');

// 避免顶层 try/catch 双写:catch (error) 块内不该调 createQueryHistory
// (顶层异常路径仍由 sseHandler/legacy 决定)
const catchIdx = src.indexOf('} catch (error) {');
if (catchIdx !== -1) {
  const catchSection = src.slice(catchIdx, catchIdx + 800);
  ok(!/createQueryHistory/.test(catchSection),
    '顶层 catch (error) 块内不调 createQueryHistory(顶层异常仍走 fallback)');
}

// 【D2】type='result' 升级
ok(/type:\s*['"]result['"]/.test(src), '成功返回 type=\'result\' (D2 升级)');
ok(/data:\s*execResult\.data/.test(src), '成功返回携带真实 data(columns/rows/rowCount/truncated)');

// 断言依赖 database 已引入
ok(/require\(['"]\.\/database['"]\)/.test(src), '顶部 require database');

console.log('\n--------');
console.log(`结果: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
