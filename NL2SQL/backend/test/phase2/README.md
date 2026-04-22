# Phase 2 回归测试

覆盖 Phase 2 优化的三项任务:
1. 去除 `slice(0, 5)` 硬截断,落地 tableRanker 统一打分
2. LIMIT 注入(工具 + Prompt 硬约束 + srDatabase 兜底)
3. 同步改造 agenticEngine 选表

## 测试脚本一览

| 脚本 | 依赖 | 说明 |
|------|------|-----|
| `test-limit-injection.js` | 无 | `hasOuterLimit` / `ensureLimit` 单测,25 条断言 |
| `test-tableRanker-unit.js` | 无 | tableRanker 打分公式 + 核心保护 + feature flag 回退,18 条断言 |
| `test-tableRanker-integration.js` | schema 加载 | 对 5 条复杂查询用例跑表选择流程,断言 mustInclude / maxSize / coreTableCount |
| `test-regression-complex.js` | LLM_API_KEY + (可选)SR_DATABASE_URL_TEST | 端到端:NL → SQL,断言 sqlKeywords;LIVE 模式再断言 rowCount |

## 运行

### 快速冒烟(无外部依赖)

```bash
cd backend
node test/phase2/test-limit-injection.js
node test/phase2/test-tableRanker-unit.js
```

### 选表集成(需要 schema-metadata.json 与向量或关键词匹配路径)

```bash
cd backend
node test/phase2/test-tableRanker-integration.js
```

> 若向量服务未启用(EMBEDDING_ENABLED=false),自动退到关键词匹配路径,仍可跑通。

### 端到端回归(需要 LLM)

```bash
# DRY_RUN(默认,不真实执行 SQL)
cd backend
node test/phase2/test-regression-complex.js

# LIVE 模式(可选)
SR_DATABASE_URL_TEST=mysql://user:pw@host:3306/new_tzpingtai \
  node backend/test/phase2/test-regression-complex.js
```

## 验收门槛

| 测试 | 门槛 |
|------|------|
| test-limit-injection | 全部通过(25/25) |
| test-tableRanker-unit | 全部通过(18/18) |
| test-tableRanker-integration | 全部用例 tablesCalled 断言通过 |
| test-regression-complex | DRY_RUN 下失败率 ≤ 20%(对齐原计划 ≥85% 通过率) |

## Feature Flag

- `FF_UNIFIED_RANKER` (默认 true)
  - `true`: 走 tableRanker,核心表保护 + cap=8
  - `false`: 回退到原 Set + slice(0, 5) 老逻辑,用于紧急回滚

## 用例类别

| 类别 | 用例 id | 查询文本 |
|------|--------|---------|
| 多维过滤 | c1, c2 | 渠道/游戏/时间维度组合聚合 |
| 行为序列 | c3, c4 | 注册→首充 / 注册→次日登录(留存) |
| 聚合+明细 | c5 | 本月 top10 充值用户明细 |

完整 fixture 定义见 `fixtures/complex-queries.json`。
