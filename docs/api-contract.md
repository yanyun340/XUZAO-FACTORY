# API 契约

版本：0.1.0｜Base URL：`/api/v1`
更新时间：2026-11-04
实现：`backend/src/routes/*.ts`；前端封装：`frontend/src/api/client.ts`

## 1. 通用规则

### 1.1 响应信封

成功：

```json
{
  "data": {},
  "meta": { "requestId": "uuid", "page": 1, "pageSize": 20, "total": 42, "totalPages": 3 }
}
```

失败：

```json
{
  "error": { "code": "ORDER_STATUS_CONFLICT", "message": "订单当前状态为 …", "details": { "current": "PENDING_PURCHASE", "expected": "PURCHASING" } },
  "meta": { "requestId": "uuid" }
}
```

`requestId` 同时写入审计，可与 5xx 日志核对。前端只根据 `error.code` 分支，不解析中文文案。

### 1.2 认证与写保护

- 认证：`Cookie: xuzao_session=<token>`，`HttpOnly`、`SameSite=Lax`、默认 168 小时。
- 未登录：401 `NOT_LOGGED_IN`；会话过期/被撤销：401 `SESSION_EXPIRED`。
- 角色不符：403 `FORBIDDEN`。
- 写请求（POST/PUT/PATCH/DELETE）必须是 `application/json`；附件上传用 `multipart/form-data` 且 `Origin` 必须等于 `APP_ORIGIN`。
- 未匹配路由：404 `ROUTE_NOT_FOUND`。

### 1.3 幂等

- 需要幂等的写接口必须带 `Idempotency-Key`（8–128 位字母、数字或 `. _ : -`），否则 400 `VALIDATION_ERROR`。
- 作用域：`(actorId, operation, key)`，有效期 24 小时。
- 同键不同请求体：409 `IDEMPOTENCY_KEY_REUSED`；首次仍在处理：409 `REQUEST_IN_PROGRESS`。
- 已完成的请求重放：返回首次响应，HTTP 200，并带 `Idempotent-Replayed: true`。
- 适用接口：`POST /orders` 与全部订单流转接口（采购、到货、生产下发/反馈、质检下发/录入/决策、包装下发/登记、发货触发/登记）。

### 1.4 分页与时间

- 分页参数：`page` 从 1 开始，`pageSize` 最大 100（基础数据最大 200）。
- 列表默认按 `createdAt desc, id desc` 稳定排序，避免同秒记录翻页重复。
- 时间戳为 ISO 8601 UTC；`dueDate` 为 `YYYY-MM-DD`；业务日按 `Asia/Shanghai`。

### 1.5 错误码目录

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Zod 校验失败，`details` 为 `{path,message}[]` |
| 400 | `CANNOT_DISABLE_SELF` / `CANNOT_CHANGE_OWN_ROLE` | 管理员对自己做危险操作 |
| 400 | `ATTACHMENT_REQUIRED` / `ATTACHMENT_TYPE_NOT_ALLOWED` / `ATTACHMENT_EMPTY` / `ATTACHMENT_TOO_LARGE` | 上传校验 |
| 401 | `AUTH_INVALID_CREDENTIALS` | 用户名/密码错误或账号停用（统一文案） |
| 401 | `NOT_LOGGED_IN` / `SESSION_EXPIRED` | 未登录 / 会话失效 |
| 403 | `FORBIDDEN` | 角色或部门不匹配 |
| 404 | 资源码，如 `ORDER_NOT_FOUND`、`USER_NOT_FOUND` | 资源不存在 |
| 409 | `DUPLICATE_VALUE` | 唯一键冲突（编码、用户名等） |
| 409 | `ORDER_STATUS_CONFLICT` | 当前状态不允许该动作 |
| 409 | `PURCHASE_ALREADY_EXISTS` / `PRODUCTION_ALREADY_DISPATCHED` / `FEEDBACK_ALREADY_RECORDED` / `QC_ALREADY_DISPATCHED` / `QC_ALREADY_RECORDED` / `QC_ALREADY_DECIDED` | 重复动作 |
| 409 | `INSUFFICIENT_STOCK` | 库存扣减会变负 |
| 422 | 业务码，如 `ARRIVAL_EXCEEDS_REMAINING`、`QC_QTY_MISMATCH`、`PACKING_EXCEEDS_REMAINING`、`SHIPMENT_EXCEEDS_LIMIT` | 业务规则拒绝 |
| 422 | `SUPPLIER_NOT_FOUND` / `PART_NOT_FOUND` / `CUSTOMER_NOT_FOUND` / `DEPARTMENT_NOT_FOUND` / `EMPLOYEE_NOT_FOUND` | 引用了不存在或已停用的主数据 |
| 503 | `DATABASE_UNAVAILABLE` | 数据库不可用 |

