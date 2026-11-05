# 后端测试执行报告

日期：2026-11-04
执行人：本人
版本：0.1.0（工作区）

## 1. 环境

| 项 | 值 |
| --- | --- |
| 操作系统 | Windows 11 Pro 10.0.26200 |
| Node.js | v24.21.0 |
| npm | 11.19.0 |
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
 Test Files  6 passed (6)
      Tests  51 passed (51)
   Start at  22:11:12
   Duration  15.12s (transform 391ms, setup 0ms, collect 4.25s, tests 7.18s, environment 1ms, prepare 478ms)
```

| 文件 | 用例数 | 结果 |
| --- | --- | --- |
| `tests/auth.test.ts` | 13 | 通过 |
| `tests/basedata.test.ts` | 7 | 通过 |
| `tests/flow.test.ts` | 7 | 通过 |
| `tests/inventory.test.ts` | 8 | 通过 |
| `tests/jobs.test.ts` | 3 | 通过 |
| `tests/domain.test.ts` | 13 | 通过 |
| 合计 | 51 | 全部通过 |

失败：0。跳过：0。

## 4. 本轮新增/变更的用例

| 用例 | 文件 | 目的 |
| --- | --- | --- |
| 并发首次建档只落一条记录，其余返回同一种冲突 | `inventory.test.ts` | 覆盖 R14/R25 的“首次创建竞争”：8 个并发请求，1 个 201，其余 7 个 409 `PRODUCT_ALREADY_EXISTS`，库中只有 1 行 |

配套代码变更：`backend/src/routes/inventory.ts` 把并发撞唯一键的 `P2002` 翻译为 `PRODUCT_ALREADY_EXISTS`，避免客户端收到通用 `DUPLICATE_VALUE`。

## 5. 关键断言摘录

- 完整主链：到货 → 生产 → 质检 → 包装 → 发货 → `COMPLETED`；`dueRemaining`、`shippableRemaining` 归零；利润 `1250.00 − 500.00 − 200.00 = 550.00`。
- 幂等：同一 `Idempotency-Key` 重放不重复建采购单。
- 并发库存：当前 150，20 个并发各扣 10，成功 15、冲突 5，最终 0，流水 15 条。
- 账号：改角色/重置密码/停用后旧会话立即失效。
- 审计：普通角色读取审计 403；账号与基础数据变更写入审计。
- 提醒：只提醒 7 天内未完成订单，同日重复执行 `created: 0`。

## 6. 前端构建

```bash
cd frontend
npm run build
```

```text
> tsc --noEmit && vite build
vite v6.4.5 building for production...
✓ 61 modules transformed.
dist/index.html                   0.52 kB │ gzip:   0.36 kB
dist/assets/index-x8fvKnIo.css   52.45 kB │ gzip:  10.39 kB
dist/assets/index-DB6aziXg.js   383.93 kB │ gzip: 114.79 kB
✓ built in 1.39s
```

结果：类型检查与构建通过。

## 7. 未执行/未覆盖

| 项 | 说明 |
| --- | --- |
| 附件上传/下载 | 无自动化用例，仅人工冒烟 |
| 订单导出 xlsx | 无自动化用例，仅人工冒烟 |
| 看板、异常 | 无自动化用例，仅人工冒烟 |
| 生产单价可见性 | 无自动化断言 |
| 真实浏览器端到端 | 未引入 Playwright；页面用截图人工核对 |
| 性能/压力 | 未执行 |

以上不写成“已通过”，交付状态以 [docs/feature-status.md](../../docs/feature-status.md) 为准。

## 8. 复现说明

1. 启动内嵌数据库：`npm run db`（或根目录 `npm run dev` 的前半段）。
2. 确认 `backend/.env` 的 `TEST_DATABASE_URL` 指向含 `test` 的库。
3. `cd backend && npx vitest run`。
4. 若失败，先看 `global-setup` 是否成功迁移；再用 `npx vitest run tests/<file>` 缩小范围。