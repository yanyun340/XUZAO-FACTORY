# AGENTS：序造 XuZao 协作说明

本文件写给在本仓库工作的 AI 助手与协作者：先读哪里、怎样改、哪些操作必须停下来确认、改完怎样验证。

## 项目背景与依据

用途：工厂订单协同管理（下单 → 采购 → 到货 → 生产 → 质检 → 包装 → 发货）。
技术栈：Node 24 + TypeScript ESM + Fastify 5 + Prisma 7 + PostgreSQL 18；React 19 + Vite 6 + react-router-dom 7。

优先阅读顺序：

1. [README.md](README.md)：启动、配置、检查命令。
2. [PRD-xuzao.md](PRD-xuzao.md)：范围、目标、拒绝规则。
3. [CONSTRAINTS.md](CONSTRAINTS.md)：不可突破的安全与质量边界。
4. [docs/traceability.csv](docs/traceability.csv) 与 [docs/feature-status.md](docs/feature-status.md)：当前真实进度。
5. [tasks/plan.md](tasks/plan.md)、[tasks/todo.md](tasks/todo.md)：接下来做什么。
6. 具体设计：[architecture](docs/architecture.md)、[api-contract](docs/api-contract.md)、[data-dictionary](docs/data-dictionary.md)、[state-and-quantity](docs/state-and-quantity.md)、[permissions](docs/permissions.md)。

需求冲突：以任务书 R01–R27 的 M 要求与 [CONSTRAINTS.md](CONSTRAINTS.md) 为准。发现冲突时先报告并等待确认，不自行降低 M、不把 M 改写成加分项。

成果依据：只认当前源码与 `tests/reports/` 的实际执行结果；计划、TODO、口头描述都不能当作已完成。

## 开工流程

1. 改之前说明：目标、涉及文件、影响范围、是否需要迁移、怎样验证。
2. 先看 `git status` 与相关文件，保留已有修改；不做无关重排、不删除未完成记录。
3. 涉及以下改动先征得确认：数据库迁移、seed/reset、备份恢复、删除文件、修改 `package.json` 脚本、触碰认证/权限/幂等/库存原子逻辑。
4. 小步提交式推进：一个业务规则 → 代码 → 测试 → 文档同步。

## 目录与实现约定

| 目录 | 约定 |
| --- | --- |
| `backend/src/routes/` | HTTP 适配 + Zod + 事务编排；不把业务规则散落在页面 |
| `backend/src/domain/` | 与 HTTP 无关的状态、数量、利润、允许动作；必须有单测 |
| `backend/src/lib/` | 审计、时间线、通知、幂等、库存原子 SQL、编号 |
| `backend/src/auth/` | 会话、角色守卫；不得用请求体里的“操作人”代替认证 |
| `frontend/src/api/` | 统一信封与错误映射；前端不解析中文文案做分支 |
| `frontend/src/components/FlowPanel.tsx` | 只渲染 `allowedActions`；不自行推导下一步 |
| `backend/prisma/migrations/` | 只追加；不改已应用迁移 |
| `backend/tests/` | 只连隔离测试库；不得指向开发库 |

必须遵守的业务口径：

- 状态机与数量公式见 [docs/state-and-quantity.md](docs/state-and-quantity.md)，不要另立一套。
- 金额用 `Prisma.Decimal` / `Decimal(12,2)`；不要用 JS 浮点累计。
- 时间戳 UTC，业务日 `Asia/Shanghai`，交期 `YYYY-MM-DD`。
- 发货上限 `min(shippableRemaining, dueRemaining)`；包装不超过放行量；到货不超过采购量。
- 允许动作由 `computeAllowedActions` 计算，新增动作必须同时补路由校验、domain 测试、权限文档。
- 幂等键只用于真正接入 `runIdempotent` 的路由；同一业务意图重试复用键，新意图换键。

## 数据与操作安全

**不得**读取、写入或外传：真实客户/员工资料、密码、`.env`、运行数据库、浏览器会话、`storage/uploads*`、`backups/`。演示数据只允许合成数据。

必须确认后才可执行：

| 操作 | 确认要求 |
| --- | --- |
| `prisma migrate dev` / `migrate deploy` | 明确目标库；测试/隔离库才可直接执行 |
| `npm run seed` | 只对开发/隔离库；生产拒绝是正常行为 |
| `npm run db:reset` | 先停库并设置 `XUZAO_DB_RESET=1`；确认删除的是项目数据目录 |
| 备份/恢复 | 恢复必须新隔离库 + 隔离附件目录；不得覆盖现有库或 `UPLOAD_DIR` |
| 删除/覆盖文件 | 先读目标内容；交付包排除运行数据 |
| 远程推送/对外发布 | 需本人明确授权；默认不推送 |

其他底线：

- 不以隐藏按钮代替授权；不以样例数据掩盖接口失败。
- 不为了“通过”而删除测试、放宽断言、关闭类型检查或跳过失败用例。
- 错误响应走统一信封；5xx 不泄露堆栈，详细日志留在服务端。

## 实际验证入口

| 检查 | 工作目录 | 命令 | 依赖/风险 | 结果位置 |
| --- | --- | --- | --- | --- |
| 后端类型检查 | 根目录 | `npm run typecheck -w backend` | 无 | 终端 |
| 前端类型检查 + 构建 | 根目录 | `npm run build -w frontend` | 无 | 终端 |
| 后端测试 | 根目录 | `npm test` | 会清空 `xuzao_test` 业务表；不得指向开发库 | `tests/reports/` |
| 健康检查 | 根目录 | `curl http://127.0.0.1:3001/api/v1/health` | 需 API 与数据库已启动 | 终端 |
| 备份 | `backend/` | `npm run backup` | 读开发库与附件 | 输出目录 |
| 恢复 | `backend/` | `npm run restore -- <file> --target <隔离库> --upload-dir <隔离目录>` | 仅隔离库 | `tests/reports/2026-11-04-backup-restore.md` |
| 前端视觉检查 | 仓库根 | 按全局 CLAUDE.md 的 browser-cdp + 截图流程 | 需 dev server；截图不入交付包 | `.shots/` |

测试必须实际执行后再记录；未执行写“未执行”，失败写失败输出，不预填通过。

## 完成与交接

每次改动完成时更新：

- 接口变化 → `docs/api-contract.md`、`docs/traceability.csv`。
- 表/迁移变化 → `docs/data-dictionary.md`。
- 业务规则变化 → `docs/state-and-quantity.md`、对应 domain 测试。
- 范围/状态变化 → `docs/feature-status.md`、`tasks/todo.md`。
- 可复现结果 → `tests/reports/<日期>-<主题>.md`。

汇报格式：

1. 改了什么（文件与行为）。
2. 实际执行了哪些验证，结果如何（含失败/未执行）。
3. 已知风险与回退方式。
4. 剩余未完成项。

AGENTS 只是协作约定，不自动提供鉴权或阻止危险命令；真正的防线在代码、测试、迁移护栏与人工审查。