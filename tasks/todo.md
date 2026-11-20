# 待办清单

更新：2026-11-14｜勾选只代表**已完成并验证**，计划中的项保持未勾选。

## 进行中

- [ ] 干净目录解压后重跑 `npm install` 与启动（当前只在源码目录验证；作为已知风险保留）
- [ ] 0.2.0 交付包重新打包与包内清单核对

## 0.2.0 已完成（有验证）

- [x] R02F 配件多供应商、默认供应商唯一、供应商类型、采购集合校验（`part-suppliers.test.ts`）
- [x] R08F 工艺价部门/任务开关、变更历史、导出/附件权限断言（`permissions.test.ts`）
- [x] R17F 五类附件层级、软删除、7 天清理任务（`attachments.test.ts`）
- [x] R18F 四类 Excel 导入：模板、预检、错误行、整批原子、重复提交 409（`imports.test.ts`）
- [x] R20F 通知业务分类、分类计数（`collab.test.ts`、`jobs.test.ts`）
- [x] R21F 看板负责人/时间筛选、生产看板、库存/发货指标、状态下钻（`collab.test.ts`）
- [x] R22F 异常分类、状态迁移、处理人、预计时间、通知与审计（`collab.test.ts`）
- [x] R23F 审计字段级差异、脱敏、xlsx 导出（`audit.test.ts`）
- [x] R25F 库存幂等、失败注入回滚、同键并发/跨资源冲突（`inventory.test.ts`）
- [x] R26F `/ready`、生产静态托管、0.1.0→0.2.0 回退演练（`ops.test.ts`、`tests/reports/2026-11-14-deploy-rollback.md`）
- [x] 全量回归：12 个测试文件 / 96 个用例通过；`npm run typecheck`、`npm run build` 通过
- [x] 文档同步：feature-status、traceability、CHANGELOG、demo-script、operations、api-contract、data-dictionary、permissions

## 已完成（交付）

- [x] 交付包 `xuzao-factory-v0.1.0-20261104.zip`：已排除 `.env`、`node_modules`、`dist/`、`backups/`、`storage/uploads*`、`.shots/`、`.git/`
- [x] 答辩材料 `docs/demo-script.md`：演示顺序、失败场景、常见问答
- [x] 交付前自检：测试 51/51、类型检查与构建通过、恢复报告、包内排除项、文档链接与状态一致性

## 已完成（有验证）

### 环境与身份

- [x] workspace + 内嵌 PostgreSQL，中文路径可用
- [x] Prisma schema、初始迁移、合成种子
- [x] 登录、登出、会话、`sessionVersion` 撤销
- [x] 五角色守卫；统一信封与错误码
- [x] 测试库隔离（库名含 `test`，global setup 迁移 + 清表）
- [x] 账号管理：创建、改角色、停用、重置密码、撤销会话
- [x] 管理员不能停用/降级自己

### 订单主链

- [x] 订单创建、唯一订单号、列表/详情/检索
- [x] 采购、分批到货、生产下发与反馈、质检录入与决策、包装、发货、完成
- [x] `computeQuantities` / `computeProfit` / `computeAllowedActions`
- [x] 超量/越级/重复动作的稳定拒绝
- [x] 时间线与审计
- [x] 幂等键与事务、重放
- [x] 新建订单本地草稿

### 配套能力

- [x] 客户/供应商/配件/部门/员工维护与停用保护
- [x] 配件/成品库存、流水、原子调整、并发非负
- [x] 成品库存首次建档并发保护（8 并发用例）
- [x] 通知、未读筛选、全部已读、7 天交期提醒与当日去重
- [x] 看板、异常上报、审计检索与分面
- [x] 订单附件上传/下载；订单导出 xlsx
- [x] 健康检查、优雅退出、调度器

### 环境交付

- [x] 逻辑备份 + 附件目录 + SHA-256
- [x] 恢复到新隔离库 + 隔离附件目录，逐表与附件核对
- [x] 恢复护栏：库名/目录/覆盖保护

### 文档

- [x] `docs/README.md`、`architecture.md`、`api-contract.md`、`data-dictionary.md`
- [x] `docs/state-and-quantity.md`、`permissions.md`、`feature-status.md`、`operations.md`
- [x] `docs/traceability.csv`、`docs/decisions/ADR-0001～0003`
- [x] `README.md`、`PRD-xuzao.md`、`AGENTS.md`、`CONSTRAINTS.md`、`CHANGELOG.md`
- [x] `docs/ai-collaboration.md`
- [x] `tasks/plan.md`、`tests/README.md`、`tests/reports/2026-11-04-backend-tests.md`、`tests/reports/2026-11-04-backup-restore.md`

## 已知缺口（不计划在本次补齐）

| 项 | 原因 | 文档位置 |
| --- | --- | --- |
| 多产品并行 | F 未选做 | `docs/feature-status.md` |
| 电镀全链路 | M 明确不支持 | 同上 |
| 返工/报废、部分合格 | F 未选做 | 同上 |
| 10 分钟撤销 | F 未选做 | 同上 |
| Excel 导入 | M 允许不提供 | 同上 |
| 通知业务分类 | F 只做部分 | 同上 |
| 异常处置流程 | F 未选做 | 同上 |
| 审计历史版本对比/导出 | F 只做部分 | 同上 |
| 库存调整幂等 | 已知限制 | `docs/api-contract.md` |
| 离线持久队列 | F 只做部分 | `docs/feature-status.md` |
| 远程部署/HTTPS | 本期本地验收 | `README.md` |

## 交付前检查命令

```bash
npm test
npm run typecheck
npm run build -w frontend
cd backend && npm run backup
# 恢复到新的隔离库与隔离附件目录后核对
```

结果写入 `tests/reports/`，未执行或失败如实记录。