# 架构说明

版本：0.2.0｜基线：Node 24 + TypeScript（ESM）+ Fastify 5 + Prisma 7 + PostgreSQL 18 + React 19 + Vite 6
更新时间：2026-11-04

## 1. 系统上下文

```text
浏览器（管理员 / 物流 / 生产 / 品控 / 包装）
        │  HTTP + HttpOnly 会话 Cookie
        ▼
前端 SPA（React 19，Vite 开发服 5173）
        │  /api 同源代理（开发）或直连（部署时由反代统一）
        ▼
后端 API（Fastify 5，127.0.0.1:3001）
        │  Prisma 7 + pg 驱动
        ├── PostgreSQL 18（内嵌二进制，127.0.0.1:55432）
        └── 本地附件目录 storage/uploads（服务端生成文件名）
```

没有外部 SaaS、对象存储、消息队列或模型调用。定时提醒由进程内 `setInterval` 触发，不依赖外部调度器。

## 2. 仓库与模块职责

| 路径 | 职责 | 关键入口 |
| --- | --- | --- |
| `backend/src/server.ts` | 读取配置、监听端口、优雅退出、启动提醒任务 | `npm run dev -w backend` |
| `backend/src/app.ts` | 组装 Fastify、Cookie、CSRF/响应头钩子、统一错误处理、注册路由 | `buildApp()`，测试直接注入 |
| `backend/src/config.ts` | 环境变量校验；测试库硬性隔离 | `NODE_ENV=test` 时强制 `TEST_DATABASE_URL` 且库名含 `test` |
| `backend/src/auth/` | scrypt 密码、会话签发/撤销、角色守卫 | `guards.ts`、`session.ts` |
| `backend/src/routes/` | HTTP 适配、Zod 校验、事务编排 | 每个文件对应一个业务面 |
| `backend/src/domain/` | 与 HTTP 无关的订单状态、数量、利润、允许动作计算 | `flow.ts`、`orders.ts` |
| `backend/src/lib/` | 审计与差异、时间线/通知分类、幂等、库存原子更新、编号、xlsx 版式 | `idempotency.ts`、`inventory.ts`、`audit-diff.ts`、`export-workbook.ts`、`notification-categories.ts` |
| `backend/src/jobs/` | 交期提醒、附件清理与调度 | `due-reminders.ts`、`attachment-cleanup.ts`、`scheduler.ts` |
| `backend/src/routes/imports.ts` | Excel 预检 + 整批原子提交 | `POST /imports/:entity/preflight`、`/commit` |
| `backend/prisma/` | schema、迁移、合成演示种子 | `schema.prisma`、`seed-demo.ts` |
| `backend/scripts/` | 逻辑备份/恢复（含附件）、冒烟脚本 | `backup.ts`、`restore.ts` |
| `frontend/src/pages/` | 页面级功能：登录、看板、订单、库存、基础数据、通知、异常、审计、用户 | `App.tsx` 路由表 |
| `frontend/src/components/` | 布局、表格、按钮、弹窗、订单流转面板 | `AppShell.tsx`、`FlowPanel.tsx` |
| `frontend/src/api/` | 统一请求、错误映射、类型定义 | `client.ts`、`types.ts` |
| `scripts/`（根） | 启动内嵌 PostgreSQL、重置本地库 | `db.mjs`、`db-reset.mjs` |

目录没有为了“看起来分层”而拆出 controller/repository：路由文件承担 HTTP 适配与用例编排，跨路由复用的规则沉到 `domain/` 与 `lib/`，规模与职责匹配。

## 3. 一次真实请求路径（以“物流登记到货”为例）

1. 页面：`frontend/src/pages/OrderDetailPage.tsx` 渲染 `FlowPanel`，物流角色看到 `record-arrival` 动作。
2. 客户端：`apiPost(path, body, { 'Idempotency-Key': key })`，同一次业务意图在失败重试时复用同一个键。
3. 路由：`backend/src/routes/flow.ts` 的 `POST /api/v1/purchases/:id/arrivals`。
4. 认证：`authenticate` 读取 `xuzao_session` Cookie → SHA-256 后查 `sessions`，校验未过期、未撤销、用户启用；`requireRoles('LOGISTICS')` 再校验角色。
5. 校验：Zod 校验 UUID 与正整数数量；`runIdempotent` 校验 `Idempotency-Key` 格式与请求体哈希。
6. 业务事务：同一事务内检查采购单状态为 `PURCHASING`、累计到货不超过采购量 → 写 `arrival_records` → 写时间线 + 通知 → 写审计 → 记录幂等结果。
7. 响应：重新读取完整订单聚合，按角色脱敏后返回 `{ data, meta }`；重放时带 `Idempotent-Replayed: true`。
8. 前端：用返回的权威订单详情替换本地状态，不自行推断成功。

