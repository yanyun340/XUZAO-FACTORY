# 数据字典与迁移

版本：0.1.0｜对应：`backend/prisma/schema.prisma` 与迁移 `20261104112845_init`
更新时间：2026-11-04

## 1. 全局约定

| 约定 | 说明 |
| --- | --- |
| 主键 | 全部 `uuid`，`id` 默认 `uuid()` |
| 时间 | `DateTime` 存 UTC；业务日按 `Asia/Shanghai`；交期用 `DATE`，JSON 中为 `YYYY-MM-DD` |
| 金额 | `Decimal(12,2)`，人民币、不含税；计算用 `Prisma.Decimal`，展示两位小数 |
| 数量 | `Int`，业务上必须为正整数（调整量可为负，但结果不能为负） |
| 停用 | 基础数据用 `active` 软停用，不物理删除；历史记录保留快照 |
| 快照 | 订单的客户名称/联系人、采购的供应商名称/配件名称规格在创建时写入，主数据改名不回写 |
| 敏感字段 | `passwordHash`、`tokenHash` 只在服务端使用；金额与客户联系方式按角色脱敏 |

## 2. 身份与组织

### `admin_users` 用户

| 字段 | 类型 / 默认 | 含义 | 约束/索引 |
| --- | --- | --- | --- |
| `id` | uuid | 用户 ID | PK |
| `username` | string | 登录名 | UNIQUE |
| `passwordHash` | string | scrypt 哈希（含 salt 参数） | 敏感，禁止出接口 |
| `displayName` | string | 展示名 | |
| `role` | enum `Role` | ADMIN/LOGISTICS/PRODUCTION/QC/PACKING | |
| `departmentId` | uuid? | 所属部门 | FK `departments` |
| `active` | bool，true | 是否启用 | 停用即拒绝登录 |
| `sessionVersion` | int，0 | 会话版本；改角色/停用/改密时递增 | |
| `createdAt` / `updatedAt` | datetime | 创建/更新时间 | |

### `sessions` 会话

| 字段 | 类型 / 默认 | 含义 | 约束/索引 |
| --- | --- | --- | --- |
| `id` | uuid | 会话 ID | PK |
| `tokenHash` | string | 32 字节 token 的 SHA-256 | UNIQUE |
| `userId` | uuid | 所属用户 | FK，索引 |
| `expiresAt` | datetime | 过期时间（默认 168h） | |
| `revokedAt` | datetime? | 主动撤销时间 | |
| `createdAt` | datetime | 签发时间 | |

### `departments` 部门

| 字段 | 类型 / 默认 | 含义 | 约束 |
| --- | --- | --- | --- |
| `code` | string | 部门编码 | UNIQUE |
| `name` | string | 名称 | |
| `category` | enum `DepartmentCategory` | PRODUCTION/LOGISTICS/QC/PACKING | 生产下发必须为 PRODUCTION |
| `active` | bool，true | 启用状态 | 停用后不能作为新任务目标 |

### `employees` 员工

| 字段 | 类型 / 默认 | 含义 | 约束 |
| --- | --- | --- | --- |
| `code` | string | 工号 | UNIQUE |
| `name` | string | 姓名（合成数据） | |
| `departmentId` | uuid | 所属部门 | FK，索引；生产任务指派时校验一致 |
| `active` | bool，true | 启用状态 | 停用后不能被新指派 |

## 3. 基础数据

### `customers` 客户 / `suppliers` 供应商

| 字段 | 类型 / 默认 | 含义 | 约束 |
| --- | --- | --- | --- |
| `code` | string | 编码 | UNIQUE；留空时系统生成 `CUS-xxxx` / `SUP-xxxx` |
| `name` | string | 名称 | 必填 |
| `contact` | string? | 联系人 | 客户联系人对现场角色隐藏 |
| `phone` | string? | 电话 | |
| `active` | bool，true | 启用状态 | 停用后不能用于新订单/新采购，历史记录不受影响 |

### `parts` 配件

| 字段 | 类型 / 默认 | 含义 | 约束 |
| --- | --- | --- | --- |
| `code` | string | 编码 | UNIQUE |
| `name` | string | 名称 | |
| `spec` | string | 规格 | |
| `active` | bool，true | 启用状态 | 停用后不能新建采购 |

## 4. 订单主链

### `orders` 订单

