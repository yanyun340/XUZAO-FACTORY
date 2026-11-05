# 备份恢复演练报告

日期：2026-11-04
执行人：本人
版本：0.1.0（工作区）

## 1. 目标

验证 R26：数据库与对应附件能从开发库完整备份，并恢复到**新的隔离环境**，逐表行数与附件校验和一致；同时验证恢复脚本不会覆盖现有库或当前附件目录。

## 2. 环境

| 项 | 值 |
| --- | --- |
| 数据库 | 内嵌 PostgreSQL 18.6，127.0.0.1:55432 |
| 源库 | `xuzao_dev` |
| 恢复目标库 | `xuzao_restore_verify_20261104b`（演练时新建） |
| 源附件目录 | `backend/storage/uploads` |
| 恢复附件目录 | `backend/storage/uploads-restore-verify-20261104b` |
| 工作目录 | `backend/` |

## 3. 备份

```bash
cd backend
npm run backup
```

产物：

```text
backups/xuzao-backup-2026-11-04T14-00-47.json
backups/xuzao-backup-2026-11-04T14-00-47.json.assets/
```

| 项 | 值 |
| --- | --- |
| 格式 | `xuzao-logical-backup` v1 |
| 来源库 | `xuzao_dev` |
| 导出时间 | 2026-11-04T14:00:47.599Z |
| 表数 | 28 |
| 总行数 | 602 |
| 附件 | 2 个（均为合成 PDF，22 字节） |
| 校验和 | `dbd9fabe357dd2f1b23a379a59d15fcfb75f231cd8e2a790806be10111aa4cf8` |

各表行数：

| 表 | 行数 | 表 | 行数 |
| --- | ---: | --- | ---: |
| departments | 4 | part_inventories | 3 |
| employees | 4 | product_inventories | 2 |
| admin_users | 6 | inventory_logs | 16 |
| customers | 4 | attachments | 2 |
| suppliers | 2 | notifications | 69 |
| parts | 3 | audit_logs | 183 |
| orders | 10 | tablet_exceptions | 2 |
| order_items | 10 | timeline_events | 78 |
| purchase_orders | 7 | idempotency_requests | 78 |
| purchase_items | 7 | sequence_counters | 5 |
| arrival_records | 7 | sessions | 63 |
| production_orders | 7 | production_feedbacks | 6 |
| qc_records | 6 | qc_decisions | 6 |
| packing_records | 6 | shipment_records | 6 |

## 4. 恢复

```bash
npm run restore -- backups/xuzao-backup-2026-11-04T14-00-47.json \
  --target "postgresql://postgres:postgres@127.0.0.1:55432/xuzao_restore_verify_20261104b" \
  --upload-dir "storage/uploads-restore-verify-20261104b"
```

脚本执行顺序与结果：

1. 备份格式与全局 SHA-256 校验：通过。
2. 目标库不存在 → 自动创建 `xuzao_restore_verify_20261104b`。
3. `prisma migrate deploy`：成功。
4. 按外键顺序写入 28 张表：逐表输出写入数与期望数一致。
5. 逐表 `COUNT(*)` 核对：28 张表全部一致，总计 602 行。
6. 附件恢复：2 个文件写入隔离目录，大小与 SHA-256 均一致。

最终输出：

```text
恢复完成：602 行写入 xuzao_restore_verify_20261104b，28 张表行数全部一致；附件 2 个已核对。
```

恢复目录文件数核对：`storage/uploads-restore-verify-20261104b` 下 2 个文件，与 `attachments` 表记录数一致。

## 5. 安全护栏验证

| 场景 | 预期 | 实际 |
| --- | --- | --- |
| 恢复到已有数据的 `xuzao_restore_verify` | 默认拒绝覆盖 | 拒绝，提示“已有 10 条订单数据”；改用新库名完成演练 |
| 目标库名不含 `restore/verify/test` | 拒绝 | 代码内置，未用于本次演练 |
| 目标库 = `DATABASE_URL` | 拒绝 | 代码内置 |
| 附件目录 = 当前 `UPLOAD_DIR` | 拒绝 | 代码内置 |
| 附件目录不含 `restore/verify/test` | 拒绝 | 代码内置 |

第一次恢复被拒绝说明“不得覆盖现有库”的护栏实际生效，而不是只写在文档里。

## 6. 附件校验

| storageKey | 大小 | SHA-256 | 恢复结果 |
| --- | ---: | --- | --- |
| `51826a79-7bf1-47b2-8510-60a063d819fb.pdf` | 22 | `82379ead…d98a0d66` | 一致 |
| `764cba5c-2429-497b-b637-171e5e8210e9.pdf` | 22 | `82379ead…d98a0d66` | 一致 |

两个文件内容相同是合成演示数据本身如此（同一测试 PDF 上传两次），不代表备份去重；恢复脚本按 `storageKey` 逐个校验。

## 7. 未覆盖

| 项 | 说明 |
| --- | --- |
| 大数据量性能 | 当前 602 行，未做百万级演练 |
| 物理备份/时间点恢复 | 内嵌发行版无 `pg_dump`，未提供 |
| 跨版本 schema 兼容 | 未做旧版本备份 + 新代码恢复的专项演练 |
| 恢复后应用连通性 | 本次只核对数据；未把 API 指向恢复库做完整回归 |

## 8. 结论

数据库与附件均能完整恢复到新的隔离环境，行数与校验和一致；护栏能阻止覆盖现有库和当前附件目录。R26 的 M 要求有可复现证据。未覆盖项已如实列出，不宣称超出范围的能力。