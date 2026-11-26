# R12F 撤销修正 · 实施计划

版本：已实现（待验收）｜日期：2026-11-26｜对应需求：R12F（选做 F）｜验收：A17
现状：已落地并全量验证；`docs/feature-status.md` 标「已验收」。执行报告见 `tests/reports/2026-11-26-record-undo.md`。

## 1. 目标与边界

**目标**：让到货、生产反馈、质检、包装、发货五类录入记录可以安全回退，且回退本身留痕可查，不破坏审计。

**已确定的四条口径**：

| 决定 | 内容 |
| --- | --- |
| 覆盖范围 | 五类全覆盖，A17 第 5 条要求逐类验收，不拿一类替代全部 |
| 窗口内权限 | 原操作者（`operatorId = 当前用户`）或 ADMIN；其他人 403 |
| 超时处理 | 仅 ADMIN，必须填 2–200 字原因；事件与审计动作独立标记为「修正」 |
| 质检级联 | 撤销质检记录时连同其决策在同一事务内作废 |

**不做**：不物理删除记录；不提供订单级「取消/退回」；不改九阶段以外的状态语义；不做多产品并行范围。

## 2. 核心设计

### 2.1 作废而非删除

六张表各加三列：`voidedAt`、`voidedById`（FK → admin_users）、`voidReason`——五类录入记录，加上 `qc_decisions`（质检决策必须随记录一起作废，见 2.6）。
作废行继续在订单详情里返回（灰显 + 原因 + 操作者），但**不参与任何数量计算**。

理由：`CONSTRAINTS.md` §4 要求业务记录、时间线、审计同事务提交；物理删除会让历史数量无法复算，也让 A17「重复撤销不再扣量」失去依据。`QCDecision.qcRecordId` 是 `@unique`，删决策再重建会破坏「一条记录只有一条决策」的约束语义，所以决策也走软作废。

### 2.2 数量口径的统一入口

`computeQuantities`（`backend/src/domain/flow.ts:140`）是唯一的数量来源，在这里加过滤即可让所有下游自动生效：

- `QuantitySource` 的各记录类型加可选 `voidedAt?: Date | null`；
- 内部先 `filter(row => !row.voidedAt)` 再求和；
- **决策也要过滤**：`releasedQty` / `scrappedQty` / `undecidedQty` / `reworkPendingQty` 只统计 `decision && !decision.voidedAt` 的行；
- `computeProfit` 同理过滤 feedback（及 plated 相关不变）。

**SQL 侧另需补过滤**（不走 `computeQuantities` 的地方）：

| 位置 | 改动 |
| --- | --- |
| `routes/collab.ts:205` 生产反馈聚合 | `where: { voidedAt: null }` |
| `routes/collab.ts:232` 发货聚合 | 同上 |
| `routes/collab.ts:220` 生产看板 `feedbacks` | `where: { voidedAt: null }` |
| `routes/collab.ts` 利润三项（feedback 成本） | 随上 |
| `lib/audit-order-context.ts` 记录反查 | 保留全量（审计要看历史），不过滤 |

**`routes/flow.ts` 内还有 7 处裸 `reduce` 求和，同样必须排除作废行**，否则「撤销后重做」会被自己挡住：

| 行 | 用途 | 漏改后果 |
| --- | --- | --- |
| 236 | 到货可追加量 `item.quantity - Σarrivals` | 撤销到货后无法重新登记（剩余量被作废行占着） |
| 293 / 335-336 | 电镀可建单量 `arrived - Σplating` | 撤销到货后电镀余量算错 |
| 805 | 下发质检时 `produced = Σfeedbacks` | 撤销反馈后仍认为有产量，`NO_PRODUCED_QTY` 不触发 |
| 874 | 录入质检时 `produced` | 同上，`QC_EXCEEDS_PRODUCED` 上界错 |
| 889 / 907 | 首检累计 `Σ round=1 inspectedQty` | 撤销质检记录后无法补录 |

建议在 `domain/flow.ts` 导出两个小工具 `sumActive(rows)`（过滤 `voidedAt`）与 `sumActiveDecisions(records)`，`routes/flow.ts` 全部改用它，避免逐处手写过滤条件。