| 字段 | 类型 / 默认 | 含义 | 约束/索引 |
| --- | --- | --- | --- |
| `orderNo` | string | 系统号 `XZ-YYYYMMDD-0001` | UNIQUE |
| `customerId` | uuid | 客户 | FK |
| `customerName` | string | **创建时快照** | 客户改名不回写 |
| `customerContact` | string? | **创建时快照**（未传则取客户默认联系人） | |
| `dueDate` | date | 交期 | 创建时必须是有效 `YYYY-MM-DD` |
| `remark` | string? | 备注 ≤500 字 | |
| `status` | enum `OrderStatus`，PENDING_PURCHASE | 当前状态 | 索引 `(status, createdAt)` |
| `createdById` | uuid | 创建人 | FK |
| `createdAt` / `updatedAt` | datetime | 时间 | 索引 `(createdAt, id)` |
| `completedAt` | datetime? | 完成时间 | 发货累计足量时写入 |

### `order_items` 订单明细

| 字段 | 类型 | 含义 | 约束 |
| --- | --- | --- | --- |
| `orderId` | uuid | 所属订单 | FK，索引 |
| `productName` / `spec` | string | 产品名称/规格 | 下单时快照 |
| `quantity` | int | 数量 >0 | |
| `unitPrice` | decimal(12,2) | 单价（不含税） | ≥0，最多两位小数 |

M 交付按“单产品”验收，但表结构允许一单多条明细；当前业务动作（采购/生产/包装/发货）取第一条明细执行，多产品并行尚未实现。

### `purchase_orders` / `purchase_items` / `arrival_records`

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `purchase_orders` | `orderId`、`supplierId`、`supplierName`（快照）、`createdById` | M 每单最多一张采购单 |
| `purchase_items` | `purchaseOrderId`、`partId`、`partName`/`partSpec`（快照）、`quantity`、`unitPrice`、`platingRequired`（默认 false） | M 每张采购单一条明细；不启用镀层 |
| `arrival_records` | `purchaseItemId`、`quantity`、`operatorId`、`createdAt` | 累计到货不得超过采购数量；支持多次到货直至到齐 |

### `production_orders` / `production_feedbacks`

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `production_orders` | `orderId`、`orderItemId`、`departmentId`、`employeeId?`、`processName`、`quantity`、`unitPrice`、`dueDate?`、`unitPriceVisible`、`createdById` | 部门必须是 PRODUCTION；员工必须同部门且启用 |
| `production_feedbacks` | `productionOrderId`、`quantity`、`operatorId` | M 每任务一次反馈；数量不得超过任务量 |

### `qc_records` / `qc_decisions`

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `qc_records` | `productionOrderId`、`inspectedQty`、`qualifiedQty`、`unqualifiedQty`、`operatorId` | 合格 + 不合格必须等于检验量；M 不合格必须为 0 |
| `qc_decisions` | `qcRecordId`（UNIQUE）、`decision`、`releasedQty`、`decidedById` | M 只允许 PASS，`releasedQty = qualifiedQty`；一条质检记录只有一条决策 |

### `packing_records` / `shipment_records`

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `packing_records` | `orderId`、`orderItemId`、`quantity`、`operatorId` | 累计包装不得超过放行量 |
| `shipment_records` | `orderId`、`orderItemId`、`quantity`、`operatorId` | 累计发货不得超过 `min(已包装−已发货, 订单量−已发货)` |

## 5. 库存

### `part_inventories` 配件库存

| 字段 | 类型 / 默认 | 说明 |
| --- | --- | --- |
| `partId` | uuid | UNIQUE，一件配件一条台账 |
| `quantity` | int，0 | 不允许为负（原子 SQL 保证） |
| `version` | int，0 | 每次调整 +1，用于观察并发更新 |
| `updatedAt` | datetime | 原子 SQL 写入 UTC 时间 |

### `product_inventories` 成品库存

| 字段 | 类型 / 默认 | 说明 |
| --- | --- | --- |
| `productKey` | string | UNIQUE，`名称小写|规格小写`，同名不同规格不合并 |
| `productName` / `spec` | string | 产品身份 |
| `quantity` | int，0 | 不允许为负 |
| `version` | int，0 | 每次调整 +1 |

订单创建时按产品 upsert 台账（数量 0），保证库存页可检索；库存数量只由管理员手工调整，不随发货自动扣减。

### `inventory_logs` 库存流水

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `kind` | enum PART/PRODUCT | 流水类型 |
| `partId` / `productInventoryId` | uuid? | 二选一 |
| `before` / `delta` / `after` | int | 调整前、调整量、调整后；`delta ≠ 0` |
| `reason` | string | 至少 2 字，≤200 |
| `operatorId` | uuid | 操作者 |

