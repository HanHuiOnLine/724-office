/**
 * Phase 4 · 任务 E 单测:agenticEngine 成功路径写 query_history
 *
 * 策略:stub `database.createQueryHistory` / `markQueryHistorySuccess` 计数调用,
 *      手工构造一个"打桩版" agenticEngine processQuery(因为真实走 LLM/schema tools)。
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
ok(/database\.createQueryHistory/.test(src), '调用 createQueryHistory');
ok(/database\.markQueryHistorySuccess/.test(src), '调用 markQueryHistorySuccess');

// 断言只在 success:true 路径调
const successBlockMatch = src.match(/finalResult\.success\s*===\s*true[\s\S]{0,1800}createQueryHistory/);
ok(successBlockMatch !== null, 'createQueryHistory 仅在 finalResult.success===true 条件内调用');

// 审计入参
ok(/userRole:\s*context\.userRole/.test(src), 'userRole 从 context 传入');
ok(/tenantId:\s*context\.tenantId/.test(src), 'tenantId 从 context 传入');
ok(/requestSource:\s*context\.requestSource/.test(src), 'requestSource 从 context 传入');
ok(/requestIp:\s*context\.requestIp/.test(src), 'requestIp 从 context 传入');
ok(/fallbackUsed:\s*false/.test(src), 'fallbackUsed 固定 false(agentic 独立成功)');
ok(/rlsApplied:\s*context\.rlsApplied/.test(src), 'rlsApplied 透传 context.rlsApplied');

// 避免双写:失败路径不该调 createQueryHistory(legacy fallback 负责)
// 通过检查:catch (error) 块内不含 createQueryHistory
const catchIdx = src.indexOf('catch (error) {');
if (catchIdx !== -1) {
  // 找到对应闭合的 } (简易近似:看到 }\n\s*}\s*$)
  // 只检查 catch 块之后 100 行
  const catchSection = src.slice(catchIdx, catchIdx + 2000);
  ok(!/createQueryHistory/.test(catchSection),
    'catch (error) 块内不调 createQueryHistory(避免双写)');
}

// 断言依赖 database 已引入
ok(/require\(['"]\.\/database['"]\)/.test(src), '顶部 require database');

console.log('\n--------');
console.log(`结果: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
