# 审计订单上下文测试执行报告

日期：2026-11-25
版本：0.3.1
执行人：本人

## 1. 命令

```bash
cd backend
npx vitest run
```

## 2. 结果

```text
 Test Files  15 passed (15)
      Tests  124 passed (124)
   Duration  32.58s
```

`tests/audit.test.ts` 新增 2 条用例：

| 用例 | 验证点 |
| --- | --- |
| 审计记录反查订单并出现在导出 | `arrival.create` 记录返回 `orderId/orderNo`；xlsx 第 3 列为“订单号”，行内包含该订单号 |
| 无订单上下文返回 null | `auth.login` 记录的 `orderId/orderNo` 均为 null |

## 3. 实现方式

- 新增 `backend/src/lib/audit-order-context.ts`：按 `resourceType + resourceId` 分块批量反查订单。
- 覆盖 `order/purchase/arrival/production/qc/qc_decision/packing/shipment/plating_order/exception/attachment`。
- 不新增数据库字段、不迁移；历史记录读取时同样能补出订单号。

## 4. 构建

```bash
npm run typecheck   # backend + frontend 通过
npm run build       # tsc --noEmit && vite build 通过
```