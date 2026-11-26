# 变更记录

遵循 Keep a Changelog 的写法；版本号从 0.1.0 起，日期为本地日期（Asia/Shanghai）。

## [0.4.0] - 2026-11-26

R12F 撤销修正。

### 新增

- **五类记录撤销**：到货、生产反馈、质检、包装、发货可在 10 分钟内由原操作者或管理员撤销；`POST /{arrivals|feedbacks|qc-records|packing-records|shipment-records}/:id/undo`。
- **超时留痕修正**：管理员超过窗口后走 `/correct`，必须填 2–200 字原因；事件与审计动作与普通撤销分开（`*_CORRECTED` / `*.correct`）。
- **软作废**：五类记录与 `qc_decisions` 增加 `voidedAt`/`voidedById`/`voidReason`；作废行保留在订单详情并标记原因与作废人，但不参与任何数量、利润与看板计算。
- **质检级联**：撤销质检记录时同一事务作废其决策；作废决策视同未决策。
- **状态修复**：只允许三条反向边——`COMPLETED→SHIPPING`（清 `completedAt`）、`QC_DONE→PENDING_QC`、`PENDING_QC→IN_PRODUCTION`；`PACKING`/`SHIPPING` 不因数量归零回退。
- **下游依赖守卫**：有生产/电镀依赖的到货、有质检的反馈、已下发包装或已包装的质检、已触发发货或已发货的包装，均拒绝并提示按依赖逆序撤销；异常凭证引用同样拒绝。
- **界面**：订单详情新增「录入记录」台账，按发生顺序列出五类记录，窗口内显示倒计时与「撤销」，管理员超时显示「修正」（弹窗填原因），作废行灰显并展示原因；390px 下自动改为三行堆叠。
- **事件与审计**：`ARRIVAL_UNDONE/CORRECTED`、`PRODUCTION_FEEDBACK_UNDONE/CORRECTED`、`QC_RECORD_UNDONE/CORRECTED`、`PACKING_UNDONE/CORRECTED`、`SHIPMENT_UNDONE/CORRECTED`；审计资源新增 `production_feedback` 反查订单。

### 数据库迁移

```text
20261125160849_record_void
  arrival_records / production_feedbacks / qc_records / packing_records / shipment_records
    voidedAt, voidedById (FK admin_users, ON DELETE SET NULL), voidReason
  qc_decisions
    voidedAt, voidReason
  六表各一条 voidedAt 索引
```

### 测试

- 新增 `tests/undo.test.ts` 19 条：五类撤销、窗口 9:59/10:01、他人 403、管理员修正、重复撤销 409、同键重放、下游依赖（生产/电镀/质检/包装/发货）、死锁回归（已下发包装/已触发发货）、撤销后可重做、看板与利润同步下降。
- `domain.test.ts` 新增 R12F 组 16 条：作废记录不计数量/利润、作废决策视同未决策、允许动作重新出现、`deriveRepairedStatus` 三条反向边与级联。
- 全量 16 文件 / 166 用例通过；`npm run typecheck -w backend`、`npm run build -w frontend` 通过。
- 浏览器实测：窗口内撤销、超时修正、作废行展示、390px 布局。

### 限制

- 不支持订单级取消/退回；撤销是记录级回退。
- 不支持多产品并行撤销（与主链单产品口径一致）。
- DTO 的 `canUndo` 只表达身份 + 窗口资格，下游依赖仍由服务端守卫兜底。

---

## [0.3.2] - 2026-11-25

质检返工复检与异常下发复核。

### 新增

- **R09F 质检**：首检可分多批；`PASS/REWORK/SCRAP` 三态决策；返工量必须复检，`round` 与 `parentQcRecordId` 保留轮次链；原不合格记录不覆盖；报废量单独计数。订单只有全部检验量都有归宿（放行 + 报废 ≥ 生产量）才转 `QC_DONE`。
- **R22F 异常复核**：质量异常可由管理员「下发品控复核」，异常转 `WAITING_QC` 并进入正式质检链；品控录入后异常单自动引用最新一轮质检记录（返工后改挂复检记录）；`RESOLVED` 前必须有 PASS 凭证，确不涉及质检时需 `waiveQc` 留痕豁免。
- **界面**：异常页增加复核按钮、凭证行、留痕豁免勾选与状态提示；订单详情支持分批检验录入、三轮决策按钮、复检模式与台账轮次展示。
- **事件**：`QC_REWORKED`、`QC_SCRAPPED`、`EXCEPTION_REVIEWED`；异常复核写入审计 `exception.review`。

### 数据库迁移

```text
20261125140000_qc_reinspection
  qc_records.round, qc_records.parentQcRecordId
  qc_decisions.scrapQty
  tablet_exceptions.qcRecordId (UNIQUE), tablet_exceptions.qcWaived
```

### 测试

