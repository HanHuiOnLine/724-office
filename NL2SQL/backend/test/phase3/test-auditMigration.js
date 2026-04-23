/**
 * Phase 3 / T3c 单测:query_history 审计字段迁移 + writer 扩参
 *
 * 覆盖:
 *   - 空库直接 CREATE TABLE → 新 schema 已含 7 审计列
 *   - 用"旧 schema"(缺 7 列)初始化 → 迁移后应有 7 列 + tenant_id 索引
 *   - 第二次调 ensureQueryHistoryColumns 应为 no-op(idempotent)
 *   - createQueryHistory 接收 userRole/tenantId/requestSource/requestIp 并落库
 *   - markQueryHistorySuccess 接收 fallbackUsed(→1)/rlsApplied(→JSON)
 *   - markQueryHistoryFailure 接收 errorCode
 *   - 历史行(迁移前已存在)新列为 NULL
 *
 * 运行:node backend/test/phase3/test-auditMigration.js
 * 不依赖 LLM / 外部库,仅用 sqlite3。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// 先设临时 DB 路径,再 require config/database(config 会读 DB_PATH env)
const TMP_DB = path.join(os.tmpdir(), `nl2sql-phase3-audit-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'warn';

// 确保干净:如果之前残留,删除
try { fs.unlinkSync(TMP_DB); } catch (e) {}

const sqlite3 = require('sqlite3');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

/**
 * 在给定文件上直接用旧 schema 创建 query_history(模拟 Phase 3 之前的老数据库)
 */
