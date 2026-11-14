# 功能状态表（R01–R27）

版本：0.2.0｜更新：2026-11-14
口径：`M` 为最低实现；`F` 为可选加分项。状态只写**当前代码实际做到的事**，未选做直接写“未选做”，不把 M 降级为加分项。

状态含义：
- **已验收**：代码存在，且当前版本有可复现的执行结果（`tests/`、`tests/reports/`）。
- **已实现**：代码存在，但只有手工冒烟或部分验证。
- **部分**：F 的边界内只完成了一部分，未完成部分明确写出。
- **未选做**：明确不在本次范围。

## 1. M 最低实现

| 需求 | 状态 | 实现位置 | 验收 | 限制 |
| --- | --- | --- | --- | --- |
| R01 身份 | 已验收 | `backend/src/auth/`、`frontend/src/pages/LoginPage.tsx` | A01、A02；`tests/auth.test.ts` | 五种角色；受控设备未做 |
| R02 基础数据 | 已验收 | `backend/src/routes/base-data.ts`、`BaseDataPage.tsx` | A03；`tests/basedata.test.ts` | 修改/停用不破坏历史 |
| R03 业务订单 | 已验收 | `backend/src/routes/orders.ts`、`NewOrderPage.tsx` | A04、A05；`tests/flow.test.ts` | 单产品主链；列表支持状态/关键词/客户/负责人过滤 |
| R04 采购 | 已验收 | `flow.ts` `POST /orders/:id/purchase` | A06；`tests/flow.test.ts` | 一单一采购单、单配件、手选供应商 |
| R05 到货 | 已验收 | `flow.ts` `POST /purchases/:id/arrivals` | A07、A08；`tests/flow.test.ts` | 支持多批次到货；必须到齐才能投产 |
| R06 电镀 | 已实现（人工核对） | 采购表单与状态表标注“未启用” | A09 | 不记录镀层、不计镀层成本；不提供入口 |
| R07 生产 | 已验收 | `flow.ts` 生产下发/反馈 | A10、A11；`tests/flow.test.ts` | 单任务、一次反馈、数量受限 |
| R08 单价开关 | 已验收 | `production.unitPriceVisible`、`department.unitPriceVisible`；`PATCH /productions/:id/price-visibility` | A02；`tests/permissions.test.ts` | 任务级 + 部门级；历史来自审计 |
| R09 质检 | 已验收 | `flow.ts` 质检录入/决策 | A12、A13；`tests/flow.test.ts` | 只支持全合格；返工/报废在 UI 与 API 同时拒绝 |
| R10 包装 | 已验收 | `flow.ts` 包装下发/登记 | A14；`tests/flow.test.ts` | 不得超过 `packableRemaining`；支持多次登记 |
| R11 发货 | 已验收 | `flow.ts` 发货触发/登记 | A15、A16；`tests/flow.test.ts` | 足量自动完成；上限取两个剩余量的较小值 |
| R12 撤销修正 | 已实现（人工核对） | 无删除接口；状态守卫明确拒绝 | A17 | 不做 10 分钟撤销；业务记录不可随意删除 |
| R13 配件库存 | 已验收 | `routes/inventory.ts`、`lib/inventory.ts` | A18、A19、A20；`tests/inventory.test.ts` | 手工调整；原子 SQL；非负；流水；幂等 |
| R14 成品库存 | 已验收 | 同上 + `ensureProductInventories` | A18、A19、A20；`tests/inventory.test.ts` | 首次建档并发已测；不做来源余量校验（F） |
| R15 利润 | 已验收 | `domain/flow.ts` `computeProfit` | A22；`tests/domain.test.ts` | Decimal、人民币不含税；预计口径 |
| R16 时间线与状态 | 已验收 | `timeline_events`、`computeAllowedActions` | A23；`tests/domain.test.ts` | 八阶段（电镀不适用）；无撤销/异常标记 |
| R17 附件 | 已验收 | `routes/attachments.ts` | A24；`tests/attachments.test.ts` | 五类层级、白名单、5MB、软删除、清理 |
| R18 导入 | 已验收 | `routes/imports.ts`、`ImportDialog.tsx` | A25；`tests/imports.test.ts` | 四类基础数据；预检 + 整批原子 |
| R19 导出 | 已实现（人工冒烟） | `routes/export.ts` | A26 | 订单列表 xlsx，服务端鉴权，≤10000 行 |
| R20 通知提醒 | 已验收 | `routes/collab.ts`、`jobs/due-reminders.ts` | A27；`tests/collab.test.ts`、`tests/jobs.test.ts` | 关键事件通知管理员；分类、已读/未读 |
| R21 看板 | 已验收 | `routes/collab.ts` `GET /dashboard`、`DashboardPage.tsx` | A28；`tests/collab.test.ts` | 负责人/时间筛选、生产/库存/发货指标；非管理员无金额 |
| R22 异常上报 | 已验收 | `routes/collab.ts` 异常接口、`ExceptionsPage.tsx` | A29；`tests/collab.test.ts` | 上报 + 分类 + 处置闭环 |
| R23 审计 | 已验收 | `lib/audit.ts`、`routes/audit.ts` | A30；`tests/audit.test.ts` | 检索、分面、差异、xlsx 导出；无改删接口 |
| R24 重试与弱网 | 已验收 | `apiPost` 幂等键、`NewOrderPage` 草稿、库存幂等键 | A31；`tests/inventory.test.ts` | 本地草稿恢复；幂等重放；无持久待同步队列 |
| R25 可靠性 | 已验收 | 事务、Zod、幂等绑定、库存原子、唯一约束 | A19、A20、A32；`tests/inventory.test.ts` | 失败注入回滚、同键并发、跨资源冲突 |
| R26 环境交付 | 已验收 | `scripts/db.mjs`、迁移、种子、备份/恢复、`/ready`、生产静态托管 | A33、A34；`tests/ops.test.ts`、`tests/reports/2026-11-14-deploy-rollback.md` | 库 + 附件恢复到新隔离环境；应用回退演练完成 |
| R27 AI 与文档 | 已验收 | `docs/`、根 README、PRD、AGENTS、CONSTRAINTS、`docs/ai-collaboration.md` | A35 | 文档与本轮执行结果同步；未完成项如实标注 |