- `flow.test.ts` 新增 3 条：分批首检、返工复检、报废结算；改写 2 条 M 口径用例。
- `collab.test.ts` 新增 4 条：复核全链路、无返工量拒绝、未关联生产任务、权限与幂等、返工后凭证改挂；改写异常处置主流程。
- 全量 15 文件 / 131 用例通过；`npm run typecheck`、`npm run build` 通过。
- 真实页面截图验证：异常页、首检录入、返工决策、复检表单、最终放行均按预期渲染。

---

## [0.3.1] - 2026-11-25

审计日志可定位订单。

### 新增

- 审计列表与导出增加 `orderId/orderNo`：按 `resourceType + resourceId` 读取时反查所属订单，覆盖采购、到货、生产、质检、质检决策、包装、发货、电镀、异常、附件。
- 审计页新增“订单”列，订单号可点击跳转订单详情；无订单上下文显示 `—`。
- 审计 xlsx 增加“订单号”列。
- 不新增数据库字段，历史记录同样生效。

### 测试

- `audit.test.ts` 增加 2 条：到货审计反查订单、无订单上下文返回 null；全量 15 文件 / 124 用例通过。

---

## [0.3.0] - 2026-11-23

R06F 电镀外协全链路。采购项可标记需要电镀；管理员建电镀单，物流发送/收货；未收货不能下发生产；电镀费按已收数量计入利润。

### 新增

- **电镀单（R06F）**：关联采购项、电镀厂商（`SupplierType.ELECTROPLATING`）、整件计价、PENDING→SENT→RECEIVED、发送前可改数量/单价、发送后改删 409、发送/收货幂等。
- **生产闸门**：需电镀物料未收货 → `PLATING_NOT_RECEIVED`；任务数量超过已收电镀量 → `PLATING_QTY_INSUFFICIENT`。
- **利润**：`platingCost = Σ RECEIVED 电镀单数量 × 单价`；订单详情与看板同步，非管理员仍不可见。
- **界面**：采购表单增加“需要电镀”；订单详情新增电镀外协卡片；流转台账与看板增加电镀成本；不需电镀显示“不适用”。
- **事件与通知**：`PLATING_CREATED / PLATING_SENT / PLATING_RECEIVED`。

### 数据库迁移

```text
20261123052931_plating_orders   plating_orders 表 + PlatingStatus
```

### 测试

- 新增 `backend/tests/plating.test.ts`（8 个用例）；全量 15 个文件 / 123 个用例通过。

### 边界

- 只统计 RECEIVED 电镀单成本；部分电镀受 M 单生产任务限制，剩余部分需 R07F 多任务。
- 不新增九阶段投影，R16F 仍为“部分”；R15F 仅补齐电镀成本，快照/版本仍缺。

---

## [0.2.1] - 2026-11-22

R01F 补齐受控设备。定位是**弱设备绑定**：能挡住“换台设备直接输密码”，挡不住手工复制或清浏览器数据；文档与答辩按此口径说明，不宣称硬件级防伪造。

### 新增

- **受控设备（R01F）**：按账号开启 `deviceBindingMode`；未登记设备登录返回 403 并生成 PENDING 记录；管理员批准/吊销/删除；吊销即撤销该设备会话；删最后一台 ACTIVE 设备自动降回 OFF；禁止管理员对自己开启。
- **登录设备标识**：客户端生成 `X-Device-Id`（localStorage），登录时校验；登录页显示 8 位设备码，便于现场报给管理员。
- **设备审计与通知**：登录成功/失败记录设备码；未授权尝试通知管理员，同设备同账号每日去重。

### 数据库迁移

```text
20261122094051_controlled_devices   devices 表、AdminUser.deviceBindingMode、Session.deviceId
```

### 测试

- 新增 `backend/tests/devices.test.ts`（10 个用例）；全量 14 个文件 / 112 个用例通过。

---

## [0.2.0] - 2026-11-14

第三轮 F 扩展版本。新增完整 F：R02F、R08F、R17F、R18F、R20F、R21F、R22F、R23F、R25F、R26F、R27F；R01F 保持已验收。R03F/R05F/R10F/R11F/R13F/R16F/R19F/R24F 明确标注为“部分”，不宣称完整。

### 新增

- **配件多供应商（R02F）**：`PartSupplier` 多对多、每配件至多一个默认供应商（数据库部分唯一索引兜底）、供应商类型（普通/电镀）、采购只能从配件供应商集合中选择、移除/停用边界与审计。
- **看板（R21F）**：负责人/时间筛选、生产看板、库存数量、发货完成率、成本/利润指标、状态下钻；非管理员服务端返回 `profit: null`。
- **异常处置（R22F）**：分类、状态迁移（OPEN→IN_PROGRESS→RESOLVED→CLOSED）、处理人、预计时间、处理说明、通知与审计。
- **附件（R17F）**：订单/采购/生产/质检/发货五类 ownerType、类型白名单、5MB、软删除、7 天清理任务。
- **Excel 导入（R18F）**：客户/供应商/配件/员工模板、预检（只校验不写库）、行级错误、重复编码策略、整批原子提交、重复提交 409。
- **通知分类（R20F）**：`NotificationCategory`、分类筛选、分类计数；交期提醒归入 `DUE_DATE`。
- **审计增强（R23F）**：字段级差异、敏感字段 `***`、审计 xlsx 导出。
- **工艺价范围（R08F）**：部门级开关 + 任务级开关、同部门边界、变更历史、导出/附件权限断言。
- **库存幂等（R25F）**：调整与建档接入 `runIdempotent`，请求哈希包含资源 ID；失败注入回滚、同键并发、跨资源冲突测试。
- **就绪与部署（R26F）**：`/api/v1/ready` 检查数据库/迁移/上传目录；生产模式托管 `frontend/dist`；完成 0.1.0 代码 + 0.2.0 schema 的回退演练。
- **测试**：12 个测试文件、96 个用例全部通过。

