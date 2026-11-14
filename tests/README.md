# 测试说明

更新：2026-11-04｜实现：`backend/tests/`（Vitest 3.2.7）｜报告：`tests/reports/`

## 1. 怎么跑

```bash
# 根目录
npm test

# backend 目录
npm test
npx vitest run tests/flow.test.ts     # 单个文件
npx vitest                            # watch
```

测试使用 `TEST_DATABASE_URL` 指向的隔离库（默认 `xuzao_test`）。`backend/src/config.ts` 会拒绝：

- 未配置 `TEST_DATABASE_URL`；
- 库名不含 `test`；
- 测试环境指向开发库连接串。

`backend/tests/global-setup.ts` 在每个测试进程开始时执行 `prisma migrate deploy`，并 `TRUNCATE` 全部业务表；`vitest.config.ts` 设置 `fileParallelism: false`，避免多个文件同时清库。

**禁止**把 `TEST_DATABASE_URL` 指向 `xuzao_dev` 或任何真实库。

## 2. 文件与覆盖范围

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `auth.test.ts` | 13 | 未登录 401、错误密码、Cookie、登出、角色边界、账号创建/改角色/重置密码/停用/撤销会话、自我保护、审计 |
| `basedata.test.ts` | 7 | 客户改名不回溯快照、停用供应商/员工后的限制、编码重复 409、空 PATCH、现场角色只读、审计 |
| `flow.test.ts` | 7 | 创建订单、采购幂等重放、完整主链、越级拒绝、时间线与审计、普通角色读审计 403 |
| `inventory.test.ts` | 13 | 入库/扣减/流水、负数拒绝、并发扣减、首次建档并发、幂等重放、同键异体、跨资源冲突、失败回滚 |
| `jobs.test.ts` | 3 | 7 天提醒与当日去重、管理员手动补跑、未读筛选与全部已读、分类计数 |
| `domain.test.ts` | 26 | 数量公式、Decimal 利润、毛利率除零、允许动作的角色/状态/部门闸门、阶段投影 |
| `collab.test.ts` | 9 | 看板脱敏/负责人筛选、通知分类、异常处置闭环 |
| `audit.test.ts` | 4 | 字段级差异、敏感字段脱敏、审计 xlsx 导出、现场角色 403 |
| `permissions.test.ts` | 2 | 任务级/部门级工艺价、跨部门边界、导出与附件鉴权 |
| `attachments.test.ts` | 4 | 多层级附件、软删除、清理、非法 ownerType |
| `ops.test.ts` | 3 | `/health`、`/ready`、未知接口 JSON 404 |
| `imports.test.ts` | 5 | 模板、预检不写库、错误行、整批原子、重复提交 409 |
| `part-suppliers.test.ts` | 6 | 多供应商、默认唯一/并发切换、采购集合校验、停用与移除边界 |

合计：13 个文件、102 个用例。最近一次执行结果见 `reports/2026-11-14-backend-tests.md`。

## 3. 测试辅助

`backend/tests/helpers.ts`：

| 函数 | 作用 |
| --- | --- |
| `createApp()` | 构建 Fastify 实例并 `ready()`，测试直接 `inject`，不监听端口 |
| `api(app, token)` | 封装请求，自动带 Cookie 与 JSON 头 |
| `login(app, username)` | 用种子账号登录，返回 token |
| `resetDb()` | 清空业务表（在隔离库内） |
| `seedBase()` | 创建最小基础数据与角色账号，返回 `Fixtures` |

测试数据是合成数据，不含真实客户或员工信息。

## 4. 手工冒烟脚本

`scripts/smoke-*.mjs` 是开发期脚本，用于快速检查接口是否通：

| 脚本 | 用途 |
| --- | --- |
| `smoke-admin.mjs` | 登录、用户与基础数据 |
| `smoke-flow.mjs` | 订单主链 |
| `smoke-collab.mjs` | 通知、看板、异常 |
| `smoke-audit.mjs` | 审计检索 |

它们**不作为自动化验收证据**，结果不写入测试报告；正式证据以 `backend/tests/` 与 `tests/reports/` 为准。

## 5. 未覆盖或只有人工验证

| 项 | 现状 |
| --- | --- |
| 附件上传/下载 | 人工冒烟；无自动化用例 |
| 订单导出 xlsx | 人工冒烟；无自动化用例 |
| 看板与异常 | 人工冒烟；无自动化用例 |
| 生产单价可见性（R08） | 实现存在，缺自动化断言 |
| 前端交互 | `tsc --noEmit` + Vite 构建；页面行为靠浏览器截图核对 |
| 浏览器兼容 | 仅 Chrome（桌面 + 390px 视口） |
| 性能/压力 | 未做，不宣称指标 |

## 6. 报告约定

- 文件名：`tests/reports/YYYY-MM-DD-<主题>.md`。
- 必须包含：命令、环境、开始时间、耗时、通过/失败数、关键输出、未执行项。
- 只记录**实际执行**的结果；失败保留原始错误，不删用例、不放宽断言。
- 当前报告：
  - [2026-11-14-backend-tests.md](reports/2026-11-14-backend-tests.md)（0.2.0，96 用例）
  - [2026-11-14-deploy-rollback.md](reports/2026-11-14-deploy-rollback.md)（就绪与回退演练）
  - [2026-11-04-backend-tests.md](reports/2026-11-04-backend-tests.md)（0.1.0 历史记录）
  - [2026-11-04-backup-restore.md](reports/2026-11-04-backup-restore.md)

## 7. 前端构建

前端没有单元测试框架，质量门禁为：

```bash
npm run build -w frontend   # tsc --noEmit && vite build
```

构建结果记录在 `2026-11-14-backend-tests.md` 的“复现说明”一节；0.2.0 的 `tsc --noEmit` 与 Vite 构建均通过。