**「取最后一条」的地方不能只靠求和过滤**——`computeAllowedActions` 用的是 `productions.at(-1).feedbacks.at(-1)` 与 `qcRecords` 全量，作废行仍会被当成「存在」：

| 位置 | 现状 | 改动 |
| --- | --- | --- |
| `domain/flow.ts:309` | `production?.feedbacks.at(-1)` 决定是否允许 `production-feedback` | 改成 `activeFeedbacks.at(-1)` |
| `domain/flow.ts:310` | `hasInitialQc = qcRecords.some(round === 1)` 决定是否允许 `dispatch-qc` | 只看非作废记录 |
| `domain/flow.ts:307` | `qcRecords` 用于返工复检判断 | 只看非作废记录 |
| `domain/orders.ts:304-316` | `production.feedback`（取最后一条）、`qc.records`、`pendingReinspection` | 同样按非作废计算数量，但 **DTO 仍返回作废行**（带 `voidedAt`），只是它们不参与「最近一条动作」判断 |

这就是 DTO 与领域计算要分开的原因：展示层需要看到「这条被撤了」，计算层必须当它不存在。

**「有没有决策」的判断同样要区分「未决策」和「已作废」**。作废的决策行还在表里，只是 `voidedAt` 非空；如果只写 `!record.decision` 会把它当成「有决策」，于是 `undecidedQty` 变成 0、`QC_DECISION_PENDING` 不触发，业务直接放行写坏数据：

| 位置 | 现状 | 改动 |
| --- | --- | --- |
| `domain/flow.ts:164` | `!record.decision` 判定 `undecidedQty` | 改成 `!record.decision \|\| record.decision.voidedAt` |
| `domain/flow.ts:158/161/169` | `record.decision ? [...]` / `decision?.decision === 'REWORK'` | 先判 `voidedAt` 再取值 |
| `routes/flow.ts:870` | `qcRecords.some((r) => !r.decision)` → `QC_DECISION_PENDING` | 同上 |
| `routes/flow.ts:1013` | `if (record.decision) → QC_ALREADY_DECIDED` | 作废的决策不该拦住重新决策，改成 `record.decision && !record.decision.voidedAt` |
| `routes/flow.ts:1058` | `!records.some((row) => !row.decision)` 结算判定 | 改用 `sumActiveDecisions` |
| `routes/collab.ts:777` | 异常复核 `records.some((record) => !record.decision)` | 同上 |
| `routes/collab.ts:632` | 异常凭证 `qc?.decision?.decision !== 'PASS'` | 作废的 PASS 不再算凭证 |
| `routes/collab.ts:820` | 异常复核返工量统计 `decision?.decision !== 'REWORK'` | 只看非作废决策 |

统一做法：给 `QCDecision` 加一个派生的 `activeDecision(record)` 帮助函数（返回 `decision && !decision.voidedAt ? decision : null`），所有位置改用它，而不是散落 `voidedAt` 判断。

**Prisma include 必须带上新列**，否则过滤条件在运行时永远是 `undefined`（TypeScript 类型会提醒，但嵌套 include 容易漏）：

| include | 需要补的字段 |
| --- | --- |
| `flowInclude`（`domain/flow.ts:8-61`） | `purchaseOrders.items.arrivals` 加 `voidedAt/voidReason/voidedBy`；`productions.feedbacks` 同上；`productions.qcRecords` 同上且 `decision` 加 `voidedAt/voidReason`；`packingRecords`、`shipments` 同上。`voidedBy: { select: { displayName: true } }` 用于 DTO 的 `voidedByName` |
| `listFlowInclude`（`domain/flow.ts:69-80`） | 只需 `voidedAt`（列表不算作废人姓名）：`arrivals`、`feedbacks`、`qcRecords` 及其 `decision`、`packingRecords`、`shipments` |

`QuantitySource` / `ActionSource` 的类型定义在 `domain/flow.ts:85-109` 与 `289-294`，同步加可选 `voidedAt`；列表行与详情行都要满足，所以用可选字段，缺失时视为未作废（兼容测试里的手工构造对象）。

### 2.3 状态回退：只允许三条反向边

