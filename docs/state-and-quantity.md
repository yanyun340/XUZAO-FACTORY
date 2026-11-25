# 订单状态与数量规则

版本：0.3.0｜实现：`backend/src/domain/flow.ts`、`backend/src/routes/flow.ts`
更新时间：2026-11-04

本文是订单主链的唯一权威口径。前端只渲染 `allowedActions`，任何提交都会在后端重新校验；文档、接口和测试不一致时以本表与代码为准，并同步修正文档。

## 1. 状态机

```text
PENDING_PURCHASE ──采购下单──▶ PURCHASING ──生产下发──▶ IN_PRODUCTION
      │                          │                          │
      │                          │ 到货可分批，需到齐        │ 生产反馈
      │                          ▼                          ▼
      │                       (仍为 PURCHASING)        质检下发
      │                                                     │
      │                                                     ▼
      │                                                 PENDING_QC
      │                                                     │
      │                                              质检录入 + 决策 PASS
      │                                                     ▼
      │                                                  QC_DONE
      │                                                     │ 包装下发
      │                                                     ▼
      │                                                  PACKING
      │                                                     │ 发货触发
      │                                                     ▼
      │                                                  SHIPPING
      │                                                     │ 发货登记累计足量
      └──────────────────── 无取消/退回分支 ───────────────▶ COMPLETED
```

| 状态 | 中文 | 进入条件 | 离开动作 |
| --- | --- | --- | --- |
| `PENDING_PURCHASE` | 待采购 | 订单创建 | 管理员创建采购单 |
| `PURCHASING` | 采购中 | 采购单创建 | 到货可多次；采购到齐且无生产任务时管理员下发生产 |
| `IN_PRODUCTION` | 生产中 | 生产任务创建 | 生产部门反馈后，管理员下发育检 |
| `PENDING_QC` | 待质检 | 质检下发，或异常「下发复核」送入首次质检 | 品控逐批录入 → 管理员逐批判定；全部检验量有归宿（放行/报废）后自动完成 |
| `QC_DONE` | 质检完成 | 已检量全部放行或报废结算 | 管理员下发包装 |
| `PACKING` | 包装中 | 包装下发 | 包装登记累计 >0 后，管理员触发发货 |
| `SHIPPING` | 发货中 | 发货触发 | 物流登记发货；累计 ≥ 订单量即完成 |
| `COMPLETED` | 已完成 | 发货累计 ≥ 订单量，写 `completedAt` | 无 |

限制说明：

- 没有“取消订单/退回上一步”状态。M 允许明确拒绝，本项目选择不实现取消；错误动作被状态守卫拒绝，而不是静默回退。
- 生产、包装、发货是“一单一条主记录”的口径；质检在 R09F 下允许多轮（分批首检 + 返工复检），每轮独立成行，`round=1` 为首检、`>1` 为复检，复检必须带 `parentQcRecordId`。

## 2. 数量口径

所有数量都从有效业务记录求和，不使用可被前端改写的汇总字段。

| 字段 | 计算 | 含义 |
| --- | --- | --- |
| `orderQty` | Σ `order_items.quantity` | 订单总量 |
| `purchaseQty` | Σ `purchase_items.quantity` | 采购总量 |
| `arrivedQty` | Σ `arrival_records.quantity` | 累计到货 |
| `platingRequiredQty` | Σ `platingRequired=true` 的采购项数量 | 需要电镀的总量 |
| `platingSentQty` | Σ SENT/RECEIVED 电镀单数量 | 已发出 |
| `platingReceivedQty` | Σ RECEIVED 电镀单数量 | 已收回 |
| `platingOutstandingQty` | `max(0, platingRequiredQty − platingReceivedQty)` | 待收回 |
| `producedQty` | Σ 最新生产任务的 `production_feedbacks.quantity` | 生产反馈累计 |
| `inspectedQty` | Σ `round=1` 质检记录的 `inspectedQty` | 首检累计（不含复检，避免重复计数） |
| `qualifiedQty` | Σ 全部质检记录的 `qualifiedQty` | 合格量 |
| `releasedQty` | Σ 已决策质检记录的 `releasedQty` | 放行量（PASS/REWORK/SCRAP 都放行合格量） |
| `scrappedQty` | Σ 已决策质检记录的 `scrapQty` | 报废量（仅 SCRAP 决策非 0） |
| `reworkPendingQty` | Σ 每张 `REWORK` 记录的 `unqualifiedQty − 其子记录 inspectedQty` | 已判返工、尚未复检的量 |
| `undecidedQty` | Σ 未决策质检记录的 `inspectedQty` | 等待管理员决策的量；>0 时不能再录新一轮 |
| `packedQty` | Σ `packing_records.quantity` | 累计包装 |
| `shippedQty` | Σ `shipment_records.quantity` | 累计发货 |
| `dueRemaining` | `max(0, orderQty − shippedQty)` | 应交未发 |
| `packableRemaining` | `max(0, releasedQty − packedQty)` | 可包装剩余 |
| `shippableRemaining` | `max(0, packedQty − shippedQty)` | 可发货剩余 |