### 修复

- 看板利润泄露：此前所有登录角色都能拿到 `profit`，前端只是隐藏；现在非管理员收到 `null`。
- 订单列表/详情补 `ownerId`/`ownerName`，历史订单回填为创建人。

### 数据库迁移

```text
20261114130241_notification_category
20261114130901_exception_workflow
20261114131156_department_price_visibility
20261114131648_order_owner
20261114132657_excel_import
20261114135524_part_suppliers
```

全部为增量迁移，不删除、不改类型；0.1.0 应用可在新结构上运行（见 `tests/reports/2026-11-14-deploy-rollback.md`）。

### 已知限制

- 多产品下游未打通，R03F/R10F/R11F 只标“部分”。
- 电镀全链路未做，R06F/R15F 未选做。
- 附件清理会在 7 天后删除元数据行，审计保留操作记录。
- 回退窗口内旧代码不写 `ownerId`，重新升级后需执行一次回填 SQL。

---

## [0.1.0] - 2026-11-04

第三轮考核交付版本。M 闭环完成，选做 R01F / R20F / R23F。

### 新增

- **认证与账号**：scrypt 登录、HttpOnly 会话、角色守卫；停用、改角色、重置密码、撤销全部会话；用户管理页。
- **订单主链**：创建订单、采购、分批到货、生产下发与反馈、质检录入与 PASS 决策、包装下发与登记、发货触发与登记、足量完成。
- **基础数据**：客户、供应商、配件、部门、员工的查询、新增、修改、停用；编码自动生成与唯一校验。
- **库存**：配件与成品台账、手工调整、流水、同规格唯一；原子条件更新保证非负。
- **通知与提醒**：关键事件通知管理员、未读筛选、全部已读；到期前 7 天每日提醒，同日去重。
- **看板**：状态数量、生产进度、利润汇总，按角色脱敏。
- **异常与审计**：现场异常上报、管理员查询；审计检索与分面（动作/资源/操作者/关键词/时间）。
- **附件**：订单附件上传、列表、下载；MIME 白名单、5MB 限制、服务端文件名。
- **导出**：订单列表 xlsx，服务端鉴权，≤10000 行。
- **可靠性**：幂等键与业务写入同事务；请求哈希绑定；重放返回首次响应；新建订单本地草稿。
- **环境与运维**：内嵌 PostgreSQL、迁移、合成种子、健康检查、优雅退出、每小时提醒调度。
- **备份恢复**：逻辑 JSON + `.assets` 附件目录 + SHA-256；隔离库与隔离附件目录护栏；逐表行数核对。

### 修复

- 窄屏（390px）下单页与详情页横向溢出：CSS Grid `1fr` 按 min-content 撑破视口，改为 `minmax(0, 1fr)` 并在 `.rail`、`.main`、`.panel` 等容器加 `min-width: 0`。
- 基础数据编辑弹窗缺少 Esc 关闭与背景滚动锁；补充键盘关闭与 `body` 滚动锁定。
- 备份未覆盖附件文件，R26 演练会“表对了但文件丢了”；备份/恢复增加附件复制、大小与 SHA-256 校验。
- 成品库存并发首次建档会落到通用 `DUPLICATE_VALUE`；统一翻译为 `PRODUCT_ALREADY_EXISTS`，并补 8 并发用例。
- 采购表单未说明电镀不适用；补充“F 未启用”提示。

### 验证

- 后端：6 个测试文件、51 个用例全部通过（Vitest，隔离库 `xuzao_test`）。
- 前端：`tsc --noEmit` 与 Vite 构建通过。
- 备份恢复：602 行、28 张表、2 个附件，恢复到 `xuzao_restore_verify_20261104b` 与隔离附件目录，核对一致。
- 视觉：桌面与 390px 视口截图核查基础数据编辑弹窗、订单详情与移动端布局。

### 已知限制

- 单产品主链；多产品并行、电镀、返工/报废、10 分钟撤销、Excel 导入未实现。
- 通知只有未读筛选，没有业务分类。
- 异常只有上报与查询，没有处置流程。
- 库存调整未接幂等键，重复提交会重复调整。
- 审计没有历史版本对比与导出。
- 仅 Windows + Chrome 验证；没有远程部署与 HTTPS 结果。

详细状态与证据见 [docs/feature-status.md](docs/feature-status.md)、[tests/README.md](tests/README.md)。