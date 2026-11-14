# 运行与运维手册

版本：0.2.0｜更新：2026-11-14
适用：本地开发、验收演示、干净环境启动、备份恢复与回退演练

## 1. 前置条件

| 项 | 要求 |
| --- | --- |
| Node.js | ≥ 20.19（开发与验收使用 24.x） |
| npm | 随 Node 安装，使用 workspace |
| PostgreSQL | 无需单独安装：项目自带 `embedded-postgres` 18.6 二进制 |
| 端口 | 55432（数据库）、3001（API）、5173（前端） |
| 磁盘 | 首次运行复制数据库二进制约 108MB 到 `%USERPROFILE%\.xuzao\pgsql` |
| 系统 | Windows 10/11 已验证；路径含中文可用（二进制与数据目录转到 ASCII 用户目录） |

## 2. 首次启动

```bash
npm install                     # 根目录一次装好 backend 与 frontend
cp .env.example backend/.env
# 编辑 backend/.env，至少设置 SEED_DEMO_PASSWORD（≥8 位，非真实口令）
npm run migrate                 # 创建/更新开发库结构
npm run seed                    # 写入合成演示数据（可重复执行）
npm run dev                     # 同时启动数据库、API、前端
```

访问 <http://localhost:5173>。`npm run dev` 会依次等待数据库端口、API 端口就绪再启动下一项，因此首次启动比单独执行慢。

也可以分三个终端：

```bash
npm run db                      # 内嵌 PostgreSQL
npm run dev -w backend          # API :3001
npm run dev -w frontend         # Vite :5173
```

### 2.1 演示账号

种子创建 5 个账号，密码统一取自 `SEED_DEMO_PASSWORD`：

| 用户名 | 角色 | 部门 |
| --- | --- | --- |
| `admin` | ADMIN | — |
| `logistics` | LOGISTICS | 物流部 |
| `production` | PRODUCTION | 生产部 |
| `qc` | QC | 品控部 |
| `packing` | PACKING | 包装部 |

密码不写入仓库、文档或截图。

## 3. 健康检查与就绪

```bash
curl -s http://127.0.0.1:3001/api/v1/health
# 存活探针：{"data":{"status":"ok","database":"up",...},"meta":{...}}

curl -s http://127.0.0.1:3001/api/v1/ready
# 就绪探针：数据库 / 迁移 / 上传目录三项都 ok 才返回 200
```

- `/health` 只证明进程活着、数据库能 ping 通；数据库不可用时返回 503 `DATABASE_UNAVAILABLE`，进程不退出。
- `/ready` 额外检查 `_prisma_migrations` 无 pending/failed、`UPLOAD_DIR` 可写；失败返回 503 `NOT_READY`，`details.checks` 指出具体组件。
- 负载均衡/反向代理应使用 `/ready` 决定是否摘流，使用 `/health` 决定是否重启。
- `requestId` 可用于在服务端日志与审计中定位同一次请求。

### 3.1 生产模式启动

```bash
npm run build
NODE_ENV=production \
COOKIE_SECURE=true \
APP_ORIGIN=https://your-host \
npm run start -w backend
```

生产模式下 API 同时托管 `frontend/dist`：非 `/api/` 的 GET 请求回落 `index.html`（SPA 路由），`/api/` 未命中仍返回 JSON 404。缺少 `DATABASE_URL`、非法 `APP_ORIGIN` 等配置会在启动或首个请求明确失败，不会静默带病运行。

## 4. 数据库操作

| 命令 | 作用 | 注意 |
| --- | --- | --- |
| `npm run migrate` | `prisma migrate dev`，开发库建表/生成客户端 | 会写开发库；不要在真实库执行 |
| `npm run migrate -w backend -- --name xxx` | 新增迁移 | 迁移只追加，不改已应用文件 |
| `npm run migrate:deploy -w backend` | 仅应用已有迁移 | 测试/隔离环境用 |
| `npm run seed` | 写入合成演示数据 | 生产环境直接拒绝；按唯一键 upsert |
| `npm run db:reset` | 删除内嵌数据目录并重新初始化 | **危险**：需先停库并设置 `XUZAO_DB_RESET=1` |

`npm run db:reset` 只删除 `%USERPROFILE%\.xuzao\pgdata`，并拒绝其他路径。重置后需重新 `npm run migrate && npm run seed`。

## 5. 测试

```bash
npm test             # backend Vitest，13 个文件 / 102 个用例
```

- 测试库来自 `TEST_DATABASE_URL`，`config.ts` 强制库名包含 `test`；未配置、指向开发库或库名不含 `test` 都会直接失败。
- `backend/tests/global-setup.ts` 先 `prisma migrate deploy`，再 `TRUNCATE` 业务表。
- `fileParallelism: false`，避免多个文件同时清库。
- 前端：`npm run build -w frontend` 会执行 `tsc --noEmit` 与 Vite 构建。

最近一次执行结果见 `tests/reports/2026-11-14-backend-tests.md`。

## 6. 备份

```bash
cd backend
npm run backup
# 或指定目录
BACKUP_DIR=D:/xuzao-backups npm run backup
```

产物：

```text
backups/xuzao-backup-2026-11-04T14-00-47.json      # 28 张表的逻辑数据 + counts + checksum
backups/xuzao-backup-2026-11-04T14-00-47.json.assets/  # 附件文件
```

规则：

