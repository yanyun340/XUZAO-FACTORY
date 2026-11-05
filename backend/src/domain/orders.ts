import { Prisma } from '../generated/prisma/client.ts';
import type { Order, OrderItem } from '../generated/prisma/client.ts';
import type { Role } from '../generated/prisma/enums.ts';
import { toDateOnly } from '../lib/time.ts';
import {
  computeAllowedActions,
  computeProfit,
  computeQuantities,
  type OrderFlowRow,
} from './flow.ts';

export type OrderWithItems = Order & { items: OrderItem[] };

/** 与前端 STATUS_META 保持一致的中文状态名。 */
export const STATUS_LABELS: Record<string, string> = {
  PENDING_PURCHASE: '待采购',
  PURCHASING: '采购中',
  IN_PRODUCTION: '生产中',
  PENDING_QC: '待质检',
  QC_DONE: '质检完成',
  PACKING: '包装中',
  SHIPPING: '发货中',
  COMPLETED: '已完成',
};

/** 金额字段只对管理员可见；生产单价另有任务级开关。 */
export function canSeeMoney(role: Role): boolean {
  return role === 'ADMIN';
}

function canSeeCustomerContact(role: Role): boolean {
  return role === 'ADMIN' || role === 'LOGISTICS';
}

function itemsTotal(items: OrderItem[]): Prisma.Decimal {
  return items.reduce(
    (total, item) => total.plus(item.unitPrice.times(item.quantity)),
    new Prisma.Decimal(0),
  );
}

export function toOrderSummary(order: OrderWithItems, role: Role) {
  const showMoney = canSeeMoney(role);
  const total = itemsTotal(order.items);

  return {
    id: order.id,
    orderNo: order.orderNo,
    customerId: order.customerId,
    customerName: order.customerName,
    customerContact: canSeeCustomerContact(role) ? order.customerContact : null,
    dueDate: toDateOnly(order.dueDate),
    status: order.status,
    remark: order.remark,
    itemCount: order.items.length,
    productSummary:
      order.items.length === 0
        ? '—'
        : order.items.length === 1
          ? order.items[0]!.productName
          : `${order.items[0]!.productName} 等 ${order.items.length} 项`,
    totalQuantity: order.items.reduce((sum, item) => sum + item.quantity, 0),
    totalAmount: showMoney ? total.toFixed(2) : null,
    moneyVisible: showMoney,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    completedAt: order.completedAt?.toISOString() ?? null,
    allowedActions: [] as string[],
  };
}

export function toOrderDetail(
  order: OrderFlowRow,
  role: Role,
  userId: string,
  departmentId: string | null,
) {
  const showMoney = canSeeMoney(role);
  const summary = toOrderSummary(order, role);
  const quantities = computeQuantities(order);
  const actions = computeAllowedActions(order, quantities, role, userId, departmentId);

  const purchase = order.purchaseOrders[0] ?? null;
  const production = order.productions.at(-1) ?? null;
  const qc = production?.qcRecords.at(-1) ?? null;

  return {
    ...summary,
    allowedActions: ['view', ...actions],
    createdByName: order.createdBy.displayName,
    items: order.items.map((item) => ({
      id: item.id,
      productName: item.productName,
      spec: item.spec,
      quantity: item.quantity,
      unitPrice: showMoney ? item.unitPrice.toFixed(2) : null,
      lineAmount: showMoney ? item.unitPrice.times(item.quantity).toFixed(2) : null,
    })),
    flow: {
      quantities,
      purchase: purchase
        ? {
            id: purchase.id,
            supplierName: purchase.supplierName,
            createdAt: purchase.createdAt.toISOString(),
            items: purchase.items.map((item) => ({
              id: item.id,
              partName: item.partName,
              partSpec: item.partSpec,
              quantity: item.quantity,
              unitPrice: showMoney ? item.unitPrice.toFixed(2) : null,
              arrivedQty: item.arrivals.reduce((sum, arrival) => sum + arrival.quantity, 0),
              arrivals: item.arrivals.map((arrival) => ({
                id: arrival.id,
                quantity: arrival.quantity,
                operatorName: arrival.operator.displayName,
                createdAt: arrival.createdAt.toISOString(),
              })),
            })),
          }
        : null,
      production: production
          ? {
              id: production.id,
              departmentName: production.department.name,
              departmentCategory: production.department.category,
              employeeName: production.employee?.name ?? null,
              processName: production.processName,
              quantity: production.quantity,
              completedQty: production.feedbacks.reduce((sum, f) => sum + f.quantity, 0),
              unitPrice: showMoney ? production.unitPrice.toFixed(2) : null,
              unitPriceVisible: production.unitPriceVisible,
              unitPriceForWorker:
                !showMoney && production.unitPriceVisible
                  ? production.unitPrice.toFixed(2)
                  : null,
              dueDate: production.dueDate ? toDateOnly(production.dueDate) : null,
              createdAt: production.createdAt.toISOString(),
              feedback: production.feedbacks.at(-1)
                ? {
                    id: production.feedbacks.at(-1)!.id,
                    quantity: production.feedbacks.at(-1)!.quantity,
                    operatorName: production.feedbacks.at(-1)!.operator.displayName,
                    createdAt: production.feedbacks.at(-1)!.createdAt.toISOString(),
                  }
                : null,
            }
          : null,
      qc: qc
        ? {
            id: qc.id,
            inspectedQty: qc.inspectedQty,
            qualifiedQty: qc.qualifiedQty,
            unqualifiedQty: qc.unqualifiedQty,
            operatorName: qc.operator.displayName,
            createdAt: qc.createdAt.toISOString(),
            decision: qc.decision
              ? {
                  decision: qc.decision.decision,
                  releasedQty: qc.decision.releasedQty,
                  decidedByName: qc.decision.decidedBy.displayName,
                  createdAt: qc.decision.createdAt.toISOString(),
                }
              : null,
          }
        : null,
      packing: {
        dispatched: order.status === 'PACKING' || order.status === 'SHIPPING' || order.status === 'COMPLETED',
        records: order.packingRecords.map((record) => ({
          id: record.id,
          quantity: record.quantity,
          operatorName: record.operator.displayName,
          createdAt: record.createdAt.toISOString(),
        })),
      },
      shipping: {
        triggered: order.status === 'SHIPPING' || order.status === 'COMPLETED',
        records: order.shipments.map((record) => ({
          id: record.id,
          quantity: record.quantity,
          operatorName: record.operator.displayName,
          createdAt: record.createdAt.toISOString(),
        })),
      },
      profit: showMoney ? computeProfit(order) : null,
    },
    timeline: order.timelineEvents.map((event) => ({
      id: event.id,
      type: event.type,
      payload: event.payload,
      createdAt: event.createdAt.toISOString(),
      actorName: event.actor.displayName,
    })),
  };
}