## 2. F 选做项

只列实际选做或明确评估过的能力；未列出的 F 一律视为未选做。

| 需求 | 状态 | 已实现的部分 | 未实现/边界 |
| --- | --- | --- | --- |
| R01F | 已验收 | 停用账号、改角色、重置密码、撤销全部会话；`sessionVersion` 立即失效；用户管理页可操作 | 受控设备绑定未做（F 原文为可选） |
| R02F | 已验收 | 配件多供应商集合、默认供应商（每配件至多一个）、供应商类型（普通/电镀）、采购只能从集合选、移除/停用边界、审计 | 未做多供应商报价与自动分单 |
| R03F | 部分 | 多明细建单、金额汇总、负责人字段与接口过滤 | 下游按明细流转、外部单号、负责人筛选 UI 未做；**不宣称完整** |
| R04F | 未选做 | 单采购单 | 多采购单、多配件、报价关联、镀层标记未做 |
| R05F | 部分（超出 M） | 多批次到货 | 部分到货投产、超量原因确认未做 |
| R06F | 未选做 | — | 电镀全链路未做 |
| R07F | 未选做 | 单任务、一次反馈 | 多任务、分批反馈、回流、超量授权未做 |
| R08F | 已验收 | 任务级 + 部门级工艺价开关；同部门边界；变更历史（审计）；导出/附件权限断言 | 仅覆盖生产计件单价，不含其他成本科目 |
| R09F | 未选做 | 全合格 | 部分合格、阈值、原因、返工/报废、再检未做 |
| R10F | 部分 | 多次包装登记、剩余量闸门 | 按产品拆分、今日/累计视图未做 |
| R11F | 部分 | 多次发货、足量完成 | 多产品“全部足量”判定未做（单产品口径） |
| R12F | 未选做 | 明确拒绝撤销 | 10 分钟安全撤销、超时留痕修正未做 |
| R13F | 部分 | 非负、原因、流水、并发安全、幂等 | 来源关联、采购辅助搜索、多采购剩余入库未做 |
| R14F | 未选做 | 手工建档/调整 | 超产转库、来源余量、重试不重复转入未做 |
| R15F | 未选做 | 销售−采购−生产 | 镀层成本、全明细聚合、版本快照未做 |
| R16F | 部分 | 八阶段投影、操作者、时间 | 电镀阶段不适用；撤销/异常标记未做 |
| R17F | 已验收 | 五类 ownerType（order/purchase/production/qc/shipment）、类型白名单、5MB、软删除、7 天清理任务、审计 | 电镀不是独立实体；清理会删除元数据行，审计保留 |
| R18F | 已验收 | 客户/供应商/配件/员工模板、预检、行级错误、重复编码策略、整批原子提交、重复提交 409 | 不导入旧库存；单次 ≤500 行 / 2MB |
| R19F | 部分 | 订单列表 xlsx，支持筛选与鉴权 | 其他业务导出、docx/pdf、所选行导出未做 |
| R20F | 已验收 | 业务分类、全部已读、未读筛选、到期前 7 天每日提醒、同日补执行去重 | 没有站外渠道与用户级偏好 |
| R21F | 已验收 | 负责人/时间筛选、生产看板、库存数量、发货完成率、成本/利润指标、状态下钻 | 无工时效率、无多工厂/多仓维度 |
| R22F | 已验收 | 分类、状态迁移、处理人、预计时间、处理说明、上报人/处理人通知、审计 | 无附件关联、无升级/超时自动提醒 |
| R23F | 已验收 | 管理员检索、分面、`before/after` 脱敏、字段级差异、xlsx 导出 | 无跨记录历史版本链对比 |
| R24F | 部分 | 草稿恢复、幂等重试、库存幂等 | 持久待同步队列、自动重试、身份过期暂停未做 |
| R25F | 已验收 | 库存幂等、失败注入回滚、同键并发、跨资源冲突、同键异体 409 | 未做撤销/补偿类扩展场景（R12F 未选做） |
| R26F | 已验收 | `/ready` 三项检查、生产静态托管、错误配置失败、应用回退 + schema 兼容演练 | 未做 TLS/反向代理、容器化发布 |
| R27F | 已验收 | PRD、README、AGENTS、CONSTRAINTS、架构/接口/数据/权限/运维、ADR、追溯表、分层测试、执行报告 | 无 |