## 2. 认证与账号

| 方法/路径 | 角色 | 请求 | 成功 | 主要错误 |
| --- | --- | --- | --- | --- |
| `POST /auth/login` | 公开 | `{username, password}` | 200 `{user, expiresAt}` + Set-Cookie | 401 `AUTH_INVALID_CREDENTIALS` |
| `GET /auth/me` | 登录 | — | 200 `{user, expiresAt}` | 401 |
| `POST /auth/logout` | 公开/登录 | — | 200 `{loggedOut:true}`，清 Cookie | — |
| `GET /users` | ADMIN | `page,pageSize,keyword,role,active` | 200 分页用户（含 `activeSessions`） | 403 |
| `POST /users` | ADMIN | `{username,password,displayName,role,departmentId?}` | 201 用户 | 409 `DUPLICATE_VALUE`、404 `DEPARTMENT_NOT_FOUND` |
| `PATCH /users/:id` | ADMIN | `{displayName?,role?,departmentId?,active?}` 至少一项 | 200 用户 + `sessionsRevoked` | 400 自停用/自改角色、404 |
| `POST /users/:id/password` | ADMIN | `{password}` ≥8 位 | 200 `{reset:true,sessionsRevoked:true}` | 404 |
| `POST /users/:id/revoke-sessions` | ADMIN | — | 200 `{revoked: count}` | 404 |

用户 DTO：`{id, username, displayName, role, active, department: {id, code, name, category} | null}`；列表额外含 `activeSessions`、`createdAt`。

## 3. 基础数据

所有列表：登录即可读；`keyword` 模糊匹配名称/编码；`active=true|false` 过滤；`page,pageSize`。所有新增/修改：仅 ADMIN。

| 方法/路径 | 请求体 | 成功 | 说明 |
| --- | --- | --- | --- |
| `GET /customers`、`GET /suppliers` | — | 200 分页 | 含 `active`、`createdAt` |
| `POST /customers`、`POST /suppliers` | `{code?, name, contact?, phone?}` | 201 | 编码留空自动生成 `CUS-xxxx`/`SUP-xxxx` |
| `PATCH /customers/:id`、`PATCH /suppliers/:id` | 至少一个：`{code?,name,contact?,phone?,active?}`（名字/编码规则同上） | 200 | 只改主数据；订单/采购快照不变 |
| `GET /parts` | — | 200 分页 | |
| `POST /parts` | `{code?, name, spec}` | 201 | 同时创建库存台账（数量 0） |
| `PATCH /parts/:id` | `{code?,name,spec?,active?}` | 200 | 规格、名称可改；历史采购快照不变 |
| `GET /departments` | — | 200 全量（不分页） | 含 `active` |
| `POST /departments` | `{code?, name, category}` | 201 | category ∈ PRODUCTION/LOGISTICS/QC/PACKING |
| `PATCH /departments/:id` | `{code?,name?,category?,active?}` | 200 | 已有生产任务时改类别/停用 → 409 `DEPARTMENT_IN_USE` |
| `GET /employees` | `keyword, departmentId?, active?, page,pageSize` | 200 分页 | |
| `POST /employees` | `{code?, name, departmentId}` | 201 | 部门必须存在 |
| `PATCH /employees/:id` | `{code?,name?,departmentId?,active?}` | 200 | 已有生产任务时改部门/停用 → 409 `EMPLOYEE_IN_USE` |

## 4. 订单与流转

### 4.1 订单

| 方法/路径 | 角色 | 请求 | 成功 | 拒绝 |
| --- | --- | --- | --- | --- |
| `GET /orders` | 登录 | `status,keyword,customerId,page,pageSize` | 200 分页订单摘要 | 400 参数不合法 |
| `GET /orders/:id` | 登录 | — | 200 订单详情（含 `flow`、`timeline`、`allowedActions`） | 404 `ORDER_NOT_FOUND` |
| `POST /orders` | ADMIN | `{customerId, customerContact?, dueDate, remark?, items:[{productName,spec,quantity,unitPrice}]}` | 201 订单详情 | 422 客户停用；400 校验 |
| `GET /orders/export.xlsx` | ADMIN | `status,keyword,customerId` | 200 xlsx 附件（≤10000 行） | 403 |