- 每个表逐行导出，`checksum` 覆盖 `{database, counts, tables, assets}`，不含导出时间，因此同一数据多次导出校验和一致。
- 附件缺失时**拒绝**生成备份，避免得到“看起来成功但不完整”的包。
- 备份文件包含业务数据，需按敏感数据处理，不能提交到仓库。

## 7. 恢复到隔离环境

```bash
cd backend
npm run restore -- backups/xuzao-backup-2026-11-04T14-00-47.json \
  --target "postgresql://postgres:postgres@127.0.0.1:55432/xuzao_restore_verify_20261104" \
  --upload-dir "storage/uploads-restore-verify-20261104"
```

脚本会：

1. 校验备份格式与全局 SHA-256。
2. 目标库不存在则创建；存在且有订单数据时默认拒绝，只有显式 `--force` 才清空。
3. 执行 `prisma migrate deploy`。
4. 按外键顺序写入 28 张表，逐表核对行数。
5. 把附件写入隔离目录，逐个校验大小与 SHA-256；目标已有同名不同内容文件时失败。

安全护栏：

| 护栏 | 行为 |
| --- | --- |
| 目标库名不含 `restore/verify/test` | 拒绝执行 |
| 目标库 = `DATABASE_URL` 指向的库 | 拒绝执行 |
| 附件目录 = 当前 `UPLOAD_DIR` | 拒绝执行 |
| 附件目录不含 `restore/verify/test` | 拒绝执行 |
| 目标库已有数据且未加 `--force` | 拒绝覆盖 |

演练记录：`tests/reports/2026-11-04-backup-restore.md`（602 行、28 张表、2 个附件，全部一致）。

## 8. 定时任务

- `jobs/scheduler.ts` 在 API 启动时注册：启动补跑一次，此后每小时执行。
- 交期提醒（R20F）：到期前 7 天内、未完成订单，给启用中的管理员各发一条；`dedupeKey = due:业务日:订单:管理员` 保证同日不重复。
- 手动触发（ADMIN）：`POST /api/v1/jobs/due-reminders`，返回 `{businessDate, orders, recipients, created}`；同日重复执行 `created: 0`。
- 定时器 `unref()`，不会阻止进程退出；优雅退出时清理。

## 9. 常见故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 启动报 `ECONNREFUSED 55432` | 数据库未启动 | 先 `npm run db`，或直接用 `npm run dev` |
| `DATABASE_UNAVAILABLE` | 库进程掉线/端口被占 | 查 `%USERPROFILE%\.xuzao\pg.log`；确认 55432 未被其他实例占用 |
| 测试报“TEST_DATABASE_URL 必须指向 test 库” | 环境变量缺失或指向开发库 | 在 `backend/.env` 配好 `TEST_DATABASE_URL` |
| 登录成功但刷新后 401 | Cookie 被代理改写 / 跨端口访问 | 用 `localhost:5173` 访问，确认 `/api` 代理到 3001 |
| 写请求 403 `FORBIDDEN` | 角色无权限 | 对照 `docs/permissions.md`；不要绕过服务端守卫 |
| 生产环境 seed 报错 | 种子拒绝写入生产 | 正常行为；生产数据应由业务流程产生 |
| 备份报“附件文件缺失” | 数据库有附件记录但 `UPLOAD_DIR` 下无文件 | 先恢复附件目录，再重新备份 |
| 恢复报“目标库已有 N 条订单数据” | 护栏生效 | 换新库名，或确认是隔离库后加 `--force` |
| Windows 中文路径下 initdb 失败 | 旧版本路径问题 | 确认使用项目自带 `scripts/db.mjs`（会转到用户目录） |

## 10. 回退

- **应用回退**：本项目未发布版本化制品；回退即切回上一提交并重新构建。0.2.0 的迁移全部是增量式（加列/加表/加索引），已实际演练 0.1.0 源码运行在 0.2.0 结构上：登录、订单读取、看板、建单均正常。详见 `tests/reports/2026-11-14-deploy-rollback.md`。
- **回退窗口的数据边界**：0.1.0 代码创建的新订单不会写 `ownerId`。重新升级到 0.2.0 后执行一次：

  ```sql
  UPDATE orders SET "ownerId" = "createdById" WHERE "ownerId" IS NULL;
  ```

- **数据回退**：不提供“在线回滚”。需要恢复时，按第 6、7 节备份 → 隔离库验证 → 人工确认后再切换连接串。
- **不可回退的变更**：一旦出现删除列、修改列类型或不可逆数据转换，就不能只靠 Git 回退应用，必须恢复备份。迁移文件只追加，不改已应用文件。
- **禁止**：直接修改已应用的迁移文件；在真实库执行 `db:reset`、`migrate dev` 或 `seed`；用备份覆盖现有库。

## 11. 目录与产物

| 路径 | 是否入交付包 | 说明 |
| --- | --- | --- |
| `backend/.env` | 否 | 含本机配置，只提交 `.env.example` |
| `backend/node_modules`、`frontend/node_modules` | 否 | `npm install` 重建 |
| `%USERPROFILE%\.xuzao\pgdata` | 否 | 运行数据库 |
| `backend/storage/uploads*` | 否 | 运行附件；备份中另有 `.assets` |
| `backend/backups/` | 否 | 运行备份，按需单独保存 |
| `.shots/` | 否 | 视觉检查过程截图 |
| `docs/`、`tests/`、源码 | 是 | 交付主体 |