### 2.1 各环节上限

| 环节 | 写入上限 | 越界错误码 | HTTP |
| --- | --- | --- | --- |
| 到货 | `arrivedQty + quantity ≤ purchaseQty` | `ARRIVAL_EXCEEDS_REMAINING` | 422 |
| 生产反馈 | `quantity ≤ 生产任务 quantity` | `FEEDBACK_EXCEEDS_TASK` | 422 |
| 质检录入（首检） | 合格 + 不合格 = 检验量；累计首检 ≤ 生产量；上一轮须已决策 | `QC_QTY_MISMATCH` / `QC_EXCEEDS_PRODUCED` / `QC_DECISION_PENDING` / `QC_ALL_INSPECTED` | 422 / 409 |
| 质检录入（复检） | 父记录必须判 `REWORK`；复检量 ≤ 待复检返工量 | `QC_PARENT_NOT_FOUND` / `QC_PARENT_NOT_REWORK` / `QC_EXCEEDS_REWORK` / `QC_REWORK_COMPLETE` | 404 / 409 / 422 |
| 质检决策 | `PASS` 要求不合格 = 0；`REWORK`/`SCRAP` 要求不合格 > 0 | `QC_PASS_WITH_UNQUALIFIED` / `QC_NO_UNQUALIFIED` | 422 |
| 包装 | `packedQty + quantity ≤ releasedQty` | `PACKING_EXCEEDS_REMAINING` | 422 |
| 发货 | `quantity ≤ min(shippableRemaining, dueRemaining)` | `SHIPMENT_EXCEEDS_LIMIT` | 422 |
| 库存调整 | `quantity + delta ≥ 0` | `INSUFFICIENT_STOCK` | 409 |
| 电镀建单/改单 | `quantity ≤ 已到货 − 其他电镀单数量` | `PLATING_EXCEEDS_REMAINING` | 422 |
| 生产下发（需电镀） | `platingReceivedQty ≥ 1` 且 `任务数量 ≤ platingReceivedQty` | `PLATING_NOT_RECEIVED` / `PLATING_QTY_INSUFFICIENT` | 422 |

发货上限刻意取两个剩余量的较小值：既不能超出已包装（避免发出不存在的货），也不能超出订单应交量（避免超发）。

### 2.2 完成判定

`shippedQty >= orderQty` 时状态置为 `COMPLETED` 并写 `completedAt`。由于发货上限已限制为 `min(shippableRemaining, dueRemaining)`，正常情况下最后一次发货刚好补齐。

## 3. 允许动作矩阵

实现：`computeAllowedActions(order, quantities, role, userId, departmentId)`。动作名与前端 `FlowPanel` 一致。

| 动作 | 角色 | 状态 | 额外闸门 |
| --- | --- | --- | --- |
| `create-purchase` | ADMIN | PENDING_PURCHASE | 尚无采购单 |
| `record-arrival` | LOGISTICS | PURCHASING | 有采购单且 `arrivedQty < purchaseQty` |
| `dispatch-production` | ADMIN | PURCHASING | 采购量 >0、已全部到货、尚无生产任务；需电镀时至少已收一批 |
| `production-feedback` | PRODUCTION | IN_PRODUCTION | 有生产任务、尚未反馈、操作者部门 = 任务部门 |
| `dispatch-qc` | ADMIN | IN_PRODUCTION | 已有反馈且反馈量 >0、尚无质检记录 |
| `qc-entry` | QC | PENDING_QC | 无未决策记录；首检未齐 **或** 存在待复检返工量 |
| `qc-decision` | ADMIN | PENDING_QC | 存在未决策质检记录 |
| `dispatch-packing` | ADMIN | QC_DONE | `packableRemaining > 0` |
| `record-packing` | PACKING | PACKING | `packableRemaining > 0` |
| `trigger-shipping` | ADMIN | PACKING | `packedQty > 0` |
| `record-shipment` | LOGISTICS | SHIPPING | `shippableRemaining > 0` |

注意：`dispatch-production` 的“已全部到货”判定同时出现在允许动作与提交校验中；即使前端渲染了按钮，后端仍会以 `ARRIVAL_INCOMPLETE` 拒绝未到齐的生产下发。

