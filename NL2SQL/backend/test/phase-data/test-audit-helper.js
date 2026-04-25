/**
 * NL2SQL 真实数据输出 · 批次 D1
 * 单元测试：summarizeResultForAudit
 *
 * 覆盖：
 *   1. 空结果集 → sampleHash 为空字符串
 *   2. 普通行集 → sampleHash 长度 16
 *   3. truncated 透传
 *   4. 超大列数原样返回
 *   5. 相同前 5 行产生相同 sampleHash（幂等）
 *
 * 运行：node backend/test/phase-data/test-audit-helper.js
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const path = require('path');

const { summarizeResultForAudit } = require(
  path.resolve(__dirname, '../../src/core/auditHelper')
);

(async () => {
  // ---------- case 1: 空结果集 ----------
  {
    const out = summarizeResultForAudit({
      columns: ['id', 'name'],
      rows: [],
      rowCount: 0,
      truncated: false
    });
    assert.deepStrictEqual(out.columns, ['id', 'name'], 'case1: columns 透传');
    assert.strictEqual(out.rowCount, 0, 'case1: rowCount=0');
    assert.strictEqual(out.truncated, false, 'case1: truncated=false');
    assert.strictEqual(out.sampleHash, '', 'case1: 空 rows -> sampleHash=""');
    assert.ok(!('rows' in out), 'case1: 摘要不应含 rows 字段');
    assert.ok(!('sampleRows' in out), 'case1: 摘要不应含 sampleRows 字段');
  }

  // ---------- case 2: 普通行集 ----------
  {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i, name: `n${i}` }));
    const out = summarizeResultForAudit({
      columns: ['id', 'name'],
      rows,
      rowCount: 10,
      truncated: false
    });
    assert.strictEqual(out.rowCount, 10, 'case2: rowCount=10');
    assert.strictEqual(out.sampleHash.length, 16, 'case2: sampleHash 长度 16');
    assert.match(out.sampleHash, /^[0-9a-f]{16}$/, 'case2: sampleHash 为 16 位 hex');
  }

  // ---------- case 3: truncated 透传 ----------
  {
    const rows = [{ a: 1 }];
    const out = summarizeResultForAudit({
      columns: ['a'],
      rows,
      rowCount: 9999,
      truncated: true
    });
    assert.strictEqual(out.truncated, true, 'case3: truncated=true 透传');
    assert.strictEqual(out.rowCount, 9999, 'case3: rowCount 来自传入而非 rows.length');
  }

  // ---------- case 4: 超大列数原样返回 ----------
  {
    const columns = Array.from({ length: 100 }, (_, i) => `c${i}`);
    const out = summarizeResultForAudit({
      columns,
      rows: [],
      rowCount: 0,
      truncated: false
    });
    assert.strictEqual(out.columns.length, 100, 'case4: 100 列原样');
    assert.strictEqual(out.columns[0], 'c0', 'case4: 首列内容正确');
    assert.strictEqual(out.columns[99], 'c99', 'case4: 末列内容正确');
  }

  // ---------- case 5: 相同前 5 行 → 相同 sampleHash（幂等） ----------
  {
    const head = [
      { id: 1, x: 'a' }, { id: 2, x: 'b' }, { id: 3, x: 'c' },
      { id: 4, x: 'd' }, { id: 5, x: 'e' }
    ];
    const out1 = summarizeResultForAudit({ columns: ['id', 'x'], rows: head, rowCount: 5 });
    const out2 = summarizeResultForAudit({
      columns: ['id', 'x'],
      rows: [...head, { id: 6, x: 'f' }, { id: 7, x: 'g' }],
      rowCount: 7
    });
    assert.strictEqual(out1.sampleHash, out2.sampleHash,
      'case5: 前 5 行相同 -> sampleHash 相同（幂等）');
    assert.notStrictEqual(out1.rowCount, out2.rowCount,
      'case5: rowCount 不同（5 vs 7）');
  }

  // ---------- 兜底：非法入参不抛异常 ----------
  {
    const a = summarizeResultForAudit(null);
    assert.deepStrictEqual(a, { columns: [], rowCount: 0, truncated: false, sampleHash: '' },
      '兜底: null 输入返回空摘要');
    const b = summarizeResultForAudit({});
    assert.deepStrictEqual(b, { columns: [], rowCount: 0, truncated: false, sampleHash: '' },
      '兜底: 空对象返回空摘要');
  }

  console.log('✅ test-audit-helper: 5 个断言 + 兜底全部通过');
  process.exit(0);
})().catch((err) => {
  console.error('❌ test-audit-helper 失败:', err);
  process.exit(1);
});
