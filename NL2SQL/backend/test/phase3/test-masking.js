/**
 * Phase 3 / T3a 单测:maskResult
 *
 * 覆盖:
 *   - 7 种规则:mid_4 / domain_only / head_tail / redact / first_1 / last_4 / length_stars
 *   - null / undefined / 非字符串 → 原样透传
 *   - 列名大小写不敏感
 *   - 两种行 shape:对象 {col:val} 和数组 [v1, v2]
 *   - 不可变性:输入数组/对象未被修改
 *   - maskedCells 计数正确
 *   - columns 为 [{name}] 对象数组时也能识别
 *
 * 运行:node backend/test/phase3/test-masking.js
 */

const assert = require('assert');
const path = require('path');

const maskResult = require(path.resolve(__dirname, '../../src/utils/maskResult'));
const {
  maskRows, maskMid4, maskDomainOnly, maskHeadTail,
  maskRedact, maskFirst1, maskLast4, maskLengthStars
} = maskResult;

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// ========================================
// 各规则纯函数
// ========================================
console.log('\n[mid_4]');
eq(maskMid4('13812345678'), '138****5678', '11 位手机号');
eq(maskMid4('1234567'), '*******', '短于 8 位 → 全替换');
eq(maskMid4('12345678'), '123****5678', '恰好 8 位 → 仍走 mid_4 逻辑'); // 3+4+4=11?,实际先3再+****+后4=11字符
// 注意:'12345678' 长 8 进入 mid_4 → '123' + '****' + '5678' = '1234****5678'(12 字符)
// 为避免歧义,做更保守的检查:只要长度和中段星号存在即通过
ok(/^.{3}\*{4}.{4}$/.test(maskMid4('13812345678')), 'mid_4 结构 head3 + **** + tail4');

console.log('\n[domain_only]');
eq(maskDomainOnly('alice@example.com'), '***@example.com', '普通邮箱');
eq(maskDomainOnly('a@b.co'), '***@b.co', '短邮箱');
eq(maskDomainOnly('nodomain'), '***', '无 @ → redact');

console.log('\n[head_tail]');
const h1 = maskHeadTail('110101199001011234');
eq(h1, '110101*********234', '18 位身份证');
ok(/^.{6}\*+.{3}$/.test(h1), 'head_tail 结构 head6 + *+ tail3');
eq(maskHeadTail('12345'), '*****', '短于 10 → 全替换');

console.log('\n[redact]');
eq(maskRedact('any'), '***', '任意值');
eq(maskRedact(''), '***', '空串也 ***');

console.log('\n[first_1]');
eq(maskFirst1('张三'), '张*', '中文 2 字');
eq(maskFirst1('张三丰'), '张**', '中文 3 字');
eq(maskFirst1('A'), 'A', '单字符保留');
eq(maskFirst1(''), '', '空串');

console.log('\n[last_4]');
eq(maskLast4('6228480000001234'), '************1234', '银行卡');
eq(maskLast4('1234'), '1234', '4 字符原样');
eq(maskLast4('123'), '123', '短于 4 原样');

console.log('\n[length_stars]');
eq(maskLengthStars('abc'), '***', '保留长度');
eq(maskLengthStars(''), '', '空串');

// ========================================
// maskRows:对象行
// ========================================
console.log('\n[maskRows 对象行]');

const rules = {
  phone: 'mid_4',
  email: 'domain_only',
  name: 'first_1',
  age: 'redact'  // 非字符串列,测试 applyRule 对数字的处理
};

const rowsObj = [
  { name: '张三', phone: '13812345678', email: 'alice@example.com', age: 25, city: '北京' },
  { name: '李四', phone: '13987654321', email: 'bob@test.com', age: 30, city: '上海' }
];
const rowsObjSnapshot = JSON.stringify(rowsObj);

const out1 = maskRows(rowsObj, ['name', 'phone', 'email', 'age', 'city'], rules);

eq(out1.rows[0].phone, '138****5678', '对象行 phone 脱敏');
eq(out1.rows[0].email, '***@example.com', '对象行 email 脱敏');
eq(out1.rows[0].name, '张*', '对象行 name first_1');
eq(out1.rows[0].age, '***', 'number 值也按规则处理(redact → ***)');
eq(out1.rows[0].city, '北京', '非敏感列原样');
ok(JSON.stringify(rowsObj) === rowsObjSnapshot, '输入 rows 未被修改(immutable)');
eq(out1.rows !== rowsObj, true, 'maskRows 返回新数组');
ok(out1.maskedCells === 8, `maskedCells=8 (4列×2行, 实际=${out1.maskedCells})`);

// ========================================
// maskRows:数组行(配合 columns)
// ========================================
console.log('\n[maskRows 数组行]');

const rowsArr = [
  ['张三', '13812345678', 'alice@example.com', 25],
  ['李四', null, undefined, 30]
];
const rowsArrSnapshot = JSON.stringify(rowsArr);
const out2 = maskRows(rowsArr, ['name', 'phone', 'email', 'age'], rules);

eq(out2.rows[0][1], '138****5678', '数组行 phone 脱敏');
eq(out2.rows[0][2], '***@example.com', '数组行 email 脱敏');
eq(out2.rows[1][1], null, 'null 透传不脱敏');
eq(out2.rows[1][2], undefined, 'undefined 透传不脱敏');
ok(JSON.stringify(rowsArr) === rowsArrSnapshot, '数组行输入 immutable');

// ========================================
// 列名大小写不敏感 + columns 对象数组
// ========================================
console.log('\n[列名大小写 + columns 对象数组]');

const rowsCase = [
  { Name: '张', Phone: '13812345678', EMAIL: 'x@y.z' }
];
const out3 = maskRows(
  rowsCase,
  [{ name: 'Name' }, { name: 'Phone' }, { name: 'EMAIL' }],
  { name: 'first_1', phone: 'mid_4', email: 'domain_only' }
);
eq(out3.rows[0].Name, '张', 'Name 单字符 first_1 → 原样');
eq(out3.rows[0].Phone, '138****5678', 'Phone 大写 → mid_4 命中');
eq(out3.rows[0].EMAIL, '***@y.z', 'EMAIL 全大写 → domain_only 命中');

// ========================================
// 未知规则 / 空规则
// ========================================
console.log('\n[未知规则 / 空规则]');

const out4 = maskRows(
  [{ phone: '13812345678' }],
  ['phone'],
  { phone: 'nonexistent_rule' }
);
eq(out4.rows[0].phone, '13812345678', '未知规则名 → 不脱敏');
eq(out4.maskedCells, 0, 'maskedCells=0');

const out5 = maskRows([{ a: 1 }], ['a'], null);
eq(out5.rows[0].a, 1, 'rules 为 null → 原样');
eq(out5.maskedCells, 0, 'maskedCells=0');

const out6 = maskRows([], ['a'], { a: 'redact' });
ok(Array.isArray(out6.rows) && out6.rows.length === 0, '空数组输入返回空数组');

// ========================================
// columns 不完整但对象 key 含敏感列
// ========================================
console.log('\n[columns 缺失但对象行自带敏感键]');

const out7 = maskRows(
  [{ phone: '13811112222', other: 'ok' }],
  [], // columns 空
  { phone: 'mid_4' }
);
eq(out7.rows[0].phone, '138****2222', 'columns 空时仍用对象 key 命中规则');

// ========================================
// 汇总
// ========================================
console.log(`\n--------\n结果: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