## 4. 数据流与一致性

- 所有写操作使用 Prisma 交互式事务；业务记录、时间线、通知、审计、幂等结果同事务提交，失败一起回滚。
- 库存调整使用单条 `UPDATE ... WHERE quantity + delta >= 0 RETURNING`，判断与写入原子完成，不依赖“先查再写”。
- 订单状态与允许动作由后端计算；前端只渲染 `allowedActions`，提交时后端重新校验状态、角色、数量和部门归属。
- 金额用 `Decimal(12,2)` 存储、`Prisma.Decimal` 计算，展示时 `toFixed(2)`；不使用浮点数累计。
- 时间戳存 UTC；业务日/交期按 `Asia/Shanghai` 计算；`DATE` 类型按 `YYYY-MM-DD` 传输，避免时区偏移。

## 5. 身份与会话

- 登录：scrypt 校验密码；用户不存在时也执行一次同强度哈希，降低用户名枚举的时序差异。
- 会话：32 字节随机 token，仅存 SHA-256 哈希；Cookie 名 `xuzao_session`，`HttpOnly`、`SameSite=Lax`、默认 168 小时。
- 撤销：管理员停用、改角色、重置密码会递增 `sessionVersion` 并批量设置 `sessions.revokedAt`；请求时校验版本，旧会话立即失效。
- 错误：无 Cookie 返回 401 `NOT_LOGGED_IN`，会话失效返回 401 `SESSION_EXPIRED`，角色不符返回 403 `FORBIDDEN`。

## 6. 安全基线

| 项 | 实现 |
| --- | --- |
| CSRF | 写请求必须是 `application/json`；multipart 额外要求 `Origin === APP_ORIGIN`；Cookie `SameSite=Lax` |
| 注入 | Prisma 参数化查询；原生 SQL 只用于固定语句 + 绑定参数 |
| 上传 | MIME 白名单、5MB 限制、服务端 UUID 文件名、`flag: 'wx'`、客户端文件名仅作展示 |
| 响应头 | `nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: same-origin`、`Cache-Control: no-store` |
| 错误泄露 | 统一信封；5xx 只回 `服务器内部错误`，详细堆栈只进服务端日志 |
| 附件访问 | 下载必须登录；文件名不进路径拼接 |

## 7. 运行拓扑与配置

| 组件 | 默认地址 | 配置 |
| --- | --- | --- |
| 内嵌 PostgreSQL | `127.0.0.1:55432` | `XUZAO_PG_PORT`、`XUZAO_PGDATA` |
| 后端 | `127.0.0.1:3001` | `HOST`、`PORT`、`DATABASE_URL`、`APP_ORIGIN` |
| 前端开发服 | `localhost:5173` | `vite.config.ts` 代理 `/api` 到 3001 |
| 附件 | `backend/storage/uploads` | `UPLOAD_DIR`（相对后端工作目录） |
| 备份 | `backend/backups` | `BACKUP_DIR` |

密钥只从环境读取；仓库只保留 `.env.example` 占位值。数据库口令仅用于本机内嵌实例，不是生产凭据。

## 8. 取舍与限制

| 决策 | 理由 | 代价/限制 |
| --- | --- | --- |
| 内置 PostgreSQL 二进制而非要求本机安装 | 干净环境可复现，无管理员权限 | 首次复制约 108MB；Windows 中文路径需转到用户目录 |
| 逻辑备份 JSON + 附件目录 | 内嵌发行版没有 `pg_dump` | 大数据量时不如物理备份快；当前规模 602 行 |
| 单机进程内定时任务 | 不引入额外基础设施 | 多实例会重复触发（有业务日期去重兜底） |
| 订单聚合在应用层计算 | 规则可测试、快照字段清晰 | 订单详情查询会带出多条子记录，超大订单需分页/汇总表 |
| 只做全合格质检 | M 范围明确，UI 与 API 同时拒绝返工/报废 | 部分合格、返工、报废属于 F，未实现 |

更细的状态、数量与权限规则见 [state-and-quantity.md](state-and-quantity.md) 与 [permissions.md](permissions.md)。