## 3. 已知缺口与风险

| 项 | 影响 | 处理 |
| --- | --- | --- |
| 多产品下游未打通 | R03F/R10F/R11F 只能标“部分” | 状态表已写明；不在本轮宣称完整 |
| 电镀全链路未做 | R06F/R15F 无法完整 | 页面明确标注未启用 |
| 通知无站外渠道 | R20F 只在系统内提醒 | 状态表已写明边界 |
| 异常无附件/超时升级 | R22F 只到处置闭环 | 不宣称更多 |
| 库存来源关联未做 | R13F 只到流水与幂等 | 保持“部分” |
| 回退窗口内旧代码不写 `ownerId` | 负责人筛选漏数 | `docs/operations.md` 给出回填 SQL |
| 审计无跨记录版本链 | R23F 只到单条差异 | 文档标注边界 |

## 4. 证据索引

| 证据 | 位置 |
| --- | --- |
| 后端测试（13 文件 / 102 用例） | `tests/reports/2026-11-14-backend-tests.md` |
| 部署、就绪与回退演练 | `tests/reports/2026-11-14-deploy-rollback.md` |
| 历史测试（0.1.0） | `tests/reports/2026-11-04-backend-tests.md` |
| 备份恢复演练 | `tests/reports/2026-11-04-backup-restore.md` |
| 前端类型检查与构建 | `npm run typecheck`、`npm run build`（0.2.0 通过） |
| 截图过程材料 | `.shots/2026-11-14-*.png`（看板、通知、异常、审计、导入、附件、390px 视口；不入交付包） |
| 需求追溯 | `docs/traceability.csv` |