状态机是正向单向的，但作废后必须修复，否则出现「记录没了、订单卡在 SHIPPING」。

新建 `backend/src/domain/status.ts`：

```ts
export interface RepairFacts {
  hasProduction: boolean;
  hasNonVoidedQcRecord: boolean;
  hasWaitingQcException: boolean;
}
/** 纯函数：给定当前状态与修复后数量，返回应落到的状态。 */
export function deriveRepairedStatus(
  current: OrderStatus,
  q: FlowQuantities,
  facts: RepairFacts,
): OrderStatus;
```

规则（其余状态一律保持不变）：

1. `COMPLETED` → `SHIPPING`：`shippedQty < orderQty` 时回退，同时清空 `completedAt`。
2. `QC_DONE` → `PENDING_QC`：不再结算（`released + scrapped < produced` 或仍有未决策记录）。
3. `PENDING_QC` → `IN_PRODUCTION`：`producedQty === 0` 且无非作废质检记录且无 `WAITING_QC` 异常。

注意第 2、3 条可级联（撤销唯一反馈 → QC_DONE → PENDING_QC → IN_PRODUCTION），实现时按顺序评估一次即可，不需要循环。

`PACKING` 在 `packedQty` 归零后保持 `PACKING`，`SHIPPING` 同理——这两个状态没有「回到上一步」的合法理由，且允许动作矩阵会用数量闸门自己挡住后续操作。

### 2.4 可注入时钟

新增 `backend/src/lib/clock.ts`：

```ts
export const UNDO_WINDOW_MS = 10 * 60_000;
export function now(): Date;            // 生产环境即 new Date()
export function setNowForTesting(d: Date | null): void;  // 仅测试调用
```

A17 要求「可控制的服务端测试时钟」；不依赖回填 `createdAt` 的取巧写法。
窗口判断统一：`now().getTime() - record.createdAt.getTime() <= UNDO_WINDOW_MS`。

### 2.5 接口形态：显式路径 + 共享适配器

不做 `/flow-records/:kind/:id` 这类通配路径（与本仓库资源式路由风格不一致）。改用**循环注册**，URL 保持资源语义，实现只有一份：

```ts
for (const adapter of RECORD_ADAPTERS) {
  app.post(`/api/v1/${adapter.path}/:id/undo`,    { preHandler: authenticate }, handleUndo(adapter));
  app.post(`/api/v1/${adapter.path}/:id/correct`, { preHandler: [authenticate, requireAdmin] }, handleCorrect(adapter));
}
```

| kind | undo / correct 路径 | 现有创建接口 |
| --- | --- | --- |
| arrival | `POST /arrivals/:id/undo` | `POST /purchases/:id/arrivals` |
| feedback | `POST /feedbacks/:id/undo` | `POST /productions/:id/feedback` |
| qc | `POST /qc-records/:id/undo` | `POST /productions/:id/qc-records` || packing | `POST /packing-records/:id/undo` | `POST /orders/:id/packing-records` |
| shipment | `POST /shipment-records/:id/undo` | `POST /orders/:id/shipment-records` |

适配器结构：

```ts
interface RecordAdapter {
  kind: 'arrival' | 'feedback' | 'qc' | 'packing' | 'shipment';
  path: string;
  load(tx, id): Promise<{ id; orderId; operatorId; createdAt; quantity; ordered? }>;
  guardVoid(tx, record, ctx): Promise<void>;   // 下游依赖校验
  voidRecord(tx, record, input): Promise<void>; // 写 voided 三列（qc 连决策）
  eventType: { undo: string; correct: string };
  audit: { undo: { action: string; resourceType: string }; correct: ... };
  category: NotificationCategory;
}
```

两种操作都走 `runIdempotent`（operation `record.undo` / `record.correct`），成功后 `finish(...)` 返回最新订单详情，HTTP 200（未创建新资源）。

### 2.6 各类型守护条件（逐条校验）