## 3.1 质检决策与结算

| 决策 | 放行量 | 报废量 | 后续 |
| --- | --- | --- | --- |
| `PASS` | `qualifiedQty` | 0 | 不合格必须为 0 |
| `REWORK` | `qualifiedQty` | 0 | 不合格量等待复检；订单留在 `PENDING_QC` |
| `SCRAP` | `qualifiedQty` | `unqualifiedQty` | 订单可结算 |

结算判定：`ΣreleasedQty + ΣscrapQty ≥ producedQty` 且不存在未决策记录 → 订单转 `QC_DONE`。返工复检的合格量会在下一轮决策时计入放行，不会与首检合格重复计数，因为每条记录只放行自己的 `qualifiedQty`。

## 3.2 异常下发复核（R22F × R09F）

异常单不写订单数量，只决定「这批货是否要再走一次质检」：

| 情形 | 校验 | 结果 |
| --- | --- | --- |
| 异常未关联生产任务 | `EXCEPTION_NO_PRODUCTION` (422) | 只能留痕解决 |
| 同任务已有 `WAITING_QC` 异常 | `EXCEPTION_REVIEW_IN_PROGRESS` (409) | 等前一张解决 |
| 存在未决策质检记录 | `EXCEPTION_QC_PENDING_DECISION` (409) | 先做决策 |
| 尚未首检、订单 `IN_PRODUCTION` | — | 订单转 `PENDING_QC`，异常转 `WAITING_QC` |
| 已首检但无待复检返工量 | `EXCEPTION_NO_QC_BASIS` (422) | 需先判返工 |
| 有返工量、订单 `PENDING_QC` | — | 异常转 `WAITING_QC`，品控复检后自动关联 |
| 异常 `RESOLVED` | 关联质检无 PASS 且未声明 `waiveQc` | `EXCEPTION_QC_NOT_PASSED` / `EXCEPTION_QC_REQUIRED` (409) |

`WAITING_QC` 不能通过 `PATCH /exceptions/:id` 手填（`EXCEPTION_REVIEW_REQUIRED`），必须走 `POST /exceptions/:id/review`，保证凭证一定来自真实质检记录。

## 4. 提交时的校验顺序

以生产下发为例，后端按以下顺序失败即返回，避免出现半成品状态：

1. 认证与角色（401/403）。
2. `Idempotency-Key` 与请求体哈希（400/409）。
3. Zod 字段校验（400）。
4. 订单存在与状态（404 `ORDER_NOT_FOUND` / 409 `ORDER_STATUS_CONFLICT`）。
5. 主数据存在且启用（404/422，如 `SUPPLIER_NOT_FOUND`、`DEPARTMENT_CATEGORY_MISMATCH`）。
6. 业务数量闸门（422）。
7. 事务写入业务记录 + 时间线 + 通知 + 审计 + 幂等结果。

事务失败会整体回滚，因此不会出现“状态已改但记录没写”的情况。

采购还有一条供应商集合校验（R02F）：配件配置了供应商后，所选供应商必须属于该集合，否则返回 422 `SUPPLIER_NOT_IN_PART_SET`；没配置集合时仍可选任意有效供应商。

## 5. 利润

```text
sales          = Σ(order_item.quantity × order_item.unitPrice)
purchaseCost   = Σ(purchase_item.quantity × purchase_item.unitPrice)
productionCost = Σ(生产反馈累计数量 × production_order.unitPrice)
platingCost    = Σ(RECEIVED 电镀单.quantity × unitPrice)
profit         = sales − purchaseCost − productionCost − platingCost
marginPercent  = sales = 0 ? 0 : profit / sales × 100
```

- 统一使用 `Prisma.Decimal` 与 `Decimal(12,2)`，输出固定两位小数字符串。
- 金额是“预计”口径，不代表已收款或已付款。
- 仅 ADMIN 可见；其他角色的 `flow.profit` 为 `null`，前端不渲染金额区块。

## 6. 与测试的对应

| 规则 | 测试 |
| --- | --- |
| 数量公式、利润、允许动作 | `backend/tests/domain.test.ts` |
| 完整主链、状态守卫、到货/包装/发货上限、幂等重放 | `backend/tests/flow.test.ts` |
| 分批首检、返工复检、报废结算、只放行合格量 | `backend/tests/flow.test.ts`（R09F 三例） |
| 异常下发复核、凭证校验、留痕豁免、幂等重放 | `backend/tests/collab.test.ts`（R22F×R09F 四例） |
| 库存扣减不为负 | `backend/tests/inventory.test.ts` |
| 权限与脱敏 | `backend/tests/auth.test.ts`、`flow.test.ts` 中的角色断言 |