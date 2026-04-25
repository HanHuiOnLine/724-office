# NL2SQL 真实数据输出 · 批次总览

## 来源
- **主计划文件**：`C:/Users/hanhui/.claude/plans/sql-vivid-lemon.md`
- **上游设计文档**：
  - [NL2SQL-真实数据输出实施计划.md](NL2SQL-真实数据输出实施计划.md)（6 阶段完整版）
  - [NL2SQL-目标偏离评估说明.md](NL2SQL-目标偏离评估说明.md)（P0 偏离项）
- **生成日期**：2026-04-24
- **裁剪范围**：最小闭环优先（跳过 Phase A 基线观测与 Phase F 灰度发布）

## 背景一句话
当前 agentic 主链路最终只返回 SQL 文本（`type='sql_result'`），目标是升级为返回真实数据（`type='result'` + `data`）。legacy 引擎已具备完整闭环，可作对齐标杆。

## 关键决策（已定）
| 维度 | 决策 |
|---|---|
| 落地范围 | 最小闭环（agentic 原生执行 + 审计修正 + 前端兼容） |
| 开关策略 | 复用现有 `DRY_RUN`，不新增 FF；紧急回滚靠 `DRY_RUN=true` 或 `FF_AGENTIC_ENGINE=false` |
| 审计存储 | `query_history.result` 改存摘要 `{columns, rowCount, truncated, sampleHash}`，legacy 与 agentic 同步对齐 |
| 澄清路径 | `resumeFromClarification` 与主路径同步改造，澄清后也出数据 |

## 批次索引
| 批次 | 文档 | 主改文件 | 依赖 |
|---|---|---|---|
| D1 | [NL2SQL-真实数据批次D1-任务计划.md](NL2SQL-真实数据批次D1-任务计划.md) | `auditHelper.js`（新）、`nl2sqlEngine.js` 局部 | 无 |
| D2 | [NL2SQL-真实数据批次D2-任务计划.md](NL2SQL-真实数据批次D2-任务计划.md) | `agenticEngine.js::processQuery` | D1 |
| D3 | [NL2SQL-真实数据批次D3-任务计划.md](NL2SQL-真实数据批次D3-任务计划.md) | `agenticEngine.js::resumeFromClarification` | D1、D2 |
| D4 | [NL2SQL-真实数据批次D4-任务计划.md](NL2SQL-真实数据批次D4-任务计划.md) | `sseHandler.js`、`session.js`、`ChatView.vue` | D2、D3 |
| D5 | [NL2SQL-真实数据批次D5-任务计划.md](NL2SQL-真实数据批次D5-任务计划.md) | `backend/test/phase-data/*`（新建） | D1-D4 |

## 目标响应契约
```json
{
  "success": true,
  "type": "result",
  "sql": "SELECT ... LIMIT 1000",
  "explanation": "...",
  "data": { "columns": [...], "rows": [...], "rowCount": 123, "truncated": false },
  "executionTime": 820,
  "engineUsed": "agentic",
  "selectedTables": [...]
}
```
`type='sql_result'` 仅保留给澄清态（`clarification` 中间态不变）；其余成功分支升级为 `result`。

## 上下文爆炸防护
1. 批次间通过交接摘要文档传递接口信息，下一批不重读全引擎。
2. 每批次"读/写范围"用严格清单约束，禁止顺手扩大变更。
3. D2/D3 落在同一文件但分函数，靠摘要中的行号定位，避免重复加载。
4. D5 只读各批摘要 + 既有测试骨架，绕开引擎源码。

## 回滚手段
- `DRY_RUN=true`：临时让 agentic 只生成不执行。
- `FF_AGENTIC_ENGINE=false`：整体切回 legacy 主链路。
- `FF_AGENTIC_AUTO_FALLBACK=true`（现状）：agentic 失败自动回退 legacy。

## 交付清单
- 代码：`auditHelper.js`（新）、`nl2sqlEngine.js` / `agenticEngine.js` / `sseHandler.js` 局部、前端 2 处轻改
- 测试：`test/phase-data/` 3 个新脚本 + `test:phase-data` 聚合
- 文档：5 份批次交接摘要 + 1 份完工摘要
- 契约说明：补入 `CLAUDE.md` "关键数据流"小节
