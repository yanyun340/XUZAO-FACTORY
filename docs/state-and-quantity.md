# 订单状态与数量规则

版本：0.2.0｜实现：`backend/src/domain/flow.ts`、`backend/src/routes/flow.ts`
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
| `PENDING_QC` | 待质检 | 质检下发 | 品控录入 → 管理员决策 PASS |
| `QC_DONE` | 质检完成 | 决策落库 | 管理员下发包装 |
| `PACKING` | 包装中 | 包装下发 | 包装登记累计 >0 后，管理员触发发货 |
| `SHIPPING` | 发货中 | 发货触发 | 物流登记发货；累计 ≥ 订单量即完成 |
| `COMPLETED` | 已完成 | 发货累计 ≥ 订单量，写 `completedAt` | 无 |

限制说明：

- 没有“取消订单/退回上一步”状态。M 允许明确拒绝，本项目选择不实现取消；错误动作被状态守卫拒绝，而不是静默回退。
- 生产、质检、包装、发货都是“一单一条主记录”的 M 口径；表结构允许多条，但业务动作取最新一条，多产品并行未实现。

## 2. 数量口径

所有数量都从有效业务记录求和，不使用可被前端改写的汇总字段。

| 字段 | 计算 | 含义 |
| --- | --- | --- |
| `orderQty` | Σ `order_items.quantity` | 订单总量 |
| `purchaseQty` | Σ `purchase_items.quantity` | 采购总量 |
| `arrivedQty` | Σ `arrival_records.quantity` | 累计到货 |
| `producedQty` | Σ 最新生产任务的 `production_feedbacks.quantity` | 生产反馈累计 |
| `inspectedQty` | 最新质检记录的 `inspectedQty` | 检验量 |
| `qualifiedQty` | 最新质检记录的 `qualifiedQty` | 合格量 |
| `releasedQty` | Σ 已决策质检记录的 `releasedQty` | 放行量 |
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
| 质检录入 | 合格 + 不合格 = 检验量；不合格 = 0；检验量 ≤ 生产量 | `QC_QTY_MISMATCH` / `QC_PARTIAL_NOT_SUPPORTED` / `QC_EXCEEDS_PRODUCED` | 422 |
| 包装 | `packedQty + quantity ≤ releasedQty` | `PACKING_EXCEEDS_REMAINING` | 422 |
| 发货 | `quantity ≤ min(shippableRemaining, dueRemaining)` | `SHIPMENT_EXCEEDS_LIMIT` | 422 |
| 库存调整 | `quantity + delta ≥ 0` | `INSUFFICIENT_STOCK` | 409 |

发货上限刻意取两个剩余量的较小值：既不能超出已包装（避免发出不存在的货），也不能超出订单应交量（避免超发）。

### 2.2 完成判定

`shippedQty >= orderQty` 时状态置为 `COMPLETED` 并写 `completedAt`。由于发货上限已限制为 `min(shippableRemaining, dueRemaining)`，正常情况下最后一次发货刚好补齐。

## 3. 允许动作矩阵

实现：`computeAllowedActions(order, quantities, role, userId, departmentId)`。动作名与前端 `FlowPanel` 一致。

| 动作 | 角色 | 状态 | 额外闸门 |
| --- | --- | --- | --- |
| `create-purchase` | ADMIN | PENDING_PURCHASE | 尚无采购单 |
| `record-arrival` | LOGISTICS | PURCHASING | 有采购单且 `arrivedQty < purchaseQty` |
| `dispatch-production` | ADMIN | PURCHASING | 采购量 >0、已全部到货、尚无生产任务 |
| `production-feedback` | PRODUCTION | IN_PRODUCTION | 有生产任务、尚未反馈、操作者部门 = 任务部门 |
| `dispatch-qc` | ADMIN | IN_PRODUCTION | 已有反馈且反馈量 >0、尚无质检记录 |
| `qc-entry` | QC | PENDING_QC | 有生产任务、尚无质检记录 |
| `qc-decision` | ADMIN | PENDING_QC | 已有质检记录、尚无决策 |
| `dispatch-packing` | ADMIN | QC_DONE | `packableRemaining > 0` |
| `record-packing` | PACKING | PACKING | `packableRemaining > 0` |
| `trigger-shipping` | ADMIN | PACKING | `packedQty > 0` |
| `record-shipment` | LOGISTICS | SHIPPING | `shippableRemaining > 0` |

注意：`dispatch-production` 的“已全部到货”判定同时出现在允许动作与提交校验中；即使前端渲染了按钮，后端仍会以 `ARRIVAL_INCOMPLETE` 拒绝未到齐的生产下发。

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
profit         = sales − purchaseCost − productionCost
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
| 库存扣减不为负 | `backend/tests/inventory.test.ts` |
| 权限与脱敏 | `backend/tests/auth.test.ts`、`flow.test.ts` 中的角色断言 |