function createLegacyDb(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_CREATE | sqlite3.OPEN_READWRITE, (err) => {
      if (err) return reject(err);
      db.serialize(() => {
        // 旧 schema:12 个字段,无审计 7 列
        db.run(`CREATE TABLE query_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT,
          user_id TEXT NOT NULL,
          natural_query TEXT NOT NULL,
          generated_sql TEXT,
          status TEXT DEFAULT 'pending',
          result TEXT,
          error_message TEXT,
          execution_time INTEGER,
          row_count INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          executed_at DATETIME
        )`);
        // sessions 表也建一下,因为 createQueryHistory 外键引用
        db.run(`CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          title TEXT,
          status TEXT DEFAULT 'active',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        // 插入一条历史行,后续验证新列为 NULL
        db.run(`INSERT INTO query_history (session_id, user_id, natural_query, status)
                VALUES ('legacy-sid', 'legacy-user', '历史查询', 'success')`, (e) => {
          if (e) return reject(e);
          db.close(() => resolve());
        });
      });
    });
  });
}

async function main() {
  console.log('[准备] 创建旧 schema 数据库:', TMP_DB);
  await createLegacyDb(TMP_DB);

  // 现在 require database,它会看到表已存在(IF NOT EXISTS 不重建),并调用 runMigrations
  const database = require(path.resolve(__dirname, '../../src/core/database'));

  console.log('\n[初始化 + 迁移]');
  await database.initialize();
  ok(true, 'initialize() 未抛异常');

  // 验证 7 个新列存在
  const cols = await database.query(`PRAGMA table_info(query_history)`);
  const colNames = cols.map(c => c.name);
  const expected = ['user_role', 'tenant_id', 'request_source', 'request_ip',
                    'error_code', 'fallback_used', 'rls_applied'];
  for (const c of expected) {
    ok(colNames.includes(c), `列 ${c} 已存在`);
  }

  // 验证历史行新列为 NULL
  const legacyRow = await database.queryOne(
    `SELECT tenant_id, user_role, fallback_used FROM query_history WHERE session_id='legacy-sid'`
  );
  ok(legacyRow !== null, '历史行仍可读');
  ok(legacyRow.tenant_id === null, '历史行 tenant_id = NULL');
  ok(legacyRow.user_role === null, '历史行 user_role = NULL');
  // fallback_used 有 DEFAULT 0,但 ALTER TABLE ADD COLUMN 对已有行填 NULL(SQLite 行为)
  ok(legacyRow.fallback_used === null || legacyRow.fallback_used === 0,
    `历史行 fallback_used 为 NULL 或 0(实际 ${legacyRow.fallback_used})`);

  // 验证索引
  const indices = await database.query(`PRAGMA index_list(query_history)`);
  const indexNames = indices.map(i => i.name);
  ok(indexNames.includes('idx_query_history_tenant_id'), '已创建 tenant_id 索引');

  // ----------------------------------------
  // idempotent:再次运行迁移不应报错
  // ----------------------------------------
  console.log('\n[idempotent 二次迁移]');
  await database.ensureQueryHistoryColumns();
  ok(true, '第二次调用 ensureQueryHistoryColumns 不抛异常');
  const cols2 = await database.query(`PRAGMA table_info(query_history)`);
  ok(cols2.length === cols.length, '列数未变化(no-op)');

  // ----------------------------------------
  // 先插入一个 session 避免外键约束失败(SQLite 默认不启用 FK,但保险)
  // ----------------------------------------
  await database.run(
    `INSERT INTO sessions (id, user_id, title) VALUES ('sid-p3c', 'alice', 't')`
  );

  // ----------------------------------------
  // createQueryHistory 带审计字段
  // ----------------------------------------
  console.log('\n[createQueryHistory 带审计字段]');
  const hid = await database.createQueryHistory({
    sessionId: 'sid-p3c',
    userId: 'alice',
    naturalQuery: '查询A',
    userRole: 'admin',
    tenantId: 'acme',
    requestSource: 'cli',
    requestIp: '10.0.0.1'
  });
  ok(typeof hid === 'number' && hid > 0, `historyId=${hid}`);

  const row = await database.queryOne(
    `SELECT user_role, tenant_id, request_source, request_ip FROM query_history WHERE id = ?`,
    [hid]
  );
  ok(row.user_role === 'admin', 'user_role 写入');
  ok(row.tenant_id === 'acme', 'tenant_id 写入');
  ok(row.request_source === 'cli', 'request_source 写入');
  ok(row.request_ip === '10.0.0.1', 'request_ip 写入');

  // ----------------------------------------
  // markQueryHistorySuccess 带 fallbackUsed + rlsApplied
  // ----------------------------------------
  console.log('\n[markQueryHistorySuccess 带 fallback/rls]');
  await database.markQueryHistorySuccess(hid, {
    generatedSql: 'SELECT 1 LIMIT 1',
    executionTime: 123,
    rowCount: 1,
    result: { columns: ['x'], sampleRows: [[1]] },
    fallbackUsed: true,
    rlsApplied: ['orders', 'users']
  });
  const ok1 = await database.queryOne(
    `SELECT status, fallback_used, rls_applied, execution_time FROM query_history WHERE id = ?`,
    [hid]
  );
  ok(ok1.status === 'success', 'status=success');
  ok(ok1.fallback_used === 1, 'fallback_used=1(true → 1)');
  ok(ok1.rls_applied && JSON.parse(ok1.rls_applied).length === 2, 'rls_applied 为 JSON 数组,2 项');
  ok(ok1.execution_time === 123, '其他字段正常');

  // ----------------------------------------
  // markQueryHistoryFailure 带 errorCode
  // ----------------------------------------
  console.log('\n[markQueryHistoryFailure 带 errorCode]');
  const hid2 = await database.createQueryHistory({
    sessionId: 'sid-p3c',
    userId: 'bob',
    naturalQuery: '查询B'
  });
  await database.markQueryHistoryFailure(hid2, {
    generatedSql: null,
    executionTime: 50,
    errorMessage: 'SQL 验证失败',
    errorCode: 'VALIDATION_ERROR',
    fallbackUsed: false
  });
  const row2 = await database.queryOne(
    `SELECT status, error_code, fallback_used FROM query_history WHERE id = ?`,
    [hid2]
  );
  ok(row2.status === 'failed', 'status=failed');
  ok(row2.error_code === 'VALIDATION_ERROR', 'error_code 写入');
  ok(row2.fallback_used === 0, 'fallback_used=0(false → 0)');

  // ----------------------------------------
  // rlsApplied 空数组/null → 写 NULL
  // ----------------------------------------
  console.log('\n[rlsApplied 空/null → NULL]');
  const hid3 = await database.createQueryHistory({
    sessionId: 'sid-p3c', userId: 'c', naturalQuery: 'x'
  });
  await database.markQueryHistorySuccess(hid3, {
    generatedSql: 'SELECT 1',
    executionTime: 1,
    rowCount: 0,
    result: null,
    fallbackUsed: false,
    rlsApplied: []   // 空数组
  });
  const row3 = await database.queryOne(
    `SELECT rls_applied FROM query_history WHERE id = ?`, [hid3]);
  ok(row3.rls_applied === null, '空数组 rls_applied 落库 NULL');

  const hid4 = await database.createQueryHistory({
    sessionId: 'sid-p3c', userId: 'd', naturalQuery: 'x'
  });
  await database.markQueryHistorySuccess(hid4, {
    generatedSql: 'SELECT 1',
    executionTime: 1,
    rowCount: 0,
    result: null,
    rlsApplied: undefined
  });
  const row4 = await database.queryOne(
    `SELECT rls_applied, fallback_used FROM query_history WHERE id = ?`, [hid4]);
  ok(row4.rls_applied === null, 'undefined rls_applied 落库 NULL');
  ok(row4.fallback_used === 0, 'undefined fallbackUsed → 0');

  // 关闭 DB 和清理
  await database.close();
  try { fs.unlinkSync(TMP_DB); } catch (e) {}

  console.log(`\n--------\n结果: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('测试执行异常:', err);
  try { fs.unlinkSync(TMP_DB); } catch (e) {}
  process.exit(1);
});
