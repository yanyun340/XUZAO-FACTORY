import { Prisma } from '../generated/prisma/client.ts';
import type { Order, OrderItem } from '../generated/prisma/client.ts';
import type { OrderStatus, Role } from '../generated/prisma/enums.ts';
import { toDateOnly } from '../lib/time.ts';
import {
  computeAllowedActions,
  computeProfit,
  computeQuantities,
  type FlowQuantities,
  type OrderAction,
  type OrderFlowRow,
  type OrderListRow,
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

/** 订单行的六段工序：顺序固定，前端按下标渲染成色带。 */
export type StageKey = 'purchase' | 'arrival' | 'production' | 'qc' | 'packing' | 'shipping';
export type StageState = 'done' | 'doing' | 'blocked' | 'todo';

export interface OrderStage {
  key: StageKey;
  state: StageState;
  label: string;
}

export const STAGE_ORDER: StageKey[] = [
  'purchase',
  'arrival',
  'production',
  'qc',
  'packing',
  'shipping',
];

const STAGE_WORDS: Record<StageKey, { todo: string; doing: string; done: string }> = {
  purchase: { todo: '待采购', doing: '采购中', done: '已下单' },
  arrival: { todo: '待到货', doing: '部分到货', done: '已到货' },
  production: { todo: '待生产', doing: '生产中', done: '已完工' },
  qc: { todo: '待质检', doing: '质检中', done: '已质检' },
  packing: { todo: '待包装', doing: '包装中', done: '已包装' },
  shipping: { todo: '待发货', doing: '发货中', done: '已发货' },
};

/**
 * 当前工序还没留下任何数量时，不能写成「…中」（采购还没下单、货一件没到、
 * 质检还没登记，说「进行中」都是假话），退回待办措辞；派工即算开工的
 * 生产/包装/发货仍用「…中」。
 */
function doingLabel(key: StageKey, started: boolean): string {
  if (started) return STAGE_WORDS[key].doing;
  return STAGE_WORDS[key].todo;
}

const ACTIVE_STAGE: Record<OrderStatus, StageKey | null> = {
  PENDING_PURCHASE: 'purchase',
  PURCHASING: 'arrival',
  IN_PRODUCTION: 'production',
  PENDING_QC: 'qc',
  QC_DONE: 'qc',
  PACKING: 'packing',
  SHIPPING: 'shipping',
  COMPLETED: null,
};

/**
 * 阶段态由「数量是否走完」+「状态机当前停在哪」共同决定：
 * 数量达标 = done，当前工序 = doing，逾期卡在当前工序 = blocked，其余 todo。
 */
export function computeStages(
  quantities: FlowQuantities,
  status: OrderStatus,
  dueDate: string,
  today: string,
): OrderStage[] {
  const target: Record<StageKey, number> = {
    purchase: quantities.orderQty,
    arrival: quantities.purchaseQty,
    production: quantities.orderQty,
    qc: quantities.producedQty,
    packing: quantities.releasedQty || quantities.qualifiedQty,
    shipping: quantities.packedQty,
  };
  const value: Record<StageKey, number> = {
    purchase: quantities.purchaseQty,
    arrival: quantities.arrivedQty,
    production: quantities.producedQty,
    qc: quantities.inspectedQty,
    packing: quantities.packedQty,
    shipping: quantities.shippedQty,
  };

  // 采购单还没建出来时，状态虽然已是「采购中」，实际仍停在采购段
  const active =
    status === 'PURCHASING' && quantities.purchaseQty === 0
      ? 'purchase'
      : ACTIVE_STAGE[status];
  const overdue = status !== 'COMPLETED' && dueDate < today;

  // 该工序是否真的动过工：采购看有没有下单，到货/质检看数量；
  // 生产、包装、发货以「派工」为开工，状态已推进就写「…中」，与筛选器用词一致
  const started: Record<StageKey, boolean> = {
    purchase: status === 'PURCHASING',
    arrival: quantities.arrivedQty > 0,
    production: true,
    qc: quantities.inspectedQty > 0,
    packing: true,
    shipping: true,
  };

  return STAGE_ORDER.map((key) => {
    let state: StageState;
    if (status === 'COMPLETED') state = 'done';
    else if (target[key] > 0 && value[key] >= target[key]) state = 'done';
    else if (key === active) state = overdue ? 'blocked' : 'doing';
    else state = 'todo';

    const words = STAGE_WORDS[key];
    const label =
      state === 'blocked'
        ? '逾期'
        : state === 'done'
          ? words.done
          : state === 'doing'
            ? doingLabel(key, started[key])
            : words.todo;

    return { key, state, label };
  });
}

/** 列表行：在摘要上补六段工序色带。 */
export function toOrderSummaryWithStages(order: OrderListRow, role: Role, today: string) {
  const summary = toOrderSummary(order, role);
  return {
    ...summary,
    stages: computeStages(computeQuantities(order), order.status, summary.dueDate, today),
  };
}

/** 待办卡上的「本次可处理量」——与对应动作的数量闸门同源。 */
function taskQuantity(
  action: OrderAction,
  quantities: FlowQuantities,
  productionQty: number,
): number {
  const raw = (() => {
    switch (action) {
      case 'create-purchase':
        return quantities.orderQty;
      case 'record-arrival':
        return quantities.purchaseQty - quantities.arrivedQty;
      case 'dispatch-production':
        return quantities.arrivedQty;
      case 'production-feedback':
        return productionQty - quantities.producedQty;
      case 'dispatch-qc':
        return quantities.producedQty;
      case 'qc-entry':
        return quantities.producedQty - quantities.inspectedQty;
      case 'qc-decision':
        return quantities.inspectedQty;
      case 'dispatch-packing':
      case 'record-packing':
        return quantities.packableRemaining;
      case 'trigger-shipping':
        return quantities.packedQty;
      case 'record-shipment':
        return quantities.shippableRemaining;
    }
  })();
  return Math.max(0, raw);
}

export interface TaskItem extends ReturnType<typeof toOrderSummaryWithStages> {
  action: OrderAction;
  taskQty: number;
}

/**
 * 待办队列的一行：只保留当前角色**立刻能推进**的订单，并带上主操作与数量。
 * 没有可执行动作时返回 null，调用方据此过滤。
 */
export function toTaskItem(
  order: OrderListRow,
  role: Role,
  userId: string,
  departmentId: string | null,
  today: string,
): TaskItem | null {
  const quantities = computeQuantities(order);
  const actions = computeAllowedActions(order, quantities, role, userId, departmentId);
  const action = actions[0];
  if (!action) return null;

  const productionQty = order.productions.at(-1)?.quantity ?? 0;

  return {
    ...toOrderSummaryWithStages(order, role, today),
    action,
    taskQty: taskQuantity(action, quantities, productionQty),
  };
}

/** 各角色关心的状态：只查这些状态的订单，避免把整张表拉进内存再做动作判定。 */
export const TASK_STATUSES: Record<Role, OrderStatus[]> = {
  ADMIN: [
    'PENDING_PURCHASE',
    'PURCHASING',
    'IN_PRODUCTION',
    'PENDING_QC',
    'QC_DONE',
    'PACKING',
  ],
  LOGISTICS: ['PURCHASING', 'SHIPPING'],
  PRODUCTION: ['IN_PRODUCTION'],
  QC: ['PENDING_QC'],
  PACKING: ['PACKING'],
};

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