| kind | 拒绝条件 | 错误码 / HTTP |
| --- | --- | --- |
| 全部 | 记录已作废 | `RECORD_ALREADY_VOIDED` / 409 |
| 全部 | 记录不存在 | `*_NOT_FOUND` / 404 |
| undo | 非原操作者且非 ADMIN | `FORBIDDEN` / 403 |
| undo | 超 10 分钟且非 ADMIN | `UNDO_WINDOW_EXPIRED` / 409（details 带 `undoableUntil`） |
| correct | 非 ADMIN | `FORBIDDEN` / 403 |
| correct | 原因为空或超 200 字 | `VALIDATION_ERROR` / 400 |
| arrival | 该订单已下发生产任务 | `UNDO_HAS_PRODUCTION` / 409 |
| arrival | 同一采购项存在 SENT/RECEIVED 电镀单 | `UNDO_HAS_PLATING` / 409 |
| feedback | 该生产任务存在非作废质检记录 | `UNDO_HAS_QC` / 409 |
| feedback | 该任务存在 `WAITING_QC` 异常 | `UNDO_EXCEPTION_REVIEWING` / 409 |
| qc | 存在非作废子复检记录 | `UNDO_HAS_CHILD_QC` / 409 |
| qc | `packedQty > 0` | `UNDO_HAS_PACKING` / 409 |
| qc | 被 `WAITING_QC` 或 `RESOLVED` 异常引用（异常凭证会失效） | `UNDO_EXCEPTION_REFERENCED` / 409 |
| qc | 被 `OPEN` / `IN_PROGRESS` 异常引用 | 允许，同一事务内把该异常 `qcRecordId` 置空 |
| packing | `shippedQty > 0` | `UNDO_HAS_SHIPMENT` / 409 |
| shipment | 无下游，仅状态回退 | — |

异常凭证的边界说明：`RESOLVED` 的质量异常靠 `POST /exceptions/:id` 校验「关联质检必须 PASS」（`routes/collab.ts:627-635`）。作废一条被 `RESOLVED` 异常引用的质检记录会让已有凭证变成「有记录但已作废」，因此直接拒绝，要求管理员先处理异常单。`CLOSED` 异常保留对已作废记录的引用（行还在，审计可查），不阻塞撤销。

A17 第 3 条三条硬约束（已发货的包装不能撤、已包装的放行 QC 不能撤、有生产/电镀依赖的到货不能撤）全部覆盖。

### 2.7 事件、审计、通知

| kind | 撤销事件 | 修正事件 | 审计 action |
| --- | --- | --- | --- |
| arrival | `ARRIVAL_UNDONE` | `ARRIVAL_CORRECTED` | `arrival.undo` / `arrival.correct` |
| feedback | `PRODUCTION_FEEDBACK_UNDONE` | `PRODUCTION_FEEDBACK_CORRECTED` | `production.feedback.undo` / `.correct` |
| qc | `QC_RECORD_UNDONE` | `QC_RECORD_CORRECTED` | `qc.undo` / `qc.correct` |
| packing | `PACKING_UNDONE` | `PACKING_CORRECTED` | `packing.undo` / `packing.correct` |
| shipment | `SHIPMENT_UNDONE` | `SHIPMENT_CORRECTED` | `shipment.undo` / `shipment.correct` |

- 新事件类型必须补进 `lib/notification-categories.ts`，否则落成 `SYSTEM`。
- `writeAudit` 的 `before` 存记录快照（`quantity`、`operatorId`、`createdAt`、决策信息），`after` 存 `{ voidedAt, voidReason, statusBefore, statusAfter }`。
- `recordEvent.payload` 带 `recordId / kind / quantity / voidReason / statusRepaired`，前端时间线据此展示。
- **注意**：`recordEvent` 的 `notify` 每调用一次就给全部管理员新建一条通知（`dedupeKey` 含新生成的 `event.id`），撤销事件同样会通知全体管理员——这是期望行为，但「修正」与「撤销」文案要区分，避免现场误读。

### 2.7.1 撤销后的「可重做」闭环

A17 只要求「撤销合法」，但撤销完不能再录就没有意义。作废后状态按 2.3 修复，即可让现有创建接口重新放行：