## 6. 配套能力

### `attachments` 附件

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ownerType` / `ownerId` | string / uuid | 当前只有 `order` |
| `fileName` | string | 展示名，去除控制字符，≤200 |
| `storageKey` | string | UNIQUE，服务端 UUID + 白名单扩展名 |
| `mimeType` / `size` | string / int | 白名单类型；≤5MB |
| `uploadedById` | uuid | 上传人 |
| `deletedAt` | datetime? | 软删除预留；当前下载会拒绝已删除 |

### `notifications` 通知

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `eventType` | string | 业务事件类型，如 `ORDER_CREATED`、`DUE_DATE_REMINDER` |
| `title` / `body` | string | 直接展示的中文文案 |
| `recipientId` | uuid | 收件人；业务事件默认发给启用中的管理员 |
| `orderId` | uuid? | 关联订单 |
| `businessDate` | date? | 交期提醒的业务日期 |
| `readAt` | datetime? | 已读时间 |
| `dedupeKey` | string | UNIQUE；交期提醒为 `due:日期:订单:收件人` |

### `audit_logs` 审计

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `requestId` | string | 与响应 `meta.requestId` 对应 |
| `actorId` | uuid? | 登录失败时可能为空 |
| `action` | string | 如 `order.create`、`inventory.part.adjust` |
| `resourceType` / `resourceId` | string / string? | 资源定位 |
| `result` | enum SUCCESS/FAILURE | 结果 |
| `beforeJson` / `afterJson` | json? | 前后变化；不含密码、token |
| `createdAt` | datetime | 索引 |

审计只读：没有修改/删除接口，现场角色访问列表返回 403。

### `tablet_exceptions` 异常

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `orderId` / `productionOrderId` | uuid? | 至少关联一个 |
| `reporterId` | uuid | 上报人（认证身份） |
| `description` | string | 4–500 字 |
| `status` | string，OPEN | 当前只有上报与查询，处置流程为 F 未实现 |

### `timeline_events` 时间线

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `orderId` | uuid | 所属订单，索引 `(orderId, createdAt)` |
| `type` | string | `ORDER_CREATED`、`PURCHASE_CREATED`、`ARRIVAL_RECORDED`… |
| `actorId` | uuid | 操作者 |
| `payload` | json? | 业务快照字段（数量、单号等） |

### `idempotency_requests` 幂等记录

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `actorId` + `operation` + `key` | uuid/string/string | UNIQUE，作用域为“人 + 操作 + 键” |
| `requestHash` | string | 规范化请求体 SHA-256；同键不同体拒绝 |
| `status` | string | IN_PROGRESS / COMPLETED |
| `responseJson` | json? | 首次成功响应，重放原样返回 |
| `resourceId` | string? | 创建出的资源 ID |
| `expiresAt` | datetime | 24 小时 |

### `sequence_counters` 编号计数器

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string PK | 如 `order:20261104`、`customer` |
| `value` | int | 当前值；与业务写入同事务递增 |

## 7. 关系与删除行为

- 订单 → 明细/采购/生产/包装/发货/时间线/通知/异常均为一对多；删除订单会因外键失败而拒绝，系统不提供删除接口。
- 基础数据停用不级联；历史订单、采购引用的是快照字段，因此改名或停用不会破坏历史。
- 会话随用户存在；用户停用不删除，只撤销会话。
- 附件删除为软删除预留；当前没有删除接口。

## 8. 迁移与初始化

| 项 | 说明 |
| --- | --- |
| 迁移文件 | `backend/prisma/migrations/20261104112845_init/migration.sql`，唯一初始迁移 |
| 测试库 | `prisma migrate deploy` 由 `backend/tests/global-setup.ts` 自动执行，然后清空业务表 |
| 演示数据 | `backend/prisma/seed-demo.ts`，按唯一业务键 upsert，可重复执行；生产环境直接拒绝 |
| 编号同步 | `syncCodeSequences` 在夹具/种子写入硬编码编码后抬高计数器，避免自动编号撞唯一键 |
| 备份 | 逻辑 JSON + 同名 `.assets` 附件目录；恢复前校验全局 SHA-256 |
| 恢复限制 | 目标库名必须含 restore/verify/test 且不能等于 `DATABASE_URL`；附件目录同理 |

回退风险：迁移只新增、不改写；若 schema 需要回退，应新写一条前向迁移并先用逻辑备份恢复到隔离库演练，不要直接改已应用迁移。