订单详情结构：`summary + createdByName + items + flow + timeline`。`flow` 包含 `quantities`、`purchase`、`production`、`qc`、`packing`、`shipping`、`profit`（非管理员为 null）。`allowedActions` 由后端按角色/状态/数量计算，前端不得自行推断。

### 4.2 流转动作

| 方法/路径 | 角色 | 请求体 | 前置状态 | 成功变化 | 关键拒绝码 |
| --- | --- | --- | --- | --- | --- |
| `POST /orders/:id/purchase` | ADMIN | `{supplierId, partId, quantity, unitPrice}` | PENDING_PURCHASE 且无采购单 | 建采购单，状态→PURCHASING | `PURCHASE_ALREADY_EXISTS`、`SUPPLIER_NOT_FOUND`、`PART_NOT_FOUND`、`ORDER_STATUS_CONFLICT` |
| `POST /purchases/:id/arrivals` | LOGISTICS | `{quantity}` | 订单 PURCHASING | 写到货，累计 ≤ 采购量 | `ARRIVAL_EXCEEDS_REMAINING`、`PURCHASE_NOT_FOUND` |
| `POST /orders/:id/productions` | ADMIN | `{departmentId, employeeId?, processName, quantity, unitPrice, dueDate?, unitPriceVisible?}` | PURCHASING 且采购全部到货、无生产任务 | 建生产任务，状态→IN_PRODUCTION | `ARRIVAL_INCOMPLETE`、`DEPARTMENT_CATEGORY_MISMATCH`、`EMPLOYEE_DEPARTMENT_MISMATCH`、`PRODUCTION_ALREADY_DISPATCHED` |
| `POST /productions/:id/feedback` | PRODUCTION（同部门） | `{quantity}` | IN_PRODUCTION，未反馈 | 写反馈，数量 ≤ 任务量 | 403 非本部门、`FEEDBACK_EXCEEDS_TASK`、`FEEDBACK_ALREADY_RECORDED` |
| `POST /orders/:id/qc-dispatch` | ADMIN | 空对象 | IN_PRODUCTION 且已有反馈 | 状态→PENDING_QC | `NO_PRODUCED_QTY`、`QC_ALREADY_DISPATCHED` |
| `POST /productions/:id/qc-records` | QC | `{inspectedQty, qualifiedQty, unqualifiedQty}` | PENDING_QC，未录入 | 写质检记录 | `QC_QTY_MISMATCH`、`QC_PARTIAL_NOT_SUPPORTED`、`QC_EXCEEDS_PRODUCED` |
| `POST /qc-records/:id/decision` | ADMIN | `{decision:'PASS'}` | PENDING_QC 且已录入、未决策 | 写 PASS 决策，状态→QC_DONE | `QC_DECISION_NOT_SUPPORTED`（REWORK/SCRAP）、`QC_ALREADY_DECIDED` |
| `POST /orders/:id/packing-dispatch` | ADMIN | 空对象 | QC_DONE 且放行量 >0 | 状态→PACKING | `NO_RELEASED_QTY` |
| `POST /orders/:id/packing-records` | PACKING | `{quantity}` | PACKING | 写包装记录，累计 ≤ 放行量 | `PACKING_EXCEEDS_REMAINING` |
| `POST /orders/:id/shipping-trigger` | ADMIN | 空对象 | PACKING 且已包装 >0 | 状态→SHIPPING | `NO_PACKED_QTY` |
| `POST /orders/:id/shipment-records` | LOGISTICS | `{quantity}` | SHIPPING | 写发货记录；累计 ≥ 订单量→COMPLETED | `SHIPMENT_EXCEEDS_LIMIT`（上限 `min(可发货剩余, 应交剩余)`） |

所有流转接口返回最新订单详情；新建类动作初始返回 201，重放返回 200。

## 5. 库存

