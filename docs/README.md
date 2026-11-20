# 序造 XuZao 文档索引

当前版本：`0.2.0`（第三轮考核交付版本）
更新时间：2026-11-04
适用代码：本仓库当前提交（`main` 分支，未打 tag）

先读根目录 [README.md](../README.md) 启动项目，再按下面的分工查阅。文档只描述**已实现并有验证记录**的行为；未做或部分完成的项集中写在 [feature-status.md](feature-status.md)，不在这里写成承诺。

| 文档 | 回答的问题 | 维护触发 |
| --- | --- | --- |
| [PRD-xuzao.md](../PRD-xuzao.md) | 为谁做、做什么、边界在哪、怎样算做对 | 需求或范围变化时 |
| [architecture.md](architecture.md) | 代码怎么分层、一次请求怎么走、外部依赖是什么 | 目录或技术选型变化时 |
| [api-contract.md](api-contract.md) | 前端怎样调用、参数与响应、错误码、幂等与分页 | 路由 schema 变化时 |
| [data-dictionary.md](data-dictionary.md) | 表、字段、约束、索引、敏感性和快照口径 | `schema.prisma` 或迁移变化时 |
| [state-and-quantity.md](state-and-quantity.md) | 状态怎么流转、数量公式、允许动作与拒绝条件 | 业务规则变化时 |
| [permissions.md](permissions.md) | 哪个角色能做什么、哪些字段不可见 | 守卫或 DTO 变化时 |
| [feature-status.md](feature-status.md) | R01–R27 的 M 状态与所申报的 F 范围 | 每次交付前 |
| [operations.md](operations.md) | 启动、健康检查、迁移、备份恢复、排错、回退 | 脚本或部署方式变化时 |
| [traceability.csv](traceability.csv) | 需求 → 接口 → 数据 → 实现 → 测试 → 结果 | 与 feature-status 同步 |
| [ai-collaboration.md](ai-collaboration.md) | AI 参与了什么、本人如何验证、哪些建议被拒绝 | 协作方式变化时 |
| [demo-script.md](demo-script.md) | 答辩演示顺序、失败场景与常见问答 | 演示流程变化时 |
| [decisions/](decisions/) | 有代价的设计取舍（ADR） | 新增大决策时 |

## 测试与证据入口

| 证据 | 位置 | 说明 |
| --- | --- | --- |
| 自动化测试代码 | `backend/tests/` | 13 个 Vitest 文件，真实隔离库 `xuzao_test` |
| 最近一次执行结果 | `tests/reports/2026-11-14-backend-tests.md` | 102 个用例全部通过，命令与耗时均已记录 |
| 部署与回退演练 | `tests/reports/2026-11-14-deploy-rollback.md` | `/ready` 三项检查；0.1.0 代码运行在 0.2.0 结构上的回退演练 |
| 备份恢复演练 | `tests/reports/2026-11-04-backup-restore.md` | 恢复到新库 `xuzao_restore_verify_20261104b` 与隔离附件目录，28 张表 + 2 个附件核对一致 |
| 手工冒烟脚本 | `scripts/smoke-*.mjs` | 开发期使用，不作为自动化验收证据；说明见 `tests/README.md` |
| 视觉检查截图 | `.shots/`（不入交付包） | 桌面与 390px 视口的页面截图，属于过程材料 |

## 维护约定

- 文档中的“已实现”指代码存在且至少有一条可复现验证；“已验收”指报告中有当前版本的执行结果，两者不混用。
- 迁移只追加、不改写已应用文件；接口变更同步更新 `api-contract.md` 与 `traceability.csv`。
- 涉及密钥、真实客户、员工资料或运行库的内容不得写入任何文档或截图。
- 文档样例来自考核任务包，但本目录内容均按本项目实际实现重写，不复制模板结论。