| 撤销对象 | 状态修复 | 重新可用的动作 |
| --- | --- | --- |
| 到货（订单仍 PURCHASING） | 不变 | `record-arrival` 重新出现 |
| 生产反馈（订单 PENDING_QC 且无质检） | → IN_PRODUCTION | `production-feedback` 重新出现 |
| 质检记录（订单 QC_DONE 且不再结算） | → PENDING_QC | `qc-entry` 重新出现 |
| 包装（订单 PACKING） | 不变 | `record-packing` 重新出现 |
| 发货（订单 COMPLETED） | → SHIPPING，清 `completedAt` | `record-shipment` 重新出现 |

这条必须写成测试断言，否则只验证了「能撤」没验证「撤了还能继续」。

### 2.8 DTO：前端保持「只渲染」

`toOrderDetail`（`domain/orders.ts:291`）为每条记录补：

```ts
voidedAt: string | null;
voidReason: string | null;
voidedByName: string | null;
undo: { canUndo: boolean; canCorrect: boolean; undoableUntil: string | null };
```

`canUndo` 由服务端按 `role + userId + window` 计算，前端不自行判断时间；`undoableUntil` 只用于倒计时展示。涉及位置：到货（349-355）、生产反馈（401-408）、QC 记录（430-448）、包装（454-459）、发货（463-468）。

## 3. 实施顺序

每步都能独立验证，失败可单独回退。

### 步骤 0 · 开工前置

按 `AGENTS.md` 的约定，迁移属于「必须确认后才执行」的操作。开工前需要确认：

- 目标库是开发库还是隔离库（`DATABASE_URL` 指向）；
- 是否允许在开发库上跑 `prisma migrate dev --name record_void`。

本计划默认在开发库新增迁移，测试库由 `global-setup` 自动 `migrate deploy` 跟上。

### 步骤 1 · 迁移

新增 `backend/prisma/migrations/<ts>_record_void/migration.sql`：

```sql
ALTER TABLE "arrival_records"      ADD COLUMN "voidedAt" TIMESTAMP(3),
                                   ADD COLUMN "voidedById" UUID,
                                   ADD COLUMN "voidReason" TEXT;
-- production_feedbacks / qc_records / packing_records / shipment_records / qc_decisions 同上
ALTER TABLE "arrival_records" ADD CONSTRAINT "arrival_records_voidedById_fkey"
  FOREIGN KEY ("voidedById") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- 其余五表同样
```

Index 只加一条，用来过滤活跃记录：

```sql
CREATE INDEX "arrival_records_voidedAt_idx" ON "arrival_records"("voidedAt");
-- 其余五表同样
```

`schema.prisma` 同步：六个模型加三列 + 关系，`AdminUser` 加六个具名反向关系（`@relation("ArrivalVoider")` 等）。`QCDecision` 只加 `voidedAt` / `voidReason`，不加 `voidedById`（决策随记录一起作废，作废人就是记录作废人）。

### 步骤 2 · domain

- `domain/flow.ts`：`QuantitySource` / `ActionSource` 加 `voidedAt`；`computeQuantities` / `computeProfit` / `computeAllowedActions` 过滤；导出 `sumActive` / `sumActiveDecisions` / `activeDecision` 工具；`flowInclude`、`listFlowInclude` 补新列。
- 新建 `domain/status.ts`：`deriveRepairedStatus`。
- `domain/orders.ts`：DTO 补字段；`toOrderDetail` 增 `now` 入参（默认 `new Date()`）；`pendingReinspection` 与 `production.feedback` 只看非作废记录。

### 步骤 3 · lib

- 新建 `lib/clock.ts`。
- `lib/notification-categories.ts` 补 10 个事件类型。

### 步骤 4 · routes

- `routes/flow.ts`：`RECORD_ADAPTERS` + `handleUndo` / `handleCorrect` + 循环注册；`qc` 适配器负责连决策作废与异常指针清理；**7 处裸求和改用 `sumActive`**，**7 处决策判断改用 `activeDecision`**（两表见 2.2）。
- `routes/collab.ts`：看板三处 SQL 加 `voidedAt: null`；异常复核与凭证三处改 `activeDecision`。

### 步骤 5 · 前端

