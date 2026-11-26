# 2026-11-26 撤销与修正（R12F）执行报告

- 版本：0.4.0
- 执行时间：2026-11-26 12:37:52–12:38:51（Asia/Shanghai）
- 关联：R12 / R12F，验收 A17
- 环境：Windows 11、Node 24、内嵌 PostgreSQL 18、`xuzao_test` 隔离库

## 1. 命令与实际结果

```bash
cd backend
npx prisma migrate deploy   # global-setup 自动执行；11 条迁移，无 pending
npx tsc --noEmit            # 通过，0 错误
npx vitest run              # 16 文件 / 166 用例全绿
```

```
Test Files  16 passed (16)
     Tests  166 passed (166)
  Duration  58.71s（wall 61s）
```

前端：

```bash
npm run build -w frontend   # tsc --noEmit + vite build，通过
```

## 2. 新增与修改的用例

| 文件 | 数量 | 说明 |
| --- | --- | --- |
| `tests/undo.test.ts`（新增） | 19 | 五类撤销、窗口、权限、修正、依赖、重复、幂等、死锁回归、可重做、看板 |
| `tests/domain.test.ts`（新增 R12F 组） | 16 | 作废过滤、作废决策视同未决策、允许动作恢复、`deriveRepairedStatus` 三条反向边与级联 |

`undo.test.ts` 明细：

| 用例 | 断言 |
| --- | --- |
| 到货窗口内撤销 | 200；`arrivedQty` 归零；记录仍在且 `voidedAt` 非空；时间线 `ARRIVAL_UNDONE`；`allowedActions` 重新含 `record-arrival`；可再次登记 |
| 已下发生产撤销到货 | 409 `UNDO_HAS_PRODUCTION` |
| 已建 PENDING 电镀单撤销到货 | 409 `UNDO_HAS_PLATING` |
| 他人撤销 | 403；管理员窗口内撤销 200 |
| 窗口边界 | 9分59秒 200；10分01秒 409 `UNDO_WINDOW_EXPIRED`；管理员 `/correct` 缺原因 400、带原因 200 且事件为 `ARRIVAL_CORRECTED` |
| 非管理员修正 | 403 |
| 重复撤销 | 409 `RECORD_ALREADY_VOIDED`；记录数量未被二次扣减 |
| 同键重放 | 200 + `Idempotent-Replayed: true`；数量只变一次 |
| 反馈撤销 | 订单退回 `IN_PRODUCTION`；`producedQty` 归零；可重新反馈 |
| 已录质检撤销反馈 | 409 `UNDO_HAS_QC` |
| 质检撤销（已决策） | 200；决策行 `voidedAt` 非空；`releasedQty` 归零；订单回到 `PENDING_QC`；可重新录入 |
| 已包装撤销质检 | 409 `UNDO_HAS_PACKING` |
| 已下发包装（未登记）撤销质检 | 409 `UNDO_HAS_PACKING`；订单状态与可执行动作不变（死锁回归） |
| 有复检子记录撤销父记录 | 409 `UNDO_HAS_CHILD_QC` |
| 包装撤销 | 200；`packedQty` 归零；可重新登记 |
| 已发货撤销包装 | 409 `UNDO_HAS_SHIPMENT` |
| 已触发发货（未登记）撤销包装 | 409 `UNDO_HAS_SHIPMENT`；`record-shipment` 仍可用（死锁回归） |
| 撤销足量发货 | `COMPLETED→SHIPPING`；`completedAt` 清空；可重新发货 |
| 看板与利润 | 撤销反馈后 `production.completedFeedback` 与 `productionCost` 同步下降 |

## 3. 浏览器手工核对（非自动化）

使用 ego-browser 在 `http://localhost:5173` 实际操作，截图在 `.shots/2026-11-26-undo-*.png`。

| 场景 | 结果 |
| --- | --- |
| 物流窗口内撤销到货 | 行内显示 `10:00` 倒计时与「撤销」；点击后灰显为「已作废 · 物流专员 · 撤销：100 件到货记录」，toast「到货记录已撤销」，流转台账「已到 0」 |
| 管理员超时修正 | 物流记录超窗后显示「修正」；弹窗标题「修正到货记录」、原因框 14/200、按钮可用；提交后灰显原因「视觉核查：管理员留痕修正用例」、作废人为管理员、toast「到货记录已修正」 |
| 依赖拒绝 | 管理员对已下发生产的订单修正到货，弹窗内显示服务端错误「该订单已下发生产任务，到货记录不能再撤销」 |
| 390px 视口 | 记录行改为三行堆叠（名称+数量 / 操作者+时间 / 作废原因），`document.scrollWidth = 390`，无横向溢出 |
| 倒计时口径 | 作废原因不再被截断（`scrollWidth === clientWidth`）；服务端 `remainingMs` 本地递减 |

视觉检查过程中发现并修正的问题：

1. 作废原因原来挤在操作列被省略号截断（234px 内容 / 207px 容器）→ 改为整行第二行显示。
2. 回填未来的 `createdAt` 时倒计时出现 `469:42` → `remainingMs` 增加窗口上限，最多显示 10:00。

## 4. A17 逐条证据

| A17 | 证据 |
| --- | --- |
| 1. 9分59秒 / 10分整允许撤销 | `undo.test.ts` 窗口边界用例（`UNDO_WINDOW_MS - 1000`） |
| 2. 10分01秒拒绝；他人拒绝 | 同上 + 「他人撤销 403」 |
| 3. 已发货包装、已包装/已下发包装的 QC、有生产/电镀依赖的到货不能撤 | 六条依赖用例 |
| 4. 按依赖逆序撤销、核对累计/状态/时间线/通知、重复撤销不重复扣量 | 五类「可重做」+ 重复 409 + 幂等重放 + 状态回退用例 |
| 5. 五类逐类执行 | 五类窗口内撤销用例各一条 |

## 5. 未执行 / 已知限制

- 未做多产品并行撤销（与主链单产品口径一致）。
- 未覆盖真实生产环境的时钟漂移；仅通过 `lib/clock.ts` 注入验证窗口边界。
- 浏览器核对为手工执行，不写成自动化通过。
- 视觉检查的 dev 库中留下了测试订单与作废记录（`XZ-20261126-0002` 等），未清理开发库数据。