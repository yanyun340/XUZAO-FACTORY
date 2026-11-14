# 部署、就绪与回退演练报告

日期：2026-11-14
版本：0.2.0
执行人：本人
环境：Windows 11 Pro / Node v24.21.0 / 内嵌 PostgreSQL 18.6（127.0.0.1:55432）

## 1. 演练目标

验证三件事：

1. 生产构建后后端能托管前端产物，健康与就绪探针可区分“活着”和“可接流量”。
2. 0.2.0 新增迁移全部是**增量式**（加列、加表、加索引），不回写旧字段。
3. **应用回退演练**：把 0.1.0 的源码直接跑在已升级到 0.2.0 的数据库上，读写仍正常。

## 2. 就绪探针

`GET /api/v1/ready` 逐项检查并返回组件状态：

| 检查 | 通过条件 |
| --- | --- |
| `database` | `pingDatabase()` 成功 |
| `migrations` | `_prisma_migrations` 无 pending、无 failed |
| `uploads` | `UPLOAD_DIR` 可创建且可写 |

任一失败返回 `503 NOT_READY`，`details.checks` 指明失败项；`/health` 保持轻量存活探针语义。

自动化证据：`backend/tests/ops.test.ts`（3 个用例）。

## 3. 0.2.0 迁移清单（全部增量）

```text
20261114130241_notification_category     加列（带默认）+ 索引
20261114130901_exception_workflow        加可空列 + 默认时间 + 外键 + 索引
20261114131156_department_price_visibility 加列（带默认）
20261114131648_order_owner               加可空列 + 回填 + 索引 + 外键
20261114132657_excel_import              新增枚举 + 新表
```

没有 `DROP`、没有列重命名、没有“无默认值的 NOT NULL 列”。旧代码不读取新列，因此可以直接运行。

## 4. 回退演练步骤与实际结果

1. 固定回退源码：`git worktree`/`git archive` 取提交 `73a3389`（0.1.0 导入提交）的 `backend/`。
2. 数据库保持 0.2.0 结构（开发库 `xuzao_dev`，已应用 6 个迁移）。
3. 用 0.1.0 源码在 `PORT=3002` 启动 API；健康检查返回 200。
4. 使用合成管理员登录并读取：

| 操作 | 结果 |
| --- | --- |
| `GET /api/v1/health` | 200，`database: up` |
| `POST /api/v1/auth/login` | 200，正常下发会话 |
| `GET /api/v1/orders?page=1&pageSize=3` | 200，读取到升级前的 13 张订单 |
| `GET /api/v1/dashboard` | 200，旧版汇总字段正常 |
| `POST /api/v1/orders` | 201，生成 `XZ-20261114-0001` |

结论：**应用层可以回退到 0.1.0，数据库保持 0.2.0 不需要恢复备份。**

## 5. 边界与注意事项

- 旧代码创建的新订单不会写 `ownerId`（0.1.0 无此概念），该列允许为空；新看板的负责人筛选不会包含这类订单。回退窗口内产生的数据在重新升级后需要一次人工回填（`UPDATE orders SET "ownerId" = "createdById" WHERE "ownerId" IS NULL`）。
- 本演练只覆盖“旧代码 + 新结构”。如果未来出现**删除列/改类型**的迁移，就不能用 Git 回退应用，必须恢复备份；这一点已写入 `docs/operations.md`。
- 新表 `import_batches` 与新增枚举对旧代码完全不可见，不影响启动。
- 演练用的临时源码目录已删除；演练管理员账号已停用，会话已清理。

## 6. 生产启动方式（已验证配置项）

```bash
npm run build
NODE_ENV=production COOKIE_SECURE=true APP_ORIGIN=https://your-host npm run start -w backend
```

生产模式下 `backend/src/app.ts` 用 `@fastify/static` 托管 `frontend/dist`，非 `/api/` 的 GET 回落 `index.html`；`/api/` 未命中仍返回 JSON 404。错误配置（缺少 `DATABASE_URL`、非法 `APP_ORIGIN`）会在启动或首个请求时明确失败，不静默带病运行。