- 新建 `frontend/src/components/RecordsPanel.tsx`：五类记录分组列表，行内 `text-btn--danger` 撤销按钮（复用 `PlatingPanel.tsx` 的 `keyFor` + `refresh` 模式），ADMIN 额外「修正」入口（弹窗写原因，复用 `useModalFocus` / `PartSuppliersDialog` 的对话框结构）。
- `OrderDetailPage.tsx`：在 `FlowLedger` 之后插入 `<RecordsPanel />`。
- `api/types.ts`：`ArrivalEntry` / `RecordFlow` / `ProductionFlow.feedback` / `QcRecordFlow` 补字段。
- `lib/format.ts`：`EVENT_LABEL` 加 10 条；`AUDIT_ACTION_LABEL` 加 10 条。

前端交互要点：

- 倒计时用 `useEffect` + 1 秒 `setInterval`，到期即停，避免无意义常驻定时器；`prefers-reduced-motion` 不影响文本倒计时。
- 撤销成功后直接 `onUpdated(detail)` 用服务端返回的订单详情覆盖，不额外 `GET`——与 `FlowPanel` 的 `ctx.run` 一致。
- 失败按 `ApiError.code` 匹配（`UNDO_WINDOW_EXPIRED` → 提示「已超过 10 分钟，请由管理员修正」），不解析中文文案分支（`AGENTS.md` 约定）。
- 作废行灰显并显示原因与作废人，样式新增 `.record-item--voided`；不改动现有 `attach-list` 结构，避免影响电镀/附件面板。

### 步骤 6 · 测试

新建 `backend/tests/undo.test.ts`（`beforeAll` 内 `resetDb()` + `seedBase()`，共享串行库）。

新增本地 helper：`createOrderAtPacking()`、`createOrderAtShipping()`、`advanceToNow(ms)`（调 `setNowForTesting`）。

用例矩阵：

| 类别 | 断言 |
| --- | --- |
| 窗口内 | 五类各一条：原操作者撤销 200，数量回退，状态按 2.3 修复，事件与审计落库 |
| 权限 | 他人撤销 403；管理员窗口内撤销 200 |
| 窗口 | 9分59秒 允许、10分01秒非管理员 409 `UNDO_WINDOW_EXPIRED` |
| 修正 | 管理员超时 + 原因 200；缺原因 400；非管理员 403 |
| 依赖 | 到货有生产 409、到货有电镀 409、反馈有质检 409、QC 已包装 409、QC 有子记录 409、QC 被 RESOLVED 异常引用 409、包装已发货 409 |
| 重做 | 五类撤销后对应 `allowedActions` 重新包含原动作（A17 第 4 条「按依赖逆序合法撤销」的可执行性） |
| 重复 | 二次撤销 409 `RECORD_ALREADY_VOIDED`；重复撤销不重复扣量 |
| 幂等 | 同键重放 200 + `Idempotent-Replayed: true` + 数量只变一次 |
| 纯函数 | `domain.test.ts`：作废行不计入；`deriveRepairedStatus` 三条反向边 + 级联 |
| 看板 | 撤销后 `production.completedFeedback`、`shipping.shippedQty`、利润同步下降 |

测试时钟的用法：`setNowForTesting(new Date(base + 9 * 60_000 + 59_000))` 验证 9分59秒；`+10 * 60_000 + 1_000` 验证过期。`afterEach` 必须 `setNowForTesting(null)`，否则同文件后续用例全被带偏。

**注意**：记录 `createdAt` 仍由数据库 `@default(now())` 生成，测试时钟只影响「窗口判断」，不影响记录写入时间。所以 `advanceToNow` 要基于记录的真实 `createdAt` 偏移，而不是基于测试开始时间：

```ts
function atRecord(record: { createdAt: string }, offsetMs: number) {
  setNowForTesting(new Date(new Date(record.createdAt).getTime() + offsetMs));
}
```

**时间线的幂等**：撤销事件写入 `TimelineEvent` 没有唯一约束，靠 `runIdempotent` 保证不重复；测试要显式传同一个 `Idempotency-Key` 重放，并断言时间线只多一条。

### 步骤 7 · 文档

