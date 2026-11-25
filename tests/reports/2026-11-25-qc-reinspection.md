# 质检返工复检与异常复核测试执行报告

日期：2026-11-25
版本：0.3.2
执行人：本人
关联：R09F、R22F；ADR-0004

## 1. 命令

```bash
cd backend
npx vitest run
```

## 2. 结果

```text
 Test Files  15 passed (15)
      Tests  131 passed (131)
   Duration  34.57s
```

本轮新增 7 条用例，改写 2 条 M 口径用例：

| 文件 | 用例 | 验证点 |
| --- | --- | --- |
| `flow.test.ts` | F 首检可分多批 | 首批 80 放行后订单仍是 `PENDING_QC`；未决策前再录 409 `QC_DECISION_PENDING`；累计超产量 422；第二批决策后 `releasedQty=100`、状态 `QC_DONE` |
| `flow.test.ts` | F 返工复检 | `PASS` 带不合格 422；`REWORK` 后 `releasedQty=90`、`reworkPendingQty=10`；复检超量 422；复检 10 件形成 `round=2` 记录且首检 `unqualifiedQty=10` 保留；复检 PASS 后放行累计 100、可下发包装 |
| `flow.test.ts` | F 报废结算 | `SCRAP` 后 `releasedQty=95`、`scrappedQty=5`、状态 `QC_DONE`；包装 96 件被拒 |
| `collab.test.ts` | 异常 → 复核 → 录入 → PASS → 解决 | 复核后订单转 `PENDING_QC`、异常 `WAITING_QC`；品控收到 `EXCEPTION_REVIEWED` 通知；同任务第二张异常 409；未 PASS 前解决被拒；录入后自动回填 `qcRecordId`；PASS 后可解决；审计含 `exception.review` |
| `collab.test.ts` | 已首检无返工量 | 422 `EXCEPTION_NO_QC_BASIS` |
| `collab.test.ts` | 未关联生产任务 | 复核 422 `EXCEPTION_NO_PRODUCTION`；非质量类异常可留痕解决 |
| `collab.test.ts` | 复核权限与幂等 | 生产角色 403；同键重放返回 200 且带 `Idempotent-Replayed: true` |
| `collab.test.ts` | 返工后凭证跟随复检 | 首检判返工后异常挂首检记录；复检录入后改挂 `round=2` 记录；复检 PASS 后可解决，订单累计放行 20 |
| `collab.test.ts`（改写） | 异常处置主流程 | 质量异常无凭证解决 409 `EXCEPTION_QC_REQUIRED`；手填 `WAITING_QC` 409 `EXCEPTION_REVIEW_REQUIRED`；勾选 `waiveQc` 后 200 |

## 3. 实现要点

- `qc_records` 增加 `round`、`parentQcRecordId`；`qc_decisions` 增加 `scrapQty`；`tablet_exceptions` 增加 `qcRecordId`（唯一）、`qcWaived`。迁移 `20261125140000_qc_reinspection`。
- `computeQuantities` 改为：首检只看 `round=1`，合格/放行/报废按记录求和，返工待复检按父记录未复检量计算，`undecidedQty` 阻断下一轮录入。
- 质检决策按「放行 + 报废 ≥ 生产量且无未决策记录」判定结算，不再在首次 PASS 时无条件转 `QC_DONE`。
- 异常复核接口与质检录入共用同一事务边界：异常只引用质检记录，不写数量。

## 4. 构建

```bash
npm run typecheck   # backend + frontend 通过
```

## 5. 页面证据

均在本机开发库实际渲染后截图，文件在 `.shots/`（不入版本库）：

| 截图 | 内容 |
| --- | --- |
| `.shots/2026-11-25-qc-exception-open.png` | 质量异常展开：开始处理 / 下发品控复核 / 关闭 |
| `.shots/2026-11-25-qc-decision.png` | 管理员三轮决策按钮同排 |
| `.shots/2026-11-25-qc-reinspect.png` | 品控返工复检表单，默认取剩余返工量 |
| `.shots/2026-11-25-qc-exception-passed.png` | 复检 PASS 后异常可解决，提示与凭证行 |
| `.shots/2026-11-25-qc-exception-resolved.png` | 解决后保留复核凭证与处理说明 |
| `.shots/2026-11-25-qc-mobile-entry.png` / `-mobile-decision.png` | 390px 视口无横向溢出，两列录入与三列决策可用 |

截图过程中发现并修复了三个问题：`WAITING_QC` 下即使 PASS 也无「标记解决」按钮；三按钮在 2 列网格里掉行；返工后异常凭证仍挂在 REWORK 记录上（改为跟随最新一轮）。

## 6. 未覆盖

- 未做不合格率阈值、原因码、多产品混合批次（见 `docs/feature-status.md` R09F 边界）。
- 复核仍未覆盖附件与超时升级。