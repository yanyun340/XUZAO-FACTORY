# 序造 XuZao

一单到底的工厂业务协同管理系统：从接单、采购、到货、生产、质检、包装到发货，把一条订单的完整链路放进同一个可追溯的系统里。

版本：`0.2.0`｜更新：2026-11-14｜源码：[github.com/yanyun340/XUZAO-FACTORY](https://github.com/yanyun340/XUZAO-FACTORY)（`main` 分支）
适用：启明之星第三轮考核交付 ｜ 开发者：本人独立完成

## 1. 用途与功能状态

主要使用者是中小工厂的五类角色：管理员、物流、生产、品控、包装。系统解决三件事：

1. **一单到底**：订单状态、数量与责任人在同一页面可见，下一步动作由后端判定。
2. **数量可信**：到货、生产、质检、包装、发货逐环设上限，库存调整原子且不为负。
3. **过程可查**：时间线、通知与审计记录每次关键写操作，金额和客户联系方式按角色脱敏。

当前范围与限制以 [docs/feature-status.md](docs/feature-status.md) 为准：M 必做项逐条列出状态，选做的 F 项写明边界，未做项不隐藏。

0.2.0 已完成的 F：R01F、R02F、R08F、R17F、R18F、R20F、R21F、R22F、R23F、R25F、R26F、R27F。R03F/R05F/R10F/R11F/R13F/R16F/R19F/R24F 只完成一部分，状态表里明确写“部分”，不冒充完整。

## 2. 环境要求

| 项目 | 已验证版本/条件 | 核验方式 |
| --- | --- | --- |
| 操作系统 | Windows 11 Pro 10.0.26200 | 实际开发与验收环境 |
| 浏览器 | Chrome（CDP 截图验证，桌面与 390px 视口） | `.shots/` 过程截图 |
| Node.js | v24.21.0（`engines` 要求 ≥20.19） | `node -v` |
| npm | 11.19.0，workspace 管理 `backend`、`frontend` | `npm -v` |
| 数据库 | 内嵌 PostgreSQL 18.6（`embedded-postgres`），端口 55432 | `npm run db` 日志、`/api/v1/health` |
| 端口 | 55432 / 3001 / 5173 | 启动日志 |
| 外部服务 | 无。不依赖云数据库、对象存储、消息队列或模型 API | 源码依赖 |

锁文件为根目录 `package-lock.json`，安装单元是整个 workspace，不要在子目录单独删锁重装。

## 3. 目录与文档导航

```text
xuzao-factory/
├── backend/          Fastify API、Prisma schema/迁移/种子、测试、备份脚本
├── frontend/         React SPA（Vite）
├── scripts/          内嵌数据库启动/重置、开发期冒烟脚本
├── docs/             架构、接口、数据、状态与数量、权限、功能状态、运维、ADR、追溯
├── tasks/            plan 与 todo
├── tests/            测试说明与执行报告
├── .shots/           视觉检查截图（过程材料，不入交付包）
├── README.md         本文件
├── PRD-xuzao.md      产品需求与范围
├── AGENTS.md         AI/协作者工作约定
├── CONSTRAINTS.md    硬约束与安全边界
└── CHANGELOG.md      版本变更
```

文档入口：[docs/README.md](docs/README.md)。常用直达：

| 想知道 | 看 |
| --- | --- |
| 做什么、边界在哪 | [PRD-xuzao.md](PRD-xuzao.md) |
| 代码怎么分层、请求怎么走 | [docs/architecture.md](docs/architecture.md) |
| 接口参数、错误码、幂等 | [docs/api-contract.md](docs/api-contract.md) |
| 表结构、快照、迁移 | [docs/data-dictionary.md](docs/data-dictionary.md) |
| 状态机、数量公式 | [docs/state-and-quantity.md](docs/state-and-quantity.md) |
| 角色能做什么、字段脱敏 | [docs/permissions.md](docs/permissions.md) |
| 哪些做了、哪些没做 | [docs/feature-status.md](docs/feature-status.md) |
| 启动、备份、排错 | [docs/operations.md](docs/operations.md) |
| 需求→接口→测试追溯 | [docs/traceability.csv](docs/traceability.csv) |

## 4. 配置

配置只从 `backend/.env` 读取；仓库只保留根目录 [.env.example](.env.example) 占位值。

| 配置键 | 用途 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `DATABASE_URL` | 开发库连接串 | 是 | 默认 `xuzao_dev`，本机内嵌实例 |
| `TEST_DATABASE_URL` | 测试库连接串 | 跑测试时必填 | 库名必须含 `test`，否则启动即失败 |
| `NODE_ENV` | 运行模式 | 是 | `development` / `test` / `production` |
| `PORT` | API 端口 | 否，默认 3001 | |
| `APP_ORIGIN` | 允许的前端源 | 是 | 默认 `http://localhost:5173`；multipart 写请求校验 Origin |
| `SESSION_TTL_HOURS` | 会话时长 | 否，默认 168 | |
| `COOKIE_SECURE` | Cookie Secure 标记 | 否 | 本地 HTTP 为 `false` |
| `SEED_DEMO_PASSWORD` | 演示账号统一密码 | 跑 seed 时必填 | 自行设置 ≥8 位，不得使用真实口令 |
| `UPLOAD_DIR` | 附件目录 | 否，默认 `storage/uploads` | 相对 `backend/` |
| `BACKUP_DIR` | 备份输出目录 | 否，默认 `backups` | |
| `XUZAO_PG_PORT` / `XUZAO_PGDATA` | 内嵌数据库端口/数据目录 | 否 | 默认 55432 与 `%USERPROFILE%\.xuzao\pgdata` |

前端不读取任何密钥；开发时 Vite 把 `/api` 代理到 `127.0.0.1:3001`。测试库与开发库物理隔离，`config.ts` 会拒绝把测试指向不含 `test` 的库。

## 5. 从干净环境安装与初始化

```bash
# 1. 确认源码并安装（根目录）
npm install

# 2. 准备配置
cp .env.example backend/.env
#    编辑 backend/.env，至少设置 SEED_DEMO_PASSWORD

# 3. 建表（开发库）
npm run migrate

# 4. 写入合成演示数据（可重复执行）
npm run seed
```

预期：第 3 步输出迁移已应用；第 4 步输出演示账号与基础数据数量。失败时先看数据库是否已启动（第 6 节），再核对 `DATABASE_URL`。

演示账号为 `admin`、`logistics`、`production`、`qc`、`packing`，密码取自 `SEED_DEMO_PASSWORD`。仓库不提供固定有效口令，也不包含任何真实客户或员工资料。

## 6. 启动、访问与停止

一条命令同时启动数据库、API、前端：

```bash
npm run dev
```

它会依次等待 55432 与 3001 就绪，再启动 Vite。也可以分三个终端：

```bash
npm run db                 # 终端 1：内嵌 PostgreSQL
npm run dev -w backend     # 终端 2：API http://127.0.0.1:3001
npm run dev -w frontend    # 终端 3：Web http://localhost:5173
```

- 前端入口：<http://localhost:5173>
- API 前缀：`/api/v1`
- 健康检查：`curl http://127.0.0.1:3001/api/v1/health`，期望 `status: ok`、`database: up`
- 就绪检查：`curl http://127.0.0.1:3001/api/v1/ready`，数据库/迁移/上传目录三项都 ok 才返回 `ready`
- 生产模式：`npm run build` 后设置 `NODE_ENV=production COOKIE_SECURE=true APP_ORIGIN=https://your-host`，执行 `npm run start -w backend`；后端会同时托管 `frontend/dist`
- 停止：在对应终端 `Ctrl+C`。端口被占用时先确认进程归属，不要盲杀 PID。
- 改端口：后端改 `PORT`，前端改 `frontend/vite.config.ts` 的代理目标，并同步 `APP_ORIGIN`。

## 7. 检查与演示

| 检查 | 目录与命令 | 数据与依赖 | 结果位置 |
| --- | --- | --- | --- |
| 类型检查 | 根目录 `npm run typecheck` | 无 | 终端输出 |
| 前端构建 | 根目录 `npm run build -w frontend` | 无 | 终端输出 |
| 后端测试 | 根目录 `npm test` | 隔离库 `xuzao_test`；13 文件 / 102 用例；会先 `migrate deploy` 再清表 | [tests/reports/2026-11-14-backend-tests.md](tests/reports/2026-11-14-backend-tests.md) |
| 备份恢复 | `backend/` 下 `npm run backup` / `npm run restore -- …` | 新隔离库 + 隔离附件目录 | [tests/reports/2026-11-04-backup-restore.md](tests/reports/2026-11-04-backup-restore.md) |
| 浏览器闭环 | 启动后按角色登录操作 | 合成演示数据 | `.shots/`（过程材料） |

建议演示顺序：

1. 管理员创建订单 → 采购下单。
2. 物流登录登记到货（可分批）。
3. 管理员下发生产；生产账号在本部门提交反馈。
4. 管理员下发育检；品控录入全合格；管理员决策 PASS。
5. 管理员下发包装；包装账号登记；管理员触发发货。
6. 物流登记发货，累计足量后订单完成。
7. 验证越权（现场角色访问用户管理/审计 403）、重复提交（同一幂等键重放不重复建单）、库存并发扣减不为负。

## 8. 交付与部署方式

本项目按**本地受控环境验收**交付，没有远程域名、云部署或 HTTPS 结果。

- 构建：`npm run build`（后端 `tsc --noEmit`，前端 Vite 产物在 `frontend/dist/`）。
- 运行：Node 进程 + 本机 PostgreSQL；附件落本地目录，需持久化。
- 配置注入：`backend/.env`，不随包分发。
- 日志：API 标准输出；审计在 `audit_logs`，用 `requestId` 关联。
- 交付包不含 `.env`、`node_modules`、数据库目录、浏览器会话、`storage/uploads*`、`backups/`、`.shots/`。

## 9. 备份、恢复与回退

```bash
cd backend
npm run backup
npm run restore -- backups/<file>.json \
  --target "postgresql://postgres:postgres@127.0.0.1:55432/xuzao_restore_verify_<日期>" \
  --upload-dir "storage/uploads-restore-verify-<日期>"
```

- 备份 = 逻辑 JSON（28 张表 + counts + SHA-256）+ 同名 `.assets` 附件目录。
- 恢复必须指向新隔离库与隔离附件目录；脚本会拒绝覆盖现有库或当前 `UPLOAD_DIR`。
- 应用回退：切回上一份源码重新构建；数据库迁移只追加，旧代码可忽略新结构。
- 数据库回退：不做在线回滚，按“备份 → 隔离库验证 → 人工确认”处理。
- 禁止在真实库执行 `db:reset`、`migrate dev`、`seed`，也不要用备份覆盖现有库。

详细步骤见 [docs/operations.md](docs/operations.md)。

## 10. 常见问题

| 现象 | 如何定位 | 处理 |
| --- | --- | --- |
| `ECONNREFUSED 55432` | 数据库未启动 | `npm run db` 或直接用 `npm run dev` |
| 测试提示 `TEST_DATABASE_URL` 不合法 | 环境变量缺失或指向开发库 | 配好含 `test` 的库名 |
| 登录后刷新变 401 | 访问了非 `APP_ORIGIN` 的地址 | 用 `http://localhost:5173` |
| 写请求 403 | 角色/部门不符 | 对照 [docs/permissions.md](docs/permissions.md) |
| 写请求 400 `VALIDATION_ERROR` | 字段不合法 | 看 `error.details` 的路径与文案 |
| 恢复被拒绝 | 隔离护栏生效 | 换新库名/目录，或确认后加 `--force` |
| 备份提示附件缺失 | 库里有记录但目录无文件 | 先恢复 `UPLOAD_DIR` 再备份 |

## 11. 限制、贡献与许可

- 未完成项与已知缺口：[docs/feature-status.md](docs/feature-status.md) 第 3 节。
- 本项目由本人独立完成；使用开源库（Fastify、Prisma、React、Vite、Zod、exceljs 等），版本见各 `package.json`。
- AI 辅助用于代码与文档起草，所有实现均经本人阅读、运行与测试；协作边界与人工验证见 [docs/ai-collaboration.md](docs/ai-collaboration.md)，安全底线见 [CONSTRAINTS.md](CONSTRAINTS.md)。
- 演示数据全部为合成数据，不含真实客户、员工资料、密码或运行数据库。
- 许可：仅用于本次考核评审，未经本人确认不对外分发。