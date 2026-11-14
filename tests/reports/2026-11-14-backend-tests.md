# 后端测试执行报告

日期：2026-11-14
执行人：本人
版本：0.2.0（工作区）

## 1. 环境

| 项 | 值 |
| --- | --- |
| 操作系统 | Windows 11 Pro 10.0.26200 |
| Node.js | v24.21.0 |
| 测试框架 | Vitest 3.2.7 |
| 数据库 | 内嵌 PostgreSQL 18.6，127.0.0.1:55432 |
| 测试库 | `xuzao_test`（`TEST_DATABASE_URL` 强制库名含 `test`） |
| 工作目录 | `backend/` |

## 2. 命令

```bash
cd backend
npx vitest run
```

执行前由 `tests/global-setup.ts` 自动执行 `prisma migrate deploy` 并清空业务表；`fileParallelism: false`。

## 3. 结果

```text
 Test Files  13 passed (13)
      Tests  102 passed (102)
   Start at  22:03:57
   Duration  23.26s
```

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `tests/auth.test.ts` | 13 | 登录、会话、角色、撤销 |
| `tests/basedata.test.ts` | 7 | 基础数据与停用保护 |
| `tests/flow.test.ts` | 7 | 订单主链、幂等、越权 |
| `tests/domain.test.ts` | 26 | 数量公式、动作矩阵、阶段 |
| `tests/inventory.test.ts` | 13 | 库存非负、并发、幂等重放、失败回滚 |
| `tests/jobs.test.ts` | 3 | 交期提醒、通知已读、分类汇总 |
| `tests/collab.test.ts` | 9 | 看板脱敏/筛选、通知分类、异常处置 |
| `tests/audit.test.ts` | 4 | 审计差异、脱敏、xlsx 导出 |
| `tests/permissions.test.ts` | 2 | 工艺价可见范围、导出与附件鉴权 |
| `tests/attachments.test.ts` | 4 | 多层级附件、软删除、清理 |
| `tests/ops.test.ts` | 3 | `/health`、`/ready`、404 信封 |
| `tests/imports.test.ts` | 5 | 模板、预检、原子提交、错误行 |
| `tests/part-suppliers.test.ts` | 6 | 多供应商、默认唯一、采购集合校验、停用/移除边界 |
| 合计 | 102 | 全部通过 |

失败：0。跳过：0。

## 4. 本轮新增

| 用例方向 | 文件 | 验证点 |
| --- | --- | --- |
| 看板金额脱敏 | `collab.test.ts` | 非管理员 `profit === null`，不是返回 0 |
| 看板筛选 | `collab.test.ts` | 负责人/日期过滤后 `totalOrders` 与订单列表一致 |
| 通知分类 | `collab.test.ts` | 分类过滤、`byCategory` 计数、未知事件回退 SYSTEM |
| 异常处置 | `collab.test.ts` | 状态迁移守卫、处理人、预计时间、通知、非管理员 403 |
| 审计导出 | `audit.test.ts` | xlsx 可解析、筛选生效、敏感字段 `***` |
| 工艺价范围 | `permissions.test.ts` | 任务级/部门级开关、跨部门不泄露 |
| 附件层级 | `attachments.test.ts` | order/purchase 隔离、软删除、清理文件与元数据 |
| 库存幂等 | `inventory.test.ts` | 同键重放一次、异体 409、跨资源 409、失败零残留 |
| 就绪检查 | `ops.test.ts` | 数据库/迁移/上传目录三项均通过 |
| Excel 导入 | `imports.test.ts` | 预检不写库、错误行行号、整批原子、重复提交 409 |
| 配件多供应商 | `part-suppliers.test.ts` | 默认唯一、并发切换、集合外供应商拒绝、快照不变 |

## 5. 关键断言摘录

- 库存同键重放：`Idempotent-Replayed: true`，数量只变化一次，流水只有一条。
- 业务失败回滚：库存不足时，流水、审计、已完成的幂等记录都不存在。
- 看板脱敏：四个现场角色都收到 `profit: null`。
- 附件清理：超过 7 天的软删除记录，物理文件与元数据都被删除。
- 导入原子性：预检存在错误行时 `IMPORT_HAS_ERRORS`，业务表零新增。

## 6. 复现说明

先启动内嵌数据库 `npm run db`，再在 `backend/` 执行 `npx vitest run`。测试数据全部为合成夹具，不读取开发库。