| 文件 | 改动 |
| --- | --- |
| `docs/api-contract.md` | 4.2 表后新增「4.3 撤销与修正」；错误码目录补 10 个新码（`RECORD_ALREADY_VOIDED`、`UNDO_WINDOW_EXPIRED`、`UNDO_HAS_PRODUCTION`、`UNDO_HAS_PLATING`、`UNDO_HAS_QC`、`UNDO_HAS_CHILD_QC`、`UNDO_HAS_PACKING`、`UNDO_HAS_SHIPMENT`、`UNDO_EXCEPTION_REVIEWING`、`UNDO_EXCEPTION_REFERENCED`）；幂等适用列表加 10 个撤销/修正接口 |
| `docs/state-and-quantity.md` | 状态机图加三条反向边；数量表加「作废记录不计入」；允许动作矩阵后补撤销闸门；校验顺序表 |
| `docs/data-dictionary.md` | 五张表补 `voidedAt/voidedById/voidReason`，`qc_decisions` 补 `voidedAt/voidReason` |
| `docs/feature-status.md` | 第 27、61、74 行；证据索引换新报告 |
| `docs/traceability.csv` | 第 13、40 行：接口、表、实现、测试、状态、限制 |
| `PRD-xuzao.md` | 第 39 行（移除「10 分钟撤销」）、第 65 行（取舍说明）、第 108 行（R12 行） |
| `docs/decisions/ADR-0005-record-void-and-status-repair.md` | 新建：为什么用软作废而不是删除/冲销，为什么只允许三条反向边 |
| `CHANGELOG.md` | 0.4.0 段：新增、迁移、测试、限制 |
| `tests/README.md` | 文件表加 `undo.test.ts`，总数更新 |
| `tests/reports/<日期>-undo-window.md` | 实际执行结果 |

## 4. 验证命令

```bash
npm run migrate -w backend            # 或 migrate deploy（确认指向开发库后）
npm run typecheck -w backend
npm test                              # 含新 undo.test.ts
npm run build -w frontend             # tsc --noEmit + vite build
npm run dev                           # 浏览器手工核对撤销/修正交互
```

前端布局按全局 CLAUDE.md 的 browser-cdp 截图 + vision 流程核查，不靠读代码推断。

A17 是逐条验收场景，最终报告要按它的五条逐项给证据：

| A17 条目 | 对应测试 |
| --- | --- |
| 1. 9分59秒 / 10分整撤销允许 | `窗口` 用例（含 10分整边界） |
| 2. 10分01秒拒绝、他人拒绝 | `窗口` + `权限` 用例 |
| 3. 已发货的包装、已包装的 QC、有生产/电镀依赖的到货不能撤 | `依赖` 用例 |
| 4. 按依赖逆序撤销，核对累计/状态/时间线/通知，重复撤销不再扣量 | `重做` + `重复` + `幂等` 用例 |
| 5. 五类逐类执行 | `窗口内` 五条用例 |

## 5. 风险与回退

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 漏掉某处数量聚合 | 作废记录仍被计数，看板虚高 | `computeQuantities` 单点过滤 + 看板 SQL 断言 + 撤销后看板用例 |
| 状态回退不彻底 | 记录删了、状态卡住，无法重做 | `deriveRepairedStatus` 纯函数单测 + 端到端「撤销后可再录」用例 |
| 质检级联漏作废决策 | 放行量残留，包装量虚高 | qc 适配器在同一事务内 `qcdDecision.updateMany` + 用例断言 `releasedQty` |
| 迁移只追加 | 回退需恢复备份 | 迁移是纯加列，0.3.x 代码在 0.4.0 结构上仍可运行；不需要数据回填 |
| 撤销接口绕过审计 | 违反 CONSTRAINTS §4 | 事件 + 审计 + 幂等全部在同一 `tx` 内，失败整体回滚 |

回退方式：迁移为纯加列，旧代码忽略新列即可运行；应用层回退即切回上一提交。

## 6. 交付口径

完成后 `docs/feature-status.md` 的 R12F 从「未选做」改为「已验收」，限制写为：

> 五类录入记录支持 10 分钟内撤销（原操作者或管理员）与超时留痕修正（管理员 + 必填原因）；作废不删行，状态按三条反向边修复；不支持订单级取消，不支持多产品并行撤销。
