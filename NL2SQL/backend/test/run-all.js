/**
 * Phase 4 · 任务 D.2 测试聚合 runner
 *
 * 用法：
 *   node test/run-all.js              # 跑全部(Phase 1-4)
 *   node test/run-all.js --smoke      # 跳过需外部依赖的脚本
 *   node test/run-all.js --phase=1    # 只跑 phase1
 *   node test/run-all.js --phase=4
 *
 * 退出码：0=全部通过或无可跑用例;1=存在失败。
 * 依赖:零第三方,原生 `child_process.fork` 派生每个脚本。
 */

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const TEST_ROOT = __dirname;
const DEPS_FILE = path.join(TEST_ROOT, 'external-deps.json');

// ---------------- CLI 参数 ----------------
const args = process.argv.slice(2);
const SMOKE = args.includes('--smoke');
const phaseArg = args.find(a => a.startsWith('--phase='));
const PHASE = phaseArg ? phaseArg.replace('--phase=', '') : null;

// ---------------- 外部依赖黑名单 ----------------
let externalDeps = { requiresLlm: [], requiresSrDb: [] };
try {
  externalDeps = JSON.parse(fs.readFileSync(DEPS_FILE, 'utf8'));
} catch (e) {
  console.warn(`[runner] 无法读取 ${DEPS_FILE}:`, e.message);
}

const HAS_LLM_KEY   = !!process.env.LLM_API_KEY;
const HAS_SR_DB     = !!process.env.SR_DATABASE_URL_TEST;

function shouldSkip(relPath) {
  const normalized = relPath.replace(/\\/g, '/');

  if (externalDeps.requiresLlm?.includes(normalized)) {
    if (SMOKE) return `skipped(smoke,requiresLlm)`;
    if (!HAS_LLM_KEY) return `skipped(no LLM_API_KEY)`;
  }
  if (externalDeps.requiresSrDb?.includes(normalized)) {
    if (SMOKE) return `skipped(smoke,requiresSrDb)`;
    if (!HAS_SR_DB) return `skipped(no SR_DATABASE_URL_TEST)`;
  }
  return null;
}

// ---------------- 脚本发现 ----------------
function discoverScripts() {
  const phases = PHASE ? [`phase${PHASE}`] : ['phase1', 'phase2', 'phase3', 'phase4'];
  const scripts = [];

  for (const phase of phases) {
    const dir = path.join(TEST_ROOT, phase);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;

    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      if (!/\.(test\.)?js$/i.test(entry)) continue;
      // 排除 fixtures/ 下的数据文件、README 等
      scripts.push({
        phase,
        name: entry,
        relPath: `${phase}/${entry}`,
        fullPath: full
      });
    }
  }
  return scripts;
}

// ---------------- 运行单脚本 ----------------
function runOne(script) {
  return new Promise((resolve) => {
    const child = fork(script.fullPath, [], {
      silent: true,
      cwd: path.resolve(__dirname, '..'),   // 统一 cwd = backend/
      env: process.env
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', d => { stdout += d.toString(); });
    child.stderr?.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* noop */ }
      resolve({ status: 'timeout', stdout, stderr });
    }, 120000);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({
        status: code === 0 ? 'pass' : 'fail',
        exitCode: code,
        stdout,
        stderr
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ status: 'fail', error: err.message, stdout, stderr });
    });
  });
}

// ---------------- 主流程 ----------------
async function main() {
  const scripts = discoverScripts();
  if (scripts.length === 0) {
    console.log(`[runner] 未发现测试脚本 (phase=${PHASE || 'all'})`);
    process.exit(0);
  }

  console.log(`[runner] 发现 ${scripts.length} 个测试脚本 | smoke=${SMOKE} | phase=${PHASE || 'all'}`);
  console.log('='.repeat(70));

  const results = [];

  for (const s of scripts) {
    const skipReason = shouldSkip(s.relPath);
    if (skipReason) {
      console.log(`⊘ ${s.relPath}  (${skipReason})`);
      results.push({ ...s, status: 'skip', reason: skipReason });
      continue;
    }

    process.stdout.write(`▶ ${s.relPath} ... `);
    const res = await runOne(s);
    if (res.status === 'pass') {
      console.log(`✓`);
      results.push({ ...s, status: 'pass' });
    } else if (res.status === 'timeout') {
      console.log(`✗ TIMEOUT`);
      results.push({ ...s, status: 'timeout' });
      if (res.stderr) console.log(`  stderr:\n${res.stderr.slice(0, 400)}`);
    } else {
      console.log(`✗ exit=${res.exitCode}`);
      if (res.stderr) console.log(`  stderr:\n${res.stderr.slice(0, 400)}`);
      if (res.stdout) console.log(`  tail:\n${res.stdout.split('\n').slice(-10).join('\n')}`);
      results.push({ ...s, status: 'fail' });
    }
  }

  // ---------------- 汇总 ----------------
  console.log('='.repeat(70));
  const byStatus = { pass: 0, fail: 0, skip: 0, timeout: 0 };
  for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

  console.log(`[runner] 汇总:`);
  console.log(`  ✓ pass:    ${byStatus.pass}`);
  console.log(`  ✗ fail:    ${byStatus.fail}`);
  console.log(`  ✗ timeout: ${byStatus.timeout}`);
  console.log(`  ⊘ skip:    ${byStatus.skip}`);
  console.log(`  总计:     ${results.length}`);

  const failed = results.filter(r => r.status === 'fail' || r.status === 'timeout');
  if (failed.length > 0) {
    console.log(`\n失败脚本:`);
    for (const f of failed) {
      console.log(`  - ${f.relPath} [${f.status}]`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('[runner] 未捕获异常:', err);
  process.exit(2);
});