| 方法/路径 | 角色 | 请求 | 成功 | 说明 |
| --- | --- | --- | --- | --- |
| `GET /inventory/parts` | 登录 | `keyword,page,pageSize` | 200 分页 | 含 `quantity`、`version`、`updatedAt` |
| `GET /inventory/products` | 登录 | 同上 | 200 分页 | 同名同规格唯一 |
| `POST /inventory/parts/:id/adjust` | ADMIN | `{delta, reason}`，delta 非 0、|delta|≤100 万、reason 2–200 字 | 200 `{before,after,version}` | 扣成负数 → 409 `INSUFFICIENT_STOCK` |
| `POST /inventory/products/:id/adjust` | ADMIN | 同上 | 同上 | 同上 |
| `POST /inventory/products` | ADMIN | `{productName,spec,quantity?≥0,reason?}` | 201 台账 | 重复身份 → 409 `PRODUCT_ALREADY_EXISTS` |
| `GET /inventory/logs` | 登录 | `kind=PART|PRODUCT,page,pageSize` | 200 分页流水 | 含调整前后值、原因、操作者 |

库存调整接口当前不使用 `Idempotency-Key`；重复提交会重复调整，前端应在失败提示后让管理员确认再重试（已知限制，见 feature-status）。

## 6. 通知、看板、异常

| 方法/路径 | 角色 | 请求 | 成功 |
| --- | --- | --- | --- |
| `GET /notifications` | 登录 | `unread=true|false,page,pageSize` | 200 分页；`meta.unread` 为未读总数 |
| `GET /notifications/summary` | 登录 | — | 200 `{unread,total}` |
| `POST /notifications/:id/read` | 登录（本人） | — | 200 `{id,readAt}`；重复标记幂等 |
| `POST /notifications/read-all` | 登录 | — | 200 `{updated}` |
| `GET /dashboard` | 登录 | — | 200 `{statusCounts,totalOrders,production,profit,recentOrders}`；金额按角色脱敏 |
| `POST /jobs/due-reminders` | ADMIN | — | 200 `{businessDate,orders,recipients,created}`；同日重复执行为 `created:0` |
| `POST /exceptions` | 登录 | `{orderId?|productionOrderId?, description}`（至少一个关联，4–500 字） | 201 异常 |
| `GET /exceptions` | ADMIN | `page,pageSize` | 200 分页异常 |

## 7. 附件

| 方法/路径 | 角色 | 请求 | 成功 | 拒绝 |
| --- | --- | --- | --- | --- |
| `POST /orders/:id/attachments` | 登录 | multipart，单文件字段 | 201 `{id,fileName,mimeType,size,createdAt,uploadedByName}` | 415/400 类型不允许、空文件、>5MB；403 Origin 不符 |
| `GET /orders/:id/attachments` | 登录 | — | 200 附件列表（软删除除外） | 404 订单不存在 |
| `GET /attachments/:id/download` | 登录 | — | 200 文件流，`Content-Disposition` 保留中文名 | 404 `ATTACHMENT_NOT_FOUND` |

允许的 MIME：PDF、PNG、JPEG、WEBP、TXT、CSV、XLSX、DOCX；上限 5MB。

## 8. 审计

| 方法/路径 | 角色 | 请求 | 成功 |
| --- | --- | --- | --- |
| `GET /audit-logs` | ADMIN | `action,resourceType,resourceId,actorId,keyword,from,to,page,pageSize` | 200 分页；含 `before/after` |
| `GET /audit-logs/facets` | ADMIN | — | 200 `{actions,resourceTypes,actors}` |

现场角色访问返回 403；审计没有修改/删除接口。

## 9. 健康检查

| 方法/路径 | 认证 | 成功 | 失败 |
| --- | --- | --- | --- |
| `GET /health` | 无 | 200 `{status:'ok',database:'up',time,requestId}` | 503 `DATABASE_UNAVAILABLE` |

## 10. 前端调用与测试对应

| 域 | 前端 | 测试 |
| --- | --- | --- |
| 认证/用户 | `LoginPage`、`UsersPage`、`AuthContext` | `backend/tests/auth.test.ts` |
| 订单主链 | `NewOrderPage`、`OrderDetailPage`、`FlowPanel` | `backend/tests/flow.test.ts`、`domain.test.ts` |
| 基础数据 | `BaseDataPage` | `backend/tests/basedata.test.ts` |
| 库存 | `InventoryPage` | `backend/tests/inventory.test.ts` |
| 通知/提醒 | `NotificationsPage`、`AppShell` | `backend/tests/jobs.test.ts` |
| 审计 | `AuditLogPage` | 手工冒烟 + `auth/basedata/flow` 中的审计断言 |